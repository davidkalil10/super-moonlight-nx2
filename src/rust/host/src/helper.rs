use crate::Operation;
use std::io::{self, Read};
use std::path::PathBuf;
use std::process::{Child, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

const CHUNK_BYTES: usize = 4096;
const OUTPUT_CHUNKS: usize = 128;
pub const OPERATION_TIMEOUT_EXIT_CODE: i32 = 3;
pub const OUTPUT_TOO_LARGE_EXIT_CODE: i32 = 4;
pub const NOT_PAIRED_EXIT_CODE: i32 = 5;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug)]
pub enum Output {
    Data(Stream, Vec<u8>),
    End(Stream),
    ReadError(Stream, io::Error),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Running,
    Exited(ExitStatus),
    TimedOut,
    OutputOverflow,
    Cancelled,
}

#[derive(Debug)]
pub enum StartError {
    InvalidOperation,
    UnsupportedOperation,
    InvalidPath,
    Spawn(io::Error),
}

#[derive(Clone)]
pub struct Helper {
    pub(crate) executable: PathBuf,
    pub(crate) config_home: Option<PathBuf>,
}

impl Helper {
    pub fn new(executable: impl Into<PathBuf>) -> Result<Self, StartError> {
        let executable = executable.into();
        if !executable.is_absolute() {
            return Err(StartError::InvalidPath);
        }
        Ok(Self {
            executable,
            config_home: None,
        })
    }

    pub fn config_home(mut self, path: impl Into<PathBuf>) -> Result<Self, StartError> {
        let path = path.into();
        if !path.is_absolute() {
            return Err(StartError::InvalidPath);
        }
        self.config_home = Some(path);
        Ok(self)
    }

    pub fn start(&self, operation: Operation<'_>) -> Result<Process, StartError> {
        if !operation.valid() {
            return Err(StartError::InvalidOperation);
        }
        let mut command = std::process::Command::new(&self.executable);
        let backpressure = matches!(operation, Operation::Cover { .. });
        let timeout = match operation {
            Operation::Pair {
                host,
                timeout_seconds,
            } => {
                command.args(["pair", host, "--timeout", &timeout_seconds.to_string()]);
                Duration::from_secs(u64::from(timeout_seconds) + 20)
            }
            Operation::Unpair { host } => {
                command.args(["unpair", host]);
                Duration::from_secs(35)
            }
            Operation::List { host } => {
                command.args(["list", host]);
                Duration::from_secs(50)
            }
            Operation::Quit { host } => {
                command.args(["quit", host]);
                Duration::from_secs(65)
            }
            Operation::Cover { host, app, .. } => {
                command.args(["cover", host, &app.to_string()]);
                Duration::from_secs(40)
            }
            Operation::Start { .. } | Operation::Stop => {
                return Err(StartError::UnsupportedOperation);
            }
        };
        if let Some(path) = &self.config_home {
            command.env("XDG_CONFIG_HOME", path);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let started = Instant::now();
        let child = command.spawn().map_err(StartError::Spawn)?;
        Process::new_with_mode(child, Some(started + timeout), backpressure, &mut |task| {
            thread::Builder::new().spawn(task).map(|_| ())
        })
        .map_err(StartError::Spawn)
    }
}

fn read_output<R: Read + Send + 'static>(
    mut reader: R,
    stream: Stream,
    sender: mpsc::SyncSender<Output>,
    overflow: Arc<AtomicBool>,
    backpressure: bool,
    spawn: &mut impl FnMut(Box<dyn FnOnce() + Send>) -> io::Result<()>,
) -> io::Result<()> {
    spawn(Box::new(move || {
        let mut bytes = [0; CHUNK_BYTES];
        loop {
            let event = match reader.read(&mut bytes) {
                Ok(0) => Output::End(stream),
                Ok(count) => Output::Data(stream, bytes[..count].to_vec()),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => Output::ReadError(stream, error),
            };
            let terminal = !matches!(event, Output::Data(..));
            if backpressure {
                if sender.send(event).is_err() {
                    break;
                }
                if terminal {
                    break;
                }
                continue;
            }
            match sender.try_send(event) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(_)) => {
                    overflow.store(true, Ordering::Release);
                }
                Err(mpsc::TrySendError::Disconnected(_)) => break,
            }
            if terminal {
                break;
            }
        }
    }))
}

struct ChildGuard(Option<Child>);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0
            && !matches!(child.try_wait(), Ok(Some(_)))
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct Process {
    child: Child,
    receiver: mpsc::Receiver<Output>,
    overflow: Arc<AtomicBool>,
    deadline: Option<Instant>,
    status: Status,
}

impl Process {
    pub(crate) fn new(child: Child, deadline: Option<Instant>) -> io::Result<Self> {
        Self::new_with(child, deadline, &mut |task| {
            thread::Builder::new().spawn(task).map(|_| ())
        })
    }

    pub(crate) fn new_with(
        child: Child,
        deadline: Option<Instant>,
        spawn: &mut impl FnMut(Box<dyn FnOnce() + Send>) -> io::Result<()>,
    ) -> io::Result<Self> {
        Self::new_with_mode(child, deadline, false, spawn)
    }

    fn new_with_mode(
        child: Child,
        deadline: Option<Instant>,
        backpressure: bool,
        spawn: &mut impl FnMut(Box<dyn FnOnce() + Send>) -> io::Result<()>,
    ) -> io::Result<Self> {
        let mut guard = ChildGuard(Some(child));
        let child = guard.0.as_mut().expect("child guard");
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("missing stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("missing stderr"))?;
        let (sender, receiver) = mpsc::sync_channel(OUTPUT_CHUNKS);
        let overflow = Arc::new(AtomicBool::new(false));
        read_output(
            stdout,
            Stream::Stdout,
            sender.clone(),
            overflow.clone(),
            backpressure,
            spawn,
        )?;
        read_output(
            stderr,
            Stream::Stderr,
            sender,
            overflow.clone(),
            backpressure,
            spawn,
        )?;
        Ok(Self {
            child: guard.0.take().expect("child guard"),
            receiver,
            overflow,
            deadline,
            status: Status::Running,
        })
    }

    pub(crate) fn set_deadline(&mut self, deadline: Option<Instant>) {
        self.deadline = deadline;
    }

    pub fn output(&self) -> Result<Output, mpsc::TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn poll(&mut self, now: Instant) -> io::Result<Status> {
        if matches!(self.status, Status::Exited(_)) && self.overflow.load(Ordering::Acquire) {
            self.status = Status::OutputOverflow;
        }
        if self.status != Status::Running {
            return Ok(self.status);
        }
        if self.overflow.load(Ordering::Acquire) {
            self.stop(Status::OutputOverflow)?;
        } else if let Some(status) = self.child.try_wait()? {
            self.status = Status::Exited(status);
        } else if self.deadline.is_some_and(|deadline| now >= deadline) {
            self.stop(Status::TimedOut)?;
        }
        Ok(self.status)
    }

    pub fn cancel(&mut self) -> io::Result<Status> {
        if self.status == Status::Running {
            self.stop(Status::Cancelled)?;
        }
        Ok(self.status)
    }

    fn stop(&mut self, result: Status) -> io::Result<()> {
        if self.child.try_wait()?.is_none() {
            if let Err(error) = self.child.kill()
                && self.child.try_wait()?.is_none()
            {
                return Err(error);
            }
            self.child.wait()?;
        }
        self.status = result;
        Ok(())
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if self.status == Status::Running {
            let _ = self.stop(Status::Cancelled);
        }
    }
}
