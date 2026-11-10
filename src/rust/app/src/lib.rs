//! Application controller for the Rust NRO: UI intents, authenticated control-v1 requests,
//! media preparation and the stream lifecycle. Portable and bounded; owns no SDK objects.
//! It allocates nothing itself; `ui::hosts` uses alloc for the saved-host book.
//! Component docs and tests live in moonlight-nx2-dev/src/rust/app.

#![no_std]

pub mod bitrate;
pub mod dock;
pub mod covers;
pub mod driver;
pub mod hosts;
pub mod input;
pub mod json;
pub mod link;
pub mod link_probe;
pub mod media;
pub mod metrics;
pub mod netprobe;
pub mod policy;
pub mod presence_watch;
pub mod reply;
pub mod request;
pub mod service;
pub mod stream;
pub mod wake;
pub mod wake_connect;
