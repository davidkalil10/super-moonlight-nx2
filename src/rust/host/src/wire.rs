use crate::{Codec, Operation, StreamOptions, Transport};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum Request {
    Pair {
        host: String,
        #[serde(default = "default_timeout")]
        timeout_seconds: u32,
    },
    List {
        host: String,
    },
    Unpair {
        host: String,
    },
    Quit {
        host: String,
    },
    Start {
        host: String,
        app: String,
        options: Options,
    },
    Stop,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Options {
    #[serde(default, deserialize_with = "telemetry_profile")]
    telemetry: Option<String>,
    #[serde(default)]
    transport: WireTransport,
    width: u32,
    height: u32,
    fps: u32,
    bitrate_kbps: u32,
    codec: WireCodec,
    sops: bool,
    local_audio: bool,
    quit_on_stop: bool,
}

fn telemetry_profile<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WireCodec {
    H264,
    Hevc,
    Av1,
}

#[derive(Default, Deserialize)]
enum WireTransport {
    #[default]
    #[serde(rename = "tcp-v1")]
    Tcp,
    #[serde(rename = "udp-v1")]
    Udp,
}

fn default_timeout() -> u32 {
    120
}

impl Request {
    pub fn telemetry(&self) -> Option<&str> {
        match self {
            Self::Start { options, .. } => options.telemetry.as_deref(),
            _ => None,
        }
    }

    pub fn operation(&self) -> Operation<'_> {
        match self {
            Self::Pair {
                host,
                timeout_seconds,
            } => Operation::Pair {
                host,
                timeout_seconds: *timeout_seconds,
            },
            Self::List { host } => Operation::List { host },
            Self::Unpair { host } => Operation::Unpair { host },
            Self::Quit { host } => Operation::Quit { host },
            Self::Stop => Operation::Stop,
            Self::Start { host, app, options } => Operation::Start {
                host,
                app,
                options: StreamOptions {
                    transport: match options.transport {
                        WireTransport::Tcp => Transport::TcpV1,
                        WireTransport::Udp => Transport::UdpV1,
                    },
                    width: options.width,
                    height: options.height,
                    fps: options.fps,
                    bitrate_kbps: options.bitrate_kbps,
                    codec: match options.codec {
                        WireCodec::H264 => Codec::H264,
                        WireCodec::Hevc => Codec::Hevc,
                        WireCodec::Av1 => Codec::Av1,
                    },
                    sops: options.sops,
                    local_audio: options.local_audio,
                    quit_on_stop: options.quit_on_stop,
                },
            },
        }
    }
}
