//! The platform random source, as the RNG the crypto crates take.

use core::fmt;

pub type Fill = fn(&mut [u8]) -> bool;

#[derive(Clone, Copy)]
pub struct Random(pub Fill);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Unavailable;

impl fmt::Display for Unavailable {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("no random source")
    }
}

impl core::error::Error for Unavailable {}

impl fmt::Debug for Random {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Random")
    }
}

impl Random {
    pub fn fill(&self, bytes: &mut [u8]) -> Result<(), Unavailable> {
        if (self.0)(bytes) {
            Ok(())
        } else {
            Err(Unavailable)
        }
    }

    pub fn array<const N: usize>(&self) -> Result<[u8; N], Unavailable> {
        let mut bytes = [0; N];
        self.fill(&mut bytes)?;
        Ok(bytes)
    }
}

impl rand_core::TryRng for Random {
    type Error = Unavailable;

    fn try_next_u32(&mut self) -> Result<u32, Unavailable> {
        self.array().map(u32::from_le_bytes)
    }

    fn try_next_u64(&mut self) -> Result<u64, Unavailable> {
        self.array().map(u64::from_le_bytes)
    }

    fn try_fill_bytes(&mut self, bytes: &mut [u8]) -> Result<(), Unavailable> {
        self.fill(bytes)
    }
}

impl rand_core::TryCryptoRng for Random {}
