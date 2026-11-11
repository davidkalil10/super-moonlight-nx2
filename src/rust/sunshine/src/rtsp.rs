//! The RTSP handshake Sunshine expects: OPTIONS, DESCRIBE, three SETUPs, ANNOUNCE and PLAY,
//! one request per connection.

use alloc::{format, string::String, vec::Vec};

use crate::{
    http::Response,
    launch,
    stream::{Audio, Codec, Negotiated, Request, StreamKey, encryption},
};

pub const VIDEO_PORT: u16 = 47998;
pub const CONTROL_PORT: u16 = 47999;
pub const AUDIO_PORT: u16 = 48000;
/// Asked for in ANNOUNCE; video packets carry their own FEC shape.
pub const MIN_FEC_PACKETS: u8 = 2;
const CONTROL_STREAM: &str = "streamid=control/13/0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Status(u16),
    Malformed,
    /// None of the console's codecs is offered.
    NoCodec,
    /// The host cannot encrypt the control stream.
    OldHost,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Options,
    Describe,
    SetupAudio,
    SetupVideo,
    SetupControl,
    Announce,
    Play,
    Done,
}

/// What DESCRIBE offered.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Offer {
    pub hevc: bool,
    pub av1: bool,
    pub encryption_supported: u32,
    pub encryption_requested: u32,
    pub surround: Vec<(u8, u8, u8, [u8; 8])>,
}

pub fn parse_offer(sdp: &str) -> Offer {
    let mut offer = Offer {
        hevc: sdp.contains("sprop-parameter-sets=AAAAAU"),
        av1: sdp.contains("a=rtpmap:98 AV1/90000"),
        ..Offer::default()
    };
    for line in sdp.lines().map(str::trim) {
        let number = |prefix: &str| line.strip_prefix(prefix).and_then(|value| value.trim().parse().ok());
        if let Some(flags) = number("a=x-ss-general.encryptionSupported:") {
            offer.encryption_supported = flags;
        }
        if let Some(flags) = number("a=x-ss-general.encryptionRequested:") {
            offer.encryption_requested = flags;
        }
        if let Some((_, params)) = line.split_once("surround-params=") {
            let digits: Vec<u8> = params
                .bytes()
                .take_while(u8::is_ascii_digit)
                .map(|digit| digit - b'0')
                .collect();
            if digits.len() >= 3 && digits.len() <= 11 {
                let mut mapping = [0; 8];
                for (slot, digit) in mapping.iter_mut().zip(&digits[3..]) {
                    *slot = *digit;
                }
                offer.surround.push((digits[0], digits[1], digits[2], mapping));
            }
        }
    }
    offer
}

/// Drives the handshake: `request` for each step, `accept` for its reply.
pub struct Handshake {
    host: [u8; 4],
    port: u16,
    cseq: u32,
    step: Step,
    session: Option<String>,
    request: Request,
    key: StreamKey,
    codec: Codec,
    encryption: u32,
    audio: Audio,
    video_port: u16,
    audio_port: u16,
    control_port: u16,
    video_ping: Option<[u8; 16]>,
    audio_ping: Option<[u8; 16]>,
    control_connect: u32,
}

fn host_text(host: [u8; 4]) -> String {
    format!("{}.{}.{}.{}", host[0], host[1], host[2], host[3])
}

fn stereo(channels: u8) -> Audio {
    Audio {
        channels,
        channel_mask: launch::channel_mask(channels),
        packet_duration_ms: 5,
        high_quality: false,
        streams: if channels == 2 { 1 } else { channels - channels / 2 },
        coupled_streams: if channels == 2 { 1 } else { channels / 2 - 1 },
        mapping: [0, 1, 2, 3, 4, 5, 6, 7],
    }
}

fn server_port(response: &Response, fallback: u16) -> u16 {
    response
        .header("Transport")
        .and_then(|transport| transport.split(';').find_map(|part| part.trim().strip_prefix("server_port=")))
        .and_then(|ports| ports.split('-').next())
        .and_then(|port| port.parse().ok())
        .unwrap_or(fallback)
}

fn ping_payload(response: &Response) -> Option<[u8; 16]> {
    response.header("X-SS-Ping-Payload")?.as_bytes().try_into().ok()
}

impl Handshake {
    pub fn new(host: [u8; 4], port: u16, request: Request, key: StreamKey) -> Self {
        Self {
            host,
            port,
            cseq: 0,
            step: Step::Options,
            session: None,
            audio: stereo(request.audio_channels),
            request,
            key,
            codec: Codec::H264,
            encryption: 0,
            video_port: VIDEO_PORT,
            audio_port: AUDIO_PORT,
            control_port: CONTROL_PORT,
            video_ping: None,
            audio_ping: None,
            control_connect: 0,
        }
    }

