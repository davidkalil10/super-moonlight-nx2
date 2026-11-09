pub const HEADER_BYTES: usize = 16;
pub const MAX_PAYLOAD: usize = 65_536;
pub const AUTH_BYTES: usize = 64;
pub const MAGIC: u32 = 0x3143_4e4d;
pub const VERSION: u16 = 1;

#[repr(u16)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Auth = 1,
    Accepted,
    Request,
    Event,
    Stream,
    Error,
}

impl TryFrom<u16> for Kind {
    type Error = Error;

    fn try_from(value: u16) -> Result<Self, Error> {
        match value {
            1 => Ok(Self::Auth),
            2 => Ok(Self::Accepted),
            3 => Ok(Self::Request),
            4 => Ok(Self::Event),
            5 => Ok(Self::Stream),
            6 => Ok(Self::Error),
            _ => Err(Error::BadKind),
        }
    }
}

#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    BadKind = 1,
    BadLength,
    BadAuth,
    BadMagic,
    BadVersion,
    FeedAfterEof,
    Truncated,
    NoFrame,
    NoRoom,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Header {
    pub kind: Kind,
    pub request_id: u32,
    pub payload_bytes: u32,
}

impl Header {
    pub fn new(kind: Kind, request_id: u32, payload_bytes: usize) -> Result<Self, Error> {
        if !(1..=MAX_PAYLOAD).contains(&payload_bytes) {
            return Err(Error::BadLength);
        }
        if kind == Kind::Auth && (request_id != 0 || payload_bytes != AUTH_BYTES) {
            return Err(Error::BadAuth);
        }
        Ok(Self {
            kind,
            request_id,
            payload_bytes: payload_bytes as u32,
        })
    }

    pub fn decode(bytes: &[u8; HEADER_BYTES]) -> Result<Self, Error> {
        if u32::from_le_bytes(bytes[0..4].try_into().unwrap()) != MAGIC {
            return Err(Error::BadMagic);
        }
        if u16::from_le_bytes(bytes[4..6].try_into().unwrap()) != VERSION {
            return Err(Error::BadVersion);
        }
        let kind = Kind::try_from(u16::from_le_bytes(bytes[6..8].try_into().unwrap()))?;
        let id = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let length = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        Self::new(kind, id, length as usize)
    }

    pub fn encode(self) -> Result<[u8; HEADER_BYTES], Error> {
        Self::new(self.kind, self.request_id, self.payload_bytes as usize)?;
        let mut bytes = [0; HEADER_BYTES];
        bytes[..4].copy_from_slice(&MAGIC.to_le_bytes());
        bytes[4..6].copy_from_slice(&VERSION.to_le_bytes());
        bytes[6..8].copy_from_slice(&(self.kind as u16).to_le_bytes());
        bytes[8..12].copy_from_slice(&self.request_id.to_le_bytes());
        bytes[12..16].copy_from_slice(&self.payload_bytes.to_le_bytes());
        Ok(bytes)
    }
}

pub struct Frame<'a> {
    pub header: Header,
    pub payload: &'a [u8],
}

pub struct Parser<'a> {
    memory: &'a mut [u8],
    bytes: [u8; HEADER_BYTES],
    header_bytes: usize,
    payload_bytes: usize,
    header: Option<Header>,
    ready: bool,
    ended: bool,
    failure: Option<Error>,
}

impl<'a> Parser<'a> {
    pub fn new(memory: &'a mut [u8]) -> Result<Self, Error> {
        if memory.len() < MAX_PAYLOAD {
            return Err(Error::Invalid);
        }
        Ok(Self {
            memory,
            bytes: [0; HEADER_BYTES],
            header_bytes: 0,
            payload_bytes: 0,
            header: None,
            ready: false,
            ended: false,
            failure: None,
        })
    }

    fn fail<T>(&mut self, error: Error) -> Result<T, Error> {
        self.failure = Some(error);
        Err(error)
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Result<usize, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.ended {
            return self.fail(Error::FeedAfterEof);
        }
        if self.ready {
            return Ok(0);
        }

        let mut taken = 0;
        if self.header_bytes < HEADER_BYTES {
            let count = bytes.len().min(HEADER_BYTES - self.header_bytes);
            self.bytes[self.header_bytes..self.header_bytes + count]
                .copy_from_slice(&bytes[..count]);
            self.header_bytes += count;
            taken += count;
            if self.header_bytes < HEADER_BYTES {
                return Ok(taken);
            }
            match Header::decode(&self.bytes) {
                Ok(header) => self.header = Some(header),
                Err(error) => return self.fail(error),
            }
        }

        let length = self.header.unwrap().payload_bytes as usize;
        let count = (bytes.len() - taken).min(length - self.payload_bytes);
        self.memory[self.payload_bytes..self.payload_bytes + count]
            .copy_from_slice(&bytes[taken..taken + count]);
        self.payload_bytes += count;
        self.ready = self.payload_bytes == length;
        Ok(taken + count)
    }

    pub fn peek(&self) -> Result<Option<Frame<'_>>, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        Ok(self.ready.then(|| Frame {
            header: self.header.unwrap(),
            payload: &self.memory[..self.payload_bytes],
        }))
    }

    pub fn consume(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if !self.ready {
            return self.fail(Error::NoFrame);
        }
        wipe(&mut self.memory[..self.payload_bytes]);
        self.header_bytes = 0;
        self.payload_bytes = 0;
        self.header = None;
        self.ready = false;
        Ok(())
    }

    pub fn end(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if !self.ready && (self.header_bytes != 0 || self.payload_bytes != 0) {
            return self.fail(Error::Truncated);
        }
        self.ended = true;
        Ok(())
    }
}

impl Drop for Parser<'_> {
    fn drop(&mut self) {
        wipe(self.memory);
    }
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
}

pub fn encode(kind: Kind, id: u32, payload: &[u8], out: &mut [u8]) -> Result<usize, Error> {
    let header = Header::new(kind, id, payload.len())?.encode()?;
    let total = HEADER_BYTES + payload.len();
    if out.len() < total {
        return Err(Error::NoRoom);
    }
    out[..HEADER_BYTES].copy_from_slice(&header);
    out[HEADER_BYTES..total].copy_from_slice(payload);
    Ok(total)
}
