//! One request and its reply over a nonblocking socket, plain or through rustls's
//! unbuffered client. `poll` moves bytes and never blocks.

use alloc::{boxed::Box, sync::Arc, vec, vec::Vec};

use moonlight_nx2_io::socket::{IoError, Socket};
use rustls::{
    ClientConfig,
    client::UnbufferedClientConnection,
    pki_types::{IpAddr, Ipv4Addr, ServerName},
    unbuffered::{ConnectionState, EncodeError, EncryptError},
};

use crate::http::{self, Reader, Response};

const READ_BYTES: usize = 16 * 1024;
const MAX_TLS_PENDING: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum Error {
    Connect(IoError),
    Io(IoError),
    Tls(rustls::Error),
    Http(http::Error),
    TimedOut,
}

struct Tls {
    connection: Box<UnbufferedClientConnection>,
    incoming: Vec<u8>,
}

pub struct Exchange<S: Socket> {
    socket: S,
    connected: bool,
    tls: Option<Tls>,
    request: Vec<u8>,
    outgoing: Vec<u8>,
    reader: Reader,
    eof: bool,
    deadline_ms: u64,
    done: bool,
}

impl<S: Socket> Exchange<S> {
    /// A plain HTTP exchange on a socket whose connect is in progress.
    pub fn plain(socket: S, request: Vec<u8>, limit: usize, deadline_ms: u64) -> Self {
        Self {
            socket,
            connected: false,
            tls: None,
            request,
            outgoing: Vec::new(),
            reader: Reader::new(limit),
            eof: false,
            deadline_ms,
            done: false,
        }
    }

    /// One RTSP request on its own connection, as Sunshine serves them.
    pub fn rtsp(socket: S, request: Vec<u8>, limit: usize, deadline_ms: u64) -> Self {
        let mut exchange = Self::plain(socket, request, limit, deadline_ms);
        exchange.reader = Reader::rtsp(limit);
        exchange
    }

    pub fn secure(
        socket: S,
        config: Arc<ClientConfig>,
        address: [u8; 4],
        request: Vec<u8>,
        limit: usize,
        deadline_ms: u64,
    ) -> Result<Self, Error> {
        let name = ServerName::IpAddress(IpAddr::V4(Ipv4Addr::from(address)));
        let connection = UnbufferedClientConnection::new(config, name).map_err(Error::Tls)?;
        let mut exchange = Self::plain(socket, request, limit, deadline_ms);
        exchange.tls = Some(Tls {
            connection: Box::new(connection),
            incoming: Vec::new(),
        });
        Ok(exchange)
    }

    /// The reply once it is whole, or why there is none; `None` while it is in progress.
    pub fn poll(&mut self, now_ms: u64) -> Option<Result<Response, Error>> {
        if self.done {
            return None;
        }
        let result = self.step(now_ms);
        if result.is_some() {
            self.done = true;
        }
        result
    }

    fn step(&mut self, now_ms: u64) -> Option<Result<Response, Error>> {
        if !self.connected {
            match self.socket.poll_connect() {
                Ok(true) => self.connected = true,
                Ok(false) if now_ms < self.deadline_ms => return None,
                Ok(false) => return Some(Err(Error::TimedOut)),
                Err(error) if error.is_retry() => return None,
                Err(error) => return Some(Err(Error::Connect(error))),
            }
            if self.tls.is_none() {
                self.outgoing = core::mem::take(&mut self.request);
            }
        }

        for _ in 0..8 {
            if let Err(error) = self.flush() {
                return Some(Err(error));
            }
            let read = match self.read() {
                Ok(read) => read,
                Err(error) => return Some(Err(error)),
            };
            if let Err(error) = self.process() {
                return Some(Err(error));
            }
            if let Some(done) = self.reader.complete(self.eof) {
                return Some(done.map_err(Error::Http));
            }
            if !read && self.outgoing.is_empty() {
                break;
            }
        }

        if now_ms >= self.deadline_ms {
            return Some(Err(Error::TimedOut));
        }
        None
    }

