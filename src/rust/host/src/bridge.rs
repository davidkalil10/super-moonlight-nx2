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
    PairFailure {
        request_id: u32,
        code: crate::response::Code,
        worker_code: i64,
        busy_app: Option<u32>,
    },
}

pub(crate) struct Pending {
    pub(crate) request_id: u32,
    pub(crate) operation: OperationName,
    pub(crate) buffer: Vec<u8>,
    pub(crate) value: Option<Value>,
    pub(crate) stderr: crate::status::Lines,
    pub(crate) not_paired: bool,
    pub(crate) cover_bytes: Vec<u8>,
    pub(crate) cover_total: Option<usize>,
}

impl Pending {
    pub(crate) fn pair_failure(&self) -> Option<(crate::response::Code, i64, Option<u32>)> {
        let value = self.value.as_ref()?;
        if self.operation != OperationName::Pair || value.get("event")?.as_str()? != "failed" {
            return None;
        }
        let code = if value.get("reason")?.as_str()? == "pairing timed out" {
            crate::response::Code::Timeout
        } else {
            crate::response::Code::BackendFailed
        };
        let worker_code = value.get("code")?.as_i64()?;
        let busy_app = if value.get("reason")?.as_str()? == "pc_busy" && worker_code == -4 {
            value
                .get("app")
                .and_then(Value::as_u64)
                .and_then(|id| u32::try_from(id).ok())
                .filter(|id| *id != 0)
        } else {
            None
        };
        Some((code, worker_code, busy_app))
    }

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
                if self.operation == OperationName::Pair {
                    log_pair_stderr(self.stderr.line().ok_or(())?);
                }
                self.stderr.consume().map_err(|_| ())?;
            } else if used == 0 {
                return Err(());
            }
        }
        Ok(())
    }
}

fn log_pair_stderr(line: &[u8]) {
    const RESULT: &[u8] = b"moonlight-worker gs_pair_return=";
    if let Some(code) = line.strip_prefix(RESULT)
        && let Ok(code) = std::str::from_utf8(code)
        && let Ok(code) = code.parse::<i32>()
    {
        eprintln!("pair: gs_pair returned {code}");
        return;
    }
    eprintln!("pair worker stderr: {}", redact_pair_line(line));
}

fn redact_pair_line(line: &[u8]) -> String {
    let mut out = String::new();
    let mut index = 0;
    while index < line.len() && index < 1024 {
        if line[index].is_ascii_hexdigit() {
            let end = index
                + line[index..]
                    .iter()
                    .take_while(|b| b.is_ascii_hexdigit())
                    .count();
            if end - index >= 64 {
                out.push_str("[redacted]");
                index = end;
                continue;
            }
        }
        let byte = line[index];
        out.push(if byte.is_ascii_digit() {
            '*'
        } else if byte.is_ascii_graphic() || byte == b' ' {
            char::from(byte)
        } else {
            '?'
        });
        index += 1;
    }
    if index < line.len() {
        out.push_str("...[truncated]");
    }
    out
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
            cover_bytes: Vec::new(),
            cover_total: None,
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
                if pending.operation == OperationName::Pair {
                    eprintln!("pair worker completion: {result:?}");
                }
                if !pending.buffer.is_empty() {
                    return Ok(Some(Event::Failure {
                        request_id: pending.request_id,
                        code: crate::response::Code::BackendFailed,
                    }));
                }
                if matches!(result, Completion::Exited(_))
                    && let Some((code, worker_code, busy_app)) = pending.pair_failure()
                {
                    return Ok(Some(Event::PairFailure {
                        request_id: pending.request_id,
                        code,
                        worker_code,
                        busy_app,
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

#[cfg(test)]
mod pair_log_tests {
    use super::redact_pair_line;

    #[test]
    fn removes_pin_tokens_and_control_bytes() {
        let token = "a".repeat(64);
        let line = format!("pair PIN=1234 token={token} code=13\r");
        let logged = redact_pair_line(line.as_bytes());
        assert!(!logged.contains("1234"));
        assert!(!logged.contains(&token));
        assert_eq!(logged, "pair PIN=**** token=[redacted] code=**?");
    }
}

pub(crate) fn consume_available(pending: &mut Pending) -> Result<Option<Event>, ()> {
    let mut progress = None;
    while pending.buffer.contains(&b'\n') {
        if let Some(event) = consume_line(pending)? {
            if progress.is_some() {
                return Err(());
            }
            progress = Some(event);
        }
    }
    Ok(progress)
}

fn consume_line(pending: &mut Pending) -> Result<Option<Event>, ()> {
    let Some(end) = pending.buffer.iter().position(|byte| *byte == b'\n') else {
        return Ok(None);
    };
    let line: Vec<_> = pending.buffer.drain(..=end).collect();
    let value: Value = serde_json::from_slice(&line).map_err(|_| ())?;
    let event = value.get("event").and_then(Value::as_str);
    if pending.operation == OperationName::Cover && event == Some("cover_chunk") {
        if pending.value.is_some() {
            return Err(());
        }
        let total = value
            .get("total")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(())?;
        let offset = value
            .get("offset")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(())?;
        let bytes =
            crate::cover::decode_base64(value.get("data").and_then(Value::as_str).ok_or(())?)
                .map_err(|_| ())?;
        if total == 0
            || total > crate::cover::MAX_COVER_BYTES
            || offset != pending.cover_bytes.len()
            || offset > total
            || pending.cover_total.is_some_and(|old| old != total)
            || bytes.len() > total - offset
        {
            return Err(());
        }
        pending.cover_total = Some(total);
        pending.cover_bytes.extend_from_slice(&bytes);
        return Ok(None);
    }
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
        OperationName::Cover => {
            event == Some("cover_done")
                && pending.cover_total == Some(pending.cover_bytes.len())
                && value
                    .get("sha256")
                    .and_then(Value::as_str)
                    .is_some_and(|hash| {
                        hash.len() == 64
                            && hash
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
        }
        OperationName::List => {
            let apps = value.get("apps").and_then(Value::as_array).ok_or(())?;
            value.get("currentGame").and_then(Value::as_i64).is_some()
                && value.get("uniqueid").is_none_or(Value::is_string)
                && value.get("macs").is_none_or(|macs| {
                    macs.as_array().is_some_and(|values| {
                        values.len() <= 8
                            && values.iter().all(|value| {
                                value.as_str().is_some_and(|mac| {
                                    crate::mac::normalize(mac).as_deref() == Some(mac)
                                })
                            })
                    })
                })
                && apps.iter().all(|app| {
                    app.get("id").and_then(Value::as_i64).is_some()
                        && app.get("name").and_then(Value::as_str).is_some()
                })
        }
        OperationName::Pair => {
            (event == Some("paired") && value.get("already").and_then(Value::as_bool).is_some())
                || (event == Some("failed")
                    && value
                        .get("reason")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty() && s.len() <= 256)
                    && value.get("code").and_then(Value::as_i64).is_some())
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
