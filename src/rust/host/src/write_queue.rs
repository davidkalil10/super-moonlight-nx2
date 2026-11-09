use std::{
    collections::VecDeque,
    io::{self, Write},
    sync::atomic::{Ordering, compiler_fence},
    time::{Duration, Instant},
};

pub(crate) const WRITE_IDLE_LIMIT: Duration = Duration::from_secs(10);
pub(crate) const FRAME_AGE_LIMIT: Duration = Duration::from_secs(30);

struct Output {
    bytes: Vec<u8>,
    offset: usize,
    queued_at: Instant,
}

impl Drop for Output {
    fn drop(&mut self) {
        for byte in &mut self.bytes {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

pub(crate) struct WriteQueue {
    frames: VecDeque<Output>,
    status: Option<Output>,
    last_progress: Option<Instant>,
}

impl WriteQueue {
    pub(crate) fn new() -> Self {
        Self {
            frames: VecDeque::new(),
            status: None,
            last_progress: None,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.frames.len()
    }

    pub(crate) fn push(&mut self, bytes: Vec<u8>, now: Instant) {
        if self.frames.is_empty() && self.status.is_none() {
            self.last_progress = Some(now);
        }
        self.frames.push_back(Output {
            bytes,
            offset: 0,
            queued_at: now,
        });
    }

    pub(crate) fn status(&mut self, bytes: Vec<u8>, now: Instant) {
        if let Some(status) = &mut self.status {
            if status.offset == 0 {
                status.bytes = bytes;
            }
            return;
        }
        if self.frames.is_empty() {
            self.last_progress = Some(now);
        }
        self.status = Some(Output {
            bytes,
            offset: 0,
            queued_at: now,
        });
    }

    pub(crate) fn purge_status(&mut self) {
        if self
            .status
            .as_ref()
            .is_some_and(|status| status.offset == 0)
        {
            self.status = None;
        }
        if self.frames.is_empty() && self.status.is_none() {
            self.last_progress = None;
        }
    }

    pub(crate) fn clear(&mut self) {
        self.frames.clear();
        self.status = None;
        self.last_progress = None;
    }

    pub(crate) fn flush(
        &mut self,
        writer: &mut impl Write,
        now: Instant,
        budget: usize,
    ) -> io::Result<()> {
        self.flush_inner(writer, now, budget, false)
    }

    pub(crate) fn flush_status(
        &mut self,
        writer: &mut impl Write,
        now: Instant,
        budget: usize,
    ) -> io::Result<()> {
        self.flush_inner(writer, now, budget, true)
    }

    fn flush_inner(
        &mut self,
        writer: &mut impl Write,
        now: Instant,
        mut budget: usize,
        allow_status: bool,
    ) -> io::Result<()> {
        while budget > 0 {
            if let Some(status) = &self.status
                && (now.saturating_duration_since(status.queued_at) >= FRAME_AGE_LIMIT
                    || now.saturating_duration_since(self.last_progress.expect("nonempty queue"))
                        >= WRITE_IDLE_LIMIT)
            {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "control output deadline",
                ));
            }
            let use_status = self.status.as_ref().is_some_and(|status| status.offset > 0)
                || (self.frames.is_empty() && allow_status && self.status.is_some());
            let output = if use_status {
                self.status.as_mut()
            } else {
                self.frames.front_mut()
            };
            let Some(output) = output else {
                break;
            };
            if now.saturating_duration_since(output.queued_at) >= FRAME_AGE_LIMIT
                || now.saturating_duration_since(self.last_progress.expect("nonempty queue"))
                    >= WRITE_IDLE_LIMIT
            {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "control output deadline",
                ));
            }
            let end = (output.offset + budget).min(output.bytes.len());
            match writer.write(&output.bytes[output.offset..end]) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "control output closed",
                    ));
                }
                Ok(count) => {
                    output.offset += count;
                    budget -= count;
                    self.last_progress = Some(now);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => break,
                Err(error) => return Err(error),
            }
            if output.offset == output.bytes.len() {
                if use_status {
                    self.status = None;
                } else {
                    self.frames.pop_front();
                }
            }
        }
        if self.frames.is_empty() && self.status.is_none() {
            self.last_progress = None;
        }
        Ok(())
    }
}
