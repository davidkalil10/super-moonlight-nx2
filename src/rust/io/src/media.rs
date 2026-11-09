use crate::outbound::Outbound;
use crate::socket::{IoError, Socket, wipe};
use crate::work::{Limits, Report, Work};
use moonlight_nx2_core::media::{
    Error, HEADER_BYTES, MAX_OUTBOUND_BYTES, MAX_PENDING_ACKS, Parser, Record, TOKEN_BYTES,
};

/// Longest input record an `input-v1` acknowledgement carries (NATIVE-CONTROL-V1.md).
pub const MAX_INPUT_BYTES: usize = 3840;

/// How the channel acknowledges a record: audio echoes the header, `input-v1` video adds a
/// u32 length and the input record, even when it is empty.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Ack {
    Header,
    Input,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    Connecting,
    Streaming,
    Closed,
}

pub struct Config<'a> {
    pub token: [u8; TOKEN_BYTES],
    pub memory: &'a mut [u8],
    pub outbound: &'a mut [u8],
    pub exact_bytes: Option<usize>,
    pub ack: Ack,
    pub read_budget: usize,
    pub connect_timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub records: u64,
    pub acknowledgements: u64,
    pub budget_stops: u64,
    pub stalled_pumps: u64,
    pub pending_acks: usize,
    pub outbound_bytes: usize,
    pub max_outbound_bytes: usize,
    pub last_io: Option<IoError>,
}

/// One media connection: token, then records, with acknowledgements sent back in record
/// order. Contract: moonlight-nx2-dev/src/rust/io/README.md.
pub struct Channel<'a, S: Socket> {
    socket: S,
    parser: Parser<'a>,
    outbound: Outbound<'a>,
    ack: Ack,
    state: State,
    failure: Option<Error>,
    receive_ended: bool,
    token_bytes: usize,
    pending: [[u8; HEADER_BYTES]; MAX_PENDING_ACKS],
    pending_head: usize,
    pending_count: usize,
    read_budget: usize,
    deadline_ms: u64,
    last_ms: u64,
    stats: Stats,
}

fn token_ok(token: &[u8; TOKEN_BYTES]) -> bool {
    token.iter().all(|byte| byte.is_ascii_graphic())
}

fn io_error(error: IoError) -> Error {
    match error {
        IoError::Refused(_) => Error::Refused,
        IoError::Disconnected(_) => Error::Disconnected,
        _ => Error::Failed,
    }
}

impl<'a, S: Socket> Channel<'a, S> {
    /// Takes a socket whose connect is in progress. On error the socket comes back unused and
    /// the caller closes it.
    pub fn open(mut config: Config<'a>, socket: S, now_ms: u64) -> Result<Self, (Error, S)> {
        let token_valid = token_ok(&config.token);
        let outbound_ok = (HEADER_BYTES + 4 + MAX_INPUT_BYTES..=MAX_OUTBOUND_BYTES)
            .contains(&config.outbound.len());
        let room_ok = config.outbound.len() >= TOKEN_BYTES;
        let timing_ok = config.read_budget > 0 && config.connect_timeout_ms > 0;
        let deadline = now_ms.checked_add(config.connect_timeout_ms);
        if !token_valid || !outbound_ok || !room_ok || !timing_ok || deadline.is_none() {
            wipe(&mut config.token);
            return Err((Error::Invalid, socket));
        }

        let parser = match Parser::new(config.memory, config.exact_bytes) {
            Ok(parser) => parser,
            Err(error) => {
                wipe(&mut config.token);
                return Err((error, socket));
            }
        };
        let mut outbound = Outbound::new(config.outbound);
        outbound.push(&[&config.token]);
        wipe(&mut config.token);

        Ok(Self {
            socket,
            parser,
            outbound,
            ack: config.ack,
            state: State::Connecting,
            failure: None,
            receive_ended: false,
            token_bytes: TOKEN_BYTES,
            pending: [[0; HEADER_BYTES]; MAX_PENDING_ACKS],
            pending_head: 0,
            pending_count: 0,
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
                self.state = State::Streaming;
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
        let sent = before - self.outbound.queued();
        self.stats.bytes_sent += sent as u64;
        self.token_bytes = self.token_bytes.saturating_sub(sent);
        match result {
            Ok(_) => Ok(()),
            Err(error) => self.fail(io_error(error), Some(error)),
        }
    }

    fn receive(&mut self, limits: Limits, work: &mut Work) -> Result<(), Error> {
        if self.parser.peek().is_some() {
            self.stats.stalled_pumps += 1;
            return Ok(());
        }

        let mut budget = self.read_budget;
        while budget > 0 {
            let window = match self.parser.writable() {
                Ok(window) => window,
                Err(_) => return Ok(()),
            };
            let space = window.len().min(budget);
            let count = match work.recv(&mut self.socket, &mut window[..space], limits) {
                Err(error) if error.is_retry() => return Ok(()),
                Err(error) => return self.fail(io_error(error), Some(error)),
                Ok(count) => count,
            };
            if count > space {
                return self.fail(Error::Failed, None);
            }
            if count == 0 {
                if let Err(error) = self.parser.end() {
                    return self.fail(error, None);
                }
                self.receive_ended = true;
                return Err(Error::Ended);
            }

            budget -= count;
            self.stats.bytes_received += count as u64;
            if let Err(error) = self.parser.commit(count) {
                return self.fail(error, None);
            }
            if self.parser.peek().is_some() {
                self.stats.records += 1;
                return Ok(());
            }
        }
        self.stats.budget_stops += 1;
        Ok(())
    }

    /// Bounded network work. Clean receive EOF returns `Ended` while continuing to flush
    /// acknowledgements on later pumps. Other failures are sticky and stop all IO.
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
        if self.state != State::Streaming {
            return Ok(());
        }
        self.flush(limits, work)?;
        if self.token_bytes > 0 {
            return Ok(());
        }
        if self.receive_ended {
            return Err(Error::Ended);
        }
        self.receive(limits, work)
    }

    pub fn peek(&self) -> Option<Record<'_>> {
        self.parser.peek()
    }

