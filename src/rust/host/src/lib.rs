pub mod ack;
pub mod assemble;
pub mod av1;
pub mod bridge;
pub mod channel;
#[cfg(unix)]
#[path = "control.rs"]
pub mod control_server;
#[cfg(unix)]
pub mod controller;
pub mod cover;
#[cfg(unix)]
pub mod display;
pub mod gamepads;
pub mod helper;
pub mod input;
pub mod listener;
pub mod mac;
pub mod management;
#[cfg(unix)]
pub mod pairing_store;
pub mod probe;
#[cfg(unix)]
pub mod relay;
pub mod relay_stats;
pub mod response;
#[cfg(target_os = "linux")]
pub mod service;
#[cfg(target_os = "linux")]
pub mod socket_options;
pub mod status;
#[cfg(unix)]
pub mod stream;
mod telemetry;
#[cfg(unix)]
pub mod transport;
pub mod udp_control;
pub mod udp_endpoint;
pub mod udp_feedback;
pub mod udp_video;
pub mod video_queue;
pub mod window;
mod wire;

use moonlight_nx2_core::control::{self, Frame, Kind};
use std::sync::atomic::{Ordering, compiler_fence};
use subtle::ConstantTimeEq;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Codec {
    H264,
    Hevc,
    Av1,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Transport {
    #[default]
    TcpV1,
    UdpV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StreamOptions {
    pub transport: Transport,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub codec: Codec,
    pub sops: bool,
    pub local_audio: bool,
    pub quit_on_stop: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Operation<'a> {
    Pair {
        host: &'a str,
        timeout_seconds: u32,
    },
    Unpair {
        host: &'a str,
    },
    List {
        host: &'a str,
    },
    Cover {
        host: &'a str,
        app: u32,
        offset: usize,
    },
    Quit {
        host: &'a str,
    },
    Start {
        host: &'a str,
        app: &'a str,
        options: StreamOptions,
    },
    Stop,
    Idr,
    /// Link measurement for the console: echo `sequence` with `bytes` of padding.
    Probe {
        sequence: u32,
        bytes: u32,
    },
}

impl Operation<'_> {
    fn valid(self) -> bool {
        fn text(s: &str, max: usize) -> bool {
            !s.is_empty() && s.len() <= max && !s.bytes().any(|b| b == 0 || b.is_ascii_control())
        }
        match self {
            Self::Pair {
                host,
                timeout_seconds,
            } => text(host, 255) && (1..=600).contains(&timeout_seconds),
            Self::Unpair { host } | Self::List { host } | Self::Quit { host } => text(host, 255),
            Self::Cover { host, app, .. } => text(host, 255) && app > 0,
            Self::Start { host, app, options } => {
                text(host, 255)
                    && text(app, 1024)
                    && (2..=3840).contains(&options.width)
                    && options.width % 2 == 0
                    && (2..=2160).contains(&options.height)
                    && options.height % 2 == 0
                    && (1..=120).contains(&options.fps)
                    && (1..=1_000_000).contains(&options.bitrate_kbps)
            }
            Self::Stop | Self::Idr => true,
            Self::Probe { bytes, .. } => bytes <= probe::MAX_BYTES,
        }
    }
}

pub trait Backend {
    type Output;
    type Error;
    fn configure_telemetry(&mut self, _enabled: bool) {}
    fn execute(
        &mut self,
        request_id: u32,
        operation: Operation<'_>,
    ) -> Result<Self::Output, Self::Error>;
    fn is_busy(&self) -> bool {
        false
    }
    fn cancel_pending(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
    fn stop_pending(&self) -> bool {
        false
    }
    fn allow_stop_during_busy(&self) -> bool {
        false
    }
    fn shutdown(&mut self, streaming: bool) -> Result<(), Self::Error> {
        if self.is_busy() {
            self.cancel_pending()?;
        }
        if streaming {
            self.execute(0, Operation::Stop)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    AwaitingAuth,
    Ready,
    Streaming,
    Closed,
}

#[derive(Debug, Eq, PartialEq)]
pub enum Error<E> {
    InvalidToken,
    Authentication,
    Closed,
    InvalidFrame,
    InvalidEncoding,
    InvalidRequest,
    Replay,
    InvalidOperation,
    InvalidState,
    Busy,
    Unsupported,
    Backend(E),
}

pub struct Session<B> {
    backend: B,
    token: [u8; control::AUTH_BYTES],
    state: State,
    last_id: u32,
    protocol_failed: bool,
}

impl<B: Backend> Session<B> {
    pub fn new(token: [u8; control::AUTH_BYTES], backend: B) -> Result<Self, Error<B::Error>> {
        if !token
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            return Err(Error::InvalidToken);
        }
        Ok(Self {
            backend,
            token,
            state: State::AwaitingAuth,
            last_id: 0,
            protocol_failed: false,
        })
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    pub fn authenticate(&mut self, frame: Frame<'_>) -> Result<(), Error<B::Error>> {
        if self.state == State::Closed {
            return Err(Error::Closed);
        }
        if self.state != State::AwaitingAuth {
            return Err(Error::InvalidState);
        }
        let shape = frame.header.kind == Kind::Auth
            && frame.header.request_id == 0
            && frame.header.payload_bytes as usize == control::AUTH_BYTES
            && frame.payload.len() == control::AUTH_BYTES;
        let matches = shape && bool::from(self.token.as_slice().ct_eq(frame.payload));
        self.clear_token();
        if !matches {
            self.state = State::Closed;
            return Err(Error::Authentication);
        }
        self.state = State::Ready;
        Ok(())
    }

    pub fn request(&mut self, frame: Frame<'_>) -> Result<B::Output, Error<B::Error>> {
        if self.state == State::Closed {
            return Err(Error::Closed);
        }
        if self.state == State::AwaitingAuth {
            self.clear_token();
            self.state = State::Closed;
            return Err(Error::Authentication);
        }
        if self.protocol_failed {
            return Err(Error::Closed);
        }
        if frame.header.kind != Kind::Request
            || frame.payload.is_empty()
            || frame.payload.len() > control::MAX_PAYLOAD
            || frame.header.payload_bytes as usize != frame.payload.len()
        {
            self.close_on_protocol_error();
            return Err(Error::InvalidFrame);
        }
        if std::str::from_utf8(frame.payload).is_err() {
            self.close_on_protocol_error();
            return Err(Error::InvalidEncoding);
        }
        if serde_json::from_slice::<serde_json::Value>(frame.payload).is_err() {
            self.close_on_protocol_error();
            return Err(Error::InvalidEncoding);
        }
        if frame.header.request_id == 0 || frame.header.request_id <= self.last_id {
            return Err(Error::Replay);
        }
        self.last_id = frame.header.request_id;
        let request: wire::Request = match serde_json::from_slice(frame.payload) {
            Ok(request) => request,
            Err(error) if error.is_syntax() || error.is_eof() => {
                self.close_on_protocol_error();
                return Err(Error::InvalidEncoding);
            }
            Err(_) => return Err(Error::InvalidRequest),
        };
        let operation = request.operation();
        if !operation.valid() {
            return Err(Error::InvalidOperation);
        }
        if self.backend.is_busy()
            && !(operation == Operation::Stop && self.backend.allow_stop_during_busy())
        {
            return Err(Error::Busy);
        }
        match (self.state, operation) {
            (State::Ready, Operation::Stop | Operation::Idr)
            | (State::Streaming, Operation::Start { .. }) => {
                return Err(Error::InvalidState);
            }
            (State::Streaming, op) if op != Operation::Stop && op != Operation::Idr => {
                return Err(Error::InvalidState);
            }
            _ => {}
        }
        if let Operation::Start { .. } = operation {
            let telemetry = match request.telemetry() {
                None => false,
                Some("upstream-v1") => true,
                Some(_) => return Err(Error::Unsupported),
            };
            self.backend.configure_telemetry(telemetry);
        }
        let output = self
            .backend
            .execute(frame.header.request_id, operation)
            .map_err(Error::Backend)?;
        match operation {
            Operation::Start { .. } => self.state = State::Streaming,
            Operation::Stop if !self.backend.stop_pending() => self.state = State::Ready,
            _ => {}
        }
        Ok(output)
    }

    fn close_on_protocol_error(&mut self) {
        self.protocol_failed = true;
        if self.state == State::Ready {
            self.clear_token();
            self.state = State::Closed;
        }
    }

    pub fn stream_stopped(&mut self) -> Result<(), Error<B::Error>> {
        if self.state != State::Streaming {
            return Err(Error::InvalidState);
        }
        self.state = State::Ready;
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), Error<B::Error>> {
        self.backend
            .shutdown(self.state == State::Streaming)
            .map_err(Error::Backend)?;
        self.clear_token();
        self.state = State::Closed;
        Ok(())
    }

    fn clear_token(&mut self) {
        for byte in &mut self.token {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

impl<B> Drop for Session<B> {
    fn drop(&mut self) {
        for byte in &mut self.token {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}
