#![cfg_attr(target_os = "none", no_std)]

#[cfg(all(target_os = "none", feature = "host-renderer"))]
compile_error!("host-renderer is only for host parity tests");
#[cfg(any(
    all(feature = "diagnostic-renderer", feature = "diagnostic-io"),
    all(feature = "diagnostic-ui", feature = "diagnostic-renderer"),
    all(feature = "diagnostic-ui", feature = "diagnostic-io"),
    all(feature = "diagnostic-ui-data", feature = "diagnostic-ui-order"),
    all(feature = "diagnostic-ui-alpha", feature = "diagnostic-ui-text"),
    all(feature = "diagnostic-udp", feature = "diagnostic-renderer"),
    all(feature = "diagnostic-udp", feature = "diagnostic-io"),
    all(feature = "diagnostic-udp", feature = "diagnostic-ui"),
    all(feature = "frontend", feature = "diagnostic-renderer"),
    all(feature = "frontend", feature = "diagnostic-ui"),
    all(feature = "frontend", feature = "diagnostic-io"),
    all(feature = "frontend", feature = "diagnostic-udp")
))]
compile_error!("select one device diagnostic mode");

#[cfg(all(
    feature = "diagnostic-audio-cue",
    any(
        feature = "diagnostic-renderer",
        feature = "diagnostic-io",
        feature = "diagnostic-udp",
        feature = "diagnostic-ui",
        feature = "frontend"
    )
))]
compile_error!("Audio cue is a separate diagnostic mode");

use moonlight_nx2_core::input::{self, Pad};

#[cfg(not(any(target_os = "none", feature = "host-renderer")))]
use ash as _;
#[cfg(not(any(target_os = "none", feature = "host-renderer")))]
use moonlight_nx2_app as _;
#[cfg(not(target_os = "none"))]
use moonlight_nx2_io as _;
#[cfg(not(any(feature = "diagnostic-ui", feature = "host-renderer")))]
use moonlight_nx2_ui as _;

#[cfg(all(target_os = "none", feature = "diagnostic-audio-cue"))]
mod audio_cue_diagnostic;
#[cfg(target_os = "none")]
pub mod audio_device;
#[cfg(target_os = "none")]
mod device;
#[cfg(all(target_os = "none", feature = "frontend"))]
mod frontend_stream;
#[cfg(all(target_os = "none", feature = "diagnostic-io"))]
mod io_diagnostic;
#[cfg(all(target_os = "none", feature = "frontend"))]
mod native_frontend;
#[cfg(target_os = "none")]
pub mod net;
#[cfg(all(target_os = "none", feature = "diagnostic-sdk-decode"))]
mod ref_replay;
#[cfg(all(target_os = "none", feature = "diagnostic-udp"))]
mod udp_diagnostic;

#[cfg(any(target_os = "none", feature = "host-renderer"))]
mod cache_file;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod client;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod client_session;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod control_link;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod display;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod files;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod frontend;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod frontend_media;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod hid;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod media_session;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
mod policy_badge;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod render;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
mod render_platform;
#[cfg(target_os = "none")]
pub mod sdk;
#[cfg(all(target_os = "none", feature = "frontend"))]
mod sdk_video;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod stream_stats;
#[cfg(all(target_os = "none", feature = "frontend"))]
mod system;
#[cfg(any(feature = "diagnostic-ui", feature = "host-renderer"))]
pub mod ui_diagnostic;
#[cfg(any(target_os = "none", feature = "host-renderer"))]
pub mod video;

pub use moonlight_nx2_core::frame_registration;

#[unsafe(export_name = "moonlightMapPad")]
pub extern "C" fn map_pad(
    connected: bool,
    buttons: u64,
    lx: i32,
    ly: i32,
    rx: i32,
    ry: i32,
) -> Pad {
    input::map_pad(connected, buttons, [lx, ly, rx, ry])
}

#[unsafe(export_name = "moonlightStopHeld")]
pub extern "C" fn stop_held(buttons: u64) -> bool {
    input::stop_held(buttons)
}
