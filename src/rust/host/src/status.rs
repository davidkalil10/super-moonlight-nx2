use crate::assemble::{MAX_VIDEO_BYTES, Metadata};
use serde::Deserialize;
use serde_json::Value;

pub const MAX_LINE_BYTES: usize = 65_536;

#[derive(Debug)]
pub enum Event {
    AccessUnit(Metadata),
    Status(Value),
    NonJson,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    TooLarge,
    InvalidMetadata,
    Truncated,
    Ended,
    NoEvent,
}

#[derive(Deserialize)]
struct AccessUnit {
    #[serde(rename = "type")]
    kind: String,
    seq: u64,
    frame: u64,
    bytes: usize,
    keyframe: bool,
    pts: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NotPairedStatus {
    event: String,
    message: String,
    #[serde(default, rename = "detail")]
    _detail: Option<String>,
}

#[derive(Default)]
pub struct Lines {
    buffer: Vec<u8>,
    ready: bool,
    ended: bool,
    failure: Option<Error>,
}

impl Lines {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn is_not_paired(&self) -> bool {
        self.ready
            && serde_json::from_slice::<NotPairedStatus>(&self.buffer)
                .is_ok_and(|status| status.event == "error" && status.message == "not paired")
    }
    pub(crate) fn telemetry_observation(&self) -> Option<crate::telemetry::Observation> {
        self.ready
            .then(|| crate::telemetry::parse(&self.buffer))
            .flatten()
    }
    fn fail<T>(&mut self, error: Error) -> Result<T, Error> {
        self.failure = Some(error);
        Err(error)
    }
    pub fn feed(&mut self, input: &[u8]) -> Result<usize, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.ended {
            return self.fail(Error::Ended);
        }
        if self.ready {
            return Ok(0);
        }
        let end = input
            .iter()
            .position(|b| *b == b'\n')
            .map_or(input.len(), |i| i + 1);
        let count = if end > 0 && input[end - 1] == b'\n' {
            end - 1
        } else {
            end
        };
        if count > MAX_LINE_BYTES - self.buffer.len() {
            return self.fail(Error::TooLarge);
        }
        self.buffer.extend_from_slice(&input[..count]);
        if end > count {
            self.ready = true;
        }
        Ok(end)
    }
    pub fn peek(&mut self) -> Result<Option<Event>, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if !self.ready {
            return Ok(None);
        }
        let Ok(value) = serde_json::from_slice::<Value>(&self.buffer) else {
            return Ok(Some(Event::NonJson));
        };
        if value.get("type").and_then(Value::as_str) != Some("au") {
            return Ok(Some(Event::Status(value)));
        }
        let record: AccessUnit = match serde_json::from_slice(&self.buffer) {
            Ok(record) => record,
            Err(_) => return self.fail(Error::InvalidMetadata),
        };
        if record.kind != "au"
            || record.bytes == 0
            || record.bytes > MAX_VIDEO_BYTES
            || record.frame > 9_007_199_254_740_991
            || record.seq > 9_007_199_254_740_991
            || record.pts > 9_007_199_254_740_991
        {
            return self.fail(Error::InvalidMetadata);
        }
        Ok(Some(Event::AccessUnit(Metadata {
            sequence: record.seq,
            bytes: record.bytes,
            pts_us: record.pts,
            keyframe: record.keyframe,
        })))
    }
    pub fn consume(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if !self.ready {
            return self.fail(Error::NoEvent);
        }
        self.buffer.clear();
        self.ready = false;
        Ok(())
    }
    pub fn end(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if !self.ready && !self.buffer.is_empty() {
            return self.fail(Error::Truncated);
        }
        self.ended = true;
        Ok(())
    }
}
