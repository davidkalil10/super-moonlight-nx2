//! Codec selection for the SDK's video decoder (`viddec.h`): the codec value, the work memory
//! and the configure buffer a session is initialized with.

use crate::{
    annexb,
    codec::{Codec, Size},
    video_wire,
};

pub const CODEC_CONFIG_MAX: usize = 1024;
/// `ViddecCodec` values.
pub const CODEC_H264: u32 = 0;
pub const CODEC_AV1: u32 = 3;
const WORK_BYTES_1080P: usize = 64 << 20;
const PIXELS_1080P: usize = 1920 * 1080;
/// What the retail client sends for AV1; the sequence header stays in band. The console
/// decoded the reference clip with it on 2026-11-10.
const AV1_MIME: &[u8] = b"video/av1\0";

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

/// `None` for a codec the service has no value for. HEVC is one: the enum skips 2 and the
/// service refused it at initialize (0x17986f) on 2026-11-10.
pub fn session(codec: Codec, display: Size) -> Option<Session> {
    let (codec, work_bytes) = match codec {
        Codec::H264 => (CODEC_H264, work_bytes_by_area(display)),
        Codec::Av1 => (CODEC_AV1, video_wire::av1_workspace_bytes(display) as usize),
        Codec::Hevc | Codec::Vp9 => return None,
    };
    Some(Session { codec, work_bytes })
}

/// Writes the configure buffer for a stream that starts with `first_unit` and returns its
/// length. `None` when the unit lacks what the buffer needs or `out` is too small.
pub fn codec_config(codec: Codec, first_unit: &[u8], out: &mut [u8]) -> Option<usize> {
    match codec {
        Codec::H264 => annexb::h264_parameter_sets(first_unit, out),
        Codec::Av1 => {
            out.get_mut(..AV1_MIME.len())?.copy_from_slice(AV1_MIME);
            Some(AV1_MIME.len())
        }
        Codec::Hevc | Codec::Vp9 => None,
    }
}
