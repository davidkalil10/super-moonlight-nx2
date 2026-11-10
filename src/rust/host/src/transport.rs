//! The control connection's byte stream: plain TCP for the one-shot token path, MNS1 records
//! for a paired console.

use moonlight_nx2_secure::{Established, LENGTH_BYTES, MAX_PLAINTEXT, MAX_RECORD, Opener};
use std::{
    io::{self, Read, Write},
    net::{Shutdown, TcpStream},
};

pub enum Transport {
    Plain(TcpStream),
    Secure(Box<SecureStream>),
}

impl Transport {
    pub fn socket(&self) -> &TcpStream {
        match self {
            Self::Plain(socket) => socket,
            Self::Secure(stream) => &stream.socket,
        }
    }

    pub fn shutdown(&self) {
        let _ = self.socket().shutdown(Shutdown::Both);
    }
}

impl Read for Transport {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(socket) => socket.read(bytes),
            Self::Secure(stream) => stream.read(bytes),
        }
    }
}

impl Write for Transport {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(socket) => socket.write(bytes),
            Self::Secure(stream) => stream.write(bytes),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(socket) => socket.flush(),
            Self::Secure(stream) => stream.flush(),
        }
    }
}

/// A nonblocking socket carrying MNS1 records after the handshake.
pub struct SecureStream {
    socket: TcpStream,
    keys: Established,
    record: Vec<u8>,
    plain: Vec<u8>,
    plain_used: usize,
    sealed: Vec<u8>,
    sealed_sent: usize,
}

fn broken(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

impl SecureStream {
    pub fn new(socket: TcpStream, keys: Established) -> Self {
        Self {
            socket,
            keys,
            record: Vec::with_capacity(MAX_RECORD),
            plain: Vec::with_capacity(MAX_PLAINTEXT),
            plain_used: 0,
            sealed: Vec::with_capacity(MAX_RECORD),
            sealed_sent: 0,
        }
    }

    /// Reads until `self.record` holds `wanted` bytes; false when the socket has no more yet.
    fn fill(&mut self, wanted: usize) -> io::Result<bool> {
        while self.record.len() < wanted {
            let have = self.record.len();
            self.record.resize(wanted, 0);
            let outcome = self.socket.read(&mut self.record[have..]);
            let count = *outcome.as_ref().unwrap_or(&0);
            self.record.truncate(have + count);
            match outcome {
                Ok(0) if have == 0 => return Err(io::ErrorKind::UnexpectedEof.into()),
                Ok(0) => return Err(broken("record cut short")),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        Ok(true)
    }

    fn receive(&mut self) -> io::Result<bool> {
        if !self.fill(LENGTH_BYTES)? {
            return Ok(false);
        }
        let body = Opener::body_bytes([self.record[0], self.record[1]])
            .map_err(|_| broken("bad record length"))?;
        if !self.fill(LENGTH_BYTES + body)? {
            return Ok(false);
        }
        let size = self
            .keys
            .opener
            .open(&mut self.record[LENGTH_BYTES..])
            .map_err(|_| broken("record failed authentication"))?;
        self.plain.clear();
        self.plain
            .extend_from_slice(&self.record[LENGTH_BYTES..LENGTH_BYTES + size]);
        self.plain_used = 0;
        self.record.iter_mut().for_each(|byte| *byte = 0);
        self.record.clear();
        Ok(true)
    }

    fn send_sealed(&mut self) -> io::Result<bool> {
        while self.sealed_sent < self.sealed.len() {
            match self.socket.write(&self.sealed[self.sealed_sent..]) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(count) => self.sealed_sent += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        self.sealed.clear();
        self.sealed_sent = 0;
        Ok(true)
    }
}

impl Read for SecureStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if self.plain_used == self.plain.len() && !self.receive()? {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let count = bytes.len().min(self.plain.len() - self.plain_used);
        bytes[..count].copy_from_slice(&self.plain[self.plain_used..self.plain_used + count]);
        self.plain[self.plain_used..self.plain_used + count]
            .iter_mut()
            .for_each(|byte| *byte = 0);
        self.plain_used += count;
        Ok(count)
    }
}

impl Write for SecureStream {
    /// Takes at most one record's worth once the previous record has left.
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if !self.send_sealed()? {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        if bytes.is_empty() {
            return Ok(0);
        }
        let count = bytes.len().min(MAX_PLAINTEXT);
        self.sealed.resize(MAX_RECORD, 0);
        let size = self
            .keys
            .sealer
            .seal(&bytes[..count], &mut self.sealed)
            .map_err(|_| broken("record could not be sealed"))?;
        self.sealed.truncate(size);
        self.send_sealed()?;
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.send_sealed()? {
            Ok(())
        } else {
            Err(io::ErrorKind::WouldBlock.into())
        }
    }
}
