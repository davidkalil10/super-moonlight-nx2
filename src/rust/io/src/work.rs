use crate::socket::{IoError, Socket};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Limits {
    pub reads: usize,
    pub writes: usize,
}

impl Limits {
    pub const UNLIMITED: Self = Self {
        reads: usize::MAX,
        writes: usize::MAX,
    };
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Work {
    pub connect_polls: usize,
    pub reads: usize,
    pub writes: usize,
    pub read_bytes: usize,
    pub written_bytes: usize,
    pub read_quota_stops: usize,
    pub write_quota_stops: usize,
    pub read_would_block: usize,
    pub write_would_block: usize,
    pub read_interrupted: usize,
    pub write_interrupted: usize,
}

impl Work {
    pub(crate) fn poll_connect(&mut self, socket: &mut impl Socket) -> Result<bool, IoError> {
        self.connect_polls += 1;
        socket.poll_connect()
    }

    pub(crate) fn recv(
        &mut self,
        socket: &mut impl Socket,
        bytes: &mut [u8],
        limits: Limits,
    ) -> Result<usize, IoError> {
        if self.reads >= limits.reads {
            self.read_quota_stops += 1;
            return Err(IoError::WouldBlock);
        }
        self.reads += 1;
        let result = socket.recv(bytes);
        match result {
            Ok(count) if count <= bytes.len() => self.read_bytes += count,
            Err(IoError::WouldBlock) => self.read_would_block += 1,
            Err(IoError::Interrupted) => self.read_interrupted += 1,
            _ => {}
        }
        result
    }

    pub(crate) fn send(
        &mut self,
        socket: &mut impl Socket,
        bytes: &[u8],
        limits: Limits,
    ) -> Result<usize, IoError> {
        if self.writes >= limits.writes {
            self.write_quota_stops += 1;
            return Err(IoError::WouldBlock);
        }
        self.writes += 1;
        let result = socket.send(bytes);
        match result {
            Ok(count) if count <= bytes.len() => self.written_bytes += count,
            Err(IoError::WouldBlock) => self.write_would_block += 1,
            Err(IoError::Interrupted) => self.write_interrupted += 1,
            _ => {}
        }
        result
    }
}

#[must_use]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Report<E> {
    pub result: Result<(), E>,
    pub work: Work,
}
