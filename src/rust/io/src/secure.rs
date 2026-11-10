//! The control socket of a paired console: the MNS1 handshake during connect, then records.
//! A plain socket passes through untouched for the one-shot token path.

use crate::socket::{IoError, Socket};
use moonlight_nx2_secure::{
    ANSWER_BYTES, Error, Established, FINISH_BYTES, HELLO_BYTES, Id, Initiator, Key, LENGTH_BYTES,
    MAX_PLAINTEXT, MAX_RECORD, Mode, Opener,
};
use rand_core::{CryptoRng, RngCore};

struct Records {
    keys: Established,
    inbound: [u8; MAX_RECORD],
    received: usize,
    plain_start: usize,
    plain_end: usize,
    outbound: [u8; MAX_RECORD],
    sealed: usize,
    sent: usize,
}

enum State {
    Plain,
    Hello {
        initiator: Initiator,
        bytes: [u8; HELLO_BYTES],
        sent: usize,
    },
    Answer {
        initiator: Initiator,
        bytes: [u8; ANSWER_BYTES],
        used: usize,
    },
    Finish {
        keys: Established,
        bytes: [u8; FINISH_BYTES],
        sent: usize,
    },
    Open(Records),
    Failed,
}

pub struct SecureSocket<S: Socket> {
    socket: S,
    state: State,
    failure: Option<Error>,
    pairing: Option<(Id, Key)>,
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
}

impl<S: Socket> SecureSocket<S> {
    pub fn plain(socket: S) -> Self {
        Self {
            socket,
            state: State::Plain,
            failure: None,
            pairing: None,
        }
    }

    /// Starts the handshake on a socket whose connect is in progress. `secret` is the code
    /// on screen (`Mode::Pair`) or the stored key (`Mode::Session`).
    pub fn secured(
        socket: S,
        mode: Mode,
        console: Id,
        secret: &[u8],
        random: impl CryptoRng + RngCore,
    ) -> Self {
        let (initiator, bytes) = Initiator::start(mode, console, secret, random);
        Self {
            socket,
            state: State::Hello {
                initiator,
                bytes,
                sent: 0,
            },
            failure: None,
            pairing: None,
        }
    }

    /// Why the handshake ended, when the helper refused or failed the proof.
    pub fn failure(&self) -> Option<Error> {
        self.failure
    }

    /// The helper and key a finished pairing produced, once.
    pub fn take_pairing(&mut self) -> Option<(Id, Key)> {
        self.pairing.take()
    }

    fn fail(&mut self, error: Error) -> IoError {
        self.failure = Some(error);
        self.state = State::Failed;
        IoError::Failed
    }

    /// One nonblocking step of the handshake; true once records can flow.
    fn handshake(&mut self) -> Result<bool, IoError> {
        loop {
            match core::mem::replace(&mut self.state, State::Failed) {
                State::Plain => {
                    self.state = State::Plain;
                    return Ok(true);
                }
                State::Open(records) => {
                    self.state = State::Open(records);
                    return Ok(true);
                }
                State::Failed => return Err(IoError::Failed),
                State::Hello {
                    initiator,
                    bytes,
                    mut sent,
                } => {
                    let outcome = self.socket.send(&bytes[sent..]);
                    if let Ok(count) = outcome {
                        sent += count;
                    }
                    self.state = if sent == HELLO_BYTES {
                        State::Answer {
                            initiator,
                            bytes: [0; ANSWER_BYTES],
                            used: 0,
                        }
                    } else {
                        State::Hello {
                            initiator,
                            bytes,
                            sent,
                        }
                    };
                    match outcome {
                        Ok(0) => return Err(self.fail(Error::Malformed)),
                        Ok(_) => {}
                        Err(error) if error.is_retry() => return Ok(false),
                        Err(error) => {
                            self.state = State::Failed;
                            return Err(error);
                        }
                    }
                }
                State::Answer {
                    initiator,
                    mut bytes,
                    mut used,
                } => {
                    match self.socket.recv(&mut bytes[used..]) {
                        Ok(0) => return Err(IoError::Disconnected(0)),
                        Ok(count) => used += count,
                        Err(error) if error.is_retry() => {
                            self.state = State::Answer {
                                initiator,
                                bytes,
                                used,
                            };
                            return Ok(false);
                        }
                        Err(error) => return Err(error),
                    }
                    if used < ANSWER_BYTES {
                        self.state = State::Answer {
                            initiator,
                            bytes,
                            used,
                        };
                        continue;
                    }
                    match initiator.finish(&bytes) {
                        Ok((keys, proof)) => {
                            self.state = State::Finish {
                                keys,
                                bytes: proof,
                                sent: 0,
                            }
                        }
                        Err(error) => return Err(self.fail(error)),
                    }
                }
                State::Finish {
                    mut keys,
                    bytes,
                    mut sent,
                } => {
                    let outcome = self.socket.send(&bytes[sent..]);
                    if let Ok(count) = outcome {
                        sent += count;
                    }
                    if sent < FINISH_BYTES {
                        self.state = State::Finish { keys, bytes, sent };
                        match outcome {
                            Ok(0) => return Err(self.fail(Error::Malformed)),
                            Ok(_) => continue,
                            Err(error) if error.is_retry() => return Ok(false),
                            Err(error) => {
                                self.state = State::Failed;
                                return Err(error);
                            }
                        }
                    }
                    self.pairing = keys.pairing_key.take().map(|key| (keys.peer, key));
                    self.state = State::Open(Records {
                        keys,
                        inbound: [0; MAX_RECORD],
                        received: 0,
                        plain_start: 0,
                        plain_end: 0,
                        outbound: [0; MAX_RECORD],
                        sealed: 0,
                        sent: 0,
                    });
                }
            }
        }
    }
}

