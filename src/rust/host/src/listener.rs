use moonlight_nx2_core::media::TOKEN_BYTES;
use std::io::{self, Read};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{Ordering, compiler_fence};
use std::time::Instant;
use subtle::ConstantTimeEq;

#[derive(Debug)]
pub enum Error {
    InvalidToken,
    Timeout,
    Authentication,
    Disconnected,
    Closed,
    Io(io::Error),
}

pub struct Listener {
    listener: Option<TcpListener>,
    peer: IpAddr,
    token: [u8; TOKEN_BYTES],
    received: [u8; TOKEN_BYTES],
    used: usize,
    incoming: Option<TcpStream>,
    deadline: Instant,
    closed: bool,
}

impl Listener {
    pub fn bind(
        address: SocketAddr,
        peer: IpAddr,
        token: [u8; TOKEN_BYTES],
        deadline: Instant,
    ) -> Result<Self, Error> {
        if !token
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return Err(Error::InvalidToken);
        }
        let listener = TcpListener::bind(address).map_err(Error::Io)?;
        listener.set_nonblocking(true).map_err(Error::Io)?;
        Ok(Self {
            listener: Some(listener),
            peer,
            token,
            received: [0; TOKEN_BYTES],
            used: 0,
            incoming: None,
            deadline,
            closed: false,
        })
    }
    pub fn local_addr(&self) -> Result<SocketAddr, Error> {
        self.listener
            .as_ref()
            .ok_or(Error::Closed)?
            .local_addr()
            .map_err(Error::Io)
    }
    pub fn poll(&mut self, now: Instant) -> Result<Option<TcpStream>, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if now >= self.deadline {
            self.close();
            return Err(Error::Timeout);
        }
        if self.incoming.is_none() {
            match self.listener.as_ref().expect("open listener").accept() {
                Ok((socket, address)) => {
                    if address.ip() != self.peer {
                        return Ok(None);
                    }
                    if let Err(error) = socket.set_nonblocking(true) {
                        self.close();
                        return Err(Error::Io(error));
                    }
                    self.incoming = Some(socket);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                Err(error) => {
                    self.close();
                    return Err(Error::Io(error));
                }
            }
        }
        let socket = self.incoming.as_mut().expect("accepted socket");
        match socket.read(&mut self.received[self.used..]) {
            Ok(0) => {
                self.close();
                return Err(Error::Disconnected);
            }
            Ok(count) => self.used += count,
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::Interrupted =>
            {
                return Ok(None);
            }
            Err(error) => {
                self.close();
                return Err(Error::Io(error));
            }
        }
        if self.used != TOKEN_BYTES {
            return Ok(None);
        }
        if !bool::from(self.token.ct_eq(&self.received)) {
            self.close();
            return Err(Error::Authentication);
        }
        let socket = self.incoming.take().expect("authenticated socket");
        self.close();
        Ok(Some(socket))
    }
    pub(crate) fn close(&mut self) {
        self.incoming.take();
        self.listener.take();
        for byte in self.token.iter_mut().chain(self.received.iter_mut()) {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
        self.closed = true;
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        self.close();
    }
}
