use crate::{Error, Key, LENGTH_BYTES, MAX_PLAINTEXT, TAG_BYTES};
use chacha20poly1305::{AeadInPlace, ChaCha20Poly1305, KeyInit, Nonce, Tag};
use zeroize::Zeroize;

fn nonce(counter: u64) -> Nonce {
    let mut bytes = [0; 12];
    bytes[4..].copy_from_slice(&counter.to_le_bytes());
    bytes.into()
}

fn cipher(key: &Key) -> ChaCha20Poly1305 {
    ChaCha20Poly1305::new(key.into())
}

/// One direction's sending half. Every record uses the next counter value as its nonce.
pub struct Sealer {
    key: Key,
    counter: u64,
}

impl Sealer {
    pub(crate) fn new(key: Key) -> Self {
        Self { key, counter: 0 }
    }

    /// Writes `length | ciphertext | tag` for `plaintext` into `out` and returns its size.
    pub fn seal(&mut self, plaintext: &[u8], out: &mut [u8]) -> Result<usize, Error> {
        let sealed = plaintext.len() + TAG_BYTES;
        let total = LENGTH_BYTES + sealed;
        if plaintext.is_empty() || plaintext.len() > MAX_PLAINTEXT || out.len() < total {
            return Err(Error::Record);
        }
        if self.counter == u64::MAX {
            return Err(Error::Exhausted);
        }
        let length = (sealed as u16).to_le_bytes();
        let (head, body) = out[..total].split_at_mut(LENGTH_BYTES);
        head.copy_from_slice(&length);
        let (text, tag) = body.split_at_mut(plaintext.len());
        text.copy_from_slice(plaintext);
        let computed = cipher(&self.key)
            .encrypt_in_place_detached(&nonce(self.counter), &length, text)
            .map_err(|_| Error::Record)?;
        tag.copy_from_slice(&computed);
        self.counter += 1;
        Ok(total)
    }
}

impl Drop for Sealer {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

/// One direction's receiving half. Records must arrive in the order they were sealed.
pub struct Opener {
    key: Key,
    counter: u64,
}

impl Opener {
    pub(crate) fn new(key: Key) -> Self {
        Self { key, counter: 0 }
    }

    /// The size of the record body that follows a length prefix.
    pub fn body_bytes(length: [u8; LENGTH_BYTES]) -> Result<usize, Error> {
        let sealed = usize::from(u16::from_le_bytes(length));
        if sealed <= TAG_BYTES || sealed > MAX_PLAINTEXT + TAG_BYTES {
            return Err(Error::Record);
        }
        Ok(sealed)
    }

    /// Decrypts `body` (`ciphertext | tag`) in place and returns the plaintext size.
    pub fn open(&mut self, body: &mut [u8]) -> Result<usize, Error> {
        let length = u16::try_from(body.len())
            .map_err(|_| Error::Record)?
            .to_le_bytes();
        let size = Self::body_bytes(length)? - TAG_BYTES;
        if self.counter == u64::MAX {
            return Err(Error::Exhausted);
        }
        let (text, tag) = body.split_at_mut(size);
        cipher(&self.key)
            .decrypt_in_place_detached(&nonce(self.counter), &length, text, Tag::from_slice(tag))
            .map_err(|_| Error::Record)?;
        self.counter += 1;
        Ok(size)
    }
}

impl Drop for Opener {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}
