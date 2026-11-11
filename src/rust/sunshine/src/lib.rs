//! Sunshine without the PC helper: the console's identity, PIN pairing, serverinfo, the app
//! list and covers over HTTP and pinned TLS, and the stream's launch and control.
//! Sans-IO; sockets are moonlight-nx2-io's.
//! Component docs and tests live in moonlight-nx2-dev/src/rust/sunshine.

#![no_std]

extern crate alloc;

pub mod apps;
pub mod control;
pub mod exchange;
pub mod hex;
pub mod http;
pub mod identity;
pub mod pairing;
pub mod random;
pub mod serverinfo;
pub mod stream;
pub mod tls;
pub mod xml;

/// The ports Sunshine serves the GameStream HTTP API on.
pub const HTTP_PORT: u16 = 47989;
pub const HTTPS_PORT: u16 = 47984;
/// The web UI where the user types the console's PIN.
pub const WEB_UI_PORT: u16 = 47990;
