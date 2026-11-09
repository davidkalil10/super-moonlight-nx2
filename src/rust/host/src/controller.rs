use crate::{
    Backend, Codec, Operation, Session, StreamOptions, Transport,
    helper::Helper,
    management::{self, Management},
    relay::{self, Relay},
    response,
};
use moonlight_nx2_core::control::{Frame, Kind};
use serde::Serialize;
use std::{
    fs::File,
    io::{self, Read},
    net::IpAddr,
    sync::atomic::{Ordering, compiler_fence},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

#[derive(Debug)]
pub enum Error {
    Unsupported,
    Busy,
    Random(io::Error),
    Relay(relay::Error),
    Management(management::Error),
    Session(crate::Error<Box<Error>>),
}

pub enum Started {
    Management,
    CoverReady,
    Stream(Descriptor),
    StartPending,
    StopPending,
}

pub struct Descriptor {
    video_token: [u8; 64],
    audio_token: [u8; 64],
    video_port: u16,
    audio_port: u16,
    udp: Option<Box<UdpDescriptor>>,
    options: StreamOptions,
    telemetry: bool,
}

#[derive(Serialize)]
struct VideoDescriptor<'a> {
    port: u16,
    token: &'a str,
    max_payload: u32,
    ack: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    transport: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    udp: Option<WireUdpDescriptor<'a>>,
}
struct UdpDescriptor {
    port: u16,
    token: [u8; 64],
    timing: crate::udp_video::Timing,
}
#[derive(Serialize)]
struct WireUdpDescriptor<'a> {
    version: u8,
    port: u16,
    token: &'a str,
    fragment_bytes: u16,
    unit_slots: u8,
    deadline_us: u32,
    spread_us: u32,
    pace_bytes_per_ms: u32,
    hello_ms: u32,
    feedback: &'static str,
}
#[derive(Serialize)]
struct AudioDescriptor<'a> {
    port: u16,
    token: &'a str,
    rate: u32,
    channels: u8,
    format: &'static str,
    chunk_bytes: u32,
    ack: &'static str,
}
#[derive(Serialize)]
struct WireDescriptor<'a> {
    codec: &'static str,
    width: u32,
    height: u32,
    fps: u32,
    video: VideoDescriptor<'a>,
    audio: AudioDescriptor<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    telemetry: Option<&'static str>,
}

