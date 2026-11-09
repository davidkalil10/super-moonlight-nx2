use crate::outbound::Outbound;
use crate::socket::{IoError, Socket, wipe};
use crate::work::{Limits, Report, Work};
use moonlight_nx2_core::control::{
    self, AUTH_BYTES, Frame, HEADER_BYTES, Kind, MAX_PAYLOAD, Parser,
};

/// Exact Accepted payload the helper sends (NATIVE-CONTROL-V1.md).
pub const ACCEPTED: &[u8] = br#"{"version":1,"ready":true}"#;
const INBOX_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Again,
    Invalid,
    Frame(control::Error),
    NotAccepted,
    Unexpected,
    IdsExhausted,
    Timeout,
    Refused,
    Disconnected,
    Ended,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    Connecting,
    Authenticating,
    Ready,
    Closed,
}

pub struct Config<'a> {
    pub token: [u8; AUTH_BYTES],
    pub memory: &'a mut [u8],
    pub outbound: &'a mut [u8],
    pub read_budget: usize,
    pub connect_timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub frames: u64,
    pub requests: u64,
    pub last_request_id: u32,
    pub last_io: Option<IoError>,
}

/// The console end of the MNC1 control connection: Auth, then Accepted, then requests with
/// strictly increasing IDs. Contract: moonlight-nx2-dev/src/rust/io/README.md.
pub struct Channel<'a, S: Socket> {
    socket: S,
    parser: Parser<'a>,
    outbound: Outbound<'a>,
    inbox: [u8; INBOX_BYTES],
    inbox_start: usize,
    inbox_end: usize,
    state: State,
    failure: Option<Error>,
    read_budget: usize,
    deadline_ms: u64,
    last_ms: u64,
    stats: Stats,
}

fn io_error(error: IoError) -> Error {
    match error {
        IoError::Refused(_) => Error::Refused,
        IoError::Disconnected(_) => Error::Disconnected,
        _ => Error::Failed,
    }
}

