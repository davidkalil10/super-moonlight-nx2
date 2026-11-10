use crate::udp_control::{self, Event, Parser};
use moonlight_nx2_core::media::Header;
use std::io::{self, Read};
use std::net::{Shutdown, TcpStream};

const READ_BYTES: usize = 8192;
const WINDOW: usize = 8;

#[derive(Debug)]
pub enum Error {
    Busy,
    InvalidWindow,
    Closed,
    Protocol(udp_control::Error),
    Io(io::Error),
}

pub struct Feedback {
    socket: TcpStream,
    parser: Parser,
    bytes: [u8; READ_BYTES],
    used: usize,
    end: usize,
    closed: bool,
    window: usize,
}

impl Feedback {
    pub fn new(socket: TcpStream) -> io::Result<Self> {
        socket.set_nonblocking(true)?;
        #[cfg(target_os = "linux")]
        crate::socket_options::apply(&socket, crate::socket_options::Class::Video)?;
        Ok(Self {
            socket,
            parser: Parser::new(),
            bytes: [0; READ_BYTES],
            used: 0,
            end: 0,
            closed: false,
            window: WINDOW,
        })
    }

    pub fn can_send(&self) -> bool {
        !self.closed && self.parser.pending_count() < self.window
    }

    pub fn set_window(&mut self, window: usize) -> Result<(), Error> {
        if !(2..=WINDOW).contains(&window) {
            return Err(Error::InvalidWindow);
        }
        self.window = window;
        Ok(())
    }

    pub fn expect(&mut self, frame: u32, header: Header) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if !self.can_send() {
            return Err(Error::Busy);
        }
        self.parser.expect(frame, header).map_err(Error::Protocol)
    }

    pub fn is_idle(&self) -> bool {
        self.parser.pending_count() == 0
    }

    pub fn event(&self) -> Result<Option<&Event>, Error> {
        self.parser.peek().map_err(Error::Protocol)
    }

    pub fn consume(&mut self) -> Result<(), Error> {
        self.parser.consume().map_err(Error::Protocol)
    }

    pub fn pump(&mut self) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if let Err(error) = self.pump_inner() {
            self.closed = true;
            let _ = self.socket.shutdown(Shutdown::Both);
            return Err(error);
        }
        Ok(())
    }

    fn pump_inner(&mut self) -> Result<(), Error> {
        if self.parser.peek().map_err(Error::Protocol)?.is_some() {
            return Ok(());
        }
        if self.used == self.end {
            match self.socket.read(&mut self.bytes) {
                Ok(0) => {
                    self.parser.end().map_err(Error::Protocol)?;
                    return Err(Error::Closed);
                }
                Ok(count) => {
                    self.used = 0;
                    self.end = count;
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    return Ok(());
                }
                Err(error) => return Err(Error::Io(error)),
            }
        }
        self.used += self
            .parser
            .feed(&self.bytes[self.used..self.end])
            .map_err(Error::Protocol)?;
        Ok(())
    }
}
