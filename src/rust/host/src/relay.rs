use crate::{
    Codec, Operation, StreamOptions, Transport,
    ack::Mode,
    assemble::{self, Pcm, Video},
    channel,
    helper::{self, Helper, Output, Status, Stream},
    input, listener, status,
    stream::{Channels, StreamProcess},
};
use std::{
    collections::VecDeque,
    io::{self, Read},
    net::{IpAddr, SocketAddr},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;

#[path = "video_read.rs"]
mod video_read;

const MEDIA_CLOSE_CONTROL_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub enum Error {
    Invalid,
    Listener(listener::Error),
    Process(helper::StartError),
    Channel(channel::Error),
    Udp(crate::udp_endpoint::Error),
    UdpFeedback(crate::udp_feedback::Error),
    Input(input::Error),
    Media(assemble::Error),
    Status(status::Error),
    Io(io::Error),
    Cleanup(Box<Error>),
    ProcessFailed,
    Timeout,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Event {
    Connected,
    Stopped,
    Rumble(Rumble),
    /// The PC's Sunshine takes no touch; reported once per stream.
    TouchUnsupported,
}

/// Players the client rumbles (1 to 8 as controllers 0 to 7).
pub const RUMBLE_PLAYERS: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rumble {
    pub controller: u8,
    pub low: u16,
    pub high: u16,
}

/// Reads a worker `{"event":"touch","supported":false}` status line.
fn touch_unsupported(value: &serde_json::Value) -> bool {
    value.get("event").and_then(|v| v.as_str()) == Some("touch")
        && value.get("supported").and_then(|v| v.as_bool()) == Some(false)
}

impl Rumble {
    /// Reads a worker `{"event":"rumble","controller":N,"low":L,"high":H}` status line.
    pub fn parse(value: &serde_json::Value) -> Option<Self> {
        if value.get("event")?.as_str()? != "rumble" {
            return None;
        }
        let field = |key| value.get(key)?.as_u64();
        let controller = u8::try_from(field("controller")?).ok()?;
        if usize::from(controller) >= RUMBLE_PLAYERS {
            return None;
        }
        Some(Self {
            controller,
            low: u16::try_from(field("low")?).ok()?,
            high: u16::try_from(field("high")?).ok()?,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TouchNote {
    Unknown,
    Pending,
    Sent,
}

/// Latest rumble per controller, in arrival order; a newer value replaces a queued one.
fn queue_rumble(queue: &mut VecDeque<Rumble>, rumble: Rumble) {
    match queue
        .iter_mut()
        .find(|queued| queued.controller == rumble.controller)
    {
        Some(queued) => *queued = rumble,
        None => queue.push_back(rumble),
    }
}

pub struct Config {
    pub bind: IpAddr,
    pub peer: IpAddr,
    pub host: String,
    pub app: String,
    pub options: StreamOptions,
    pub video_token: [u8; 64],
    pub audio_token: Option<[u8; 64]>,
    pub udp_token: Option<[u8; 64]>,
    pub deadline: Instant,
}

pub struct Relay {
    helper: Helper,
    host: String,
    app: String,
    options: StreamOptions,
    video_listener: listener::Listener,
    audio_listener: Option<listener::Listener>,
    video_channel: Option<channel::Channel>,
    udp: Option<crate::udp_endpoint::Endpoint>,
    udp_feedback: Option<crate::udp_feedback::Feedback>,
    udp_end_started: bool,
    audio_channel: Option<channel::Channel>,
    video_read: Option<UnixStream>,
    audio_read: Option<UnixStream>,
    process: Option<StreamProcess>,
    video: Video,
    video_queue: crate::video_queue::Queue,
    av1: crate::av1::Keyframes,
    current_keyframe: Option<bool>,
    idr_pending: bool,
    last_idr_sent: Option<Instant>,
    last_idr_requested: Option<Instant>,
    idr_inflight: bool,
    video_window: crate::window::VideoWindow,
    window_updated: Instant,
    video_sent: VecDeque<(u32, Instant)>,
    udp_keyframes: Vec<u32>,
    pcm: Pcm,
    statuses: status::Lines,
    status_bytes: Vec<u8>,
    status_offset: usize,
    input: input::Forwarder,
    pending_input: VecDeque<Vec<u8>>,
    rumble: VecDeque<Rumble>,
    touch_note: TouchNote,
    input_inflight: bool,
    stopping: bool,
    stop_started: bool,
    connected: bool,
    finished: bool,
    child_exited: bool,
    status_ended: bool,
    early_stopped: bool,
    shutdown_deadline: Option<Instant>,
    media_abandoned: bool,
    await_stop_request: bool,
    stop_request_deadline: Option<Instant>,
    video_budget_exhausted: bool,
    video_readable: bool,
    telemetry: Option<crate::telemetry::Producer>,
}

impl Relay {
    pub(crate) fn request_idr(&mut self, now: Instant) -> bool {
        if self.stopping
            || self.finished
            || self.idr_pending
            || self.idr_inflight
            || self.last_idr_requested.is_some_and(|last| {
                now.saturating_duration_since(last) < Duration::from_millis(500)
            })
        {
            return false;
        }
        self.last_idr_requested = Some(now);
        self.idr_pending = true;
        true
    }

    pub fn prepare(helper: Helper, config: Config) -> Result<Self, Error> {
        let Config {
            bind,
            peer,
            host,
            app,
            options,
            video_token,
            audio_token,
            udp_token,
            deadline,
        } = config;
        if !(Operation::Start {
            host: &host,
            app: &app,
            options,
        })
        .valid()
            || audio_token
                .as_ref()
                .is_some_and(|token| bool::from(token.ct_eq(&video_token)))
            || (options.transport == Transport::UdpV1) != udp_token.is_some()
            || udp_token.as_ref().is_some_and(|token| {
                bool::from(token.ct_eq(&video_token))
                    || audio_token
                        .as_ref()
                        .is_some_and(|audio| bool::from(token.ct_eq(audio)))
            })
        {
            return Err(Error::Invalid);
        }
        let address = SocketAddr::new(bind, 0);
        let video_listener = listener::Listener::bind(address, peer, video_token, deadline)
            .map_err(Error::Listener)?;
        let audio_listener = audio_token
            .map(|token| listener::Listener::bind(address, peer, token, deadline))
            .transpose()
            .map_err(Error::Listener)?;
        let now = Instant::now();
        let udp = udp_token
            .map(|token| {
                crate::udp_endpoint::Endpoint::bind(
                    address,
                    peer,
                    token,
                    options.fps,
                    assemble::MAX_VIDEO_BYTES,
                    now,
                    now + Duration::from_secs(8),
                )
            })
            .transpose()
            .map_err(Error::Udp)?;
        Ok(Self {
            helper,
            host,
            app,
            options,
            video_listener,
            audio_listener,
            video_channel: None,
            udp,
            udp_feedback: None,
            udp_end_started: false,
            audio_channel: None,
            video_read: None,
            audio_read: None,
            process: None,
            video: Video::new(),
            video_queue: crate::video_queue::Queue::new(options.fps).expect("validated fps"),
            av1: crate::av1::Keyframes::new(),
            current_keyframe: None,
            idr_pending: false,
            last_idr_sent: None,
            last_idr_requested: None,
            idr_inflight: false,
            video_window: crate::window::VideoWindow::new(options.fps).expect("validated fps"),
            window_updated: Instant::now(),
            video_sent: VecDeque::new(),
            udp_keyframes: Vec::new(),
            pcm: Pcm::new(),
            statuses: status::Lines::new(),
            status_bytes: Vec::new(),
            status_offset: 0,
            input: input::Forwarder::new(),
            pending_input: VecDeque::new(),
            rumble: VecDeque::new(),
            touch_note: TouchNote::Unknown,
            input_inflight: false,
            stopping: false,
            stop_started: false,
            connected: false,
            finished: false,
            child_exited: false,
            status_ended: false,
            early_stopped: false,
            shutdown_deadline: None,
            media_abandoned: false,
            await_stop_request: false,
            stop_request_deadline: None,
            video_budget_exhausted: false,
            video_readable: false,
            telemetry: None,
        })
    }
    pub fn video_addr(&self) -> Result<SocketAddr, Error> {
        self.video_listener.local_addr().map_err(Error::Listener)
    }
    pub fn audio_addr(&self) -> Result<Option<SocketAddr>, Error> {
        self.audio_listener
            .as_ref()
            .map(|listener| listener.local_addr().map_err(Error::Listener))
            .transpose()
    }
    pub fn udp_addr(&self) -> Result<Option<SocketAddr>, Error> {
        self.udp
            .as_ref()
            .map(|endpoint| endpoint.local_addr())
            .transpose()
            .map_err(Error::Udp)
    }
    pub fn udp_timing(&self) -> Option<crate::udp_video::Timing> {
        self.udp.as_ref().map(|endpoint| endpoint.timing())
    }
    pub fn poll(&mut self, now: Instant) -> Result<Option<Event>, Error> {
        self.video_budget_exhausted = false;
        self.video_readable = false;
        let result = self.poll_inner(now).and_then(|event| {
            self.video_readable = self.probe_video_readable()?;
            Ok(event)
        });
        if result.is_err()
            && let Err(error) = self.cancel()
        {
            return Err(Error::Cleanup(Box::new(error)));
        }
        result
    }
    pub(crate) fn take_video_readable(&mut self) -> bool {
        std::mem::take(&mut self.video_readable)
    }
    pub(crate) fn enable_telemetry(&mut self, start_id: u32) {
        self.telemetry = Some(crate::telemetry::Producer::new(start_id));
    }
    pub(crate) fn telemetry_allowed(&self) -> bool {
        self.telemetry.is_some()
            && self.connected
            && !self.stopping
            && !self.finished
            && !self.status_ended
            && self.video_read.is_some()
            && self.audio_read.is_some()
    }
    pub(crate) fn telemetry_snapshot(
        &mut self,
        now: Instant,
    ) -> Option<crate::telemetry::Snapshot> {
        if !self.telemetry_allowed() {
            return None;
        }
        self.telemetry.as_mut()?.snapshot(now)
    }
    fn probe_video_readable(&self) -> Result<bool, Error> {
        use std::os::fd::AsRawFd;
        if !self.video_budget_exhausted
            || (!self.media_abandoned
                && self.video.buffered_bytes() == assemble::MAX_BUFFERED_VIDEO_BYTES)
        {
            return Ok(false);
        }
        let Some(reader) = &self.video_read else {
            return Ok(false);
        };
        let mut fd = libc::pollfd {
            fd: reader.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut fd, 1, 0) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            return if error.kind() == io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(Error::Io(error))
            };
        }
        if fd.revents & libc::POLLNVAL != 0 {
            return Err(Error::Io(io::Error::from_raw_os_error(libc::EBADF)));
        }
        Ok(ready > 0 && fd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0)
    }
    fn poll_inner(&mut self, now: Instant) -> Result<Option<Event>, Error> {
        if self.early_stopped {
            self.early_stopped = false;
            return Ok(Some(Event::Stopped));
        }
        if self.finished {
            return Ok(None);
        }
        if self
            .shutdown_deadline
            .is_some_and(|deadline| now >= deadline)
        {
            return Err(Error::Timeout);
        }
        if !self.media_abandoned
            && self.video_channel.is_none()
            && self.udp_feedback.is_none()
            && let Some(socket) = self.video_listener.poll(now).map_err(Error::Listener)?
        {
            if self.udp.is_some() {
                let mut feedback = crate::udp_feedback::Feedback::new(socket).map_err(Error::Io)?;
                feedback
                    .set_window(self.video_window.size())
                    .map_err(Error::UdpFeedback)?;
                self.udp_feedback = Some(feedback);
            } else {
                let mut channel =
                    channel::Channel::new(socket, Mode::VideoInput).map_err(Error::Io)?;
                channel
                    .set_video_window(self.video_window.size())
                    .map_err(Error::Channel)?;
                self.video_channel = Some(channel);
            }
        }
        if !self.media_abandoned
            && self.audio_channel.is_none()
            && let Some(listener) = &mut self.audio_listener
            && let Some(socket) = listener.poll(now).map_err(Error::Listener)?
        {
            self.audio_channel =
                Some(channel::Channel::new(socket, Mode::Audio).map_err(Error::Io)?);
        }
        if let Some(udp) = &mut self.udp {
            let outstanding = self
                .udp_feedback
                .as_ref()
                .is_some_and(|feedback| !feedback.is_idle());
            udp.poll(now, outstanding).map_err(Error::Udp)?;
        }
        if self.process.is_none() {
            if (self.video_channel.is_none() && self.udp_feedback.is_none())
                || self
                    .udp
                    .as_ref()
                    .is_some_and(|endpoint| endpoint.peer().is_none())
                || (self.audio_listener.is_some() && self.audio_channel.is_none())
            {
                return Ok(None);
            }
            let (video_read, video_write) = UnixStream::pair().map_err(Error::Io)?;
            video_read.set_nonblocking(true).map_err(Error::Io)?;
            let audio = if self.audio_listener.is_some() {
                Some(UnixStream::pair().map_err(Error::Io)?)
            } else {
                None
            };
            if let Some((reader, _)) = &audio {
                reader.set_nonblocking(true).map_err(Error::Io)?;
            }
            let audio_fd = audio
                .as_ref()
                .map(|(_, writer)| writer.try_clone().map(Into::into))
                .transpose()
                .map_err(Error::Io)?;
            let process = self
                .helper
                .start_stream(
                    &self.host,
                    &self.app,
                    self.options,
                    Channels {
                        video: video_write.into(),
                        audio: audio_fd,
                    },
                )
                .map_err(Error::Process)?;
            self.video_read = Some(video_read);
            self.audio_read = audio.map(|(reader, _)| reader);
            self.process = Some(process);
        }
        self.drain_input(now)?;
        if let Some(event) = self.read_status(now)? {
            return Ok(Some(event));
        }
        self.read_media()?;
        if !self.media_abandoned {
            let video_result = if self.udp.is_some() {
                self.pump_udp_video(now)
            } else {
                self.pump_video(now)
            };
            if let Err(error) = video_result {
                if Self::is_media_disconnect(&error) {
                    self.abandon_media(now);
                } else {
                    return Err(error);
                }
            }
            if !self.media_abandoned
                && let Err(error) = self.pump_audio()
            {
                if Self::is_media_disconnect(&error) {
                    self.abandon_media(now);
                } else {
                    return Err(error);
                }
            }
        }
        match self
            .process
            .as_mut()
            .expect("started")
            .poll(now)
            .map_err(Error::Io)?
        {
            Status::Running => {}
            Status::Exited(code) if self.stop_started && code.success() => self.child_exited = true,
            _ => return Err(Error::ProcessFailed),
        }
        if self.await_stop_request
            && self
                .stop_request_deadline
                .is_some_and(|deadline| now >= deadline)
        {
            self.await_stop_request = false;
        }
        if self.child_exited
            && self.status_ended
            && self.video_read.is_none()
            && self.audio_read.is_none()
            && (self.media_abandoned
                || (matches!(self.video.peek(), Err(assemble::Error::Ended))
                    && self.video_queue.is_empty()
                    && (self.audio_channel.is_none()
                        || matches!(self.pcm.peek(), Err(assemble::Error::Ended)))
                    && (self
                        .video_channel
                        .as_ref()
                        .is_some_and(channel::Channel::is_idle)
                        || (self
                            .udp_feedback
                            .as_ref()
                            .is_some_and(crate::udp_feedback::Feedback::is_idle)
                            && self.udp.as_ref().is_some_and(|udp| udp.ended(now))))
                    && self
                        .audio_channel
                        .as_ref()
                        .is_none_or(channel::Channel::is_idle)))
        {
            self.shutdown_deadline = None;
            if self.await_stop_request {
                return Ok(None);
            }
            self.finished = true;
            return Ok(Some(Event::Stopped));
        }
        if self.stopping {
            self.rumble.clear();
            return Ok(None);
        }
        if self.touch_note == TouchNote::Pending {
            self.touch_note = TouchNote::Sent;
            return Ok(Some(Event::TouchUnsupported));
        }
        Ok(self.rumble.pop_front().map(Event::Rumble))
    }
    pub fn stop(&mut self) {
        self.await_stop_request = false;
        self.stop_request_deadline = None;
        self.begin_stop();
    }
    fn begin_stop(&mut self) {
        if self.finished {
            self.early_stopped = true;
            return;
        }
        if !self.stopping {
            self.idr_pending = false;
            if self.process.is_none() {
                let _ = self.cancel();
                self.early_stopped = true;
                return;
            }
            self.stopping = true;
            self.shutdown_deadline = Some(Instant::now() + Duration::from_secs(10));
            let output = self.input.release();
            self.pending_input.extend(output.lines);
        }
    }

    fn abandon_media(&mut self, now: Instant) {
        let unsolicited = !self.stopping;
        self.media_abandoned = true;
        self.video_channel = None;
        self.udp_feedback = None;
        self.udp = None;
        self.audio_channel = None;
        if unsolicited {
            self.await_stop_request = true;
            self.stop_request_deadline = Some(now + MEDIA_CLOSE_CONTROL_GRACE);
        }
        self.begin_stop();
    }

    fn is_media_disconnect(error: &Error) -> bool {
        match error {
            Error::Channel(
                channel::Error::Closed | channel::Error::Ack(crate::ack::Error::Truncated),
            ) => true,
            Error::Channel(channel::Error::Io(error)) => matches!(
                error.kind(),
                io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::NotConnected
                    | io::ErrorKind::TimedOut
                    | io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::WriteZero
            ),
            Error::UdpFeedback(crate::udp_feedback::Error::Closed) => true,
            Error::UdpFeedback(crate::udp_feedback::Error::Io(error)) => matches!(
                error.kind(),
                io::ErrorKind::BrokenPipe
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::NotConnected
                    | io::ErrorKind::TimedOut
                    | io::ErrorKind::UnexpectedEof
            ),
            _ => false,
        }
    }
    pub fn cancel(&mut self) -> Result<(), Error> {
        if let Some(process) = &mut self.process {
            process.cancel().map_err(Error::Io)?;
        }
        self.video_listener.close();
        if let Some(listener) = &mut self.audio_listener {
            listener.close();
        }
        self.video_read = None;
        self.audio_read = None;
        self.video_channel = None;
        self.udp_feedback = None;
        self.udp = None;
        self.audio_channel = None;
        self.finished = true;
        Ok(())
    }

    fn drain_input(&mut self, now: Instant) -> Result<(), Error> {
        let process = self.process.as_mut().expect("started");
        if self.input_inflight {
            if !process.flush_input().map_err(Error::Io)? {
                return Ok(());
            }
            self.input_inflight = false;
            if self.idr_inflight {
                self.idr_inflight = false;
                self.last_idr_sent = Some(now);
            }
        }
        if self.pending_input.is_empty()
            && self.idr_pending
            && !self.stopping
            && self.last_idr_sent.is_none_or(|last| {
                now.saturating_duration_since(last) >= Duration::from_millis(500)
            })
        {
            self.pending_input
                .push_back(br#"{"type":"request-idr"}"#.to_vec());
            self.idr_pending = false;
        }
        if let Some(line) = self.pending_input.pop_front() {
            self.idr_inflight = line == br#"{"type":"request-idr"}"#;
            process.queue_input(&line).map_err(Error::Io)?;
            self.input_inflight = true;
            if process.flush_input().map_err(Error::Io)? {
                self.input_inflight = false;
                if self.idr_inflight {
                    self.idr_inflight = false;
                    self.last_idr_sent = Some(now);
                }
            }
        }
        if self.stopping
            && !self.input_inflight
            && self.pending_input.is_empty()
            && !self.stop_started
        {
            process.begin_stop(now);
            self.stop_started = true;
        }
        Ok(())
    }
    fn read_status(&mut self, now: Instant) -> Result<Option<Event>, Error> {
        if self.status_offset == self.status_bytes.len() {
            self.status_bytes.clear();
            self.status_offset = 0;
            if let Ok(output) = self.process.as_ref().expect("started").output() {
                match output {
                    Output::Data(Stream::Stderr, bytes) => self.status_bytes = bytes,
                    Output::End(Stream::Stderr) => {
                        self.statuses.end().map_err(Error::Status)?;
                        self.video.end_metadata();
                        self.status_ended = true;
                    }
                    Output::ReadError(_, error) => return Err(Error::Io(error)),
                    _ => {}
                }
            }
        }
        if self.status_offset < self.status_bytes.len() {
            self.status_offset += self
                .statuses
                .feed(&self.status_bytes[self.status_offset..])
                .map_err(Error::Status)?;
        }
        if let Some(event) = self.statuses.peek().map_err(Error::Status)? {
            if self.connected
                && !self.stopping
                && !self.status_ended
                && let Some(observation) = self.statuses.telemetry_observation()
                && let Some(telemetry) = &mut self.telemetry
            {
                telemetry.observe(observation, now);
            }
            self.statuses.consume().map_err(Error::Status)?;
            match event {
                status::Event::AccessUnit(meta) if !self.media_abandoned => {
                    self.video.announce(meta).map_err(Error::Media)?
                }
                status::Event::AccessUnit(_) => {}
                status::Event::Status(value) => {
                    if value.get("event").and_then(|v| v.as_str()) == Some("video") {
                        let expected = match self.options.codec {
                            Codec::H264 => "h264",
                            Codec::Hevc => "hevc",
                            Codec::Av1 => "av1",
                        };
                        if value.get("codec").and_then(|v| v.as_str()) != Some(expected) {
                            return Err(Error::Invalid);
                        }
                    }
                    if value.get("event").and_then(|v| v.as_str()) == Some("connected")
                        && !self.connected
                    {
                        self.process.as_mut().expect("started").connected();
                        self.connected = true;
                        return Ok(Some(Event::Connected));
                    }
                    if self.connected
                        && !self.stopping
                        && let Some(rumble) = Rumble::parse(&value)
                    {
                        queue_rumble(&mut self.rumble, rumble);
                    }
                    if self.touch_note == TouchNote::Unknown && touch_unsupported(&value) {
                        self.touch_note = TouchNote::Pending;
                    }
                    if value.get("event").and_then(|v| v.as_str()) == Some("terminated")
                        && !self.stop_started
                    {
                        self.stopping = true;
                        self.rumble.clear();
                        self.shutdown_deadline = Some(Instant::now() + Duration::from_secs(10));
                        self.pending_input.clear();
                        self.input_inflight = false;
                        self.process
                            .as_mut()
                            .expect("started")
                            .begin_stop(Instant::now());
                        self.stop_started = true;
                    }
                }
                status::Event::NonJson => {}
            }
        }
        Ok(None)
    }
    fn read_media(&mut self) -> Result<(), Error> {
        if let Some(reader) = &mut self.video_read {
            let turn = video_read::read_turn(reader, &mut self.video, self.media_abandoned)
                .map_err(|error| match error {
                    video_read::Error::Io(error) => Error::Io(error),
                    video_read::Error::Media(error) => Error::Media(error),
                })?;
            self.video_budget_exhausted = turn.exhausted;
            if turn.eof {
                self.video_read = None;
            }
        }
        if let Some(reader) = &mut self.audio_read {
            let mut bytes = [0; 8192];
            match reader.read(&mut bytes) {
                Ok(0) => {
                    self.audio_read = None;
                    self.pcm.end();
                }
                Ok(count) if !self.media_abandoned => {
                    self.pcm.feed(&bytes[..count]).map_err(Error::Media)?;
                }
                Ok(_) => {}
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(Error::Io(error)),
            }
        }
        Ok(())
    }
    fn queue_video(&mut self, now: Instant) -> Result<(), Error> {
        if let Some(record) = self
            .video
            .peek()
            .or_else(|error| {
                if error == assemble::Error::Ended {
                    Ok(None)
                } else {
                    Err(error)
                }
            })
            .map_err(Error::Media)?
        {
            let keyframe = match self.current_keyframe {
                Some(keyframe) => keyframe,
                None => {
                    let keyframe = if self.options.codec == Codec::Av1 {
                        self.av1
                            .classify(record.payload)
                            .map_err(|_| Error::Invalid)?
                    } else {
                        record.keyframe
                    };
                    self.current_keyframe = Some(keyframe);
                    keyframe
                }
            };
            match self
                .video_queue
                .offer(record.header, keyframe, record.payload, now)
            {
                crate::video_queue::Outcome::Accepted { request_idr }
                | crate::video_queue::Outcome::Dropped { request_idr } => {
                    self.idr_pending |= request_idr;
                    self.video.consume().map_err(Error::Media)?;
                    self.current_keyframe = None;
                }
                crate::video_queue::Outcome::Full { request_idr } => {
                    self.idr_pending |= request_idr
                }
            }
        }
        Ok(())
    }
    fn pump_video(&mut self, now: Instant) -> Result<(), Error> {
        self.queue_video(now)?;
        let channel = self.video_channel.as_mut().expect("video channel");
        if now.saturating_duration_since(self.window_updated) >= Duration::from_secs(1) {
            channel
                .set_video_window(self.video_window.adapt())
                .map_err(Error::Channel)?;
            self.window_updated = now;
        }
        if let Some(unit) = self.video_queue.front() {
            match channel.queue(unit.header, &unit.payload) {
                Ok(()) => {
                    self.video_sent.push_back((unit.header.sequence, now));
                    self.video_queue.sent(now);
                }
                Err(channel::Error::Busy) => {}
                Err(error) => return Err(Error::Channel(error)),
            }
        }
        channel.pump().map_err(Error::Channel)?;
        if (self.stopping || (self.pending_input.is_empty() && !self.input_inflight))
            && let Some(ack) = channel.ack().map_err(Error::Channel)?
        {
            let (sequence, sent) = self.video_sent.pop_front().ok_or(Error::Invalid)?;
            if sequence != ack.header.sequence {
                return Err(Error::Invalid);
            }
            self.video_window
                .sample(now.saturating_duration_since(sent));
            self.video_queue.acknowledged(ack.header.sequence, now);
            if !self.stopping && !ack.input.is_empty() {
                let output = self.input.apply(ack.input).map_err(Error::Input)?;
                self.pending_input.extend(output.lines);
                if output.stop {
                    self.pending_input.extend(self.input.release().lines);
                    self.stopping = true;
                    self.shutdown_deadline = Some(Instant::now() + Duration::from_secs(10));
                }
            }
            channel.consume_ack().map_err(Error::Channel)?;
        }
        Ok(())
    }
    fn pump_udp_video(&mut self, now: Instant) -> Result<(), Error> {
        self.queue_video(now)?;
        let feedback = self.udp_feedback.as_mut().expect("UDP feedback");
        if now.saturating_duration_since(self.window_updated) >= Duration::from_secs(1) {
            feedback
                .set_window(self.video_window.adapt())
                .map_err(Error::UdpFeedback)?;
            self.window_updated = now;
        }
        feedback.pump().map_err(Error::UdpFeedback)?;
        if (self.stopping || (self.pending_input.is_empty() && !self.input_inflight))
            && let Some(event) = feedback.event().map_err(Error::UdpFeedback)?.cloned()
        {
            let (frame, header, input, lost, acknowledged) = match event {
                crate::udp_control::Event::Ack {
                    frame,
                    header,
                    input,
                } => (frame, header, input, false, true),
                crate::udp_control::Event::Dropped {
                    frame,
                    header,
                    reason,
                } => {
                    let lost = reason == crate::udp_control::DropReason::Late
                        || self
                            .video_sent
                            .iter()
                            .any(|(sent_frame, _)| *sent_frame == frame)
                            && self.udp_keyframes.contains(&frame);
                    (frame, header, Vec::new(), lost, false)
                }
            };
            let index = self
                .video_sent
                .iter()
                .position(|(sent_frame, _)| *sent_frame == frame)
                .ok_or(Error::Invalid)?;
            let (_, sent) = self.video_sent.remove(index).expect("known UDP frame");
            self.udp_keyframes.retain(|key| *key != frame);
            if lost {
                self.idr_pending |= self.video_queue.lost(header.sequence, now);
            } else if acknowledged {
                self.video_window
                    .sample(now.saturating_duration_since(sent));
                self.video_queue.acknowledged(header.sequence, now);
            }
            if !self.stopping && !input.is_empty() {
                let output = self.input.apply(&input).map_err(Error::Input)?;
                self.pending_input.extend(output.lines);
                if output.stop {
                    self.pending_input.extend(self.input.release().lines);
                    self.stopping = true;
                    self.shutdown_deadline = Some(Instant::now() + Duration::from_secs(10));
                }
            }
            feedback.consume().map_err(Error::UdpFeedback)?;
        }
        if feedback.can_send()
            && let Some(unit) = self.video_queue.front()
        {
            let frame = self
                .udp
                .as_mut()
                .expect("UDP endpoint")
                .send(
                    crate::udp_video::Unit {
                        sequence: unit.header.sequence,
                        pts_us: unit.header.pts_us,
                        keyframe: unit.keyframe,
                        data: &unit.payload,
                    },
                    now,
                )
                .map_err(Error::Udp)?;
            feedback
                .expect(frame, unit.header)
                .map_err(Error::UdpFeedback)?;
            self.video_sent.push_back((frame, now));
            if unit.keyframe {
                self.udp_keyframes.push(frame);
            }
            self.video_queue.sent(now);
        }
        if self.child_exited
            && self.status_ended
            && self.video_read.is_none()
            && matches!(self.video.peek(), Err(assemble::Error::Ended))
            && self.video_queue.is_empty()
        {
            let udp = self.udp.as_mut().expect("UDP endpoint");
            if !self.udp_end_started {
                udp.begin_end(now, feedback.is_idle()).map_err(Error::Udp)?;
                self.udp_end_started = true;
            } else if feedback.is_idle() {
                udp.settle_end();
            }
        }
        Ok(())
    }
    fn pump_audio(&mut self) -> Result<(), Error> {
        let Some(channel) = &mut self.audio_channel else {
            return Ok(());
        };
        if let Some((header, payload)) = self
            .pcm
            .peek()
            .or_else(|error| {
                if error == assemble::Error::Ended {
                    Ok(None)
                } else {
                    Err(error)
                }
            })
            .map_err(Error::Media)?
        {
            match channel.queue(header, payload) {
                Ok(()) => self.pcm.consume().map_err(Error::Media)?,
                Err(channel::Error::Busy) => {}
                Err(error) => return Err(Error::Channel(error)),
            }
        }
        channel.pump().map_err(Error::Channel)?;
        if channel.ack().map_err(Error::Channel)?.is_some() {
            channel.consume_ack().map_err(Error::Channel)?;
        }
        Ok(())
    }
}

pub fn media_deadline(now: Instant) -> Instant {
    now + Duration::from_secs(15)
}

#[cfg(test)]
mod rumble_tests {
    use super::{Rumble, VecDeque, queue_rumble, touch_unsupported};
    use serde_json::json;

    #[test]
    fn parses_worker_rumble_lines() {
        let line = json!({"event":"rumble","controller":1,"low":65535,"high":0});
        assert_eq!(
            Rumble::parse(&line),
            Some(Rumble {
                controller: 1,
                low: 65535,
                high: 0
            })
        );
        for bad in [
            json!({"event":"rumble","controller":8,"low":1,"high":1}),
            json!({"event":"rumble","controller":0,"low":65536,"high":1}),
            json!({"event":"rumble","controller":0,"low":1}),
            json!({"event":"connected"}),
        ] {
            assert_eq!(Rumble::parse(&bad), None);
        }
    }

    #[test]
    fn only_a_refused_touch_line_raises_the_touch_note() {
        assert!(touch_unsupported(
            &json!({"event":"touch","supported":false})
        ));
        for other in [
            json!({"event":"touch","supported":true}),
            json!({"event":"touch"}),
            json!({"event":"rumble","supported":false}),
        ] {
            assert!(!touch_unsupported(&other));
        }
    }

    #[test]
    fn a_peer_timeout_is_a_media_disconnect() {
        use crate::{channel, relay::Error, relay::Relay, udp_feedback};
        let timed_out = || std::io::Error::from(std::io::ErrorKind::TimedOut);
        assert!(Relay::is_media_disconnect(&Error::Channel(
            channel::Error::Io(timed_out())
        )));
        assert!(Relay::is_media_disconnect(&Error::UdpFeedback(
            udp_feedback::Error::Io(timed_out())
        )));
        assert!(!Relay::is_media_disconnect(&Error::Io(timed_out())));
    }

    #[test]
    fn queued_rumble_keeps_the_latest_per_controller() {
        let mut queue = VecDeque::new();
        let rumble = |controller, low| Rumble {
            controller,
            low,
            high: 0,
        };
        queue_rumble(&mut queue, rumble(0, 1));
        queue_rumble(&mut queue, rumble(1, 2));
        queue_rumble(&mut queue, rumble(0, 0));
        assert_eq!(queue, [rumble(0, 0), rumble(1, 2)]);
    }
}
