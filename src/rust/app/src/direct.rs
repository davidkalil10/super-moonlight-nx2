//! The control-v1 link answered on the console itself: list, pair, unpair, quit and covers go
//! straight to Sunshine, and start launches the app and runs its RTSP and control handshakes.
//! Once control is up the start answers with a stream frame and the runtime opens media from
//! the live session.
//! Design: moonlight-nx2-dev/src/rust/sunshine/README.md.

extern crate alloc;

use alloc::{boxed::Box, collections::VecDeque, format, string::String, sync::Arc, vec::Vec};

use moonlight_nx2_core::control::{Frame, Header, Kind};
use moonlight_nx2_io::{
    socket::{IoError, Socket},
    udp::Datagram,
};
use moonlight_nx2_sunshine::{
    HTTP_PORT, HTTPS_PORT, WEB_UI_PORT, apps,
    control::HostEvent,
    control_stream::{self, ControlStream},
    exchange::{self, Exchange},
    hex, http,
    identity::Identity,
    launch,
    pairing::{self, Pairing, Stage},
    random::Random,
    rtsp::{self, Handshake},
    serverinfo::{self, ServerInfo},
    stream::{Codec, Negotiated, Request as StreamRequest, StreamKey},
    tls,
};
use moonlight_nx2_ui::{
    model::{Address, MAX_APPS},
    store::Files,
};

use crate::{
    covers,
    direct_input::DirectInput,
    direct_stream::Live,
    direct_keys::{self, Keys},
    json,
    link::{Link, LinkError},
    request::DEFAULT_PAIR_TIMEOUT_S,
};

/// Opens connections and supplies randomness for the direct link.
pub trait Dial {
    type Socket: Socket;
    fn dial(&mut self, address: [u8; 4], port: u16) -> Result<Self::Socket, IoError>;
    fn random(&self) -> Random;
    /// The name Sunshine lists the console under.
    fn device_name(&self) -> String;
    /// A UDP socket connected to `address`, for the stream's control channel.
    fn datagram(&mut self, _address: [u8; 4], _port: u16) -> Result<Box<dyn Datagram>, IoError> {
        Err(IoError::Failed)
    }
    /// A line for the console log.
    fn log(&mut self, _line: &str) {}
    /// A monotonic clock for timing slow steps in the log.
    fn now_ms(&self) -> u64 {
        0
    }
}

impl<D: Dial + ?Sized> Dial for Box<D> {
    type Socket = D::Socket;

    fn dial(&mut self, address: [u8; 4], port: u16) -> Result<Self::Socket, IoError> {
        (**self).dial(address, port)
    }

    fn random(&self) -> Random {
        (**self).random()
    }

    fn device_name(&self) -> String {
        (**self).device_name()
    }

    fn datagram(&mut self, address: [u8; 4], port: u16) -> Result<Box<dyn Datagram>, IoError> {
        (**self).datagram(address, port)
    }

    fn log(&mut self, line: &str) {
        (**self).log(line)
    }

    fn now_ms(&self) -> u64 {
        (**self).now_ms()
    }
}

const REQUEST_MS: u64 = 15_000;
const MAX_REPLY_BYTES: usize = 256 * 1024;
const MAX_QUEUED: usize = 8;
const ANONYMOUS: &str = "0123456789ABCDEF";

const NOT_PAIRED: &str = "Pair with this host first";
const UNREACHABLE: &str = "Sunshine did not answer on this PC";
const CHANGED: &str = "This PC's certificate changed; pair it again";
const KEY_NOT_SAVED: &str = "The console's Sunshine key could not be saved";
const REFUSED: &str = "Sunshine refused the pairing; check the PIN and try again";
const WRONG_PIN: &str = "The PIN typed in Sunshine did not match";
const NO_RANDOM: &str = "The console has no random source";
const OLD_HOST: &str = "This host is too old for direct pairing; update Sunshine";
const NO_APP: &str = "Sunshine has no app with that name";
const OTHER_APP: &str = "Another app is running on this PC; quit it first";
const NO_CONTROL: &str = "Sunshine's control channel did not answer";
const NO_CODEC: &str = "Sunshine offers none of the console's codecs";
const OLD_CONTROL: &str = "This Sunshine cannot encrypt its control stream; update it";
const CONTROL_MS: u64 = 10_000;
const PACKET_SIZE: u16 = 1392;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Job {
    List,
    Pair { timeout_s: u32 },
    Unpair,
    Quit,
    Cover { app: u32, offset: usize },
    Start,
    Stop,
    Idr,
}