    fn flush(&mut self) -> Result<(), Error> {
        while !self.outgoing.is_empty() {
            match self.socket.send(&self.outgoing) {
                Ok(0) => return Err(Error::Io(IoError::Failed)),
                Ok(sent) => {
                    self.outgoing.drain(..sent);
                }
                Err(error) if error.is_retry() => return Ok(()),
                Err(error) => return Err(Error::Io(error)),
            }
        }
        Ok(())
    }

    /// Reads what the socket has; true when bytes arrived.
    fn read(&mut self) -> Result<bool, Error> {
        if self.eof {
            return Ok(false);
        }
        let mut buffer = vec![0; READ_BYTES];
        match self.socket.recv(&mut buffer) {
            Ok(0) => {
                self.eof = true;
                Ok(true)
            }
            Ok(count) => {
                match self.tls.as_mut() {
                    Some(tls) if tls.incoming.len() + count > MAX_TLS_PENDING => {
                        return Err(Error::Http(http::Error::TooLarge));
                    }
                    Some(tls) => tls.incoming.extend_from_slice(&buffer[..count]),
                    None => self.reader.feed(&buffer[..count]).map_err(Error::Http)?,
                }
                Ok(true)
            }
            Err(error) if error.is_retry() => Ok(false),
            Err(IoError::Disconnected(_)) => {
                self.eof = true;
                Ok(true)
            }
            Err(error) => Err(Error::Io(error)),
        }
    }

    /// Runs rustls over the buffered records until it needs the network.
    fn process(&mut self) -> Result<(), Error> {
        let Some(tls) = self.tls.as_mut() else {
            return Ok(());
        };
        let Tls {
            connection,
            incoming,
        } = tls;

        loop {
            let status = connection.process_tls_records(incoming);
            let mut discard = status.discard;
            let state = status.state.map_err(Error::Tls)?;
            let progressed = match state {
                ConnectionState::ReadTraffic(mut traffic) => {
                    while let Some(record) = traffic.next_record() {
                        let record = record.map_err(Error::Tls)?;
                        discard += record.discard;
                        self.reader.feed(record.payload).map_err(Error::Http)?;
                    }
                    true
                }
                ConnectionState::EncodeTlsData(mut encode) => {
                    let mut size = 4096;
                    loop {
                        let start = self.outgoing.len();
                        self.outgoing.resize(start + size, 0);
                        match encode.encode(&mut self.outgoing[start..]) {
                            Ok(written) => {
                                self.outgoing.truncate(start + written);
                                break;
                            }
                            Err(EncodeError::InsufficientSize(needed)) => {
                                self.outgoing.truncate(start);
                                size = needed.required_size;
                            }
                            Err(_) => {
                                self.outgoing.truncate(start);
                                return Err(Error::Tls(rustls::Error::EncryptError));
                            }
                        }
                    }
                    true
                }
                ConnectionState::TransmitTlsData(transmit) => {
                    transmit.done();
                    true
                }
                ConnectionState::WriteTraffic(mut write) if !self.request.is_empty() => {
                    let mut size = self.request.len() + 256;
                    loop {
                        let start = self.outgoing.len();
                        self.outgoing.resize(start + size, 0);
                        match write.encrypt(&self.request, &mut self.outgoing[start..]) {
                            Ok(written) => {
                                self.outgoing.truncate(start + written);
                                break;
                            }
                            Err(EncryptError::InsufficientSize(needed)) => {
                                self.outgoing.truncate(start);
                                size = needed.required_size;
                            }
                            Err(_) => {
                                self.outgoing.truncate(start);
                                return Err(Error::Tls(rustls::Error::EncryptError));
                            }
                        }
                    }
                    self.request.clear();
                    true
                }
                ConnectionState::PeerClosed | ConnectionState::Closed => {
                    self.eof = true;
                    false
                }
                _ => false,
            };
            incoming.drain(..discard);
            if !progressed {
                return Ok(());
            }
        }
    }

    pub fn close(mut self) -> Result<(), IoError> {
        self.socket.close()
    }
}
