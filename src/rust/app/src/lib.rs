//! Application controller for the Rust NRO: UI intents, authenticated control-v1 requests,
//! media preparation and the stream lifecycle. Portable and bounded; owns no SDK objects.
//! It allocates nothing itself, except `direct`, which talks to Sunshine through alloc buffers,
//! `direct_stream`, which shares the live control channel, `direct_media`, which allocates its packet and frame buffers once per stream, and
//! `ui::hosts`, which uses alloc for the saved-host book.
//! Component docs and tests live in moonlight-nx2-dev/src/rust/app.

#![no_std]

pub mod bitrate;
pub mod dock;
pub mod covers;
pub mod direct;
pub mod direct_keys;
pub mod direct_input;
pub mod direct_media;
pub mod direct_stream;
pub mod driver;
pub mod hosts;
pub mod input;
pub mod json;
pub mod link;
pub mod link_probe;
pub mod media;
pub mod metrics;
pub mod netprobe;
pub mod pads;
pub mod pairings;
pub mod policy;
pub mod pointer;
pub mod presence_watch;
pub mod reconnect;
pub mod reply;
pub mod request;
pub mod service;
pub mod stall;
pub mod stream;
pub mod suspend;
pub mod typing;
pub mod system_status;
pub mod wake;
pub mod wake_connect;

pub use moonlight_nx2_sunshine as sunshine;
