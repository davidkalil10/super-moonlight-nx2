//! Connected UDP video transport with a separate TCP feedback channel.

mod receiver;
pub mod wire;

pub use receiver::{CloseError, Error, Receiver, Stats, Unit};

use crate::socket::IoError;

pub const UNIT_SLOTS: usize = 8;
pub const MAX_PAYLOAD: usize = 1 << 20;
pub const MAX_DATAGRAM: usize = wire::HEADER_BYTES + wire::FRAGMENT_BYTES;

/// One nonblocking datagram socket connected to the authenticated control peer's endpoint.
/// Receives preserve message boundaries; zero bytes is a datagram, not EOF.
pub trait Datagram {
    fn poll_connect(&mut self) -> Result<bool, IoError>;
    /// Accepts the entire datagram or returns an error. Never sends a remaining byte tail.
    fn send(&mut self, bytes: &[u8]) -> Result<(), IoError>;
    /// The receiver supplies MAX_DATAGRAM + 1 bytes to detect oversized messages.
    fn recv(&mut self, bytes: &mut [u8]) -> Result<usize, IoError>;
    fn close(&mut self) -> Result<(), IoError>;
    /// Optional monotonic measurement for the drain-time counter.
    fn now_us(&self) -> Option<u64> {
        None
    }
}

pub struct Config {
    pub feedback_token: [u8; 64],
    pub udp_token: [u8; 64],
    pub max_payload: usize,
    pub deadline_us: u64,
    pub spread_us: u64,
    pub pace_bytes_per_ms: u32,
    pub hello_ms: u32,
    pub connect_timeout_us: u64,
    pub datagram_budget: usize,
}

pub struct Memory<'a> {
    pub units: &'a mut [u8],
    pub feedback: &'a mut [u8],
}
