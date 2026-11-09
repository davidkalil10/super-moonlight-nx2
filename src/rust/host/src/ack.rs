use moonlight_nx2_core::media::{HEADER_BYTES, Header, MAX_PENDING_ACKS};
use std::collections::VecDeque;

pub const MAX_INPUT_BYTES: usize = 3840;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Audio,
    VideoInput,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    NoPending,
    QueueFull,
    Mismatch,
    TooLarge,
    InvalidInput,
    Truncated,
    Ended,
    NoFrame,
}

pub struct Ack<'a> {
    pub header: Header,
    pub input: &'a [u8],
}

pub struct Parser {
    mode: Mode,
    pending: VecDeque<[u8; HEADER_BYTES]>,
    header: [u8; HEADER_BYTES],
    header_used: usize,
    length_bytes: [u8; 4],
    length_used: usize,
    input: [u8; MAX_INPUT_BYTES],
    input_used: usize,
    length: usize,
    ready: bool,
    ended: bool,
    failure: Option<Error>,
}

impl Parser {
    pub fn new(mode: Mode) -> Self {
        Self {
            mode,
            pending: VecDeque::new(),
            header: [0; HEADER_BYTES],
            header_used: 0,
            length_bytes: [0; 4],
            length_used: 0,
            input: [0; MAX_INPUT_BYTES],
            input_used: 0,
            length: 0,
            ready: false,
            ended: false,
            failure: None,
        }
    }
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    fn fail<T>(&mut self, error: Error) -> Result<T, Error> {
        self.failure = Some(error);
        Err(error)
    }
    pub fn expect(&mut self, header: Header) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.ended {
            return Err(Error::Ended);
        }
        if self.pending.len() == MAX_PENDING_ACKS {
            return Err(Error::QueueFull);
        }
        self.pending.push_back(header.encode());
        Ok(())
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Result<usize, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.ended {
            return Err(Error::Ended);
        }
        if self.ready || bytes.is_empty() {
            return Ok(0);
        }
        if self.pending.is_empty() {
            return self.fail(Error::NoPending);
        }
        let mut taken = 0;
        if self.header_used < HEADER_BYTES {
            let n = (HEADER_BYTES - self.header_used).min(bytes.len());
            self.header[self.header_used..self.header_used + n].copy_from_slice(&bytes[..n]);
            self.header_used += n;
            taken += n;
            if self.header_used < HEADER_BYTES {
                return Ok(taken);
            }
            if self.pending.front() != Some(&self.header) {
                return self.fail(Error::Mismatch);
            }
            if self.mode == Mode::Audio {
                self.ready = true;
                return Ok(taken);
            }
        }
        if self.length_used < 4 {
            let n = (4 - self.length_used).min(bytes.len() - taken);
            self.length_bytes[self.length_used..self.length_used + n]
                .copy_from_slice(&bytes[taken..taken + n]);
            self.length_used += n;
            taken += n;
            if self.length_used < 4 {
                return Ok(taken);
            }
            self.length = u32::from_le_bytes(self.length_bytes) as usize;
            if self.length > MAX_INPUT_BYTES {
                return self.fail(Error::TooLarge);
            }
            if self.length == 0 {
                self.ready = true;
                return Ok(taken);
            }
        }
        let n = (self.length - self.input_used).min(bytes.len() - taken);
        self.input[self.input_used..self.input_used + n].copy_from_slice(&bytes[taken..taken + n]);
        self.input_used += n;
        taken += n;
        if self.input_used == self.length {
            if std::str::from_utf8(&self.input[..self.length]).is_err() {
                return self.fail(Error::InvalidInput);
            }
            self.ready = true;
        }
        Ok(taken)
    }
    pub fn peek(&self) -> Result<Option<Ack<'_>>, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        Ok(self.ready.then(|| Ack {
            header: Header::decode(&self.header),
            input: &self.input[..self.length],
        }))
    }
    pub fn consume(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if !self.ready {
            return self.fail(Error::NoFrame);
        }
        self.pending.pop_front();
        self.header_used = 0;
        self.length_used = 0;
        self.input_used = 0;
        self.input[..self.length].fill(0);
        self.length = 0;
        self.ready = false;
        Ok(())
    }
    pub fn end(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if !self.ready && (self.header_used != 0 || self.length_used != 0 || self.input_used != 0) {
            return self.fail(Error::Truncated);
        }
        self.ended = true;
        Ok(())
    }
}
