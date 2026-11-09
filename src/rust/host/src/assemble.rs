use moonlight_nx2_core::media::Header;
use std::collections::VecDeque;

pub const MAX_VIDEO_BYTES: usize = 1024 * 1024;
pub const MAX_BUFFERED_VIDEO_BYTES: usize = MAX_VIDEO_BYTES * 2;
pub const MAX_VIDEO_METADATA: usize = 128;
pub const PCM_BYTES: usize = 1920;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    TooLarge,
    OutOfOrder,
    Full,
    Truncated,
    Ended,
    NoRecord,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Metadata {
    pub sequence: u64,
    pub bytes: usize,
    pub pts_us: u64,
    pub keyframe: bool,
}

pub struct VideoRecord<'a> {
    pub header: Header,
    pub keyframe: bool,
    pub payload: &'a [u8],
}

#[derive(Default)]
pub struct Video {
    data: Vec<u8>,
    offset: usize,
    metadata: VecDeque<Metadata>,
    last_sequence: Option<u64>,
    data_ended: bool,
    metadata_ended: bool,
}

impl Video {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn buffered_bytes(&self) -> usize {
        self.data.len() - self.offset
    }
    pub fn push_data(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if self.data_ended {
            return Err(Error::Ended);
        }
        if bytes.len() > MAX_BUFFERED_VIDEO_BYTES - self.buffered_bytes() {
            return Err(Error::Full);
        }
        if self.offset != 0 && self.data.len() + bytes.len() > MAX_BUFFERED_VIDEO_BYTES {
            self.data.drain(..self.offset);
            self.offset = 0;
        }
        self.data.extend_from_slice(bytes);
        Ok(())
    }
    pub fn announce(&mut self, meta: Metadata) -> Result<(), Error> {
        if self.metadata_ended {
            return Err(Error::Ended);
        }
        if meta.bytes == 0 {
            return Err(Error::Invalid);
        }
        if meta.bytes > MAX_VIDEO_BYTES {
            return Err(Error::TooLarge);
        }
        if self
            .last_sequence
            .is_some_and(|last| last.checked_add(1) != Some(meta.sequence))
        {
            return Err(Error::OutOfOrder);
        }
        if self.metadata.len() == MAX_VIDEO_METADATA {
            return Err(Error::Full);
        }
        self.metadata.push_back(meta);
        self.last_sequence = Some(meta.sequence);
        Ok(())
    }
    pub fn peek(&self) -> Result<Option<VideoRecord<'_>>, Error> {
        if let Some(meta) = self.metadata.front()
            && self.buffered_bytes() >= meta.bytes
        {
            return Ok(Some(VideoRecord {
                header: Header {
                    payload_bytes: meta.bytes as u32,
                    sequence: meta.sequence as u32,
                    pts_us: meta.pts_us,
                },
                keyframe: meta.keyframe,
                payload: &self.data[self.offset..self.offset + meta.bytes],
            }));
        }
        if self.data_ended && self.metadata_ended {
            if self.metadata.is_empty() && self.buffered_bytes() == 0 {
                return Err(Error::Ended);
            }
            return Err(Error::Truncated);
        }
        Ok(None)
    }
    pub fn consume(&mut self) -> Result<(), Error> {
        if self.peek()?.is_none() {
            return Err(Error::NoRecord);
        }
        let meta = self.metadata.pop_front().expect("ready metadata");
        self.offset += meta.bytes;
        if self.offset == self.data.len() {
            self.data.clear();
            self.offset = 0;
        }
        Ok(())
    }
    pub fn end_data(&mut self) {
        self.data_ended = true;
    }
    pub fn end_metadata(&mut self) {
        self.metadata_ended = true;
    }
}

pub const MAX_PCM_PENDING: usize = PCM_BYTES * 10;

#[derive(Default)]
pub struct Pcm {
    bytes: Vec<u8>,
    offset: usize,
    sequence: u64,
    dropped_bytes: u64,
    ended: bool,
}
impl Pcm {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn buffered_bytes(&self) -> usize {
        self.bytes.len() - self.offset
    }
    pub fn dropped_bytes(&self) -> u64 {
        self.dropped_bytes
    }
    pub fn feed(&mut self, input: &[u8]) -> Result<usize, Error> {
        if self.ended {
            return Err(Error::Ended);
        }
        let total = self
            .buffered_bytes()
            .checked_add(input.len())
            .ok_or(Error::TooLarge)?;
        let excess = total.saturating_sub(MAX_PCM_PENDING);
        let discard = excess.div_ceil(PCM_BYTES).min(total / PCM_BYTES) * PCM_BYTES;
        let from_old = discard.min(self.buffered_bytes());
        self.offset += from_old;
        let from_new = discard - from_old;
        self.dropped_bytes = self.dropped_bytes.saturating_add(discard as u64);
        if self.offset != 0 {
            self.bytes.drain(..self.offset);
            self.offset = 0;
        }
        self.bytes.extend_from_slice(&input[from_new..]);
        Ok(input.len())
    }
    pub fn peek(&self) -> Result<Option<(Header, &[u8])>, Error> {
        if self.buffered_bytes() >= PCM_BYTES {
            let pts_us = self.sequence.checked_mul(10_000).ok_or(Error::TooLarge)?;
            return Ok(Some((
                Header {
                    payload_bytes: PCM_BYTES as u32,
                    sequence: self.sequence as u32,
                    pts_us,
                },
                &self.bytes[self.offset..self.offset + PCM_BYTES],
            )));
        }
        if self.ended {
            return if self.buffered_bytes() == 0 {
                Err(Error::Ended)
            } else {
                Err(Error::Truncated)
            };
        }
        Ok(None)
    }
    pub fn consume(&mut self) -> Result<(), Error> {
        if self.peek()?.is_none() {
            return Err(Error::NoRecord);
        }
        self.sequence = self.sequence.checked_add(1).ok_or(Error::TooLarge)?;
        self.offset += PCM_BYTES;
        if self.offset == self.bytes.len() {
            self.bytes.clear();
            self.offset = 0;
        }
        Ok(())
    }
    pub fn end(&mut self) {
        self.ended = true;
    }
}
