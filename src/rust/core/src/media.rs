pub const HEADER_BYTES: usize = 16;
pub const TOKEN_BYTES: usize = 64;
pub const MAX_PENDING_ACKS: usize = 32;
pub const MAX_OUTBOUND_BYTES: usize = 8192;

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Again = 1,
    Invalid,
    TooLarge,
    NoMemory,
    Ended,
    Truncated,
    Timeout,
    Refused,
    Disconnected,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Header {
    pub payload_bytes: u32,
    pub sequence: u32,
    pub pts_us: u64,
}

impl Header {
    pub fn decode(bytes: &[u8; HEADER_BYTES]) -> Self {
        Self {
            payload_bytes: u32::from_le_bytes(bytes[..4].try_into().unwrap()),
            sequence: u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            pts_us: u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        }
    }

    pub fn encode(self) -> [u8; HEADER_BYTES] {
        let mut bytes = [0; HEADER_BYTES];
        bytes[..4].copy_from_slice(&self.payload_bytes.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.sequence.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.pts_us.to_le_bytes());
        bytes
    }
}

pub struct Record<'a> {
    pub header: Header,
    pub raw_header: [u8; HEADER_BYTES],
    pub payload: &'a [u8],
}

pub struct Parser<'a> {
    memory: &'a mut [u8],
    exact_bytes: Option<usize>,
    bytes: [u8; HEADER_BYTES],
    header_bytes: usize,
    payload_bytes: usize,
    length: usize,
    ready: bool,
    ended: bool,
    failure: Option<Error>,
}

impl<'a> Parser<'a> {
    pub fn new(memory: &'a mut [u8], exact_bytes: Option<usize>) -> Result<Self, Error> {
        if memory.is_empty()
            || exact_bytes.is_some_and(|length| length == 0 || length > memory.len())
        {
            return Err(Error::Invalid);
        }
        Ok(Self {
            memory,
            exact_bytes,
            bytes: [0; HEADER_BYTES],
            header_bytes: 0,
            payload_bytes: 0,
            length: 0,
            ready: false,
            ended: false,
            failure: None,
        })
    }

    pub fn writable(&mut self) -> Result<&mut [u8], Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.ready {
            return Err(Error::Again);
        }
        if self.ended {
            return Err(Error::Ended);
        }
        if self.header_bytes < HEADER_BYTES {
            return Ok(&mut self.bytes[self.header_bytes..]);
        }
        Ok(&mut self.memory[self.payload_bytes..self.length])
    }

    pub fn commit(&mut self, bytes: usize) -> Result<(), Error> {
        let room = self.writable()?.len();
        if bytes > room {
            return Err(Error::Invalid);
        }
        if self.header_bytes < HEADER_BYTES {
            self.header_bytes += bytes;
            if self.header_bytes < HEADER_BYTES {
                return Ok(());
            }
            let length = Header::decode(&self.bytes).payload_bytes as usize;
            let error = if length == 0 {
                Some(Error::Invalid)
            } else if length > self.memory.len() {
                Some(Error::TooLarge)
            } else if self.exact_bytes.is_some_and(|exact| length != exact) {
                Some(Error::Invalid)
            } else {
                None
            };
            if let Some(error) = error {
                self.failure = Some(error);
                return Err(error);
            }
            self.length = length;
        } else {
            self.payload_bytes += bytes;
            self.ready = self.payload_bytes == self.length;
        }
        Ok(())
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Result<usize, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let mut taken = 0;
        while taken < bytes.len() {
            let window = match self.writable() {
                Err(Error::Again) if taken > 0 => return Ok(taken),
                other => other?,
            };
            let count = window.len().min(bytes.len() - taken);
            window[..count].copy_from_slice(&bytes[taken..taken + count]);
            taken += count;
            self.commit(count)?;
        }
        Ok(taken)
    }

    pub fn peek(&self) -> Option<Record<'_>> {
        self.ready.then(|| Record {
            header: Header::decode(&self.bytes),
            raw_header: self.bytes,
            payload: &self.memory[..self.length],
        })
    }

    pub fn consume(&mut self) -> Result<(), Error> {
        if !self.ready {
            return Err(Error::Again);
        }
        self.ready = false;
        self.header_bytes = 0;
        self.payload_bytes = 0;
        self.length = 0;
        Ok(())
    }

    pub fn end(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        self.ended = true;
        if self.ready || self.header_bytes == 0 {
            return Ok(());
        }
        self.failure = Some(Error::Truncated);
        Err(Error::Truncated)
    }
}