fn token_ok(token: &[u8; AUTH_BYTES]) -> bool {
    token
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

impl<'a, S: Socket> Channel<'a, S> {
    /// Takes a socket whose connect is in progress and queues the Auth frame. On error the
    /// socket comes back unused. `memory` holds at least 65,536 bytes.
    pub fn open(mut config: Config<'a>, socket: S, now_ms: u64) -> Result<Self, (Error, S)> {
        let token_valid = token_ok(&config.token);
        let outbound_ok = config.outbound.len() >= HEADER_BYTES + AUTH_BYTES;
        let timing_ok = config.read_budget > 0 && config.connect_timeout_ms > 0;
        let deadline = now_ms.checked_add(config.connect_timeout_ms);
        if !token_valid || !outbound_ok || !timing_ok || deadline.is_none() {
            wipe(&mut config.token);
            return Err((Error::Invalid, socket));
        }

        let parser = match Parser::new(config.memory) {
            Ok(parser) => parser,
            Err(error) => {
                wipe(&mut config.token);
                return Err((Error::Frame(error), socket));
            }
        };
        let header = control::Header::new(Kind::Auth, 0, AUTH_BYTES)
            .and_then(control::Header::encode)
            .expect("auth header is valid");
        let mut outbound = Outbound::new(config.outbound);
        outbound.push(&[&header, &config.token]);
        wipe(&mut config.token);

        Ok(Self {
            socket,
            parser,
            outbound,
            inbox: [0; INBOX_BYTES],
            inbox_start: 0,
            inbox_end: 0,
            state: State::Connecting,
            failure: None,
            read_budget: config.read_budget,
            deadline_ms: deadline.unwrap(),
            last_ms: now_ms,
            stats: Stats::default(),
        })
    }

    fn fail(&mut self, error: Error, io: Option<IoError>) -> Result<(), Error> {
        if io.is_some() {
            self.stats.last_io = io;
        }
        self.failure = Some(error);
        Err(error)
    }

    fn connect(&mut self, now_ms: u64, work: &mut Work) -> Result<(), Error> {
        match work.poll_connect(&mut self.socket) {
            Ok(true) => {
                self.state = State::Authenticating;
                Ok(())
            }
            Err(error) if !error.is_retry() => self.fail(io_error(error), Some(error)),
            _ if now_ms >= self.deadline_ms => self.fail(Error::Timeout, None),
            _ => Ok(()),
        }
    }

    fn flush(&mut self, limits: Limits, work: &mut Work) -> Result<(), Error> {
        let before = self.outbound.queued();
        let result = self.outbound.flush_bounded(&mut self.socket, limits, work);
        self.stats.bytes_sent += (before - self.outbound.queued()) as u64;
        match result {
            Ok(_) => Ok(()),
            Err(error) => self.fail(io_error(error), Some(error)),
        }
    }

    fn check_frame(&self) -> Result<bool, Error> {
        let frame = match self.parser.peek() {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(false),
            Err(error) => return Err(Error::Frame(error)),
        };
        let header = frame.header;
        if self.state == State::Authenticating {
            let accepted = header.kind == Kind::Accepted
                && header.request_id == 0
                && frame.payload == ACCEPTED;
            return if accepted {
                Ok(true)
            } else {
                Err(Error::NotAccepted)
            };
        }

        let issued = (1..=self.stats.last_request_id).contains(&header.request_id);
        let correlated = match header.kind {
            Kind::Event => header.request_id == 0 || issued,
            Kind::Stream | Kind::Error => issued,
            _ => false,
        };
        if correlated {
            Ok(true)
        } else {
            Err(Error::Unexpected)
        }
    }

    fn accept_frame(&mut self) -> Result<bool, Error> {
        match self.check_frame() {
            Ok(false) => Ok(false),
            Ok(true) => {
                self.stats.frames += 1;
                if self.state == State::Authenticating {
                    self.state = State::Ready;
                    self.parser.consume().map_err(Error::Frame)?;
                    return Ok(false);
                }
                Ok(true)
            }
            Err(error) => {
                self.failure = Some(error);
                Err(error)
            }
        }
    }

    fn drain_inbox(&mut self) -> Result<bool, Error> {
        while self.inbox_start < self.inbox_end {
            let taken = match self
                .parser
                .feed(&self.inbox[self.inbox_start..self.inbox_end])
            {
                Ok(taken) => taken,
                Err(error) => return self.fail(Error::Frame(error), None).map(|_| false),
            };
            wipe(&mut self.inbox[self.inbox_start..self.inbox_start + taken]);
            self.inbox_start += taken;
            if self.accept_frame()? {
                return Ok(true);
            }
            if taken == 0 {
                return Ok(true);
            }
        }
        self.inbox_start = 0;
        self.inbox_end = 0;
        Ok(false)
    }

    fn receive(&mut self, limits: Limits, work: &mut Work) -> Result<(), Error> {
        let mut budget = self.read_budget;
        loop {
            if self.drain_inbox()? {
                return Ok(());
            }
            if budget == 0 {
                return Ok(());
            }
            let space = INBOX_BYTES.min(budget);
            let count = match work.recv(&mut self.socket, &mut self.inbox[..space], limits) {
                Err(error) if error.is_retry() => return Ok(()),
                Err(error) => return self.fail(io_error(error), Some(error)),
                Ok(count) => count,
            };
            if count > space {
                return self.fail(Error::Failed, None);
            }
            if count == 0 {
                let error = match self.parser.end() {
                    Ok(()) => Error::Ended,
                    Err(error) => Error::Frame(error),
                };
                return self.fail(error, None);
            }
            budget -= count;
            self.inbox_end = count;
            self.stats.bytes_received += count as u64;
        }
    }

    /// Bounded network work. Failures are sticky; a frame already complete stays readable.
    pub fn pump(&mut self, now_ms: u64) -> Result<(), Error> {
        self.pump_bounded(now_ms, Limits::UNLIMITED).result
    }

    pub fn pump_bounded(&mut self, now_ms: u64, limits: Limits) -> Report<Error> {
        let mut work = Work::default();
        let result = self.pump_with_work(now_ms, limits, &mut work);
        Report { result, work }
    }

    fn pump_with_work(
        &mut self,
        now_ms: u64,
        limits: Limits,
        work: &mut Work,
    ) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.state == State::Closed || now_ms < self.last_ms {
            return Err(Error::Invalid);
        }
        self.last_ms = now_ms;

        if self.state == State::Connecting {
            self.connect(now_ms, work)?;
        }
        if self.state == State::Connecting {
            return Ok(());
        }
        self.flush(limits, work)?;
        if matches!(self.parser.peek(), Ok(Some(_))) && self.state == State::Ready {
            return Ok(());
        }
        self.receive(limits, work)
    }

    /// The next Event, Stream or Error frame. Only frames correlated with a sent request,
    /// or ID 0 lifecycle events, reach the caller.
    pub fn peek(&self) -> Option<Frame<'_>> {
        let usable = matches!(self.failure, None | Some(Error::Ended));
        if self.state != State::Ready || !usable {
            return None;
        }
        self.parser.peek().ok().flatten()
    }

    /// Wipes the peeked frame's payload.
    pub fn consume(&mut self) -> Result<(), Error> {
        if self.peek().is_none() {
            return Err(Error::Again);
        }
        self.parser.consume().map_err(Error::Frame)
    }

    /// Queues one request and returns its ID. `Again` uses no ID; a queued request is never
    /// resent, even if the connection fails before it leaves.
    pub fn request(&mut self, payload: &[u8]) -> Result<u32, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.state != State::Ready {
            return Err(Error::Again);
        }
        if payload.is_empty() || payload.len() > MAX_PAYLOAD {
            return Err(Error::Invalid);
        }
        let id = match self.stats.last_request_id.checked_add(1) {
            Some(id) => id,
            None => return Err(Error::IdsExhausted),
        };

        let header = control::Header::new(Kind::Request, id, payload.len())
            .and_then(control::Header::encode)
            .map_err(Error::Frame)?;
        if HEADER_BYTES + payload.len() > self.outbound.capacity() {
            return Err(Error::Invalid);
        }
        if !self.outbound.push(&[&header, payload]) {
            return Err(Error::Again);
        }
        self.stats.last_request_id = id;
        self.stats.requests += 1;
        Ok(id)
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn failure(&self) -> Option<Error> {
        self.failure
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// Closes the socket and wipes buffers. Pending requests have uncertain results; the
    /// caller reports them and never replays them on a new connection.
    pub fn close(mut self) -> Result<Stats, (Error, Stats)> {
        self.state = State::Closed;
        wipe(&mut self.inbox);
        let stats = self.stats;
        match self.socket.close() {
            Ok(()) => Ok(stats),
            Err(error) => Err((
                io_error(error),
                Stats {
                    last_io: Some(error),
                    ..stats
                },
            )),
        }
    }
}
