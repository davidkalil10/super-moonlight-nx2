use crate::{
    bridge,
    controller::{self, Controller, Started},
    helper::Helper,
    management, response,
};
use moonlight_nx2_core::control::{self, Kind, Parser};
use serde_json::json;
use std::{
    io::{self, Read},
    net::TcpStream,
    sync::atomic::{Ordering, compiler_fence},
    time::{Duration, Instant},
};

#[path = "write_queue.rs"]
mod write_queue;
use write_queue::WriteQueue;

use crate::transport::{SecureStream, Transport};
use std::io::Write as _;

const INPUT_BYTES: usize = 8192;
const MAX_QUEUED: usize = 4;
const WRITE_BUDGET: usize = 65_536;

#[derive(Debug)]
pub enum Error {
    Closed,
    WriteTimeout,
    Frame(control::Error),
    Controller(controller::Error),
    Response(response::Error),
    Io(io::Error),
}

pub struct Connection<'a> {
    socket: Transport,
    parser: Parser<'a>,
    controller: Controller,
    input: [u8; INPUT_BYTES],
    input_used: usize,
    input_end: usize,
    output: WriteQueue,
    authenticated: bool,
    auth_deadline: Instant,
    closed: bool,
    revoked: bool,
}

impl<'a> Connection<'a> {
    /// The one-shot path: the console proves itself with the token in its Auth frame.
    pub fn new(
        socket: TcpStream,
        token: [u8; 64],
        helper: Helper,
        payload_storage: &'a mut [u8],
    ) -> Result<Self, Error> {
        Self::over(Transport::Plain(socket), token, helper, payload_storage)
    }

    /// A paired console's session: the handshake already authenticated both ends.
    pub fn secure(
        stream: SecureStream,
        helper: Helper,
        payload_storage: &'a mut [u8],
    ) -> Result<Self, Error> {
        Self::over(
            Transport::Secure(Box::new(stream)),
            moonlight_nx2_secure::SESSION_TOKEN,
            helper,
            payload_storage,
        )
    }

