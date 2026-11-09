//! Console UI: the screen state machine, settings and their store, and the page composer.
//! Port of src/native/ui; parity tests live in moonlight-nx2-dev/src/rust/ui.

#![no_std]

extern crate alloc;

pub mod badge;
pub mod bridge;
pub mod composer;
pub mod discover;
pub mod glyphs;
pub mod hosts;
pub mod inflate;
pub mod json;
pub mod model;
pub mod page;
pub mod png;
pub mod settings;
pub mod store;
pub mod text;
pub mod uppercase;
