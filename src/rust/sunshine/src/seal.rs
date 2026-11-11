//! The encrypted control framing of moonlight-common-c (`ControlStream.c`): a type and length
//! header, AES-128-GCM under the launch's rikey, and a per-message sequence that is the IV.
//! The control channel counts one sequence across every message the client sends; this is the
//! framing it applies, kept apart so the byte layout is tested against the C library.

use aes_gcm::aead::consts::U16;
use aes_gcm::{Aes128Gcm, AesGcm, KeyInit, aead::AeadInOut};
use alloc::vec::Vec;

const ENCRYPTED_TYPE: u16 = 0x0001;
const TAG_BYTES: usize = 16;
const SEQ_BYTES: usize = 4;
const HEADER_BYTES: usize = 2 + 2 + SEQ_BYTES;
const MESSAGE_HEADER_BYTES: usize = 4;
const CLIENT_ORIGIN: u8 = b'C';
const HOST_ORIGIN: u8 = b'H';
const CONTROL_STREAM: u8 = b'C';

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    TooLarge,
    Runt,
    Length,
    Authentication,
}

/// Encrypts the client's control messages and opens the host's.
pub struct Cipher {
    key: [u8; 16],
    sequence: u32,
    v2: bool,
}

impl Cipher {
    /// `v2` is Sunshine's control encryption v2: a 12-byte IV of the sequence and the origin.
    /// Older hosts take a 16-byte IV that holds only the sequence's low byte.
    pub fn new(key: [u8; 16], v2: bool) -> Self {
        Self {
            key,
            sequence: 0,
            v2,
        }
    }

    pub fn sequence(&self) -> u32 {
        self.sequence
    }

    /// Frames and encrypts one message and counts it.
    pub fn seal(&mut self, kind: u16, payload: &[u8]) -> Result<Vec<u8>, Error> {
        let sequence = self.sequence;
        let sealed = self.seal_at(sequence, kind, payload)?;
        self.sequence = sequence.wrapping_add(1);
        Ok(sealed)
    }

    pub fn seal_at(&self, sequence: u32, kind: u16, payload: &[u8]) -> Result<Vec<u8>, Error> {
        let inner = MESSAGE_HEADER_BYTES + payload.len();
        let length = u16::try_from(SEQ_BYTES + TAG_BYTES + inner).map_err(|_| Error::TooLarge)?;
        let mut out = Vec::with_capacity(HEADER_BYTES + TAG_BYTES + inner);
        out.extend_from_slice(&ENCRYPTED_TYPE.to_le_bytes());
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(&sequence.to_le_bytes());
        out.extend_from_slice(&[0; TAG_BYTES]);
        out.extend_from_slice(&kind.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        out.extend_from_slice(payload);
        let (head, body) = out.split_at_mut(HEADER_BYTES + TAG_BYTES);
        let tag = self.encrypt(sequence, CLIENT_ORIGIN, body)?;
        head[HEADER_BYTES..].copy_from_slice(&tag);
        Ok(out)
    }

    /// The type and payload of one encrypted host message.
    pub fn open(&self, message: &[u8]) -> Result<(u16, Vec<u8>), Error> {
        if message.len() < HEADER_BYTES + TAG_BYTES + MESSAGE_HEADER_BYTES {
            return Err(Error::Runt);
        }
        let length = usize::from(u16::from_le_bytes([message[2], message[3]]));
        if u16::from_le_bytes([message[0], message[1]]) != ENCRYPTED_TYPE
            || length + 4 != message.len()
        {
            return Err(Error::Length);
        }
        let sequence = u32::from_le_bytes([message[4], message[5], message[6], message[7]]);
        let tag = &message[HEADER_BYTES..HEADER_BYTES + TAG_BYTES];
        let mut body = message[HEADER_BYTES + TAG_BYTES..].to_vec();
        self.decrypt(sequence, HOST_ORIGIN, &mut body, tag)?;
        let kind = u16::from_le_bytes([body[0], body[1]]);
        let payload_length = usize::from(u16::from_le_bytes([body[2], body[3]]));
        if payload_length != body.len() - MESSAGE_HEADER_BYTES {
            return Err(Error::Length);
        }
        Ok((kind, body.split_off(MESSAGE_HEADER_BYTES)))
    }

    fn iv(&self, sequence: u32, origin: u8) -> [u8; 16] {
        let mut iv = [0u8; 16];
        if self.v2 {
            iv[..SEQ_BYTES].copy_from_slice(&sequence.to_le_bytes());
            iv[10] = origin;
            iv[11] = CONTROL_STREAM;
        } else {
            iv[0] = sequence as u8;
        }
        iv
    }

    fn encrypt(&self, sequence: u32, origin: u8, body: &mut [u8]) -> Result<[u8; 16], Error> {
        let iv = self.iv(sequence, origin);
        let tag = if self.v2 {
            let cipher = Aes128Gcm::new_from_slice(&self.key).map_err(|_| Error::Authentication)?;
            cipher.encrypt_inout_detached(
                (&iv[..12]).try_into().map_err(|_| Error::Length)?,
                &[],
                body.into(),
            )
        } else {
            let cipher = AesGcm::<aes::Aes128, U16>::new_from_slice(&self.key)
                .map_err(|_| Error::Authentication)?;
            cipher.encrypt_inout_detached((&iv).into(), &[], body.into())
        };
        let tag = tag.map_err(|_| Error::Authentication)?;
        Ok(tag.into())
    }

    fn decrypt(&self, sequence: u32, origin: u8, body: &mut [u8], tag: &[u8]) -> Result<(), Error> {
        let iv = self.iv(sequence, origin);
        let tag = aes_gcm::Tag::try_from(tag).map_err(|_| Error::Authentication)?;
        let opened = if self.v2 {
            let cipher = Aes128Gcm::new_from_slice(&self.key).map_err(|_| Error::Authentication)?;
            cipher.decrypt_inout_detached(
                (&iv[..12]).try_into().map_err(|_| Error::Length)?,
                &[],
                body.into(),
                &tag,
            )
        } else {
            let cipher = AesGcm::<aes::Aes128, U16>::new_from_slice(&self.key)
                .map_err(|_| Error::Authentication)?;
            cipher.decrypt_inout_detached((&iv).into(), &[], body.into(), &tag)
        };
        opened.map_err(|_| Error::Authentication)
    }
}
