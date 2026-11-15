//! The modes the SDK video decoder is offered for, kept apart from the decoder so the host can
//! check them.

use moonlight_nx2_core::codec::{Capabilities, Codec, Depth, Evidence, Mode, Size};

/// Enable only in a commit citing matching pixel sums and a clean close on the console.
pub const SDK_H264_VERIFIED: bool = true;
/// AV1 stays out of the stream offer until the diagnostic shows matching sums on the console.
pub const SDK_AV1_VERIFIED: bool = true;
/// AV1 at 2160p60, configured at 30 (`viddec::session`): a real stream decoded, showed 914 of
/// 1139 frames and closed cleanly on the console (3cf0628, 20261110T121625Z-3cf0628-sdk-
/// integration/docked-modes/collected/runtime-000000629006da48.log).
pub const SDK_AV1_2160P_VERIFIED: bool = true;
/// H.264 at 2160p decoded 60 fed frames a second in the diagnostic with the decoder full on
/// nearly every turn, and has not streamed: 2160p is AV1 only.
pub const SDK_H264_2160P_VERIFIED: bool = false;
/// 120 units a second were decoded at 1440p on AV1 by a decoder configured at 60, in a real
/// stream on the console (2026-11-10). The display decides whether 120 is offered.
pub const FAST_FPS: u32 = 120;
const fn offered(verified: bool, fps: u32) -> u32 {
    if verified { fps } else { 0 }
}
/// Largest size per tier and the highest rate offered on AV1 and on H.264, 0 for none. AV1
/// comes first and a tier may be offered on it alone: H.264 is the fallback, not a condition.
const MODES: [(u32, u32, u32, u32); 3] = [
    (1920, 1080, FAST_FPS, FAST_FPS),
    (2560, 1440, FAST_FPS, FAST_FPS),
    (
        3840,
        2160,
        offered(SDK_AV1_2160P_VERIFIED, 60),
        offered(SDK_H264_2160P_VERIFIED, 60),
    ),
];
pub fn verified(codec: Codec) -> bool {
    match codec {
        Codec::H264 => SDK_H264_VERIFIED,
        Codec::Av1 => SDK_AV1_VERIFIED,
        Codec::Hevc | Codec::Vp9 => false,
    }
}

/// Every verified codec at each tier's largest size and highest offered rate.
pub fn capabilities() -> Capabilities {
    let mut capabilities = Capabilities::default();
    for (width, height, av1, h264) in MODES {
        for (codec, fps) in [(Codec::Av1, av1), (Codec::H264, h264)] {
            if verified(codec) && fps != 0 {
                capabilities.record(
                    Mode {
                        codec,
                        depth: Depth::Eight,
                        maximum: Size::new(width, height).unwrap(),
                        fps,
                    },
                    Evidence::PixelsAndCloseVerified,
                );
            }
        }
    }
    capabilities
}
