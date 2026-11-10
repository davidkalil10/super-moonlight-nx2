use moonlight_nx2_core::control::{self, Kind};
use serde::Serialize;
use serde_json::Value;
use std::io::{self, Write};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    InvalidRequest,
    InvalidState,
    Busy,
    Unsupported,
    TooLarge,
    NotPaired,
    BackendFailed,
    Timeout,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamFailureCode {
    BackendFailed,
    Timeout,
    Cancelled,
    Unsupported,
    TooLarge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationName {
    Pair,
    List,
    Cover,
    Unpair,
    Quit,
    Stop,
    Idr,
    Probe,
}

#[derive(Debug)]
pub enum Error {
    InvalidId,
    TooLarge,
    Encoding,
    Frame(control::Error),
}

#[derive(Serialize)]
struct Accepted {
    version: u8,
    ready: bool,
}
#[derive(Serialize)]
struct Failure<'a> {
    code: Code,
    message: &'a str,
}
#[derive(Serialize)]
struct StreamFailure<'a> {
    event: &'static str,
    start_id: u32,
    code: StreamFailureCode,
    message: &'a str,
}
#[derive(Serialize)]
struct ResultPayload<'a> {
    event: &'static str,
    op: OperationName,
    ok: bool,
    value: &'a Value,
}

struct Limited {
    bytes: Vec<u8>,
    exceeded: bool,
}

impl Drop for Limited {
    fn drop(&mut self) {
        for byte in &mut self.bytes {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    }
}

impl Write for Limited {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > control::MAX_PAYLOAD - self.bytes.len() {
            self.exceeded = true;
            return Err(io::Error::other("response too large"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn encode<T: Serialize>(
    kind: Kind,
    request_id: u32,
    value: &T,
    out: &mut [u8],
) -> Result<usize, Error> {
    let mut payload = Limited {
        bytes: Vec::new(),
        exceeded: false,
    };
    if serde_json::to_writer(&mut payload, value).is_err() {
        return Err(if payload.exceeded {
            Error::TooLarge
        } else {
            Error::Encoding
        });
    }
    control::encode(kind, request_id, &payload.bytes, out).map_err(Error::Frame)
}

pub fn accepted(out: &mut [u8]) -> Result<usize, Error> {
    encode(
        Kind::Accepted,
        0,
        &Accepted {
            version: 1,
            ready: true,
        },
        out,
    )
}

pub fn stream_failure(
    start_id: u32,
    code: StreamFailureCode,
    message: &str,
    out: &mut [u8],
) -> Result<usize, Error> {
    if start_id == 0 {
        return Err(Error::InvalidId);
    }
    if message.is_empty()
        || message.len() > 256
        || message.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(Error::Encoding);
    }
    encode(
        Kind::Event,
        0,
        &StreamFailure {
            event: "stream_failed",
            start_id,
            code,
            message,
        },
        out,
    )
}

pub fn failure(id: u32, code: Code, out: &mut [u8]) -> Result<usize, Error> {
    if id == 0 {
        return Err(Error::InvalidId);
    }
    let message = match code {
        Code::InvalidRequest => "Invalid request",
        Code::InvalidState => "Invalid session state",
        Code::Busy => "Operation in progress",
        Code::Unsupported => "Unsupported operation",
        Code::TooLarge => "Response too large",
        Code::NotPaired => "Pair with this host first",
        Code::BackendFailed => "Host operation failed",
        Code::Timeout => "Operation timed out",
        Code::Cancelled => "Operation cancelled",
    };
    encode(Kind::Error, id, &Failure { code, message }, out)
}

pub fn pair_failure(
    id: u32,
    code: Code,
    worker_code: i64,
    busy_app: Option<u32>,
    out: &mut [u8],
) -> Result<usize, Error> {
    if id == 0 {
        return Err(Error::InvalidId);
    }
    let reason = if code == Code::Timeout {
        "Pairing timed out"
    } else {
        "Pairing request failed"
    };
    let message = match busy_app {
        Some(app) => format!("The PC is busy with app {app}; close it in Sunshine first"),
        None if worker_code == -4 => {
            "Pairing failed because the PC state changed; retry after checking Sunshine".to_owned()
        }
        None => format!("{reason} (worker code {worker_code})"),
    };
    encode(
        Kind::Error,
        id,
        &Failure {
            code,
            message: &message,
        },
        out,
    )
}

pub fn result(id: u32, op: OperationName, value: &Value, out: &mut [u8]) -> Result<usize, Error> {
    if id == 0 {
        return Err(Error::InvalidId);
    }
    encode(
        Kind::Event,
        id,
        &ResultPayload {
            event: "result",
            op,
            ok: true,
            value,
        },
        out,
    )
}

pub fn pair_progress(id: u32, value: &Value, out: &mut [u8]) -> Result<usize, Error> {
    if id == 0 {
        return Err(Error::InvalidId);
    }
    if value.get("event").and_then(Value::as_str) != Some("pin") {
        return Err(Error::Encoding);
    }
    encode(Kind::Event, id, value, out)
}