impl Records {
    /// Pushes the sealed record out; true when nothing is left.
    fn flush(&mut self, socket: &mut impl Socket) -> Result<bool, IoError> {
        while self.sent < self.sealed {
            match socket.send(&self.outbound[self.sent..self.sealed]) {
                Ok(0) => return Err(IoError::Failed),
                Ok(count) => self.sent += count,
                Err(error) if error.is_retry() => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        self.sealed = 0;
        self.sent = 0;
        Ok(true)
    }

    fn fill(&mut self, socket: &mut impl Socket, wanted: usize) -> Result<bool, IoError> {
        while self.received < wanted {
            match socket.recv(&mut self.inbound[self.received..wanted]) {
                Ok(0) if self.received == 0 => return Err(IoError::Disconnected(0)),
                Ok(0) => return Err(IoError::Failed),
                Ok(count) => self.received += count,
                Err(error) if error.is_retry() => return Ok(false),
                Err(error) => return Err(error),
            }
        }
        Ok(true)
    }

    /// Reads and opens the next record; false while it is incomplete.
    fn receive(&mut self, socket: &mut impl Socket) -> Result<bool, IoError> {
        if !self.fill(socket, LENGTH_BYTES)? {
            return Ok(false);
        }
        let body =
            Opener::body_bytes([self.inbound[0], self.inbound[1]]).map_err(|_| IoError::Failed)?;
        let end = LENGTH_BYTES + body;
        if !self.fill(socket, end)? {
            return Ok(false);
        }
        let size = self
            .keys
            .opener
            .open(&mut self.inbound[LENGTH_BYTES..end])
            .map_err(|_| IoError::Failed)?;
        self.received = 0;
        self.plain_start = LENGTH_BYTES;
        self.plain_end = LENGTH_BYTES + size;
        Ok(true)
    }
}

impl<S: Socket> Socket for SecureSocket<S> {
    fn poll_connect(&mut self) -> Result<bool, IoError> {
        if matches!(self.state, State::Failed) {
            return Err(IoError::Failed);
        }
        if !self.socket.poll_connect()? {
            return Ok(false);
        }
        self.handshake()
    }

    fn send(&mut self, bytes: &[u8]) -> Result<usize, IoError> {
        let records = match &mut self.state {
            State::Plain => return self.socket.send(bytes),
            State::Open(records) => records,
            _ => return Err(IoError::Failed),
        };
        if !records.flush(&mut self.socket)? {
            return Err(IoError::WouldBlock);
        }
        if bytes.is_empty() {
            return Ok(0);
        }
        let count = bytes.len().min(MAX_PLAINTEXT);
        records.sealed = records
            .keys
            .sealer
            .seal(&bytes[..count], &mut records.outbound)
            .map_err(|_| IoError::Failed)?;
        records.flush(&mut self.socket)?;
        Ok(count)
    }

    fn recv(&mut self, bytes: &mut [u8]) -> Result<usize, IoError> {
        let records = match &mut self.state {
            State::Plain => return self.socket.recv(bytes),
            State::Open(records) => records,
            _ => return Err(IoError::Failed),
        };
        records.flush(&mut self.socket)?;
        if records.plain_start == records.plain_end && !records.receive(&mut self.socket)? {
            return Err(IoError::WouldBlock);
        }
        let count = bytes.len().min(records.plain_end - records.plain_start);
        let taken = &mut records.inbound[records.plain_start..records.plain_start + count];
        bytes[..count].copy_from_slice(taken);
        wipe(taken);
        records.plain_start += count;
        Ok(count)
    }

    fn close(&mut self) -> Result<(), IoError> {
        if let State::Open(records) = &mut self.state {
            wipe(&mut records.inbound);
            wipe(&mut records.outbound);
        }
        self.state = State::Failed;
        self.socket.close()
    }
}
