//! Control-v1 request payloads (NATIVE-CONTROL-V1.md, "Requests"), written into caller storage.
//! Field order matches the shared fixtures so the bytes compare exactly.

pub const MAX_HOST_BYTES: usize = 255;
pub const MAX_APP_BYTES: usize = 1024;
pub const MAX_REQUEST_BYTES: usize = 3072;
pub const DEFAULT_PAIR_TIMEOUT_S: u32 = 120;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidHost,
    InvalidApp,
    InvalidOptions,
    NoRoom,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Codec {
    H264,
    Hevc,
    Av1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Transport {
    TcpV1,
    UdpV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TelemetryProfile {
    UpstreamV1,
}

impl TelemetryProfile {
    pub fn name(self) -> &'static str {
        match self {
            Self::UpstreamV1 => "upstream-v1",
        }
    }
}

impl Transport {
    pub fn name(self) -> &'static str {
        match self {
            Self::TcpV1 => "tcp-v1",
            Self::UdpV1 => "udp-v1",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "tcp-v1" => Some(Self::TcpV1),
            "udp-v1" => Some(Self::UdpV1),
            _ => None,
        }
    }
}

impl Codec {
    pub fn name(self) -> &'static str {
        match self {
            Codec::H264 => "h264",
            Codec::Hevc => "hevc",
            Codec::Av1 => "av1",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "h264" => Some(Codec::H264),
            "hevc" => Some(Codec::Hevc),
            "av1" => Some(Codec::Av1),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Options {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub sops: bool,
    pub local_audio: bool,
    pub quit_on_stop: bool,
    /// Absent preserves the original TCP diagnostic request bytes.
    pub transport: Option<Transport>,
}

impl Options {
    /// The wire bounds; device capabilities are checked separately.
    pub fn is_valid(&self) -> bool {
        let width_ok = self.width % 2 == 0 && (2..=3840).contains(&self.width);
        let height_ok = self.height % 2 == 0 && (2..=2160).contains(&self.height);
        let rate_ok = (1..=120).contains(&self.fps) && (1..=1_000_000).contains(&self.bitrate_kbps);
        width_ok && height_ok && rate_ok
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Op {
    Pair,
    List,
    Unpair,
    Quit,
    Start,
    Stop,
}

impl Op {
    pub fn name(self) -> &'static str {
        match self {
            Op::Pair => "pair",
            Op::List => "list",
            Op::Unpair => "unpair",
            Op::Quit => "quit",
            Op::Start => "start",
            Op::Stop => "stop",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "pair" => Some(Op::Pair),
            "list" => Some(Op::List),
            "unpair" => Some(Op::Unpair),
            "quit" => Some(Op::Quit),
            "start" => Some(Op::Start),
            "stop" => Some(Op::Stop),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Request<'a> {
    Pair {
        host: &'a str,
        timeout_seconds: u32,
    },
    List {
        host: &'a str,
    },
    Unpair {
        host: &'a str,
    },
    Quit {
        host: &'a str,
    },
    Start {
        host: &'a str,
        app: &'a str,
        options: Options,
    },
    Stop,
}

impl Request<'_> {
    pub fn op(&self) -> Op {
        match self {
            Request::Pair { .. } => Op::Pair,
            Request::List { .. } => Op::List,
            Request::Unpair { .. } => Op::Unpair,
            Request::Quit { .. } => Op::Quit,
            Request::Start { .. } => Op::Start,
            Request::Stop => Op::Stop,
        }
    }

    /// Validates and writes the JSON payload; returns its length.
    pub fn write(&self, out: &mut [u8]) -> Result<usize, Error> {
        self.write_with_telemetry(out, None)
    }

    /// An opt-in Start profile; omission preserves the original request bytes.
    pub fn write_with_telemetry(
        &self,
        out: &mut [u8],
        telemetry: Option<TelemetryProfile>,
    ) -> Result<usize, Error> {
        if telemetry.is_some() && self.op() != Op::Start {
            return Err(Error::InvalidOptions);
        }
        let mut writer = Writer { out, used: 0 };
        writer.raw("{\"op\":\"")?;
        writer.raw(self.op().name())?;
        writer.raw("\"")?;

        match *self {
            Request::Pair {
                host,
                timeout_seconds,
            } => {
                writer.host(host)?;
                if !(1..=600).contains(&timeout_seconds) {
                    return Err(Error::InvalidOptions);
                }
                writer.raw(",\"timeout_seconds\":")?;
                writer.number(timeout_seconds)?;
            }
            Request::List { host } | Request::Unpair { host } | Request::Quit { host } => {
                writer.host(host)?;
            }
            Request::Start { host, app, options } => {
                writer.host(host)?;
                if !valid_text(app, MAX_APP_BYTES) {
                    return Err(Error::InvalidApp);
                }
                writer.raw(",\"app\":")?;
                writer.string(app)?;
                writer.options(&options, telemetry)?;
            }
            Request::Stop => {}
        }

        writer.raw("}")?;
        Ok(writer.used)
    }
}

/// Nonempty, bounded, and free of NUL and ASCII control characters.
pub fn valid_text(text: &str, max_bytes: usize) -> bool {
    let size_ok = !text.is_empty() && text.len() <= max_bytes;
    size_ok && !text.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
}

struct Writer<'a> {
    out: &'a mut [u8],
    used: usize,
}

impl Writer<'_> {
    fn raw(&mut self, text: &str) -> Result<(), Error> {
        let end = self.used + text.len();
        let slot = self.out.get_mut(self.used..end).ok_or(Error::NoRoom)?;
        slot.copy_from_slice(text.as_bytes());
        self.used = end;
        Ok(())
    }

    fn number(&mut self, value: u32) -> Result<(), Error> {
        let mut digits = [0u8; 10];
        let mut count = 0;
        let mut rest = value;
        loop {
            digits[digits.len() - 1 - count] = b'0' + (rest % 10) as u8;
            count += 1;
            rest /= 10;
            if rest == 0 {
                break;
            }
        }
        let text =
            core::str::from_utf8(&digits[digits.len() - count..]).map_err(|_| Error::NoRoom)?;
        self.raw(text)
    }

    fn boolean(&mut self, value: bool) -> Result<(), Error> {
        self.raw(if value { "true" } else { "false" })
    }

    /// Writes a validated string; only `"` and `\` need escaping once controls are refused.
    fn string(&mut self, text: &str) -> Result<(), Error> {
        self.raw("\"")?;
        for piece in text.split_inclusive(['"', '\\']) {
            let (body, special) = match piece.as_bytes().last() {
                Some(b'"') => (&piece[..piece.len() - 1], Some("\\\"")),
                Some(b'\\') => (&piece[..piece.len() - 1], Some("\\\\")),
                _ => (piece, None),
            };
            self.raw(body)?;
            if let Some(escaped) = special {
                self.raw(escaped)?;
            }
        }
        self.raw("\"")
    }

    fn host(&mut self, host: &str) -> Result<(), Error> {
        if !valid_text(host, MAX_HOST_BYTES) {
            return Err(Error::InvalidHost);
        }
        self.raw(",\"host\":")?;
        self.string(host)
    }

    fn options(
        &mut self,
        options: &Options,
        telemetry: Option<TelemetryProfile>,
    ) -> Result<(), Error> {
        if !options.is_valid() {
            return Err(Error::InvalidOptions);
        }

        self.raw(",\"options\":{\"width\":")?;
        self.number(options.width)?;
        self.raw(",\"height\":")?;
        self.number(options.height)?;
        self.raw(",\"fps\":")?;
        self.number(options.fps)?;
        self.raw(",\"bitrate_kbps\":")?;
        self.number(options.bitrate_kbps)?;
        self.raw(",\"codec\":\"")?;
        self.raw(options.codec.name())?;
        self.raw("\",\"sops\":")?;
        self.boolean(options.sops)?;
        self.raw(",\"local_audio\":")?;
        self.boolean(options.local_audio)?;
        self.raw(",\"quit_on_stop\":")?;
        self.boolean(options.quit_on_stop)?;
        if let Some(transport) = options.transport {
            self.raw(",\"transport\":\"")?;
            self.raw(transport.name())?;
            self.raw("\"")?;
        }
        if let Some(profile) = telemetry {
            self.raw(",\"telemetry\":\"")?;
            self.raw(profile.name())?;
            self.raw("\"")?;
        }
        self.raw("}")
    }
}