    pub fn step(&self) -> Step {
        self.step
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The bytes for the current step; none once PLAY was answered.
    pub fn request(&mut self) -> Option<Vec<u8>> {
        let url = format!("rtsp://{}:{}", host_text(self.host), self.port);
        let (method, target, extra, body) = match self.step {
            Step::Options => ("OPTIONS", url, String::new(), String::new()),
            Step::Describe => (
                "DESCRIBE",
                url,
                String::from("Accept: application/sdp\r\nIf-Modified-Since: Thu, 01 Jan 1970 00:00:00 GMT\r\n"),
                String::new(),
            ),
            Step::SetupAudio | Step::SetupVideo | Step::SetupControl => {
                let stream = match self.step {
                    Step::SetupAudio => "streamid=audio/0/0",
                    Step::SetupVideo => "streamid=video/0/0",
                    _ => CONTROL_STREAM,
                };
                (
                    "SETUP",
                    String::from(stream),
                    String::from(
                        "Transport: unicast;X-GS-ClientPort=50000-50001\r\n\
                         If-Modified-Since: Thu, 01 Jan 1970 00:00:00 GMT\r\n",
                    ),
                    String::new(),
                )
            }
            Step::Announce => {
                let sdp = self.announcement();
                let extra = format!("Content-type: application/sdp\r\nContent-length: {}\r\n", sdp.len());
                ("ANNOUNCE", String::from(CONTROL_STREAM), extra, sdp)
            }
            Step::Play => ("PLAY", String::from("/"), String::new(), String::new()),
            Step::Done => return None,
        };
        self.cseq += 1;
        let session = self
            .session
            .as_ref()
            .map(|session| format!("Session: {session}\r\n"))
            .unwrap_or_default();
        let text = format!(
            "{method} {target} RTSP/1.0\r\nCSeq: {}\r\nX-GS-ClientVersion: 14\r\nHost: {}\r\n{session}{extra}\r\n{body}",
            self.cseq,
            host_text(self.host)
        );
        Some(text.into_bytes())
    }

    /// Takes the reply to the current step and moves on.
    pub fn accept(&mut self, response: &Response) -> Result<Step, Error> {
        if response.status != 200 {
            return Err(Error::Status(response.status));
        }
        match self.step {
            Step::Options => self.step = Step::Describe,
            Step::Describe => {
                let sdp = core::str::from_utf8(&response.body).map_err(|_| Error::Malformed)?;
                self.choose(&parse_offer(sdp))?;
                self.step = Step::SetupAudio;
            }
            Step::SetupAudio | Step::SetupVideo | Step::SetupControl => {
                let session = response
                    .header("Session")
                    .and_then(|session| session.split(';').next())
                    .map(str::trim)
                    .filter(|session| !session.is_empty());
                if let Some(session) = session {
                    self.session = Some(String::from(session));
                }
                self.step = match self.step {
                    Step::SetupAudio => {
                        self.audio_port = server_port(response, AUDIO_PORT);
                        self.audio_ping = ping_payload(response);
                        Step::SetupVideo
                    }
                    Step::SetupVideo => {
                        self.video_port = server_port(response, VIDEO_PORT);
                        self.video_ping = ping_payload(response);
                        Step::SetupControl
                    }
                    _ => {
                        self.control_port = server_port(response, CONTROL_PORT);
                        self.control_connect = response
                            .header("X-SS-Connect-Data")
                            .and_then(|data| data.parse().ok())
                            .unwrap_or(0);
                        Step::Announce
                    }
                };
                if self.session.is_none() {
                    return Err(Error::Malformed);
                }
            }
            Step::Announce => self.step = Step::Play,
            Step::Play => self.step = Step::Done,
            Step::Done => {}
        }
        Ok(self.step)
    }

    fn choose(&mut self, offer: &Offer) -> Result<(), Error> {
        let offered = |codec: &Codec| match codec {
            Codec::H264 => true,
            Codec::Hevc => offer.hevc,
            Codec::Av1 => offer.av1,
        };
        self.codec = *self.request.codecs.iter().find(|codec| offered(codec)).ok_or(Error::NoCodec)?;
        if offer.encryption_supported & encryption::CONTROL_V2 == 0 {
            return Err(Error::OldHost);
        }
        let wanted = offer.encryption_requested | encryption::CONTROL_V2 | encryption::AUDIO;
        self.encryption = offer.encryption_supported & wanted;
        let channels = self.audio.channels;
        if let Some(&(_, streams, coupled, mapping)) =
            offer.surround.iter().find(|(count, ..)| *count == channels)
        {
            self.audio.streams = streams;
            self.audio.coupled_streams = coupled;
            self.audio.mapping = mapping;
        }
        Ok(())
    }

    fn announcement(&self) -> String {
        let request = &self.request;
        let host = host_text(self.host);
        let bitrate = request.bitrate_kbps;
        let hevc = u8::from(self.codec == Codec::Hevc);
        let csc = if request.hdr { 4 } else { 2 };
        let surround = u8::from(self.audio.channels > 2);
        let lines = [
            format!("x-nv-general.serverAddress:rtsp://{host}:{}", self.port),
            format!("x-nv-video[0].clientViewportWd:{}", request.width),
            format!("x-nv-video[0].clientViewportHt:{}", request.height),
            format!("x-nv-video[0].maxFPS:{}", request.fps),
            format!("x-nv-video[0].packetSize:{}", request.packet_size),
            String::from("x-nv-video[0].rateControlMode:4"),
            String::from("x-nv-video[0].timeoutLengthMs:7000"),
            String::from("x-nv-video[0].framesWithInvalidRefThreshold:0"),
            format!("x-nv-video[0].initialBitrateKbps:{bitrate}"),
            format!("x-nv-video[0].initialPeakBitrateKbps:{bitrate}"),
            format!("x-nv-vqos[0].bw.minimumBitrateKbps:{bitrate}"),
            format!("x-nv-vqos[0].bw.maximumBitrateKbps:{bitrate}"),
            format!("x-ml-video.configuredBitrateKbps:{bitrate}"),
            String::from("x-nv-vqos[0].fec.enable:1"),
            String::from("x-nv-vqos[0].videoQualityScoreUpdateTime:5000"),
            String::from("x-nv-vqos[0].qosTrafficType:5"),
            String::from("x-nv-aqos.qosTrafficType:4"),
            String::from("x-nv-general.featureFlags:167"),
            String::from("x-ml-general.featureFlags:0"),
            format!("x-ss-general.encryptionEnabled:{}", self.encryption),
            format!("x-nv-vqos[0].fec.minRequiredFecPackets:{MIN_FEC_PACKETS}"),
            String::from("x-nv-vqos[0].bllFec.enable:0"),
            String::from("x-nv-vqos[0].drc.enable:0"),
            String::from("x-nv-general.enableRecoveryMode:0"),
            String::from("x-nv-video[0].videoEncoderSlicesPerFrame:1"),
            format!("x-nv-clientSupportHevc:{hevc}"),
            format!("x-nv-vqos[0].bitStreamFormat:{}", self.codec as u8),
            format!("x-nv-video[0].dynamicRangeMode:{}", u8::from(request.hdr)),
            String::from("x-nv-video[0].maxNumReferenceFrames:1"),
            String::from("x-ss-video[0].chromaSamplingType:0"),
            String::from("x-ss-video[0].intraRefresh:0"),
            format!("x-nv-video[0].encoderCscMode:{csc}"),
            format!("x-nv-audio.surround.numChannels:{}", self.audio.channels),
            format!("x-nv-audio.surround.channelMask:{}", self.audio.channel_mask),
            format!("x-nv-audio.surround.enable:{surround}"),
            format!("x-nv-audio.surround.AudioQuality:{}", u8::from(self.audio.high_quality)),
            format!("x-nv-aqos.packetDuration:{}", self.audio.packet_duration_ms),
            String::from("x-nv-general.useReliableUdp:13"),
            String::from("x-nv-ri.useControlChannel:1"),
        ];
        let mut sdp = format!("v=0\r\no=android 0 14 IN IPv4 {host}\r\ns=NVIDIA Streaming Client\r\n");
        for line in lines {
            sdp.push_str("a=");
            sdp.push_str(&line);
            sdp.push_str(" \r\n");
        }
        sdp.push_str(&format!("t=0 0\r\nm=video {} \r\n", self.video_port));
        sdp
    }

    /// The settled stream, once PLAY was answered.
    pub fn negotiated(&self) -> Option<Negotiated> {
        (self.step == Step::Done).then(|| Negotiated {
            host: self.host,
            video_port: self.video_port,
            audio_port: self.audio_port,
            control_port: self.control_port,
            video_ping: self.video_ping,
            audio_ping: self.audio_ping,
            control_connect: self.control_connect,
            key: self.key.clone(),
            encryption: self.encryption,
            codec: self.codec,
            width: self.request.width,
            height: self.request.height,
            fps: self.request.fps,
            hdr: self.request.hdr,
            packet_size: self.request.packet_size,
            min_fec_packets: MIN_FEC_PACKETS,
            audio: self.audio,
        })
    }
}