    fn over(
        socket: Transport,
        token: [u8; 64],
        helper: Helper,
        payload_storage: &'a mut [u8],
    ) -> Result<Self, Error> {
        let tcp = socket.socket();
        tcp.set_nonblocking(true).map_err(Error::Io)?;
        #[cfg(target_os = "linux")]
        crate::socket_options::apply(tcp, crate::socket_options::Class::Control)
            .map_err(Error::Io)?;
        let bind = tcp.local_addr().map_err(Error::Io)?.ip();
        let peer = tcp.peer_addr().map_err(Error::Io)?.ip();
        let parser = Parser::new(payload_storage).map_err(Error::Frame)?;
        let controller = Controller::new(token, helper, bind, peer).map_err(Error::Controller)?;
        Ok(Self {
            socket,
            parser,
            controller,
            input: [0; INPUT_BYTES],
            input_used: 0,
            input_end: 0,
            output: WriteQueue::new(),
            authenticated: false,
            auth_deadline: Instant::now() + Duration::from_secs(15),
            closed: false,
            revoked: false,
        })
    }
    /// Lets streams that ask for it switch the PC display; without this it is never touched.
    pub fn match_display(&mut self, display: crate::display::Session) {
        self.controller.match_display(display);
    }
    pub fn pump(&mut self, now: Instant) -> Result<(), Error> {
        self.pump_with_video_readiness(now).map(|_| ())
    }
    /// Reports an advisory video-readability hint after the bounded relay turn.
    /// A false result includes idle, interrupted, capacity and control-output backpressure.
    pub fn pump_with_video_readiness(&mut self, now: Instant) -> Result<bool, Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if let Err(error) = self
            .pump_inner(now)
            .and_then(|()| self.service_telemetry(now))
        {
            self.close()?;
            return Err(error);
        }
        let readable = self.controller.take_video_readable();
        Ok(readable && self.output.len() < MAX_QUEUED)
    }
    fn service_telemetry(&mut self, now: Instant) -> Result<(), Error> {
        if !self.controller.telemetry_allowed() {
            self.output.purge_status();
            return Ok(());
        }
        if let Some(snapshot) = self.controller.telemetry_snapshot(now) {
            let mut bytes = vec![0; control::HEADER_BYTES + control::MAX_PAYLOAD];
            let size =
                response::encode(Kind::Event, 0, &snapshot, &mut bytes).map_err(Error::Response)?;
            bytes.truncate(size);
            self.output.status(bytes, now);
        }
        if self.output.len() == 0 {
            self.output
                .flush_status(&mut self.socket, now, WRITE_BUDGET)
                .map_err(|error| match error.kind() {
                    io::ErrorKind::TimedOut => Error::WriteTimeout,
                    io::ErrorKind::WriteZero => Error::Closed,
                    _ => Error::Io(error),
                })?;
        }
        Ok(())
    }
    fn enqueue(
        &mut self,
        now: Instant,
        encode: impl FnOnce(&mut [u8]) -> Result<usize, response::Error>,
    ) -> Result<(), Error> {
        let mut bytes = vec![0; control::HEADER_BYTES + control::MAX_PAYLOAD];
        let size = encode(&mut bytes).map_err(Error::Response)?;
        bytes.truncate(size);
        self.output.push(bytes, now);
        Ok(())
    }
    fn flush(&mut self, now: Instant) -> Result<(), Error> {
        self.output
            .flush(&mut self.socket, now, WRITE_BUDGET)
            .map_err(|error| match error.kind() {
                io::ErrorKind::TimedOut => Error::WriteTimeout,
                io::ErrorKind::WriteZero => Error::Closed,
                _ => Error::Io(error),
            })
    }
    fn check_full_queue_peer(&self) -> Result<(), Error> {
        let mut byte = [0; 1];
        match self.socket.socket().peek(&mut byte) {
            Ok(0) => Err(Error::Closed),
            Ok(_) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(Error::Io(error)),
        }
    }
    fn pump_inner(&mut self, now: Instant) -> Result<(), Error> {
        if !self.authenticated && now >= self.auth_deadline {
            return Err(Error::Closed);
        }
        match self.socket.flush() {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(Error::Io(error)),
        }
        self.flush(now)?;
        if self.output.len() == MAX_QUEUED {
            return self.check_full_queue_peer();
        }
        if let Some(event) = self.controller.poll(now).map_err(Error::Controller)? {
            self.emit_event(now, event)?;
        }
        if self.output.len() == MAX_QUEUED {
            return self.check_full_queue_peer();
        }
        if self.input_used == self.input_end {
            match self.socket.read(&mut self.input) {
                Ok(0) => {
                    self.parser.end().map_err(Error::Frame)?;
                    return Err(Error::Closed);
                }
                Ok(count) => {
                    self.input_used = 0;
                    self.input_end = count;
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.kind() == io::ErrorKind::Interrupted =>
                {
                    return Ok(());
                }
                Err(error) => return Err(Error::Io(error)),
            }
        }
        let taken = self
            .parser
            .feed(&self.input[self.input_used..self.input_end])
            .map_err(Error::Frame)?;
        for byte in &mut self.input[self.input_used..self.input_used + taken] {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
        self.input_used += taken;
        if let Some(frame) = self.parser.peek().map_err(Error::Frame)? {
            let id = frame.header.request_id;
            if !self.authenticated {
                self.controller
                    .authenticate(frame)
                    .map_err(Error::Controller)?;
                self.parser.consume().map_err(Error::Frame)?;
                self.authenticated = true;
                self.enqueue(now, response::accepted)?;
            } else {
                let result = self.controller.request(frame);
                self.parser.consume().map_err(Error::Frame)?;
                match result {
                    Ok(
                        Started::Management
                        | Started::CoverReady
                        | Started::StartPending
                        | Started::StopPending,
                    ) => {}
                    Ok(Started::Stream(descriptor)) => {
                        self.enqueue(now, |out| descriptor.encode(id, out))?
                    }
                    Ok(Started::IdrReady { queued }) => self.enqueue(now, |out| {
                        response::result(
                            id,
                            response::OperationName::Idr,
                            &json!({"queued":queued}),
                            out,
                        )
                    })?,
                    Ok(Started::TextReady { queued }) => self.enqueue(now, |out| {
                        response::result(
                            id,
                            response::OperationName::Text,
                            &json!({"queued":queued}),
                            out,
                        )
                    })?,
                    Ok(Started::RevokeReady) => {
                        self.revoked = true;
                        self.enqueue(now, |out| {
                            response::result(
                                id,
                                response::OperationName::Revoke,
                                &json!({"event":"revoked"}),
                                out,
                            )
                        })?
                    }
                    Ok(Started::ProbeReady { sequence, bytes }) => self.enqueue(now, |out| {
                        response::result(
                            id,
                            response::OperationName::Probe,
                            &crate::probe::reply(sequence, bytes),
                            out,
                        )
                    })?,
                    Err(controller::Error::Session(error)) => {
                        let code = match error {
                            crate::Error::InvalidRequest
                            | crate::Error::InvalidOperation
                            | crate::Error::Replay => response::Code::InvalidRequest,
                            crate::Error::InvalidState => response::Code::InvalidState,
                            crate::Error::Busy => response::Code::Busy,
                            crate::Error::Unsupported => response::Code::Unsupported,
                            crate::Error::Backend(_) => response::Code::BackendFailed,
                            _ => return Err(Error::Closed),
                        };
                        if id == 0 {
                            return Err(Error::Closed);
                        }
                        self.enqueue(now, |out| response::failure(id, code, out))?;
                    }
                    Err(error) => return Err(Error::Controller(error)),
                }
            }
        }
        Ok(())
    }
    fn emit_event(&mut self, now: Instant, event: controller::Event) -> Result<(), Error> {
        match event {
            controller::Event::Stream {
                request_id,
                descriptor,
            } => self.enqueue(now, |out| descriptor.encode(request_id, out)),
            controller::Event::Management(bridge::Event::Progress { request_id, value }) => {
                self.enqueue(now, |out| response::pair_progress(request_id, &value, out))
            }
            controller::Event::Management(bridge::Event::Result {
                request_id,
                operation,
                value,
            }) => {
                let op = match operation {
                    management::OperationName::Pair => response::OperationName::Pair,
                    management::OperationName::List => response::OperationName::List,
                    management::OperationName::Cover => response::OperationName::Cover,
                    management::OperationName::Unpair => response::OperationName::Unpair,
                    management::OperationName::Quit => response::OperationName::Quit,
                };
                match self.enqueue(now, |out| response::result(request_id, op, &value, out)) {
                    Err(Error::Response(response::Error::TooLarge)) => self.enqueue(now, |out| {
                        response::failure(request_id, response::Code::TooLarge, out)
                    }),
                    result => result,
                }
            }
            controller::Event::Management(bridge::Event::Failure { request_id, code }) => {
                self.enqueue(now, |out| response::failure(request_id, code, out))
            }
            controller::Event::Management(bridge::Event::PairFailure {
                request_id,
                code,
                worker_code,
                busy_app,
            }) => self.enqueue(now, |out| {
                response::pair_failure(request_id, code, worker_code, busy_app, out)
            }),
            controller::Event::Connected => self.enqueue(now, |out| {
                response::encode(Kind::Event, 0, &json!({"event":"connected"}), out)
            }),
            controller::Event::StreamFailed {
                start_id,
                code,
                message,
            } => self.enqueue(now, |out| {
                response::stream_failure(start_id, code, message, out)
            }),
            controller::Event::Stopped {
                request_id: Some(id),
            } => self.enqueue(now, |out| {
                response::result(id, response::OperationName::Stop, &json!({}), out)
            }),
            controller::Event::Stopped { request_id: None } => self.enqueue(now, |out| {
                response::encode(Kind::Event, 0, &json!({"event":"stopped"}), out)
            }),
            controller::Event::Rumble(rumble) => self.enqueue(now, |out| {
                let value = json!({
                    "event": "rumble",
                    "controller": rumble.controller,
                    "low": rumble.low,
                    "high": rumble.high,
                });
                response::encode(Kind::Event, 0, &value, out)
            }),
            controller::Event::TouchUnsupported => self.enqueue(now, |out| {
                let value = json!({"event": "touch", "supported": false});
                response::encode(Kind::Event, 0, &value, out)
            }),
            controller::Event::DisplayUnmatched(reason) => self.enqueue(now, |out| {
                let value = json!({"event": "host_display", "reason": reason.code()});
                response::encode(Kind::Event, 0, &value, out)
            }),
        }
    }
    /// The console asked to be dropped from the trusted list.
    pub fn revoked(&self) -> bool {
        self.revoked
    }

    /// Whether replies are still waiting to be written.
    pub fn flushing(&self) -> bool {
        self.output.len() > 0
    }

    pub fn close(&mut self) -> Result<(), Error> {
        if self.closed {
            return Ok(());
        }
        self.socket.shutdown();
        let cleanup = self.controller.close().map_err(Error::Controller);
        for byte in &mut self.input {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
        self.output.clear();
        self.closed = true;
        cleanup
    }
}
impl Drop for Connection<'_> {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
