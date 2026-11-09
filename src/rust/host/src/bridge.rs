use crate::helper::{Helper, Stream};
use crate::management::{self, Completion, Management, OperationName};
use crate::{Error as SessionError, Session};
use moonlight_nx2_core::control::{self, Frame};
use serde_json::Value;
use std::time::Instant;

#[derive(Debug)]
pub enum Error {
    Session(SessionError<management::Error>),
    Management(management::Error),
}

#[derive(Debug)]
pub enum Event {
    Progress {
        request_id: u32,
        value: Value,
    },
    Result {
        request_id: u32,
        operation: OperationName,
        value: Value,
    },
    Failure {
        request_id: u32,
        code: crate::response::Code,
    },
}

pub(crate) struct Pending {
    pub(crate) request_id: u32,
    pub(crate) operation: OperationName,
    pub(crate) buffer: Vec<u8>,
    pub(crate) value: Option<Value>,
    pub(crate) stderr: crate::status::Lines,
    pub(crate) not_paired: bool,
}

impl Pending {
    pub(crate) fn confirmed_not_paired(&self, status: std::process::ExitStatus) -> bool {
        matches!(self.operation, OperationName::List | OperationName::Quit)
            && (status.code() == Some(crate::helper::NOT_PAIRED_EXIT_CODE)
                || (status.code() == Some(1) && self.not_paired))
    }

    pub(crate) fn consume_stderr(&mut self, mut bytes: &[u8]) -> Result<(), ()> {
        while !bytes.is_empty() {
            let used = self.stderr.feed(bytes).map_err(|_| ())?;
            bytes = &bytes[used..];
            if self.stderr.peek().map_err(|_| ())?.is_some() {
                self.not_paired |= self.stderr.is_not_paired();
                self.stderr.consume().map_err(|_| ())?;
            } else if used == 0 {
                return Err(());
            }
        }
        Ok(())
    }
}

pub struct Bridge {
    session: Session<Management>,
    pending: Option<Pending>,
}

impl Bridge {
    pub fn new(token: [u8; control::AUTH_BYTES], helper: Helper) -> Result<Self, Error> {
        Ok(Self {
            session: Session::new(token, Management::new(helper)).map_err(Error::Session)?,
            pending: None,
        })
    }

    pub fn authenticate(&mut self, frame: Frame<'_>) -> Result<(), Error> {
        self.session.authenticate(frame).map_err(Error::Session)
    }

    pub fn request(&mut self, frame: Frame<'_>) -> Result<(), Error> {
        if let Err(error) = self.session.request(frame) {
            if matches!(
                error,
                SessionError::Authentication
                    | SessionError::InvalidFrame
                    | SessionError::InvalidEncoding
            ) {
                self.close()?;
            }
            return Err(Error::Session(error));
        }
        let (request_id, operation) = self
            .session
            .backend_mut()
            .current()
            .expect("management request started");
        self.pending = Some(Pending {
            request_id,
            operation,
            buffer: Vec::new(),
            value: None,
            stderr: crate::status::Lines::new(),
            not_paired: false,
        });
        Ok(())
    }

