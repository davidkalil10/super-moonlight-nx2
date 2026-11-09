//! Typed control-v1 replies (NATIVE-CONTROL-V1.md, "Replies and events" and "Stream descriptor").
//! Envelopes, descriptors and errors are strict. Result values and PIN events pass through
//! the PC helper's own lines, so only their documented fields are read and others are ignored.

use crate::json::{self, Kind, Value};
use crate::policy::{RemoteQuality, RemoteRtt};
use crate::request::{Codec, Op, Transport};
use moonlight_nx2_core::control::Kind as FrameKind;
use moonlight_nx2_core::media::TOKEN_BYTES;
use moonlight_nx2_ui::model::{Address, App, MAX_APPS, Message, Name};

pub const PIN_BYTES: usize = 4;
pub const MAX_URL_BYTES: usize = 255;
pub const MAX_UNIQUEID_BYTES: usize = 63;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Json(json::Error),
    /// Valid JSON that does not match the documented shape.
    Shape,
    /// A documented bound the console cannot hold (apps, identifiers); refused, never truncated.
    TooLarge,
    /// A frame kind the console never accepts after authentication.
    Kind,
}

impl From<json::Error> for Error {
    fn from(error: json::Error) -> Self {
        Error::Json(error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Code {
    InvalidRequest,
    InvalidState,
    Busy,
    Unsupported,
    TooLarge,
    BackendFailed,
    Timeout,
    Cancelled,
    /// The host was reached and reported this console unpaired; nothing was done.
    NotPaired,
}

impl Code {
    fn from_name(name: &str) -> Option<Self> {
        match name {
            "invalid_request" => Some(Code::InvalidRequest),
            "invalid_state" => Some(Code::InvalidState),
            "busy" => Some(Code::Busy),
            "unsupported" => Some(Code::Unsupported),
            "too_large" => Some(Code::TooLarge),
            "backend_failed" => Some(Code::BackendFailed),
            "timeout" => Some(Code::Timeout),
            "cancelled" => Some(Code::Cancelled),
            "not_paired" => Some(Code::NotPaired),
            _ => None,
        }
    }

    /// Console wording; the host's message text is never shown.
    pub fn message(self) -> &'static str {
        match self {
            Code::InvalidRequest => "the PC refused the request",
            Code::InvalidState => "the PC was not ready for it",
            Code::Busy => "the PC is busy with another request",
            Code::Unsupported => "the PC does not support it",
            Code::TooLarge => "the PC's reply was too large",
            Code::BackendFailed => "the host operation failed",
            Code::Timeout => "the PC timed out",
            Code::Cancelled => "it was cancelled",
            Code::NotPaired => "pair with this PC first",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Pin {
    pub pin: [u8; PIN_BYTES],
    pub url: Message,
    /// The PC's pairing timeout when it reported one.
    pub timeout_s: Option<u32>,
}

impl Pin {
    pub fn digits(&self) -> &str {
        core::str::from_utf8(&self.pin).unwrap_or("")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MediaAck {
    InputV1,
    Header,
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Video {
    pub port: u16,
    pub token: [u8; TOKEN_BYTES],
    pub max_payload: u32,
    pub ack: MediaAck,
    pub transport: Transport,
    pub udp: Option<Udp>,
}

/// Validated UDP-v1 parameters; version, fragment size, slot count and feedback are fixed.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Udp {
    pub port: u16,
    pub token: [u8; TOKEN_BYTES],
    pub deadline_us: u32,
    pub spread_us: u32,
    pub pace_bytes_per_ms: u32,
    pub hello_ms: u32,
}

impl Udp {
    pub fn is_valid(&self) -> bool {
        self.port != 0
            && self
                .token
                .iter()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
            && (1000..=2_000_000).contains(&self.deadline_us)
            && self.spread_us <= 1_000_000
            && (100..=1_000_000).contains(&self.pace_bytes_per_ms)
            && (100..=60_000).contains(&self.hello_ms)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Audio {
    pub port: u16,
    pub token: [u8; TOKEN_BYTES],
    pub rate: u32,
    pub channels: u32,
    pub chunk_bytes: u32,
    pub ack: MediaAck,
}

/// A prepared stream. Tokens are secrets: Debug omits them; call `wipe` when done.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct Descriptor {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video: Video,
    pub audio: Option<Audio>,
}

impl Descriptor {
    pub fn wipe(&mut self) {
        wipe(&mut self.video.token);
        if let Some(udp) = &mut self.video.udp {
            wipe(&mut udp.token);
        }
        if let Some(audio) = &mut self.audio {
            wipe(&mut audio.token);
        }
    }
}

impl core::fmt::Debug for Descriptor {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Descriptor")
            .field("codec", &self.codec)
            .field("width", &self.width)
            .field("height", &self.height)
            .field("fps", &self.fps)
            .field("video_port", &self.video.port)
            .field("transport", &self.video.transport)
            .field("audio", &self.audio.map(|audio| audio.port))
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Quit {
    pub already: bool,
    pub cancelled: bool,
    pub current_game: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TelemetryEcho {
    UpstreamV1,
    Other,
    Null,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpstreamStatus {
    pub start_id: u32,
    pub sequence: u32,
    pub rtt: Option<RemoteRtt>,
    pub quality: RemoteQuality,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventClass {
    UpstreamStatus,
    Rumble,
    Lifecycle,
    Unknown,
    Unclassifiable,
}

/// Classifies the entire original bounded document before advisory schema rejection.
pub fn classify_event(payload: &[u8]) -> EventClass {
    if payload.len() > moonlight_nx2_core::control::MAX_PAYLOAD {
        return EventClass::Unclassifiable;
    }
    let Ok(root) = json::classify(payload) else {
        return EventClass::Unclassifiable;
    };
    if root.kind() != Kind::Object {
        return EventClass::Unclassifiable;
    }
    let mut event = None;
    for (key, value) in root.members() {
        if key.string_is("event") {
            if event.is_some() {
                return EventClass::Unclassifiable;
            }
            event = Some(value);
        }
    }
    let Some(event) = event.filter(|value| value.kind() == Kind::String) else {
        return EventClass::Unclassifiable;
    };
    if event.string_is("upstream_status") {
        EventClass::UpstreamStatus
    } else if event.string_is("rumble") {
        EventClass::Rumble
    } else if ["connected", "stopped", "stream_failed"]
        .iter()
        .any(|name| event.string_is(name))
    {
        EventClass::Lifecycle
    } else {
        EventClass::Unknown
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Reply<'a> {
    Pin(Pin),
    /// A list result; decode it with `Catalog::decode`.
    Listed(Value<'a>),
    Paired {
        already: bool,
    },
    Unpaired {
        already: bool,
    },
    Quit(Quit),
    Stopped,
    /// ID 0: the upstream session connected. Not playback.
    Connected,
    /// ID 0: the upstream session ended on its own.
    Ended,
    /// ID 0: failure of the stream prepared by this original start request.
    StreamFailed {
        start_id: u32,
        code: Code,
    },
    Descriptor(Descriptor),
    DescriptorWithTelemetry {
        descriptor: Descriptor,
        echo: TelemetryEcho,
    },
    UpstreamStatus(UpstreamStatus),
    /// ID 0: the PC rumbled `player` (0 = player 1, up to 7); 0/0 stops the motors.
    Rumble(Rumble),
    Failure(Code),
}

/// Motor strengths for one player, 0 to 65535 each.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rumble {
    pub player: u8,
    pub low: u16,
    pub high: u16,
}

/// Players a rumble event may address.
pub const RUMBLE_PLAYERS: u8 = 8;

/// Decodes one frame's payload. `request_id` 0 selects the session lifecycle events.
pub fn decode(kind: FrameKind, request_id: u32, payload: &[u8]) -> Result<Reply<'_>, Error> {
    let known = matches!(
        kind,
        FrameKind::Event | FrameKind::Stream | FrameKind::Error
    );
    if !known {
        return Err(Error::Kind);
    }

    let root = json::parse(payload)?;
    if root.kind() != Kind::Object {
        return Err(Error::Shape);
    }

    match kind {
        FrameKind::Event if request_id == 0 => lifecycle(root),
        FrameKind::Event => event(root),
        FrameKind::Stream => {
            let echo = match root.member("telemetry") {
                None => None,
                Some(value) => {
                    let echo = match value.kind() {
                        Kind::Null => TelemetryEcho::Null,
                        Kind::String if value.string_is("upstream-v1") => TelemetryEcho::UpstreamV1,
                        Kind::String => TelemetryEcho::Other,
                        _ => return Err(Error::Shape),
                    };
                    Some(echo)
                }
            };
            let descriptor = descriptor(root)?;
            match echo {
                None => Ok(Reply::Descriptor(descriptor)),
                Some(echo) => Ok(Reply::DescriptorWithTelemetry { descriptor, echo }),
            }
        }
        FrameKind::Error => failure(root),
        _ => Err(Error::Kind),
    }
}

fn lifecycle(root: Value<'_>) -> Result<Reply<'_>, Error> {
    let event = root.member("event").ok_or(Error::Shape)?;
    if event.string_is("upstream_status") {
        return upstream_status(root).map(Reply::UpstreamStatus);
    }
    if event.string_is("rumble") {
        return rumble(root).map(Reply::Rumble);
    }
    if event.string_is("stream_failed") {
        exact_keys(root, &["event", "start_id", "code", "message"])?;
        let start_id = number(root, "start_id")?;
        let code = root
            .member("code")
            .and_then(|code| code.as_plain_str())
            .and_then(Code::from_name)
            .ok_or(Error::Shape)?;
        let mut buffer = [0; 256];
        let message = string(root.member("message").ok_or(Error::Shape)?, &mut buffer)?;
        if start_id == 0
            || !crate::request::valid_text(message, 256)
            || !matches!(
                code,
                Code::Timeout
                    | Code::BackendFailed
                    | Code::Cancelled
                    | Code::Unsupported
                    | Code::TooLarge
            )
        {
            return Err(Error::Shape);
        }
        return Ok(Reply::StreamFailed { start_id, code });
    }
    exact_keys(root, &["event"])?;

    if event.string_is("connected") {
        return Ok(Reply::Connected);
    }
    if event.string_is("stopped") {
        return Ok(Reply::Ended);
    }
    Err(Error::Shape)
}

fn rumble(root: Value<'_>) -> Result<Rumble, Error> {
    exact_keys(root, &["event", "controller", "low", "high"])?;
    let motor = |key| u16::try_from(number(root, key)?).map_err(|_| Error::Shape);
    let player = number(root, "controller")?;
    if player >= u32::from(RUMBLE_PLAYERS) {
        return Err(Error::Shape);
    }
    Ok(Rumble {
        player: player as u8,
        low: motor("low")?,
        high: motor("high")?,
    })
}

fn upstream_status(root: Value<'_>) -> Result<UpstreamStatus, Error> {
    exact_keys(
        root,
        &[
            "event",
            "start_id",
            "sequence",
            "rtt_ms",
            "rtt_deviation_ms",
            "connection",
        ],
    )?;
    let start_id = number(root, "start_id")?;
    let sequence = number(root, "sequence")?;
    if start_id == 0 || sequence == 0 {
        return Err(Error::Shape);
    }
    let rtt = root.member("rtt_ms").ok_or(Error::Shape)?;
    let deviation = root.member("rtt_deviation_ms").ok_or(Error::Shape)?;
    let rtt = match (rtt.kind(), deviation.kind()) {
        (Kind::Null, Kind::Null) => None,
        (Kind::Number, Kind::Number) => Some(RemoteRtt {
            rtt_ms: number(root, "rtt_ms")?,
            deviation_ms: number(root, "rtt_deviation_ms")?,
        }),
        _ => return Err(Error::Shape),
    };
    let quality = root.member("connection").ok_or(Error::Shape)?;
    let quality = if quality.string_is("unknown") {
        RemoteQuality::Unknown
    } else if quality.string_is("poor") {
        RemoteQuality::Poor
    } else if quality.string_is("okay") {
        RemoteQuality::Okay
    } else {
        return Err(Error::Shape);
    };
    Ok(UpstreamStatus {
        start_id,
        sequence,
        rtt,
        quality,
    })
}

fn event(root: Value<'_>) -> Result<Reply<'_>, Error> {
    let event = root.member("event").ok_or(Error::Shape)?;
    if event.string_is("pin") {
        return pin(root).map(Reply::Pin);
    }
    if !event.string_is("result") {
        return Err(Error::Shape);
    }

    exact_keys(root, &["event", "op", "ok", "value"])?;
    if root.member("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return Err(Error::Shape);
    }
    let op = root
        .member("op")
        .and_then(|op| op.as_plain_str())
        .and_then(Op::from_name);
    let value = root.member("value").ok_or(Error::Shape)?;
    if value.kind() != Kind::Object {
        return Err(Error::Shape);
    }

    match op.ok_or(Error::Shape)? {
        Op::List => Ok(Reply::Listed(value)),
        Op::Pair => helper_flag(value, "paired").map(|already| Reply::Paired { already }),
        Op::Unpair => helper_flag(value, "unpaired").map(|already| Reply::Unpaired { already }),
        Op::Quit => quit(value).map(Reply::Quit),
        Op::Stop if value.members().next().is_none() => Ok(Reply::Stopped),
        _ => Err(Error::Shape),
    }
}

fn pin(root: Value<'_>) -> Result<Pin, Error> {
    let digits = root
        .member("pin")
        .and_then(|pin| pin.as_plain_str())
        .ok_or(Error::Shape)?;
    let url = root.member("url").ok_or(Error::Shape)?;
    let timeout_s = match root.member("timeout") {
        None => None,
        Some(timeout) => {
            let seconds = timeout.as_u64().and_then(|value| u32::try_from(value).ok());
            Some(seconds.ok_or(Error::Shape)?)
        }
    };

    let digits_ok = digits.len() == PIN_BYTES && digits.bytes().all(|byte| byte.is_ascii_digit());
    if !digits_ok {
        return Err(Error::Shape);
    }

    let mut buffer = [0u8; MAX_URL_BYTES];
    let url = string(url, &mut buffer)?;
    let mut pin = [0u8; PIN_BYTES];
    pin.copy_from_slice(digits.as_bytes());
    Ok(Pin {
        pin,
        url: Message::of(url),
        timeout_s,
    })
}

fn helper_flag(value: Value<'_>, event: &str) -> Result<bool, Error> {
    let event_ok = value
        .member("event")
        .is_some_and(|name| name.string_is(event));
    let already = value
        .member("already")
        .and_then(|already| already.as_bool());
    match (event_ok, already) {
        (true, Some(already)) => Ok(already),
        _ => Err(Error::Shape),
    }
}

fn quit(value: Value<'_>) -> Result<Quit, Error> {
    let already = helper_flag(value, "quit")?;
    let cancelled = value.member("cancelled").and_then(|flag| flag.as_bool());
    let current_game = value.member("currentGame").and_then(|game| game.as_u64());
    let current_game = current_game.and_then(|game| u32::try_from(game).ok());

    match (cancelled, current_game) {
        (Some(cancelled), Some(current_game)) => Ok(Quit {
            already,
            cancelled,
            current_game,
        }),
        _ => Err(Error::Shape),
    }
}

fn failure(root: Value<'_>) -> Result<Reply<'_>, Error> {
    exact_keys(root, &["code", "message"])?;
    let message_ok = root
        .member("message")
        .is_some_and(|message| message.kind() == Kind::String);
    let code = root
        .member("code")
        .and_then(|code| code.as_plain_str())
        .and_then(Code::from_name);

    match (message_ok, code) {
        (true, Some(code)) => Ok(Reply::Failure(code)),
        _ => Err(Error::Shape),
    }
}

fn descriptor(root: Value<'_>) -> Result<Descriptor, Error> {
    let keys = [
        "codec",
        "width",
        "height",
        "fps",
        "video",
        "audio",
        "telemetry",
    ];
    let count = if root.member("telemetry").is_some() {
        7
    } else {
        6
    };
    exact_keys(root, &keys[..count])?;
    let codec = root
        .member("codec")
        .and_then(|codec| codec.as_plain_str())
        .and_then(Codec::from_name);
    let video = root.member("video").ok_or(Error::Shape)?;
    let audio = root.member("audio").ok_or(Error::Shape)?;

    let audio = match audio.kind() {
        Kind::Null => None,
        Kind::Object => Some(audio_channel(audio)?),
        _ => return Err(Error::Shape),
    };

    let mut descriptor = Descriptor {
        codec: codec.ok_or(Error::Shape)?,
        width: number(root, "width")?,
        height: number(root, "height")?,
        fps: number(root, "fps")?,
        video: video_channel(video)?,
        audio,
    };
    if let Some(udp) = descriptor.video.udp
        && (udp.token == descriptor.video.token
            || descriptor
                .audio
                .is_some_and(|audio| audio.token == udp.token))
    {
        descriptor.wipe();
        return Err(Error::Shape);
    }
    Ok(descriptor)
}

fn video_channel(video: Value<'_>) -> Result<Video, Error> {
    if video.kind() != Kind::Object {
        return Err(Error::Shape);
    }
    let transport = match video.member("transport") {
        Some(value) => value
            .as_plain_str()
            .and_then(Transport::from_name)
            .ok_or(Error::Shape)?,
        None => Transport::TcpV1,
    };
    let keys = ["port", "token", "max_payload", "ack", "transport", "udp"];
    let count = if transport == Transport::UdpV1 {
        6
    } else if video.member("transport").is_some() {
        5
    } else {
        4
    };
    exact_keys(video, &keys[..count])?;
    let udp = if transport == Transport::UdpV1 {
        let max_payload = number(video, "max_payload")?;
        if !(1..=crate::stream::MAX_VIDEO_PAYLOAD).contains(&max_payload)
            || ack(video)? != MediaAck::InputV1
        {
            return Err(Error::Shape);
        }
        Some(udp_channel(video.member("udp").ok_or(Error::Shape)?)?)
    } else {
        None
    };

    Ok(Video {
        port: port(video)?,
        token: token(video)?,
        max_payload: number(video, "max_payload")?,
        ack: ack(video)?,
        transport,
        udp,
    })
}

fn udp_channel(udp: Value<'_>) -> Result<Udp, Error> {
    exact_keys(
        udp,
        &[
            "version",
            "port",
            "token",
            "fragment_bytes",
            "unit_slots",
            "deadline_us",
            "spread_us",
            "pace_bytes_per_ms",
            "hello_ms",
            "feedback",
        ],
    )?;
    let constants_ok = number(udp, "version")? == 1
        && number(udp, "fragment_bytes")? == 1360
        && number(udp, "unit_slots")? == 8
        && udp
            .member("feedback")
            .is_some_and(|feedback| feedback.string_is("input-drop-v1"));
    let deadline_us = number(udp, "deadline_us")?;
    let spread_us = number(udp, "spread_us")?;
    let pace_bytes_per_ms = number(udp, "pace_bytes_per_ms")?;
    let hello_ms = number(udp, "hello_ms")?;
    let bounds_ok = (1000..=2_000_000).contains(&deadline_us)
        && spread_us <= 1_000_000
        && (100..=1_000_000).contains(&pace_bytes_per_ms)
        && (100..=60_000).contains(&hello_ms);
    if !constants_ok || !bounds_ok {
        return Err(Error::Shape);
    }
    Ok(Udp {
        port: port(udp)?,
        token: token(udp)?,
        deadline_us,
        spread_us,
        pace_bytes_per_ms,
        hello_ms,
    })
}

fn audio_channel(audio: Value<'_>) -> Result<Audio, Error> {
    exact_keys(
        audio,
        &[
            "port",
            "token",
            "rate",
            "channels",
            "format",
            "chunk_bytes",
            "ack",
        ],
    )?;
    let format_ok = audio
        .member("format")
        .is_some_and(|format| format.string_is("s16le"));
    if !format_ok {
        return Err(Error::Shape);
    }

    Ok(Audio {
        port: port(audio)?,
        token: token(audio)?,
        rate: number(audio, "rate")?,
        channels: number(audio, "channels")?,
        chunk_bytes: number(audio, "chunk_bytes")?,
        ack: ack(audio)?,
    })
}

fn number(object: Value<'_>, key: &str) -> Result<u32, Error> {
    let value = object.member(key).and_then(|value| value.as_u64());
    value
        .and_then(|value| u32::try_from(value).ok())
        .ok_or(Error::Shape)
}

fn port(object: Value<'_>) -> Result<u16, Error> {
    let port = number(object, "port")?;
    match u16::try_from(port) {
        Ok(port) if port != 0 => Ok(port),
        _ => Err(Error::Shape),
    }
}

fn token(object: Value<'_>) -> Result<[u8; TOKEN_BYTES], Error> {
    let text = object
        .member("token")
        .and_then(|token| token.as_plain_str())
        .ok_or(Error::Shape)?;
    let hex_ok = text.len() == TOKEN_BYTES
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
    if !hex_ok {
        return Err(Error::Shape);
    }

    let mut token = [0u8; TOKEN_BYTES];
    token.copy_from_slice(text.as_bytes());
    Ok(token)
}

fn ack(object: Value<'_>) -> Result<MediaAck, Error> {
    let ack = object.member("ack").ok_or(Error::Shape)?;
    if ack.string_is("input-v1") {
        return Ok(MediaAck::InputV1);
    }
    if ack.string_is("header") {
        return Ok(MediaAck::Header);
    }
    Err(Error::Shape)
}

/// Every key present exactly once and nothing else; duplicates were refused by the parser.
fn exact_keys(object: Value<'_>, keys: &[&str]) -> Result<(), Error> {
    let mut count = 0;
    for (key, _) in object.members() {
        if !keys.iter().any(|expected| key.string_is(expected)) {
            return Err(Error::Shape);
        }
        count += 1;
    }

    if count != keys.len() {
        return Err(Error::Shape);
    }
    Ok(())
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes.iter_mut() {
        // SAFETY: `byte` is a valid exclusive reference.
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
    core::sync::atomic::compiler_fence(core::sync::atomic::Ordering::SeqCst);
}

/// A host's app catalog from one list result. Bounded by the UI model's tables.
pub struct Catalog {
    apps: [App; MAX_APPS],
    truncated: [u64; MAX_APPS / 64],
    count: usize,
    current_game: u32,
    uniqueid: Address,
}

impl Default for Catalog {
    fn default() -> Self {
        Self::new()
    }
}

impl Catalog {
    pub const fn new() -> Self {
        Self {
            apps: [App {
                id: 0,
                name: Name::new(),
            }; MAX_APPS],
            truncated: [0; MAX_APPS / 64],
            count: 0,
            current_game: 0,
            uniqueid: Address::new(),
        }
    }

    pub fn apps(&self) -> &[App] {
        &self.apps[..self.count]
    }

    /// The listed app with this ID, and whether its name was too long to send back exactly.
    pub fn find(&self, id: u32) -> Option<(&App, bool)> {
        let index = self.apps().iter().position(|app| app.id == id)?;
        let truncated = self.truncated[index / 64] & (1 << (index % 64)) != 0;
        Some((&self.apps[index], truncated))
    }

    fn set_truncated(&mut self, index: usize, truncated: bool) {
        let bit = 1u64 << (index % 64);
        if truncated {
            self.truncated[index / 64] |= bit;
        } else {
            self.truncated[index / 64] &= !bit;
        }
    }

    pub fn current_game(&self) -> u32 {
        self.current_game
    }

    /// Empty when the host did not report one.
    pub fn uniqueid(&self) -> &str {
        self.uniqueid.as_str()
    }

    /// Replaces the catalog from a list value. On error the previous catalog is cleared.
    pub fn decode(&mut self, value: Value<'_>) -> Result<(), Error> {
        self.count = 0;
        self.current_game = 0;
        self.uniqueid.clear();

        let result = self.fill(value);
        if result.is_err() {
            self.count = 0;
            self.current_game = 0;
            self.uniqueid.clear();
        }
        result
    }

    fn fill(&mut self, value: Value<'_>) -> Result<(), Error> {
        let current = value.member("currentGame").and_then(|game| game.as_u64());
        let apps = value.member("apps").ok_or(Error::Shape)?;
        if apps.kind() != Kind::Array {
            return Err(Error::Shape);
        }
        self.current_game = current
            .and_then(|game| u32::try_from(game).ok())
            .ok_or(Error::Shape)?;

        if let Some(uniqueid) = value.member("uniqueid") {
            let mut buffer = [0u8; 64];
            let text = string(uniqueid, &mut buffer)?;
            if text.len() > MAX_UNIQUEID_BYTES {
                return Err(Error::TooLarge);
            }
            self.uniqueid = Address::of(text);
        }

        for app in apps.elements() {
            if self.count == MAX_APPS {
                return Err(Error::TooLarge);
            }
            let (entry, truncated) = entry(app)?;
            self.apps[self.count] = entry;
            self.set_truncated(self.count, truncated);
            self.count += 1;
        }
        Ok(())
    }
}

/// An app and whether its display name was cut to the UI's `Name` capacity.
fn entry(app: Value<'_>) -> Result<(App, bool), Error> {
    if app.kind() != Kind::Object {
        return Err(Error::Shape);
    }
    let id = app
        .member("id")
        .and_then(|id| id.as_u64())
        .and_then(|id| u32::try_from(id).ok());
    let name = app.member("name").ok_or(Error::Shape)?;

    let mut buffer = [0u8; 1024];
    let text = string(name, &mut buffer)?;
    let name = Name::of(text);
    let truncated = name.len() < text.len();
    let app = App {
        id: id.ok_or(Error::Shape)?,
        name,
    };
    Ok((app, truncated))
}

/// A string value decoded into `buffer`: `Shape` when it is not a string, `TooLarge` when long.
fn string<'b>(value: Value<'_>, buffer: &'b mut [u8]) -> Result<&'b str, Error> {
    if value.kind() != Kind::String {
        return Err(Error::Shape);
    }
    value.decode_str(buffer).ok_or(Error::TooLarge)
}
