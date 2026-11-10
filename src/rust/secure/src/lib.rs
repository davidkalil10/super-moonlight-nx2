//! MNS1: the authenticated, encrypted connection between a paired console and its PC helper.
//! A SPAKE2 handshake from a short code (pairing) or the stored pairing key (session), key
//! confirmation over the transcript, then ChaCha20-Poly1305 records. No IO here: both ends
//! feed and take byte arrays. Design: lead/PERSISTENT-SESSION.md.

#![no_std]

mod handshake;
mod record;

pub use handshake::{Established, Hello, Initiator, Pending, refuse};
pub use record::{Opener, Sealer};

pub const MAGIC: [u8; 4] = *b"MNS1";
pub const VERSION: u8 = 1;
/// The TCP port a helper service listens on unless told otherwise.
pub const PORT: u16 = 39381;
pub const ID_BYTES: usize = 16;
pub const KEY_BYTES: usize = 32;
pub const CODE_DIGITS: usize = 8;
pub const HELLO_BYTES: usize = 55;
pub const ANSWER_BYTES: usize = 87;
pub const FINISH_BYTES: usize = 32;
/// Largest plaintext one record carries.
pub const MAX_PLAINTEXT: usize = 4096;
pub const TAG_BYTES: usize = 16;
pub const LENGTH_BYTES: usize = 2;
pub const MAX_RECORD: usize = LENGTH_BYTES + MAX_PLAINTEXT + TAG_BYTES;
/// The MNC1 token used inside a session: both ends are already authenticated.
pub const SESSION_TOKEN: [u8; 64] = [b'0'; 64];

pub type Id = [u8; ID_BYTES];
pub type Key = [u8; KEY_BYTES];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    /// The password is the code the console shows.
    Pair = 1,
    /// The password is the pairing key both ends stored.
    Session = 2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Ok = 0,
    UnknownConsole = 1,
    PairingUnavailable = 2,
    Version = 3,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Malformed,
    Version,
    /// The helper declined; unauthenticated, so only good for ending the attempt.
    Refused(Status),
    /// The other end does not hold the same code or key.
    Confirm,
    Record,
    Exhausted,
}

/// A random source the caller vouches for: the operating system's on the PC, the console's
/// kernel-seeded generator in the NRO.
pub struct Random<F: FnMut(&mut [u8])>(pub F);

impl<F: FnMut(&mut [u8])> rand_core::RngCore for Random<F> {
    fn next_u32(&mut self) -> u32 {
        let mut bytes = [0; 4];
        (self.0)(&mut bytes);
        u32::from_le_bytes(bytes)
    }
    fn next_u64(&mut self) -> u64 {
        let mut bytes = [0; 8];
        (self.0)(&mut bytes);
        u64::from_le_bytes(bytes)
    }
    fn fill_bytes(&mut self, bytes: &mut [u8]) {
        (self.0)(bytes);
    }
    fn try_fill_bytes(&mut self, bytes: &mut [u8]) -> Result<(), rand_core::Error> {
        (self.0)(bytes);
        Ok(())
    }
}

impl<F: FnMut(&mut [u8])> rand_core::CryptoRng for Random<F> {}

/// Whether `code` is a pairing code: exactly eight ASCII digits.
pub fn code_ok(code: &[u8]) -> bool {
    code.len() == CODE_DIGITS && code.iter().all(u8::is_ascii_digit)
}

/// An eight-digit code, uniform over 00000000..=99999999.
pub fn new_code<F: FnMut(&mut [u8])>(random: &mut Random<F>) -> [u8; CODE_DIGITS] {
    use rand_core::RngCore;
    const LIMIT: u32 = u32::MAX - u32::MAX % 100_000_000;
    let value = loop {
        let value = random.next_u32();
        if value < LIMIT {
            break value % 100_000_000;
        }
    };
    let mut code = [b'0'; CODE_DIGITS];
    let mut rest = value;
    for digit in code.iter_mut().rev() {
        *digit = b'0' + (rest % 10) as u8;
        rest /= 10;
    }
    code
}