    pub fn poll(&mut self, now: Instant) -> Result<Option<Event>, Error> {
        if let Some(pending) = &mut self.pending {
            match consume_available(pending) {
                Ok(Some(event)) => return Ok(Some(event)),
                Ok(None) => {}
                Err(()) => return self.fail_output(crate::response::Code::BackendFailed),
            }
        }
        let Some(event) = self
            .session
            .backend_mut()
            .poll(now)
            .map_err(Error::Management)?
        else {
            return Ok(None);
        };
        let pending = self
            .pending
            .as_mut()
            .expect("process has a pending request");
        match event {
            management::Event::Output {
                stream: Stream::Stderr,
                bytes,
                ..
            } => match pending.consume_stderr(&bytes) {
                Ok(()) => Ok(None),
                Err(()) => self.fail_output(crate::response::Code::BackendFailed),
            },
            management::Event::Output {
                stream: Stream::Stdout,
                bytes,
                ..
            } => {
                if bytes.len() > control::MAX_PAYLOAD - pending.buffer.len() {
                    self.session
                        .backend_mut()
                        .cancel()
                        .map_err(Error::Management)?;
                    let id = pending.request_id;
                    self.pending = None;
                    return Ok(Some(Event::Failure {
                        request_id: id,
                        code: crate::response::Code::TooLarge,
                    }));
                }
                pending.buffer.extend_from_slice(&bytes);
                match consume_available(pending) {
                    Ok(event) => Ok(event),
                    Err(()) => self.fail_output(crate::response::Code::BackendFailed),
                }
            }
            management::Event::Complete { result, .. } => {
                let mut pending = self.pending.take().expect("pending request");
                if !pending.buffer.is_empty() {
                    return Ok(Some(Event::Failure {
                        request_id: pending.request_id,
                        code: crate::response::Code::BackendFailed,
                    }));
                }
                let code = match result {
                    Completion::Exited(status) if status.success() => None,
                    Completion::Exited(status) if pending.confirmed_not_paired(status) => {
                        Some(crate::response::Code::NotPaired)
                    }
                    Completion::Exited(status)
                        if status.code() == Some(crate::helper::OPERATION_TIMEOUT_EXIT_CODE) =>
                    {
                        Some(crate::response::Code::Timeout)
                    }
                    Completion::Exited(status)
                        if status.code() == Some(crate::helper::OUTPUT_TOO_LARGE_EXIT_CODE) =>
                    {
                        Some(crate::response::Code::TooLarge)
                    }
                    Completion::TimedOut | Completion::OutputCloseTimeout => {
                        Some(crate::response::Code::Timeout)
                    }
                    Completion::OutputOverflow => Some(crate::response::Code::TooLarge),
                    Completion::Cancelled => Some(crate::response::Code::Cancelled),
                    _ => Some(crate::response::Code::BackendFailed),
                };
                if let Some(code) = code {
                    return Ok(Some(Event::Failure {
                        request_id: pending.request_id,
                        code,
                    }));
                }
                match pending.value.take() {
                    Some(value) => Ok(Some(Event::Result {
                        request_id: pending.request_id,
                        operation: pending.operation,
                        value,
                    })),
                    None => Ok(Some(Event::Failure {
                        request_id: pending.request_id,
                        code: crate::response::Code::BackendFailed,
                    })),
                }
            }
        }
    }

    fn fail_output(&mut self, code: crate::response::Code) -> Result<Option<Event>, Error> {
        self.session
            .backend_mut()
            .cancel()
            .map_err(Error::Management)?;
        let request_id = self.pending.take().expect("pending request").request_id;
        Ok(Some(Event::Failure { request_id, code }))
    }

    pub fn close(&mut self) -> Result<(), Error> {
        self.session.close().map_err(Error::Session)?;
        self.pending = None;
        Ok(())
    }
}

pub(crate) fn consume_available(pending: &mut Pending) -> Result<Option<Event>, ()> {
    while pending.buffer.contains(&b'\n') {
        if let Some(event) = consume_line(pending)? {
            return Ok(Some(event));
        }
    }
    Ok(None)
}

fn consume_line(pending: &mut Pending) -> Result<Option<Event>, ()> {
    let Some(end) = pending.buffer.iter().position(|byte| *byte == b'\n') else {
        return Ok(None);
    };
    let line: Vec<_> = pending.buffer.drain(..=end).collect();
    let value: Value = serde_json::from_slice(&line).map_err(|_| ())?;
    let event = value.get("event").and_then(Value::as_str);
    if pending.operation == OperationName::Pair && event == Some("pin") {
        let pin = value.get("pin").and_then(Value::as_str).ok_or(())?;
        if pin.len() != 4
            || !pin.bytes().all(|b| b.is_ascii_digit())
            || value.get("url").and_then(Value::as_str).is_none()
            || value.get("timeout").and_then(Value::as_u64).is_none()
        {
            return Err(());
        }
        return Ok(Some(Event::Progress {
            request_id: pending.request_id,
            value,
        }));
    }
    let valid = match pending.operation {
        OperationName::List => {
            let apps = value.get("apps").and_then(Value::as_array).ok_or(())?;
            value.get("currentGame").and_then(Value::as_i64).is_some()
                && value.get("uniqueid").is_none_or(Value::is_string)
                && apps.iter().all(|app| {
                    app.get("id").and_then(Value::as_i64).is_some()
                        && app.get("name").and_then(Value::as_str).is_some()
                })
        }
        OperationName::Pair => {
            event == Some("paired") && value.get("already").and_then(Value::as_bool).is_some()
        }
        OperationName::Unpair => {
            event == Some("unpaired") && value.get("already").and_then(Value::as_bool).is_some()
        }
        OperationName::Quit => {
            event == Some("quit")
                && value.get("already").and_then(Value::as_bool).is_some()
                && value.get("cancelled").and_then(Value::as_bool).is_some()
                && value.get("currentGame").and_then(Value::as_i64).is_some()
        }
    };
    if !valid || pending.value.is_some() {
        return Err(());
    }
    pending.value = Some(value);
    Ok(None)
}
