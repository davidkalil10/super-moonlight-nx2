//! Stream lifecycle states and descriptor checks (dev docs/NATIVE-CONTROL-V1.md, "Stream descriptor").
//! Playback is only reported after the runtime presents a decoded frame.

use crate::reply::{Descriptor, MediaAck};
use crate::request::{Codec, Options, Transport};
use moonlight_nx2_core::codec::{self, Capabilities, Depth, Size};

/// The current native access-unit limit.
pub const MAX_VIDEO_PAYLOAD: u32 = 1 << 20;
pub const AUDIO_RATE: u32 = 48_000;
pub const AUDIO_CHANNELS: u32 = 2;
pub const AUDIO_CHUNK_BYTES: u32 = 1920;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    Idle,
    /// Start sent; no descriptor yet.
    Starting,
    /// Descriptor accepted; media opening, no presented frame yet.
    Opening,
    /// The runtime presented a decoded frame.
    Streaming,
    /// Stop sent or media closing.
    Stopping,
    /// The PC may still own a stream; cleared by a new control connection.
    HostUncertain,
    /// Local decoder/GPU/audio resources are retained; only process exit clears this.
    Retained,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mismatch {
    Codec,
    Size,
    Fps,
    VideoAck,
    VideoPayload,
    AudioFormat,
    AudioAck,
    Transport,
    Telemetry,
}

pub fn check_telemetry(
    echo: Option<crate::reply::TelemetryEcho>,
    requested: Option<crate::request::TelemetryProfile>,
) -> Result<(), Mismatch> {
    match (echo, requested) {
        (None, None)
        | (
            Some(crate::reply::TelemetryEcho::UpstreamV1),
            Some(crate::request::TelemetryProfile::UpstreamV1),
        ) => Ok(()),
        _ => Err(Mismatch::Telemetry),
    }
}

pub fn core_codec(codec: Codec) -> codec::Codec {
    match codec {
        Codec::H264 => codec::Codec::H264,
        Codec::Hevc => codec::Codec::Hevc,
        Codec::Av1 => codec::Codec::Av1,
    }
}

/// Whether verified device evidence allows requesting these options.
pub fn supported(capabilities: &Capabilities, options: &Options) -> bool {
    let Some(size) = Size::new(options.width, options.height) else {
        return false;
    };
    capabilities.supports(core_codec(options.codec), Depth::Eight, size, options.fps)
}

/// Checks a descriptor against the accepted request; any negotiated difference is refused.
pub fn check(descriptor: &Descriptor, requested: &Options) -> Result<(), Mismatch> {
    if descriptor.codec != requested.codec {
        return Err(Mismatch::Codec);
    }
    if descriptor.width != requested.width || descriptor.height != requested.height {
        return Err(Mismatch::Size);
    }
    if descriptor.fps != requested.fps {
        return Err(Mismatch::Fps);
    }

    let video = &descriptor.video;
    if video.transport != requested.transport.unwrap_or(Transport::TcpV1)
        || (video.transport == Transport::UdpV1) != video.udp.is_some()
    {
        return Err(Mismatch::Transport);
    }
    if video.ack != MediaAck::InputV1 {
        return Err(Mismatch::VideoAck);
    }
    if video.max_payload == 0 || video.max_payload > MAX_VIDEO_PAYLOAD {
        return Err(Mismatch::VideoPayload);
    }

    let Some(audio) = &descriptor.audio else {
        return Ok(());
    };
    let format_ok = audio.rate == AUDIO_RATE && audio.channels == AUDIO_CHANNELS;
    if !format_ok || audio.chunk_bytes != AUDIO_CHUNK_BYTES {
        return Err(Mismatch::AudioFormat);
    }
    if audio.ack != MediaAck::Header {
        return Err(Mismatch::AudioAck);
    }
    Ok(())
}
