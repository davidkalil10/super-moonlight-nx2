use crate::ack::{self, Ack, Mode};
use crate::assemble::{MAX_VIDEO_BYTES, PCM_BYTES};
use moonlight_nx2_core::media::{Header, MAX_PENDING_ACKS};
use std::io::{self, Read, Write};
use std::net::TcpStream;

const READ_BYTES: usize = 8192;
const WRITE_BUDGET: usize = 65_536;

#[derive(Debug)]
pub enum Error {
    Invalid,
    Busy,
    Closed,
    Ack(ack::Error),
    Io(io::Error),
}

pub struct Channel {
    socket: TcpStream,
    mode: Mode,
    window: usize,
    acknowledgements: ack::Parser,
    outgoing: Vec<u8>,
    sent: usize,
    current: Option<Header>,
    input: [u8; READ_BYTES],
    input_used: usize,
    input_end: usize,
    closed: bool,
}

impl Channel {
    pub fn new(socket: TcpStream, mode: Mode) -> io::Result<Self> {
        socket.set_nonblocking(true)?;
        #[cfg(target_os = "linux")]
        crate::socket_options::apply(
            &socket,
            match mode {
                Mode::VideoInput => crate::socket_options::Class::Video,
                Mode::Audio => crate::socket_options::Class::Audio,
            },
        )?;
        Ok(Self {
            socket,
            mode,
            window: if mode == Mode::VideoInput {
                8
            } else {
                MAX_PENDING_ACKS
            },
            acknowledgements: ack::Parser::new(mode),
            outgoing: Vec::new(),
            sent: 0,
            current: None,
            input: [0; READ_BYTES],
            input_used: 0,
            input_end: 0,
            closed: false,
        })
    }
    pub fn queue(&mut self, header: Header, payload: &[u8]) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if self.current.is_some() || self.acknowledgements.pending_count() >= self.window {
            return Err(Error::Busy);
        }
        if payload.is_empty()
            || payload.len() != header.payload_bytes as usize
            || match self.mode {
                Mode::Audio => payload.len() != PCM_BYTES,
                Mode::VideoInput => payload.len() > MAX_VIDEO_BYTES,
            }
        {
            return Err(Error::Invalid);
        }
        self.outgoing.extend_from_slice(&header.encode());
        self.outgoing.extend_from_slice(payload);
        self.sent = 0;
        self.current = Some(header);
        Ok(())
    }
    pub fn set_video_window(&mut self, window: usize) -> Result<(), Error> {
        if self.mode != Mode::VideoInput || !(2..=8).contains(&window) {
            return Err(Error::Invalid);
        }
        self.window = window;
        Ok(())
    }

    pub fn is_idle(&self) -> bool {
        self.current.is_none() && self.acknowledgements.pending_count() == 0
    }

    pub fn ack(&self) -> Result<Option<Ack<'_>>, Error> {
        self.acknowledgements.peek().map_err(Error::Ack)
    }
    pub fn consume_ack(&mut self) -> Result<(), Error> {
        self.acknowledgements.consume().map_err(Error::Ack)
    }
    pub fn pump(&mut self) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if let Err(error) = self.pump_inner() {
            self.closed = true;
            let _ = self.socket.shutdown(std::net::Shutdown::Both);
            return Err(error);
        }
        Ok(())
    }
    fn pump_inner(&mut self) -> Result<(), Error> {
        let end = (self.sent + WRITE_BUDGET).min(self.outgoing.len());
        while self.sent < end {
            match self.socket.write(&self.outgoing[self.sent..end]) {
                Ok(0) => return Err(Error::Closed),
                Ok(count) => self.sent += count,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(Error::Io(error)),
            }
        }
        if let Some(header) = self.current
            && self.sent == self.outgoing.len()
        {
            self.acknowledgements.expect(header).map_err(Error::Ack)?;
            self.current = None;
            self.outgoing.clear();
            self.sent = 0;
        }
        if self.acknowledgements.peek().map_err(Error::Ack)?.is_some() {
            return Ok(());
        }
        if self.input_used == self.input_end {
            match self.socket.read(&mut self.input) {
                Ok(0) => {
                    self.acknowledgements.end().map_err(Error::Ack)?;
                    return Err(Error::Closed);
                }
                Ok(count) => {
                    self.input_used = 0;
                    self.input_end = count;
                }
                Err(error)
                    if error.kind() == io::ErrorKind::Interrupted
                        || error.kind() == io::ErrorKind::WouldBlock =>
                {
                    return Ok(());
                }
                Err(error) => return Err(Error::Io(error)),
            }
        }
        let count = self
            .acknowledgements
            .feed(&self.input[self.input_used..self.input_end])
            .map_err(Error::Ack)?;
        self.input_used += count;
        Ok(())
    }
}
