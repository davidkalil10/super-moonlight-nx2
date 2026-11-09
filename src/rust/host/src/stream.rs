use crate::helper::{Helper, Output, Process, StartError, Status};
use crate::{Codec, Operation, StreamOptions};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const MAX_INPUT: usize = 4094;
const START_TIMEOUT: Duration = Duration::from_secs(45);
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Channels {
    pub video: OwnedFd,
    pub audio: Option<OwnedFd>,
}

fn duplicate(fd: &OwnedFd) -> io::Result<OwnedFd> {
    let raw = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 5) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

impl Helper {
    pub fn start_stream(
        &self,
        host: &str,
        app: &str,
        options: StreamOptions,
        channels: Channels,
    ) -> Result<StreamProcess, StartError> {
        if !(Operation::Start { host, app, options }).valid() {
            return Err(StartError::InvalidOperation);
        }
        let video = duplicate(&channels.video).map_err(StartError::Spawn)?;
        let audio = channels
            .audio
            .as_ref()
            .map(duplicate)
            .transpose()
            .map_err(StartError::Spawn)?;
        let video_fd = video.as_raw_fd();
        let audio_fd = audio.as_ref().map(AsRawFd::as_raw_fd);
        let mut command = Command::new(&self.executable);
        command.args([
            "stream",
            host,
            app,
            "--raw-fd",
            "3",
            "--codec",
            match options.codec {
                Codec::H264 => "h264",
                Codec::Hevc => "hevc",
                Codec::Av1 => "av1",
            },
            "--size",
            &format!("{}x{}", options.width, options.height),
            "--fps",
            &options.fps.to_string(),
            "--bitrate",
            &options.bitrate_kbps.to_string(),
        ]);
        if audio.is_some() {
            command.args(["--audio-fd", "4"]);
        }
        if options.sops {
            command.arg("--sops");
        }
        if options.local_audio {
            command.arg("--local-audio");
        }
        if options.quit_on_stop {
            command.arg("--quit");
        }
        if let Some(path) = &self.config_home {
            command.env("XDG_CONFIG_HOME", path);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(video_fd, 3) < 0 {
                    return Err(io::Error::last_os_error());
                }
                if let Some(fd) = audio_fd
                    && libc::dup2(fd, 4) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let started = Instant::now();
        let mut child = command.spawn().map_err(StartError::Spawn)?;
        let input = child.stdin.take().expect("piped stdin");
        let flags = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_GETFL) };
        if flags < 0
            || unsafe { libc::fcntl(input.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) }
                < 0
        {
            let error = io::Error::last_os_error();
            let _ = child.kill();
            let _ = child.wait();
            return Err(StartError::Spawn(error));
        }
        Ok(StreamProcess {
            process: Process::new(child, Some(started + START_TIMEOUT))
                .map_err(StartError::Spawn)?,
            input: Some(input),
            pending: Vec::new(),
            offset: 0,
            stopping: false,
        })
    }
}

pub struct StreamProcess {
    process: Process,
    input: Option<ChildStdin>,
    pending: Vec<u8>,
    offset: usize,
    stopping: bool,
}

impl StreamProcess {
    pub fn output(&self) -> Result<Output, mpsc::TryRecvError> {
        self.process.output()
    }
    pub fn poll(&mut self, now: Instant) -> io::Result<Status> {
        self.process.poll(now)
    }
    pub fn connected(&mut self) {
        if !self.stopping {
            self.process.set_deadline(None);
        }
    }
    pub fn begin_stop(&mut self, now: Instant) {
        self.input.take();
        self.pending.clear();
        self.stopping = true;
        self.process.set_deadline(Some(now + STOP_TIMEOUT));
    }
    pub fn cancel(&mut self) -> io::Result<Status> {
        self.input.take();
        self.process.cancel()
    }
    pub fn queue_input(&mut self, json: &[u8]) -> io::Result<()> {
        if self.input.is_none() || !self.pending.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "input unavailable",
            ));
        }
        if json.is_empty()
            || json.len() > MAX_INPUT
            || json.contains(&b'\n')
            || std::str::from_utf8(json).is_err()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid input record",
            ));
        }
        self.pending.extend_from_slice(json);
        self.pending.push(b'\n');
        self.offset = 0;
        Ok(())
    }
    pub fn flush_input(&mut self) -> io::Result<bool> {
        let Some(input) = &mut self.input else {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "input closed"));
        };
        while self.offset < self.pending.len() {
            match input.write(&self.pending[self.offset..]) {
                Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "input closed")),
                Ok(count) => self.offset += count,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        self.pending.clear();
        self.offset = 0;
        Ok(true)
    }
}