/// What a start asked for, kept beside the job.
#[derive(Clone, Debug, Default)]
struct Start {
    app: String,
    width: u16,
    height: u16,
    fps: u16,
    bitrate_kbps: u32,
    codec: Option<Codec>,
    options: launch::Options,
    udp: bool,
    telemetry: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Step {
    PlainInfo,
    SecureInfo,
    AppList,
    Asset,
    Unpair,
    Cancel,
    Pair(Stage),
    Launch { app: u32, resume: bool },
    Rtsp,
    Control,
}

struct Active<S: Socket> {
    id: u32,
    job: Job,
    step: Step,
    exchange: Option<Exchange<S>>,
    info: Option<ServerInfo>,
    pairing: Option<Pairing>,
    start: Option<Start>,
    key: Option<StreamKey>,
    rtsp: Option<Handshake>,
    live: Option<Live>,
    deadline_ms: u64,
}

enum Next {
    Call(Step),
    Reply(Kind, String),
}

pub struct DirectLink<D: Dial> {
    dial: D,
    address: [u8; 4],
    host: Address,
    keys: Keys,
    identity: Option<Identity>,
    config: Option<Arc<rustls::ClientConfig>>,
    uuid: String,
    next_id: u32,
    queue: VecDeque<(u32, Result<(Job, Option<Start>), (&'static str, &'static str)>)>,
    active: Option<Active<D::Socket>>,
    replies: VecDeque<(Kind, u32, Vec<u8>)>,
    cover: Option<(u32, Vec<u8>)>,
    https_port: u16,
    closed: bool,
    apps: Vec<apps::App>,
    live: Option<Live>,
    events: VecDeque<HostEvent>,
}

fn quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn failure(code: &str, message: &str) -> Next {
    Next::Reply(
        Kind::Error,
        format!("{{\"code\":{},\"message\":{}}}", quoted(code), quoted(message)),
    )
}

fn result(op: &str, value: &str) -> Next {
    Next::Reply(
        Kind::Event,
        format!("{{\"event\":\"result\",\"op\":\"{op}\",\"ok\":true,\"value\":{value}}}"),
    )
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let word = u32::from(chunk[0]) << 16
            | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(TABLE[(word >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn url_encoded(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn octets(address: &str) -> Option<[u8; 4]> {
    let mut parts = address.split('.');
    let mut bytes = [0; 4];
    for byte in &mut bytes {
        *byte = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(bytes)
}

fn codec(name: &str) -> Option<Codec> {
    match name {
        "h264" => Some(Codec::H264),
        "hevc" => Some(Codec::Hevc),
        "av1" => Some(Codec::Av1),
        _ => None,
    }
}

fn parse_start(root: json::Value<'_>) -> Option<Start> {
    let app = root.member("app")?.as_plain_str()?;
    let options = root.member("options");
    let number = |key: &str| options.and_then(|options| options.member(key)).and_then(|value| value.as_u64());
    let flag = |key: &str| {
        options
            .and_then(|options| options.member(key))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    };
    let text = |key: &str| options.and_then(|options| options.member(key)).and_then(|value| value.as_plain_str());
    let small = |key: &str, default: u16| {
        number(key).and_then(|value| u16::try_from(value).ok()).filter(|value| *value > 0).unwrap_or(default)
    };
    Some(Start {
        app: String::from(app),
        width: small("width", 1280),
        height: small("height", 720),
        fps: small("fps", 60),
        bitrate_kbps: number("bitrate_kbps")
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
            .unwrap_or(10_000),
        codec: options
            .and_then(|options| options.member("codec"))
            .and_then(|value| value.as_plain_str())
            .and_then(codec),
        options: launch::Options {
            sops: flag("sops"),
            local_audio: flag("local_audio"),
        },
        udp: text("transport") == Some("udp-v1"),
        telemetry: text("telemetry") == Some("upstream-v1"),
    })
}

/// The stream frame the service checks a start against. Media itself opens from the
/// negotiated session, so the tokens only have to be well formed and distinct.
fn handoff(start: &Start, stream: &Negotiated) -> String {
    let codec = match stream.codec {
        Codec::H264 => "h264",
        Codec::Hevc => "hevc",
        Codec::Av1 => "av1",
    };
    let token = |digit: char| core::iter::repeat_n(digit, 64).collect::<String>();
    let video = if start.udp {
        format!(
            "\"transport\":\"udp-v1\",\"udp\":{{\"version\":1,\"port\":{},\"token\":\"{}\",\"fragment_bytes\":1360,\"unit_slots\":8,\"feedback\":\"input-drop-v1\",\"deadline_us\":100000,\"spread_us\":0,\"pace_bytes_per_ms\":1000,\"hello_ms\":1000}},",
            stream.video_port,
            token('2')
        )
    } else {
        String::new()
    };
    let telemetry = if start.telemetry { ",\"telemetry\":\"upstream-v1\"" } else { "" };
    format!(
        "{{\"codec\":\"{codec}\",\"width\":{},\"height\":{},\"fps\":{},\"video\":{{{video}\"port\":{},\"token\":\"{}\",\"max_payload\":{},\"ack\":\"input-v1\"}},\"audio\":{{\"port\":{},\"token\":\"{}\",\"rate\":48000,\"channels\":2,\"format\":\"s16le\",\"chunk_bytes\":1920,\"ack\":\"header\"}}{telemetry}}}",
        stream.width,
        stream.height,
        stream.fps,
        stream.video_port,
        token('0'),
        crate::stream::MAX_VIDEO_PAYLOAD,
        stream.audio_port,
        token('1'),
    )
}

fn codecs(preferred: Option<Codec>) -> &'static [Codec] {
    match preferred {
        Some(Codec::Av1) => &[Codec::Av1, Codec::H264],
        Some(Codec::Hevc) => &[Codec::Hevc, Codec::H264],
        _ => &[Codec::H264],
    }
}

fn parse_request(payload: &[u8]) -> Result<(Job, Option<Start>, Option<Address>), (&'static str, &'static str)> {
    let invalid = ("invalid_request", "Malformed request");
    let root = json::parse(payload).map_err(|_| invalid)?;
    let op = root
        .member("op")
        .and_then(|op| op.as_plain_str())
        .ok_or(invalid)?;
    let host = root.member("host").and_then(|host| host.as_plain_str());
    let number = |key: &str| root.member(key).and_then(|value| value.as_u64());

    let job = match op {
        "list" => Job::List,
        "pair" => Job::Pair {
            timeout_s: number("timeout_seconds")
                .and_then(|seconds| u32::try_from(seconds).ok())
                .filter(|seconds| (1..=600).contains(seconds))
                .unwrap_or(DEFAULT_PAIR_TIMEOUT_S),
        },
        "unpair" => Job::Unpair,
        "quit" => Job::Quit,
        "cover" => Job::Cover {
            app: number("app")
                .and_then(|app| u32::try_from(app).ok())
                .ok_or(invalid)?,
            offset: number("offset")
                .and_then(|offset| usize::try_from(offset).ok())
                .ok_or(invalid)?,
        },
        "start" => {
            let start = parse_start(root).ok_or(invalid)?;
            let host = host.filter(|host| octets(host).is_some()).ok_or(invalid)?;
            return Ok((Job::Start, Some(start), Some(Address::of(host))));
        }
        "stop" => return Ok((Job::Stop, None, None)),
        "idr" => return Ok((Job::Idr, None, None)),
        _ => return Err(("unsupported", "Unsupported operation")),
    };
    let host = host.filter(|host| octets(host).is_some()).ok_or(invalid)?;
    Ok((job, None, Some(Address::of(host))))
}

fn transport_failure(error: &exchange::Error) -> Next {
    match error {
        exchange::Error::TimedOut => failure("timeout", UNREACHABLE),
        exchange::Error::Http(http::Error::TooLarge) => {
            failure("too_large", "The PC's reply was too large")
        }
        exchange::Error::Tls(rustls::Error::InvalidCertificate(_)) => {
            failure("not_paired", CHANGED)
        }
        _ => failure("backend_failed", UNREACHABLE),
    }
}

impl<D: Dial> DirectLink<D> {
    /// A link to the Sunshine host at `host`, with the keys read from `files`.
    pub fn new(dial: D, host: &Address, files: &mut impl Files) -> Option<Self> {
        let address = octets(host.as_str())?;
        let (keys, _) = Keys::load(files);
        let identity = keys
            .identity()
            .and_then(|stored| Identity::from_der(&stored.key, &stored.cert, &stored.uniqueid).ok());
        let uuid = uuid(dial.random())?;
        Some(Self {
            dial,
            address,
            host: *host,
            keys,
            identity,
            config: None,
            uuid,
            next_id: 1,
            queue: VecDeque::new(),
            active: None,
            replies: VecDeque::new(),
            cover: None,
            https_port: HTTPS_PORT,
            closed: false,
            apps: Vec::new(),
            live: None,
            events: VecDeque::new(),
        })
    }

    /// Whether this console holds a pinned certificate for the host.
    pub fn paired(&self) -> bool {
        self.identity.is_some() && self.keys.server(&self.host).is_some()
    }

    pub fn busy(&self) -> bool {
        self.active.is_some() || !self.queue.is_empty()
    }

    /// Drops pending work and closes the open connection.
    pub fn close(&mut self) {
        self.closed = true;
        self.queue.clear();
        if let Some(mut active) = self.active.take() {
            if let Some(exchange) = active.exchange.take() {
                let _ = exchange.close();
            }
            if let Some(live) = active.live.take() {
                live.end(0);
            }
        }
        self.end_live(0);
    }

    /// The stream whose control channel is up, for the media and input paths.
    pub fn live(&mut self) -> Option<&mut Live> {
        self.live.as_mut()
    }

    /// Rumble, motion and other requests the host sent since the last call.
    pub fn take_events(&mut self) -> VecDeque<HostEvent> {
        core::mem::take(&mut self.events)
    }

    fn end_live(&mut self, now_ms: u64) {
        if let Some(live) = self.live.take() {
            live.end(now_ms);
        }
    }

    fn pump_live(&mut self, now_ms: u64) {
        let Some(live) = self.live.as_mut() else {
            return;
        };
        if !live.pump(now_ms, &mut self.events, &mut self.replies) {
            self.live = None;
        }
    }

    /// Moves the current request on; `files` takes new keys after a pairing.
    pub fn pump(&mut self, files: &mut impl Files, now_ms: u64) {
        if self.closed {
            return;
        }
        self.pump_live(now_ms);
        if self.active.is_none() {
            self.begin(now_ms);
        }
        let Some(active) = self.active.as_mut() else {
            return;
        };
        if active.step == Step::Control {
            let next = self.wait_control(now_ms);
            if let Some(next) = next {
                self.go(next, now_ms);
            }
            return;
        }
        let Some(exchange) = active.exchange.as_mut() else {
            return;
        };
        let Some(outcome) = exchange.poll(now_ms) else {
            return;
        };
        let exchange = active.exchange.take().expect("exchange");
        let _ = exchange.close();
        let step = active.step;
        let next = self.advance(step, outcome, files, now_ms);
        self.go(next, now_ms);
    }

    fn begin(&mut self, now_ms: u64) {
        let Some((id, job)) = self.queue.pop_front() else {
            return;
        };
        let (job, start) = match job {
            Ok(job) => job,
            Err((code, message)) => {
                if let Next::Reply(kind, payload) = failure(code, message) {
                    self.replies.push_back((kind, id, payload.into_bytes()));
                }
                return;
            }
        };
        self.active = Some(Active {
            id,
            job,
            step: Step::PlainInfo,
            exchange: None,
            info: None,
            pairing: None,
            start,
            key: None,
            rtsp: None,
            live: None,
            deadline_ms: 0,
        });

        let first = match job {
            Job::List | Job::Pair { .. } => Next::Call(Step::PlainInfo),
            Job::Quit if self.paired() => {
                self.end_live(now_ms);
                Next::Call(Step::Cancel)
            }
            Job::Quit => Next::Call(Step::PlainInfo),
            Job::Unpair => Next::Call(Step::Unpair),
            Job::Cover { app, offset } => match &self.cover {
                Some((cached, png)) if *cached == app => self.cover_chunk(app, png, offset),
                _ if !self.paired() => failure("not_paired", NOT_PAIRED),
                _ => Next::Call(Step::Asset),
            },
            Job::Start if !self.paired() => failure("not_paired", NOT_PAIRED),
            Job::Start if self.live.is_some() => failure("invalid_state", "A stream is already running"),
            Job::Start => Next::Call(Step::SecureInfo),
            Job::Stop if self.live.is_some() => {
                self.end_live(now_ms);
                result("stop", "{\"event\":\"stopped\"}")
            }
            Job::Stop => failure("invalid_state", "No stream is running"),
            Job::Idr => match self.live.as_mut() {
                Some(live) => {
                    let queued = live.request_idr(now_ms).is_ok();
                    result("idr", &format!("{{\"event\":\"idr\",\"queued\":{queued}}}"))
                }
                None => failure("invalid_state", "No stream is running"),
            },
        };
        self.go(first, now_ms);
    }

    fn go(&mut self, next: Next, now_ms: u64) {
        let Some(active) = self.active.as_mut() else {
            return;
        };
        let id = active.id;
        match next {
            Next::Reply(kind, payload) => {
                self.replies.push_back((kind, id, payload.into_bytes()));
                self.active = None;
            }
            Next::Call(step) => {
                active.step = step;
                if step == Step::Control {
                    return;
                }
                match self.call(step, now_ms) {
                    Ok(exchange) => {
                        if let Some(active) = self.active.as_mut() {
                            active.exchange = Some(exchange);
                        }
                    }
                    Err(next) => self.go(next, now_ms),
                }
            }
        }
    }

    fn query(&self) -> String {
        let uniqueid = self.identity.as_ref().map_or(ANONYMOUS, Identity::uniqueid);
        format!("uniqueid={uniqueid}&uuid={}", self.uuid)
    }

    fn call(&mut self, step: Step, now_ms: u64) -> Result<Exchange<D::Socket>, Next> {
        let query = self.query();
        let active = self.active.as_ref().expect("active");
        let mut deadline_ms = now_ms.saturating_add(REQUEST_MS);
        let (secure, target) = match step {
            Step::PlainInfo => (false, format!("/serverinfo?{query}")),
            Step::SecureInfo => (true, format!("/serverinfo?{query}")),
            Step::AppList => (true, format!("/applist?{query}")),
            Step::Asset => {
                let Job::Cover { app, .. } = active.job else {
                    return Err(failure("invalid_state", "No cover was asked for"));
                };
                (
                    true,
                    format!("/appasset?{query}&appid={app}&AssetType=2&AssetIdx=0"),
                )
            }
            Step::Unpair => (false, format!("/unpair?{query}")),
            Step::Cancel => (true, format!("/cancel?{query}")),
            Step::Launch { app, resume } => {
                let (Some(start), Some(key)) = (active.start.as_ref(), active.key.as_ref()) else {
                    return Err(failure("invalid_state", "No start was asked for"));
                };
                let request = stream_request(start);
                let target = launch::target(app, resume, &request, key, start.options);
                let (path, rest) = target.split_once('?').unwrap_or((&target, ""));
                (true, format!("{path}?{query}&{rest}"))
            }
            Step::Rtsp => return self.call_rtsp(deadline_ms),
            Step::Control => return Err(failure("invalid_state", "Control has no request")),
            Step::Pair(stage) => {
                let pairing = active.pairing.as_ref().expect("pairing");
                let identity = self.identity.as_ref().expect("identity");
                let Some(request) = pairing.request(identity) else {
                    return Err(failure("invalid_state", "Pairing already finished"));
                };
                if let (Stage::ServerCert, Job::Pair { timeout_s }) = (stage, active.job) {
                    deadline_ms = now_ms.saturating_add(u64::from(timeout_s) * 1000);
                }
                let name = url_encoded(&self.dial.device_name());
                let common = format!("/pair?{query}&devicename={name}&updateState=1");
                match request {
                    pairing::Request::Http(rest) => (false, format!("{common}&{rest}")),
                    pairing::Request::Https(rest) => (true, format!("{common}&{rest}")),
                }
            }
        };

        let limit = if step == Step::Asset { covers::MAX_BYTES } else { MAX_REPLY_BYTES };
        let port = if secure { self.https_port } else { HTTP_PORT };
        let request = http::get(self.host.as_str(), port, &target);
        let socket = self
            .dial
            .dial(self.address, port)
            .map_err(|_| failure("backend_failed", UNREACHABLE))?;
        if !secure {
            return Ok(Exchange::plain(socket, request, limit, deadline_ms));
        }

        let config = match step {
            Step::Pair(_) => self.pairing_config(),
            _ => self.config(),
        };
        let Some(config) = config else {
            let mut socket = socket;
            let _ = socket.close();
            return Err(failure("not_paired", NOT_PAIRED));
        };
        Exchange::secure(socket, config, self.address, request, limit, deadline_ms)
            .map_err(|_| failure("backend_failed", UNREACHABLE))
    }

    fn config(&mut self) -> Option<Arc<rustls::ClientConfig>> {
        if self.config.is_none() {
            let identity = self.identity.as_ref()?;
            let pinned = self.keys.server(&self.host)?;
            self.config = tls::config(identity, pinned, self.dial.random()).ok();
        }
        self.config.clone()
    }

    fn pairing_config(&self) -> Option<Arc<rustls::ClientConfig>> {
        let identity = self.identity.as_ref()?;
        let active = self.active.as_ref()?;
        let pinned = active.pairing.as_ref()?.server_cert()?;
        tls::config(identity, pinned, self.dial.random()).ok()
    }

    fn advance(
        &mut self,
        step: Step,
        outcome: Result<http::Response, exchange::Error>,
        files: &mut impl Files,
        now_ms: u64,
    ) -> Next {
        let active = self.active.as_mut().expect("active");
        let job = active.job;
        if step == Step::Unpair {
            return self.unpaired(files);
        }
        let response = match outcome {
            Ok(response) => response,
            Err(error) => {
                if step == Step::Rtsp {
                    let rtsp = active.rtsp.as_ref().map(rtsp::Handshake::step);
                    self.dial.log(&format!("direct: rtsp {rtsp:?} failed: {error:?}"));
                }
                return transport_failure(&error);
            }
        };
        let body = core::str::from_utf8(&response.body).unwrap_or("");

        match step {
            Step::PlainInfo => {
                let Ok(info) = serverinfo::parse(body) else {
                    return failure("backend_failed", UNREACHABLE);
                };
                if info.generation().is_none_or(|generation| generation < 7) {
                    return failure("unsupported", OLD_HOST);
                }
                self.https_port = info.https_port;
                active.info = Some(info);
                match job {
                    Job::Pair { .. } if self.paired() => Next::Call(Step::SecureInfo),
                    Job::Pair { .. } => self.start_pairing(files),
                    _ if self.paired() => Next::Call(Step::SecureInfo),
                    _ => failure("not_paired", NOT_PAIRED),
                }
            }
            Step::SecureInfo => match serverinfo::parse(body) {
                Ok(info) => {
                    active.info = Some(info);
                    match job {
                        Job::Pair { .. } => result("pair", "{\"event\":\"paired\",\"already\":true}"),
                        Job::Quit => self.quit_result(),
                        Job::Start if !self.apps.is_empty() => self.launch(),
                        _ => Next::Call(Step::AppList),
                    }
                }
                Err(serverinfo::Error::Status(401)) if matches!(job, Job::Pair { .. }) => {
                    self.start_pairing(files)
                }
                Err(serverinfo::Error::Status(401)) => failure("not_paired", NOT_PAIRED),
                Err(_) => failure("backend_failed", UNREACHABLE),
            },
            Step::AppList => match apps::parse(body) {
                Ok(list) if list.len() > MAX_APPS => failure("too_large", "Too many apps"),
                Ok(list) => {
                    self.apps = list;
                    if job == Job::Start {
                        return self.launch();
                    }
                    let list = core::mem::take(&mut self.apps);
                    let next = self.list_result(&list);
                    self.apps = list;
                    next
                }
                Err(serverinfo::Error::Status(401)) => failure("not_paired", NOT_PAIRED),
                Err(_) => failure("backend_failed", UNREACHABLE),
            },
            Step::Asset => {
                let Job::Cover { app, offset } = job else {
                    return failure("invalid_state", "No cover was asked for");
                };
                let png = response.body;
                let is_png = png.starts_with(b"\x89PNG");
                if response.status != 200 || !is_png || png.len() > covers::MAX_BYTES {
                    return failure("backend_failed", "Sunshine has no cover for this app");
                }
                let next = self.cover_chunk(app, &png, offset);
                self.cover = Some((app, png));
                next
            }
            Step::Cancel => match serverinfo::parse(body) {
                Err(serverinfo::Error::Status(401)) => failure("not_paired", NOT_PAIRED),
                _ => Next::Call(Step::SecureInfo),
            },
            Step::Pair(_) => self.paired_step(body, files),
            Step::Unpair => self.unpaired(files),
            Step::Launch { resume, .. } => match launch::parse(body, resume) {
                Ok(port) => {
                    let active = self.active.as_mut().expect("active");
                    let (Some(start), Some(key)) = (active.start.as_ref(), active.key.clone()) else {
                        return failure("invalid_state", "No start was asked for");
                    };
                    active.rtsp = Some(Handshake::new(self.address, port, stream_request(start), key));
                    Next::Call(Step::Rtsp)
                }
                Err(serverinfo::Error::Status(401)) => failure("not_paired", NOT_PAIRED),
                Err(_) => failure("backend_failed", "Sunshine did not start the app"),
            },
            Step::Rtsp => self.rtsp_step(&response, now_ms),
            Step::Control => failure("invalid_state", "Control has no reply"),
        }
    }

    /// Picks launch or resume for the asked app, with a fresh stream key.
    fn launch(&mut self) -> Next {
        let active = self.active.as_mut().expect("active");
        let Some(start) = active.start.as_ref() else {
            return failure("invalid_state", "No start was asked for");
        };
        let Some(app) = self.apps.iter().find(|app| app.title == start.app).map(|app| app.id) else {
            return failure("invalid_request", NO_APP);
        };
        let current = active.info.as_ref().map_or(0, |info| info.current_game);
        if current != 0 && current != app {
            return failure("busy", OTHER_APP);
        }
        let random = self.dial.random();
        let (Ok(key), Ok(id)) = (random.array::<16>(), random.array::<4>()) else {
            return failure("backend_failed", NO_RANDOM);
        };
        active.key = Some(StreamKey {
            key,
            key_id: u32::from_le_bytes(id) & 0x7fff_ffff,
        });
        Next::Call(Step::Launch {
            app,
            resume: current == app,
        })
    }

    fn call_rtsp(&mut self, deadline_ms: u64) -> Result<Exchange<D::Socket>, Next> {
        let active = self.active.as_mut().expect("active");
        let handshake = active.rtsp.as_mut().expect("rtsp");
        let port = handshake.port();
        let Some(request) = handshake.request() else {
            return Err(failure("invalid_state", "RTSP already finished"));
        };
        let socket = self
            .dial
            .dial(self.address, port)
            .map_err(|_| failure("backend_failed", UNREACHABLE))?;
        Ok(Exchange::rtsp(socket, request, MAX_REPLY_BYTES, deadline_ms))
    }

    fn rtsp_step(&mut self, response: &http::Response, now_ms: u64) -> Next {
        let active = self.active.as_mut().expect("active");
        let handshake = active.rtsp.as_mut().expect("rtsp");
        let step = handshake.step();
        let error = match handshake.accept(response) {
            Ok(rtsp::Step::Done) => None,
            Ok(_) => return Next::Call(Step::Rtsp),
            Err(error) => Some(error),
        };
        if let Some(error) = error {
            self.log_rtsp_failure(step, error, response);
            return match error {
                rtsp::Error::NoCodec => failure("unsupported", NO_CODEC),
                rtsp::Error::OldHost => failure("unsupported", OLD_CONTROL),
                _ => failure("backend_failed", "Sunshine refused the stream setup"),
            };
        }
        let active = self.active.as_mut().expect("active");
        let handshake = active.rtsp.as_mut().expect("rtsp");
        let Some(negotiated) = handshake.negotiated() else {
            return failure("backend_failed", "Sunshine refused the stream setup");
        };
        let features = handshake.host_features();
        let socket = match self.dial.datagram(self.address, negotiated.control_port) {
            Ok(socket) => socket,
            Err(_) => return failure("backend_failed", NO_CONTROL),
        };
        let Ok(connect) = self.dial.random().array::<4>() else {
            return failure("backend_failed", NO_RANDOM);
        };
        let control = ControlStream::new(&negotiated, u32::from_le_bytes(connect), now_ms);
        let app = active
            .start
            .as_ref()
            .and_then(|start| self.apps.iter().find(|app| app.title == start.app))
            .map(|app| app.id);
        let input = DirectInput::new(features);
        active.live = Some(Live::new(app.unwrap_or(0), negotiated, control, input, socket, now_ms));
        active.deadline_ms = now_ms.saturating_add(CONTROL_MS);
        Next::Call(Step::Control)
    }

    /// Logs why an RTSP reply was refused, with the SDP lines DESCRIBE is judged on.
    fn log_rtsp_failure(&mut self, step: rtsp::Step, error: rtsp::Error, response: &http::Response) {
        let body = String::from_utf8_lossy(&response.body);
        self.dial.log(&format!(
            "direct: rtsp {step:?} refused: {error:?} status={} body_bytes={}",
            response.status,
            response.body.len()
        ));
        let offer = body.lines().map(str::trim).filter(|line| {
            line.starts_with("a=x-ss-general")
                || line.starts_with("sprop-parameter-sets")
                || line.starts_with("a=rtpmap:98")
        });
        for line in offer {
            self.dial.log(&format!("direct: rtsp sdp {line}"));
        }
    }

    /// Waits for the control channel; `None` while it connects.
    fn wait_control(&mut self, now_ms: u64) -> Option<Next> {
        let active = self.active.as_mut()?;
        let live = active.live.as_mut()?;
        if !live.pump(now_ms, &mut self.events, &mut self.replies) {
            active.live = None;
            return Some(failure("backend_failed", NO_CONTROL));
        }
        match live.state() {
            control_stream::State::Streaming => {}
            control_stream::State::Connecting if now_ms < active.deadline_ms => return None,
            _ => {
                if let Some(live) = active.live.take() {
                    live.end(now_ms);
                }
                return Some(failure("timeout", NO_CONTROL));
            }
        }
        let live = active.live.take()?;
        let handoff = active.start.as_ref().map(|start| handoff(start, &live.negotiated));
        self.live = Some(live);
        Some(Next::Reply(Kind::Stream, handoff.unwrap_or_default()))
    }

    fn start_pairing(&mut self, files: &mut impl Files) -> Next {
        let random = self.dial.random();
        if self.identity.is_none() {
            let started = self.dial.now_ms();
            let identity = Identity::generate(random);
            let took = self.dial.now_ms().saturating_sub(started);
            self.dial.log(&format!("direct: generated the console key ok={} ms={took}", identity.is_ok()));
            let Ok(identity) = identity else {
                return failure("backend_failed", NO_RANDOM);
            };
            let mut keys = core::mem::take(&mut self.keys);
            let encoded = keys.set_identity(&identity);
            let size = keys.format().map(|text| text.len());
            let saved = encoded && keys.save(files);
            self.keys = keys;
            if !saved {
                self.dial.log(&format!(
                    "direct: key file {} not saved encoded={encoded} bytes={size:?}",
                    direct_keys::FILE
                ));
                return failure("backend_failed", KEY_NOT_SAVED);
            }
            self.identity = Some(identity);
            self.config = None;
        }

        let Ok(pin) = pairing::new_pin(random) else {
            return failure("backend_failed", NO_RANDOM);
        };
        let Ok(pairing) = Pairing::new(&pin, random) else {
            return failure("backend_failed", NO_RANDOM);
        };
        let active = self.active.as_mut().expect("active");
        let Job::Pair { timeout_s } = active.job else {
            return failure("invalid_state", "Not pairing");
        };
        active.pairing = Some(pairing);

        let pin = core::str::from_utf8(&pin).unwrap_or("0000");
        let url = format!("https://{}:{WEB_UI_PORT}/pin", self.host.as_str());
        let event = format!(
            "{{\"event\":\"pin\",\"pin\":\"{pin}\",\"url\":{},\"timeout\":{timeout_s}}}",
            quoted(&url)
        );
        self.replies
            .push_back((Kind::Event, active.id, event.into_bytes()));
        Next::Call(Step::Pair(Stage::ServerCert))
    }

    fn paired_step(&mut self, body: &str, files: &mut impl Files) -> Next {
        let active = self.active.as_mut().expect("active");
        let pairing = active.pairing.as_mut().expect("pairing");
        match pairing.accept(body) {
            Ok(Stage::Done) => {}
            Ok(stage) => return Next::Call(Step::Pair(stage)),
            Err(pairing::Error::WrongPin) => return failure("backend_failed", WRONG_PIN),
            Err(pairing::Error::Refused) => return failure("busy", REFUSED),
            Err(pairing::Error::Untrusted) => return failure("backend_failed", WRONG_PIN),
            Err(_) => return failure("backend_failed", UNREACHABLE),
        }

        let cert = pairing.server_cert().map(<[u8]>::to_vec).unwrap_or_default();
        if !self.keys.pin(&self.host, &cert) || !self.keys.save(files) {
            self.keys.forget(&self.host);
            return failure("backend_failed", KEY_NOT_SAVED);
        }
        self.config = None;
        self.cover = None;
        result("pair", "{\"event\":\"paired\",\"already\":false}")
    }

    fn unpaired(&mut self, files: &mut impl Files) -> Next {
        let known = self.keys.forget(&self.host);
        if known && !self.keys.save(files) {
            return failure("backend_failed", KEY_NOT_SAVED);
        }
        self.config = None;
        self.cover = None;
        let value = format!("{{\"event\":\"unpaired\",\"already\":{}}}", !known);
        result("unpair", &value)
    }

    fn list_result(&self, list: &[apps::App]) -> Next {
        let info = self.active.as_ref().and_then(|active| active.info.as_ref());
        let current = info.map_or(0, |info| info.current_game);
        let mut value = format!("{{\"currentGame\":{current},");
        if let Some(info) = info {
            value.push_str(&format!("\"uniqueid\":{},", quoted(&info.uniqueid)));
            if let Some(mac) = info.mac {
                let mac = mac.map(|byte| hex::encode(&[byte]));
                value.push_str(&format!("\"macs\":[\"{}\"],", mac.join(":")));
            }
        }
        value.push_str("\"apps\":[");
        for (index, app) in list.iter().enumerate() {
            if index > 0 {
                value.push(',');
            }
            value.push_str(&format!("{{\"id\":{},\"name\":{}}}", app.id, quoted(&app.title)));
        }
        value.push_str("]}");
        result("list", &value)
    }

    fn quit_result(&self) -> Next {
        let info = self.active.as_ref().and_then(|active| active.info.as_ref());
        let current = info.map_or(0, |info| info.current_game);
        let value = format!(
            "{{\"event\":\"quit\",\"already\":false,\"cancelled\":{},\"currentGame\":{current}}}",
            current == 0
        );
        result("quit", &value)
    }

    fn cover_chunk(&self, app: u32, png: &[u8], offset: usize) -> Next {
        if offset >= png.len() {
            return failure("invalid_request", "Cover offset is past its end");
        }
        let end = png.len().min(offset + covers::CHUNK_BYTES);
        let value = format!(
            "{{\"app\":{app},\"mime\":\"image/png\",\"total\":{},\"offset\":{offset},\"data\":\"{}\"}}",
            png.len(),
            base64(&png[offset..end])
        );
        result("cover", &value)
    }
}

fn stream_request(start: &Start) -> StreamRequest {
    StreamRequest {
        width: start.width,
        height: start.height,
        fps: start.fps,
        bitrate_kbps: start.bitrate_kbps,
        packet_size: PACKET_SIZE,
        codecs: codecs(start.codec),
        hdr: false,
        audio_channels: 2,
        controllers: 1,
    }
}

/// A random version 4 UUID for the requests' `uuid` argument.
fn uuid(random: Random) -> Option<String> {
    let mut bytes = random.array::<16>().ok()?;
    bytes[6] = bytes[6] & 0x0f | 0x40;
    bytes[8] = bytes[8] & 0x3f | 0x80;
    let text = hex::encode(&bytes);
    Some(format!(
        "{}-{}-{}-{}-{}",
        &text[..8],
        &text[8..12],
        &text[12..16],
        &text[16..20],
        &text[20..]
    ))
}

impl<D: Dial> Link for DirectLink<D> {
    fn ready(&self) -> bool {
        !self.closed
    }

    fn failed(&self) -> bool {
        self.closed
    }

    fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError> {
        if self.closed {
            return Err(LinkError::Closed);
        }
        if self.queue.len() >= MAX_QUEUED {
            return Err(LinkError::Again);
        }
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let job = parse_request(payload).and_then(|(job, start, host)| match host {
            Some(host) if host != self.host => Err(("invalid_request", "This link serves another host")),
            _ => Ok((job, start)),
        });
        self.queue.push_back((id, job));
        Ok(id)
    }

    fn peek(&self) -> Option<Frame<'_>> {
        let (kind, id, payload) = self.replies.front()?;
        let header = Header::new(*kind, *id, payload.len()).ok()?;
        Some(Frame { header, payload })
    }

    fn consume(&mut self) -> Result<(), LinkError> {
        self.replies.pop_front().map(|_| ()).ok_or(LinkError::Again)
    }
}
