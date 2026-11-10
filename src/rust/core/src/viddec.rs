//! Codec selection for the SDK's video decoder (`viddec.h`): the codec value, the work memory
//! and the configure buffer a session is initialized with.

use crate::{
    annexb, av1,
    codec::{Codec, Size},
    video_wire,
};

pub const CODEC_CONFIG_MAX: usize = 1024;
/// `ViddecCodec` values.
pub const CODEC_H264: u32 = 0;
pub const CODEC_AV1: u32 = 3;
/// Not in the SDK's enum, which skips 2. The service refused 2 at initialize when the retail
/// client's process tried it on 2026-11-07, so HEVC here is an experiment, not a codec.
pub const CODEC_HEVC_GUESS: u32 = 2;
const WORK_BYTES_1080P: usize = 64 << 20;
const PIXELS_1080P: usize = 1920 * 1080;
const AV1_MIME: &[u8] = b"video/av1\0";

/// What the configure buffer of an AV1 session carries. The header documents H.264 only.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Av1Config {
    /// The MIME string the retail client sends. It decoded on the console from that client's
    /// process, with the sequence header in band.
    Mime,
    /// The stream's sequence header OBU, by analogy with the documented H.264 SPS and PPS.
    SequenceHeader,
    Empty,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Session {
    pub codec: u32,
    pub work_bytes: usize,
}

/// 64 MiB carried H.264 at 1080p on the console; larger pictures get it once per 1080p of area.
fn work_bytes_by_area(display: Size) -> usize {
    let pixels = display.width() as usize * display.height() as usize;
    WORK_BYTES_1080P * pixels.div_ceil(PIXELS_1080P)
}

/// `None` for a codec the service has no value for.
pub fn session(codec: Codec, display: Size) -> Option<Session> {
    let (codec, work_bytes) = match codec {
        Codec::H264 => (CODEC_H264, work_bytes_by_area(display)),
        Codec::Av1 => (CODEC_AV1, video_wire::av1_workspace_bytes(display) as usize),
        Codec::Hevc => (CODEC_HEVC_GUESS, work_bytes_by_area(display)),
        Codec::Vp9 => return None,
    };
    Some(Session { codec, work_bytes })
}

/// Writes the configure buffer for a stream that starts with `first_unit` and returns its
/// length. `None` when the unit lacks what the buffer needs or `out` is too small.
pub fn codec_config(
    codec: Codec,
    av1: Av1Config,
    first_unit: &[u8],
    out: &mut [u8],
) -> Option<usize> {
    let copy = |bytes: &[u8], out: &mut [u8]| {
        out.get_mut(..bytes.len())?.copy_from_slice(bytes);
        Some(bytes.len())
    };
    match (codec, av1) {
        (Codec::H264, _) => annexb::h264_parameter_sets(first_unit, out),
        (Codec::Hevc, _) => annexb::hevc_parameter_sets(first_unit, out),
        (Codec::Av1, Av1Config::Mime) => copy(AV1_MIME, out),
        (Codec::Av1, Av1Config::SequenceHeader) => copy(av1::sequence_header(first_unit)?, out),
        (Codec::Av1, Av1Config::Empty) => Some(0),
        (Codec::Vp9, _) => None,
    }
}