impl Descriptor {
    pub fn encode(&self, request_id: u32, out: &mut [u8]) -> Result<usize, response::Error> {
        if request_id == 0 {
            return Err(response::Error::InvalidId);
        }
        let value = WireDescriptor {
            codec: match self.options.codec {
                Codec::H264 => "h264",
                Codec::Hevc => "hevc",
                Codec::Av1 => "av1",
            },
            width: self.options.width,
            height: self.options.height,
            fps: self.options.fps,
            video: VideoDescriptor {
                port: self.video_port,
                token: std::str::from_utf8(&self.video_token).expect("hex token"),
                max_payload: crate::assemble::MAX_VIDEO_BYTES as u32,
                ack: "input-v1",
                transport: self.udp.as_ref().map(|_| "udp-v1"),
                udp: self.udp.as_ref().map(|udp| WireUdpDescriptor {
                    version: 1,
                    port: udp.port,
                    token: std::str::from_utf8(&udp.token).expect("hex token"),
                    fragment_bytes: crate::udp_video::FRAGMENT_BYTES as u16,
                    unit_slots: 8,
                    deadline_us: (udp.timing.deadline_ms * 1000.0).round() as u32,
                    spread_us: (udp.timing.spread_ms * 1000.0).round() as u32,
                    pace_bytes_per_ms: udp.timing.pace_bytes_per_ms as u32,
                    hello_ms: 8000,
                    feedback: "input-drop-v1",
                }),
            },
            audio: AudioDescriptor {
                port: self.audio_port,
                token: std::str::from_utf8(&self.audio_token).expect("hex token"),
                rate: 48_000,
                channels: 2,
                format: "s16le",
                chunk_bytes: crate::assemble::PCM_BYTES as u32,
                ack: "header",
            },
            telemetry: self.telemetry.then_some("upstream-v1"),
        };
        response::encode(Kind::Stream, request_id, &value, out)
    }
}
impl Drop for Descriptor {
    fn drop(&mut self) {
        for byte in self
            .video_token
            .iter_mut()
            .chain(self.audio_token.iter_mut())
        {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        if let Some(udp) = &mut self.udp {
            for byte in &mut udp.token {
                unsafe { std::ptr::write_volatile(byte, 0) };
            }
        }
        compiler_fence(Ordering::SeqCst);
    }
}

fn random_token(random: &mut File) -> io::Result<[u8; 64]> {
    let mut raw = [0u8; 32];
    random.read_exact(&mut raw)?;
    let alphabet = b"0123456789abcdef";
    let mut token = [0; 64];
    for (i, byte) in raw.iter().enumerate() {
        token[i * 2] = alphabet[(byte >> 4) as usize];
        token[i * 2 + 1] = alphabet[(byte & 15) as usize];
    }
    for byte in &mut raw {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
    Ok(token)
}

struct HostBackend {
    helper: Helper,
    bind: IpAddr,
    peer: IpAddr,
    management: Management,
    relay: Option<Relay>,
    stopping: Option<u32>,
    starting: bool,
    start_id: Option<u32>,
    preflight: Option<StartPreflight>,
    cancelled_start: Option<u32>,
    preflight_stopped: bool,
    telemetry: bool,
    cover_cache: crate::cover::Cache,
    cover_pending: Option<CoverRequest>,
    cover_result: Option<crate::bridge::Event>,
}

struct CoverRequest {
    host: String,
    app: u32,
    offset: usize,
}

struct StartPreflight {
    request_id: u32,
    host: String,
    app: String,
    options: StreamOptions,
}

impl HostBackend {
    fn prepare_stream(&mut self, start: StartPreflight) -> Result<Descriptor, Box<Error>> {
        let StartPreflight {
            host, app, options, ..
        } = start;
        let mut random = File::open("/dev/urandom").map_err(|e| Box::new(Error::Random(e)))?;
        let video_token = random_token(&mut random).map_err(|e| Box::new(Error::Random(e)))?;
        let mut audio_token = random_token(&mut random).map_err(|e| Box::new(Error::Random(e)))?;
        while bool::from(video_token.ct_eq(&audio_token)) {
            audio_token = random_token(&mut random).map_err(|e| Box::new(Error::Random(e)))?;
        }
        let udp_token = if options.transport == Transport::UdpV1 {
            loop {
                let token = random_token(&mut random).map_err(|e| Box::new(Error::Random(e)))?;
                if !bool::from(token.ct_eq(&audio_token)) && !bool::from(token.ct_eq(&video_token))
                {
                    break Some(token);
                }
            }
        } else {
            None
        };
        let config = relay::Config {
            bind: self.bind,
            peer: self.peer,
            host,
            app,
            options,
            video_token,
            audio_token: Some(audio_token),
            udp_token,
            deadline: Instant::now() + Duration::from_secs(15),
        };
        let mut relay =
            Relay::prepare(self.helper.clone(), config).map_err(|e| Box::new(Error::Relay(e)))?;
        if self.telemetry {
            relay.enable_telemetry(start.request_id);
        }
        let video_port = relay
            .video_addr()
            .map_err(|e| Box::new(Error::Relay(e)))?
            .port();
        let audio_port = relay
            .audio_addr()
            .map_err(|e| Box::new(Error::Relay(e)))?
            .ok_or_else(|| Box::new(Error::Unsupported))?
            .port();
        let udp = match udp_token {
            Some(token) => Some(Box::new(UdpDescriptor {
                token,
                port: relay
                    .udp_addr()
                    .map_err(|e| Box::new(Error::Relay(e)))?
                    .ok_or_else(|| Box::new(Error::Unsupported))?
                    .port(),
                timing: relay
                    .udp_timing()
                    .ok_or_else(|| Box::new(Error::Unsupported))?,
            })),
            None => None,
        };
        self.relay = Some(relay);
        Ok(Descriptor {
            video_token,
            audio_token,
            video_port,
            audio_port,
            udp,
            options,
            telemetry: self.telemetry,
        })
    }
}
impl Backend for HostBackend {
    type Output = Started;
    type Error = Box<Error>;
    fn configure_telemetry(&mut self, enabled: bool) {
        self.telemetry = enabled;
    }
    fn execute(&mut self, id: u32, operation: Operation<'_>) -> Result<Started, Box<Error>> {
        match operation {
            Operation::Cover { host, app, offset } => {
                match self.cover_cache.chunk(host, app, offset) {
                    Ok(Some(value)) => {
                        self.cover_result = Some(crate::bridge::Event::Result {
                            request_id: id,
                            operation: management::OperationName::Cover,
                            value,
                        });
                        return Ok(Started::CoverReady);
                    }
                    Err(_) => {
                        self.cover_result = Some(crate::bridge::Event::Failure {
                            request_id: id,
                            code: response::Code::InvalidRequest,
                        });
                        return Ok(Started::CoverReady);
                    }
                    Ok(None) => {}
                }
                self.management
                    .start(id, operation)
                    .map_err(|e| Box::new(Error::Management(e)))?;
                self.cover_pending = Some(CoverRequest {
                    host: host.into(),
                    app,
                    offset,
                });
                Ok(Started::Management)
            }
            Operation::Start { host, app, options } => {
                self.management
                    .start_preflight(id, host)
                    .map_err(|e| Box::new(Error::Management(e)))?;
                self.preflight = Some(StartPreflight {
                    request_id: id,
                    host: host.into(),
                    app: app.into(),
                    options,
                });
                self.starting = true;
                self.start_id = Some(id);
                Ok(Started::StartPending)
            }
            Operation::Stop => {
                if self.preflight.is_some() {
                    self.management
                        .cancel()
                        .map_err(|e| Box::new(Error::Management(e)))?;
                    let start = self.preflight.take().expect("pending preflight");
                    self.cancelled_start = Some(start.request_id);
                    self.preflight_stopped = true;
                    self.stopping = Some(id);
                    self.starting = false;
                    self.start_id = None;
                    return Ok(Started::StopPending);
                }
                self.relay
                    .as_mut()
                    .ok_or_else(|| Box::new(Error::Unsupported))?
                    .stop();
                self.stopping = Some(id);
                self.starting = false;
                Ok(Started::StopPending)
            }
            op => {
                self.management
                    .start(id, op)
                    .map_err(|e| Box::new(Error::Management(e)))?;
                Ok(Started::Management)
            }
        }
    }
    fn is_busy(&self) -> bool {
        self.management.is_busy()
            || self.stopping.is_some()
            || self.starting
            || self.cover_result.is_some()
    }
    fn stop_pending(&self) -> bool {
        self.stopping.is_some()
    }
    fn allow_stop_during_busy(&self) -> bool {
        self.starting && self.stopping.is_none()
    }
    fn cancel_pending(&mut self) -> Result<(), Box<Error>> {
        self.management
            .cancel()
            .map_err(|e| Box::new(Error::Management(e)))?;
        Ok(())
    }
    fn shutdown(&mut self, _: bool) -> Result<(), Box<Error>> {
        self.management
            .cancel()
            .map_err(|e| Box::new(Error::Management(e)))?;
        if let Some(relay) = &mut self.relay {
            relay.stop();
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                match relay.poll(Instant::now()) {
                    Ok(Some(relay::Event::Stopped)) => break,
                    Ok(_) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Ok(_) => {
                        relay.cancel().map_err(|e| Box::new(Error::Relay(e)))?;
                        return Err(Box::new(Error::Relay(relay::Error::Timeout)));
                    }
                    Err(error) => return Err(Box::new(Error::Relay(error))),
                }
            }
        }
        self.relay = None;
        self.stopping = None;
        self.starting = false;
        self.start_id = None;
        self.preflight = None;
        self.cancelled_start = None;
        self.preflight_stopped = false;
        Ok(())
    }
}

pub enum Event {
    Management(crate::bridge::Event),
    Stream {
        request_id: u32,
        descriptor: Descriptor,
    },
    Connected,
    StreamFailed {
        start_id: u32,
        code: response::StreamFailureCode,
        message: &'static str,
    },
    Stopped {
        request_id: Option<u32>,
    },
    /// The PC rumbled a player; sent as an ID-0 event that older clients ignore.
    Rumble(relay::Rumble),
}

pub struct Controller {
    session: Session<HostBackend>,
    management_output: Option<crate::bridge::Pending>,
}
impl Controller {
    pub fn new(token: [u8; 64], helper: Helper, bind: IpAddr, peer: IpAddr) -> Result<Self, Error> {
        let backend = HostBackend {
            management: Management::new(helper.clone()),
            helper,
            bind,
            peer,
            relay: None,
            stopping: None,
            starting: false,
            start_id: None,
            preflight: None,
            cancelled_start: None,
            preflight_stopped: false,
            telemetry: false,
            cover_cache: crate::cover::Cache::new(),
            cover_pending: None,
            cover_result: None,
        };
        Ok(Self {
            session: Session::new(token, backend).map_err(Error::Session)?,
            management_output: None,
        })
    }
    pub fn authenticate(&mut self, frame: Frame<'_>) -> Result<(), Error> {
        self.session.authenticate(frame).map_err(Error::Session)
    }
    pub(crate) fn take_video_readable(&mut self) -> bool {
        self.session
            .backend_mut()
            .relay
            .as_mut()
            .is_some_and(relay::Relay::take_video_readable)
    }
    pub(crate) fn telemetry_allowed(&mut self) -> bool {
        self.session
            .backend_mut()
            .relay
            .as_ref()
            .is_some_and(Relay::telemetry_allowed)
    }
    pub(crate) fn telemetry_snapshot(
        &mut self,
        now: Instant,
    ) -> Option<crate::telemetry::Snapshot> {
        self.session
            .backend_mut()
            .relay
            .as_mut()?
            .telemetry_snapshot(now)
    }
    pub fn request(&mut self, frame: Frame<'_>) -> Result<Started, Error> {
        match self.session.request(frame) {
            Ok(result) => {
                if matches!(result, Started::Management | Started::StartPending) {
                    let (request_id, operation) = self
                        .session
                        .backend_mut()
                        .management
                        .current()
                        .expect("management started");
                    self.management_output = Some(crate::bridge::Pending {
                        request_id,
                        operation,
                        buffer: Vec::new(),
                        value: None,
                        stderr: crate::status::Lines::new(),
                        not_paired: false,
                        cover_bytes: Vec::new(),
                        cover_total: None,
                    });
                }
                if matches!(result, Started::StopPending)
                    && self.session.backend_mut().preflight_stopped
                {
                    self.management_output = None;
                }
                Ok(result)
            }
            Err(error) => {
                if matches!(
                    error,
                    crate::Error::Authentication
                        | crate::Error::InvalidFrame
                        | crate::Error::InvalidEncoding
                ) {
                    self.close()?;
                }
                Err(Error::Session(error))
            }
        }
    }
    pub fn poll(&mut self, now: Instant) -> Result<Option<Event>, Error> {
        if let Some(result) = self.session.backend_mut().cover_result.take() {
            return Ok(Some(Event::Management(result)));
        }
        if let Some(request_id) = self.session.backend_mut().cancelled_start.take() {
            return Ok(Some(Event::Management(crate::bridge::Event::Failure {
                request_id,
                code: response::Code::Cancelled,
            })));
        }
        if self.session.backend_mut().preflight_stopped {
            let backend = self.session.backend_mut();
            backend.preflight_stopped = false;
            let request_id = backend.stopping.take();
            self.session.stream_stopped().map_err(Error::Session)?;
            return Ok(Some(Event::Stopped { request_id }));
        }
        if let Some(pending) = &mut self.management_output {
            match crate::bridge::consume_available(pending) {
                Ok(Some(event)) => return Ok(Some(Event::Management(event))),
                Ok(None) => {}
                Err(()) => return self.fail_management(response::Code::BackendFailed),
            }
        }
        let management_event = self
            .session
            .backend_mut()
            .management
            .poll(now)
            .map_err(Error::Management)?;
        if let Some(event) = management_event {
            let pending = self.management_output.as_mut().expect("management output");
            match event {
                management::Event::Output {
                    stream: crate::helper::Stream::Stderr,
                    bytes,
                    ..
                } => {
                    if pending.consume_stderr(&bytes).is_err() {
                        return self.fail_management(response::Code::BackendFailed);
                    }
                }
                management::Event::Output {
                    stream: crate::helper::Stream::Stdout,
                    bytes,
                    ..
                } => {
                    if pending.operation == management::OperationName::Cover {
                        let mut remaining = bytes.as_slice();
                        while !remaining.is_empty() {
                            let count = remaining
                                .iter()
                                .position(|byte| *byte == b'\n')
                                .map_or(remaining.len(), |index| index + 1);
                            if count
                                > moonlight_nx2_core::control::MAX_PAYLOAD - pending.buffer.len()
                            {
                                return self.fail_management(response::Code::TooLarge);
                            }
                            pending.buffer.extend_from_slice(&remaining[..count]);
                            remaining = &remaining[count..];
                            match crate::bridge::consume_available(pending) {
                                Ok(Some(event)) => return Ok(Some(Event::Management(event))),
                                Ok(None) => {}
                                Err(()) => {
                                    return self.fail_management(response::Code::BackendFailed);
                                }
                            }
                        }
                        return Ok(None);
                    }
                    if bytes.len() > moonlight_nx2_core::control::MAX_PAYLOAD - pending.buffer.len()
                    {
                        return self.fail_management(response::Code::TooLarge);
                    }
                    pending.buffer.extend_from_slice(&bytes);
                    match crate::bridge::consume_available(pending) {
                        Ok(Some(event)) => return Ok(Some(Event::Management(event))),
                        Ok(None) => {}
                        Err(()) => return self.fail_management(response::Code::BackendFailed),
                    }
                }
                management::Event::Complete { result, .. } => {
                    let pending = self.management_output.take().expect("management output");
                    if pending.operation == management::OperationName::Pair {
                        eprintln!("pair worker completion: {result:?}");
                    }
                    let pair_failure = if matches!(result, management::Completion::Exited(_)) {
                        pending.pair_failure()
                    } else {
                        None
                    };
                    if let Some((code, worker_code)) = pair_failure {
                        return Ok(Some(Event::Management(crate::bridge::Event::PairFailure {
                            request_id: pending.request_id,
                            code,
                            worker_code,
                        })));
                    }
                    let code = match result {
                        management::Completion::Exited(status)
                            if status.success()
                                && pending.buffer.is_empty()
                                && pending.value.is_some() =>
                        {
                            None
                        }
                        management::Completion::Exited(status)
                            if pending.confirmed_not_paired(status) =>
                        {
                            Some(response::Code::NotPaired)
                        }
                        management::Completion::Exited(status)
                            if status.code()
                                == Some(crate::helper::OPERATION_TIMEOUT_EXIT_CODE) =>
                        {
                            Some(response::Code::Timeout)
                        }
                        management::Completion::Exited(status)
                            if status.code() == Some(crate::helper::OUTPUT_TOO_LARGE_EXIT_CODE) =>
                        {
                            Some(response::Code::TooLarge)
                        }
                        management::Completion::TimedOut
                        | management::Completion::OutputCloseTimeout => {
                            Some(response::Code::Timeout)
                        }
                        management::Completion::OutputOverflow => Some(response::Code::TooLarge),
                        management::Completion::Cancelled => Some(response::Code::Cancelled),
                        _ => Some(response::Code::BackendFailed),
                    };
                    if pending.operation == management::OperationName::Cover {
                        let backend = self.session.backend_mut();
                        let request = backend.cover_pending.take().expect("cover request");
                        let result = if let Some(code) = code {
                            crate::bridge::Event::Failure {
                                request_id: pending.request_id,
                                code,
                            }
                        } else {
                            let hash = pending
                                .value
                                .as_ref()
                                .and_then(|value| value.get("sha256"))
                                .and_then(serde_json::Value::as_str)
                                .and_then(crate::cover::parse_digest);
                            let result = hash
                                .ok_or(crate::cover::Error::BackendFailed)
                                .and_then(|hash| {
                                    backend.cover_cache.insert(
                                        &request.host,
                                        request.app,
                                        request.offset,
                                        pending.cover_bytes,
                                        hash,
                                    )
                                })
                                .and_then(|()| {
                                    backend.cover_cache.chunk(
                                        &request.host,
                                        request.app,
                                        request.offset,
                                    )
                                })
                                .and_then(|value| value.ok_or(crate::cover::Error::BackendFailed));
                            match result {
                                Ok(value) => crate::bridge::Event::Result {
                                    request_id: pending.request_id,
                                    operation: management::OperationName::Cover,
                                    value,
                                },
                                Err(error) => crate::bridge::Event::Failure {
                                    request_id: pending.request_id,
                                    code: match error {
                                        crate::cover::Error::InvalidRequest => {
                                            response::Code::InvalidRequest
                                        }
                                        crate::cover::Error::TooLarge => response::Code::TooLarge,
                                        crate::cover::Error::BackendFailed => {
                                            response::Code::BackendFailed
                                        }
                                    },
                                },
                            }
                        };
                        return Ok(Some(Event::Management(result)));
                    }
                    if let Some(start) = self.session.backend_mut().preflight.take() {
                        let request_id = start.request_id;
                        if let Some(code) = code {
                            self.session.backend_mut().starting = false;
                            self.session.backend_mut().start_id = None;
                            self.session.stream_stopped().map_err(Error::Session)?;
                            return Ok(Some(Event::Management(crate::bridge::Event::Failure {
                                request_id,
                                code,
                            })));
                        }
                        return match self.session.backend_mut().prepare_stream(start) {
                            Ok(descriptor) => Ok(Some(Event::Stream {
                                request_id,
                                descriptor,
                            })),
                            Err(_) => {
                                self.session.backend_mut().starting = false;
                                self.session.backend_mut().start_id = None;
                                self.session.stream_stopped().map_err(Error::Session)?;
                                Ok(Some(Event::Management(crate::bridge::Event::Failure {
                                    request_id,
                                    code: response::Code::BackendFailed,
                                })))
                            }
                        };
                    }
                    let event = if let Some(code) = code {
                        crate::bridge::Event::Failure {
                            request_id: pending.request_id,
                            code,
                        }
                    } else {
                        crate::bridge::Event::Result {
                            request_id: pending.request_id,
                            operation: pending.operation,
                            value: pending.value.expect("validated result"),
                        }
                    };
                    return Ok(Some(Event::Management(event)));
                }
            }
        }
        let backend = self.session.backend_mut();
        if let Some(relay) = &mut backend.relay {
            match relay.poll(now) {
                Ok(Some(relay::Event::Connected)) => {
                    backend.starting = false;
                    return Ok(Some(Event::Connected));
                }
                Ok(Some(relay::Event::Rumble(rumble))) => return Ok(Some(Event::Rumble(rumble))),
                Ok(Some(relay::Event::Stopped)) => {
                    let id = backend.stopping.take().filter(|id| *id != 0);
                    backend.relay = None;
                    backend.start_id = None;
                    self.session.stream_stopped().map_err(Error::Session)?;
                    return Ok(Some(Event::Stopped { request_id: id }));
                }
                Ok(None) => {}
                Err(error @ relay::Error::Cleanup(_)) => return Err(Error::Relay(error)),
                Err(error) => {
                    let start_id = backend.start_id.expect("owned stream request");
                    let (code, message) = match error {
                        relay::Error::Udp(crate::udp_endpoint::Error::Timeout) => (
                            response::StreamFailureCode::Timeout,
                            "UDP video startup timed out",
                        ),
                        relay::Error::Timeout
                        | relay::Error::Listener(crate::listener::Error::Timeout) => (
                            response::StreamFailureCode::Timeout,
                            "Video stream timed out",
                        ),
                        _ => (
                            response::StreamFailureCode::BackendFailed,
                            "Video stream failed",
                        ),
                    };
                    backend.starting = false;
                    if backend.stopping.is_some() {
                        relay.stop();
                    }
                    return Ok(Some(Event::StreamFailed {
                        start_id,
                        code,
                        message,
                    }));
                }
            }
        }
        Ok(None)
    }
    fn fail_management(&mut self, code: response::Code) -> Result<Option<Event>, Error> {
        self.session
            .backend_mut()
            .management
            .cancel()
            .map_err(Error::Management)?;
        let request_id = self
            .management_output
            .take()
            .expect("management output")
            .request_id;
        if self.session.backend_mut().preflight.take().is_some() {
            self.session.backend_mut().starting = false;
            self.session.backend_mut().start_id = None;
            self.session.stream_stopped().map_err(Error::Session)?;
        }
        Ok(Some(Event::Management(crate::bridge::Event::Failure {
            request_id,
            code,
        })))
    }
    pub fn close(&mut self) -> Result<(), Error> {
        self.session.close().map_err(Error::Session)?;
        self.management_output = None;
        Ok(())
    }
}
