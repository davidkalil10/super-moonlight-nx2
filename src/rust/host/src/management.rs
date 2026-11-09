use crate::Operation;
use crate::helper::{Helper, Output, Process, StartError, Status, Stream};
use std::io;
use std::time::{Duration, Instant};

const OUTPUT_CLOSE_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub enum Error {
    Busy,
    Start(StartError),
    Process(io::Error),
}

#[derive(Debug)]
pub enum Event {
    Output {
        request_id: u32,
        stream: Stream,
        bytes: Vec<u8>,
    },
    Complete {
        request_id: u32,
        result: Completion,
    },
}

#[derive(Debug)]
pub enum Completion {
    Exited(std::process::ExitStatus),
    TimedOut,
    OutputOverflow,
    OutputReadError(Stream, io::Error),
    OutputCloseTimeout,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperationName {
    Pair,
    List,
    Unpair,
    Quit,
}

struct Active {
    request_id: u32,
    operation: OperationName,
    process: Process,
    stdout_ended: bool,
    stderr_ended: bool,
    exited: Option<(std::process::ExitStatus, Instant)>,
}

pub struct Management {
    helper: Helper,
    active: Option<Active>,
}

impl Management {
    pub fn new(helper: Helper) -> Self {
        Self {
            helper,
            active: None,
        }
    }

    pub fn is_busy(&self) -> bool {
        self.active.is_some()
    }

    pub fn current(&self) -> Option<(u32, OperationName)> {
        self.active
            .as_ref()
            .map(|active| (active.request_id, active.operation))
    }

    pub fn start(&mut self, request_id: u32, operation: Operation<'_>) -> Result<(), Error> {
        if self.active.is_some() {
            return Err(Error::Busy);
        }
        let name = match operation {
            Operation::Pair { .. } => OperationName::Pair,
            Operation::List { .. } => OperationName::List,
            Operation::Unpair { .. } => OperationName::Unpair,
            Operation::Quit { .. } => OperationName::Quit,
            _ => return Err(Error::Start(StartError::UnsupportedOperation)),
        };
        let process = self.helper.start(operation).map_err(Error::Start)?;
        self.active = Some(Active {
            request_id,
            operation: name,
            process,
            stdout_ended: false,
            stderr_ended: false,
            exited: None,
        });
        Ok(())
    }

    pub fn start_preflight(&mut self, request_id: u32, host: &str) -> Result<(), Error> {
        self.start(request_id, Operation::List { host })?;
        self.active
            .as_mut()
            .expect("preflight started")
            .process
            .set_deadline(Some(Instant::now() + Duration::from_secs(25)));
        Ok(())
    }

    pub fn poll(&mut self, now: Instant) -> Result<Option<Event>, Error> {
        let Some(active) = &mut self.active else {
            return Ok(None);
        };
        let status = active.process.poll(now).map_err(Error::Process)?;
        let failure = match status {
            Status::TimedOut => Some(Completion::TimedOut),
            Status::OutputOverflow => Some(Completion::OutputOverflow),
            Status::Cancelled => Some(Completion::Cancelled),
            Status::Exited(code) => {
                active.exited.get_or_insert((code, now));
                None
            }
            Status::Running => None,
        };
        if let Some(result) = failure {
            let request_id = active.request_id;
            self.active = None;
            return Ok(Some(Event::Complete { request_id, result }));
        }
        while let Ok(output) = active.process.output() {
            match output {
                Output::Data(stream, bytes) => {
                    return Ok(Some(Event::Output {
                        request_id: active.request_id,
                        stream,
                        bytes,
                    }));
                }
                Output::End(Stream::Stdout) => active.stdout_ended = true,
                Output::End(Stream::Stderr) => active.stderr_ended = true,
                Output::ReadError(stream, error) => {
                    active.process.cancel().map_err(Error::Process)?;
                    let request_id = active.request_id;
                    self.active = None;
                    return Ok(Some(Event::Complete {
                        request_id,
                        result: Completion::OutputReadError(stream, error),
                    }));
                }
            }
        }
        if let Some((code, exited_at)) = active.exited {
            let result = if active.stdout_ended && active.stderr_ended {
                match active.process.poll(now).map_err(Error::Process)? {
                    Status::OutputOverflow => Some(Completion::OutputOverflow),
                    _ => Some(Completion::Exited(code)),
                }
            } else if now.saturating_duration_since(exited_at) >= OUTPUT_CLOSE_GRACE {
                Some(Completion::OutputCloseTimeout)
            } else {
                None
            };
            if let Some(result) = result {
                let request_id = active.request_id;
                self.active = None;
                return Ok(Some(Event::Complete { request_id, result }));
            }
        }
        Ok(None)
    }

    pub fn cancel(&mut self) -> Result<Option<Event>, Error> {
        let Some(active) = &mut self.active else {
            return Ok(None);
        };
        active.process.cancel().map_err(Error::Process)?;
        let request_id = active.request_id;
        self.active = None;
        Ok(Some(Event::Complete {
            request_id,
            result: Completion::Cancelled,
        }))
    }
}

impl crate::Backend for Management {
    type Output = ();
    type Error = Error;

    fn execute(&mut self, request_id: u32, operation: Operation<'_>) -> Result<(), Error> {
        self.start(request_id, operation)
    }

    fn is_busy(&self) -> bool {
        self.is_busy()
    }

    fn cancel_pending(&mut self) -> Result<(), Error> {
        self.cancel().map(|_| ())
    }
}