    /// Frees the record's storage and queues its header for acknowledgement. `Again` when
    /// 32 acknowledgements are already outstanding.
    pub fn consume(&mut self) -> Result<(), Error> {
        let header = match self.parser.peek() {
            Some(record) => record.raw_header,
            None => return Err(Error::Again),
        };
        if self.pending_count == MAX_PENDING_ACKS {
            return Err(Error::Again);
        }
        self.parser.consume()?;
        let slot = (self.pending_head + self.pending_count) % MAX_PENDING_ACKS;
        self.pending[slot] = header;
        self.pending_count += 1;
        Ok(())
    }

    /// Acknowledges the oldest consumed record. `header` must be that record's raw header;
    /// `input` is the input record for an `Input` channel and must be empty for `Header`.
    /// Clean receive EOF still permits acknowledgements; a send failure does not.
    pub fn acknowledge(&mut self, header: &[u8; HEADER_BYTES], input: &[u8]) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let in_order = self.pending_count > 0 && self.pending[self.pending_head] == *header;
        let input_ok = match self.ack {
            Ack::Header => input.is_empty(),
            Ack::Input => input.len() <= MAX_INPUT_BYTES,
        };
        if !in_order || !input_ok {
            return Err(Error::Invalid);
        }

        let length = (input.len() as u32).to_le_bytes();
        let queued = match self.ack {
            Ack::Header => self.outbound.push(&[header]),
            Ack::Input => self.outbound.push(&[header, &length, input]),
        };
        if !queued {
            return Err(Error::Again);
        }
        self.pending_head = (self.pending_head + 1) % MAX_PENDING_ACKS;
        self.pending_count -= 1;
        self.stats.acknowledgements += 1;
        Ok(())
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn failure(&self) -> Option<Error> {
        self.failure
    }

    /// The peer ended its send half at a record boundary. This does not close our send half
    /// or mean acknowledgements have drained; a later send can still fail.
    pub fn receive_ended(&self) -> bool {
        self.receive_ended
    }

    /// Clean receive EOF with every record consumed and acknowledgement sent. A failure
    /// never counts as drained. The caller bounds the time it will wait for send readiness.
    pub fn drained(&self) -> bool {
        self.receive_ended
            && self.failure.is_none()
            && self.parser.peek().is_none()
            && self.pending_count == 0
            && self.outbound.queued() == 0
    }

    pub fn stats(&self) -> Stats {
        Stats {
            pending_acks: self.pending_count,
            outbound_bytes: self.outbound.queued(),
            max_outbound_bytes: self.outbound.max_queued(),
            ..self.stats
        }
    }

    /// Closes the socket and wipes buffers. A failed close is returned, never hidden.
    pub fn close(mut self) -> Result<Stats, (Error, Stats)> {
        self.state = State::Closed;
        let stats = self.stats();
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
