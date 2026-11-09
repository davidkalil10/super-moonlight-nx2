use crate::{
    codec::{Codec, Size},
    video_wire::Output,
};
use core::{
    cell::Cell,
    mem::ManuallyDrop,
    sync::atomic::{AtomicU64, Ordering},
};

pub const SURFACES: usize = 2;
pub const INPUT_MAX: usize = 1024 * 1024;
static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

fn allocate_owner() -> Option<u64> {
    let mut owner = NEXT_OWNER.load(Ordering::Relaxed);
    loop {
        let next = owner.checked_add(1)?;
        match NEXT_OWNER.compare_exchange_weak(owner, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return Some(owner),
            Err(actual) => owner = actual,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendError {
    Refused,
    Invalid,
    NoMemory,
    Unsupported,
    Malformed,
    Uncertain,
}

impl BackendError {
    fn uncertain(self) -> bool {
        matches!(self, Self::Malformed | Self::Uncertain)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Again,
    Invalid,
    Unsupported,
    NoMemory,
    Refused,
    Timeout,
    Uncertain,
    Failed,
    Retired,
    Closed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameRegistration {
    Register,
    Observed(u64),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Backing {
    CpuReference,
    NativeGpu,
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub codec: Codec,
    pub coded: Size,
    pub display: Size,
    pub timeout_ms: u64,
    pub frame_registration: FrameRegistration,
    pub backing: Backing,
}

pub trait Backend {
    fn open(&mut self, config: Config) -> Result<[u32; SURFACES], BackendError>;
    fn submit(&mut self, bytes: &[u8], pts_us: u64) -> Result<(), BackendError>;
    fn ready(&mut self, surface: usize) -> Result<bool, BackendError>;
    fn output(&mut self) -> Result<Output, BackendError>;
    fn readback(&mut self, surface: usize, out: &mut [u8]) -> Result<(), BackendError>;
    fn release(&mut self, surface: usize) -> Result<(), BackendError>;
    fn close(&mut self) -> Result<(), BackendError>;
    fn now_ms(&self) -> u64;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameToken {
    owner: u64,
    index: usize,
    generation: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct FrameInfo {
    pub token: FrameToken,
    pub pts_us: u64,
    pub timestamp_ns: u64,
    pub service_color: u32,
    pub coded: Size,
    pub display: Size,
}

#[derive(Clone, Copy)]
struct Pending {
    pts_us: u64,
    submitted_ms: u64,
}

pub struct Decoder<'a, B: Backend> {
    owner: u64,
    backend: ManuallyDrop<B>,
    config: Config,
    retired: &'a Cell<bool>,
    frames: [&'a mut [u8]; SURFACES],
    held: [Option<FrameToken>; SURFACES],
    images: [u32; SURFACES],
    queued: [usize; SURFACES],
    arrived: [Option<Output>; SURFACES],
    pending: [Option<Pending>; SURFACES],
    generation: u64,
    failed: bool,
    uncertain: bool,
    closed: bool,
    close_attempted: bool,
}

impl<'a, B: Backend> Decoder<'a, B> {
    pub fn open(
        mut backend: B,
        config: Config,
        retired: &'a Cell<bool>,
        frames: [&'a mut [u8]; SURFACES],
    ) -> Result<Self, Error> {
        if retired.get() {
            return Err(Error::Retired);
        }
        if !config.coded.contains(config.display)
            || frames
                .iter()
                .any(|frame| frame.len() < config.coded.nv12_bytes())
        {
            return Err(Error::Invalid);
        }
        let mut config = config;
        if config.timeout_ms == 0 {
            config.timeout_ms = 5000;
        }
        let owner = allocate_owner().ok_or_else(|| {
            retired.set(true);
            Error::Retired
        })?;
        let opened = backend.open(config);
        let mut decoder = Self {
            owner,
            backend: ManuallyDrop::new(backend),
            config,
            retired,
            frames,
            held: [None; SURFACES],
            images: [0; SURFACES],
            queued: [0, 1],
            arrived: [None; SURFACES],
            pending: [None; SURFACES],
            generation: 0,
            failed: false,
            uncertain: false,
            closed: false,
            close_attempted: false,
        };
        match opened {
            Ok(images) => {
                if images.contains(&0) || images[0] == images[1] {
                    decoder.fail(BackendError::Malformed);
                    return Err(decoder.close().unwrap_err());
                }
                decoder.images = images;
                Ok(decoder)
            }
            Err(error) => {
                let result = decoder.fail(error);
                match decoder.close() {
                    Ok(()) => Err(result),
                    Err(close) => Err(close),
                }
            }
        }
    }

    fn fail(&mut self, error: BackendError) -> Error {
        self.failed = true;
        if error.uncertain() {
            self.uncertain = true;
            self.retired.set(true);
            return Error::Uncertain;
        }
        match error {
            BackendError::Refused => Error::Refused,
            BackendError::Invalid => Error::Invalid,
            BackendError::NoMemory => Error::NoMemory,
            BackendError::Unsupported => Error::Unsupported,
            BackendError::Malformed | BackendError::Uncertain => unreachable!(),
        }
    }

    fn active(&self) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if self.failed {
            return Err(Error::Failed);
        }
        Ok(())
    }

    pub fn submit(&mut self, bytes: &[u8], pts_us: u64) -> Result<(), Error> {
        self.active()?;
        if bytes.is_empty() || bytes.len() > INPUT_MAX || pts_us.checked_mul(1000).is_none() {
            return Err(Error::Invalid);
        }
        if self
            .pending
            .iter()
            .flatten()
            .any(|unit| unit.pts_us == pts_us)
        {
            return Err(Error::Invalid);
        }
        let Some(index) = self.pending.iter().position(Option::is_none) else {
            return Err(Error::Again);
        };
        if let Err(error) = self.backend.submit(bytes, pts_us) {
            return Err(self.fail(error));
        }
        self.pending[index] = Some(Pending {
            pts_us,
            submitted_ms: self.backend.now_ms(),
        });
        Ok(())
    }

    fn metadata(&mut self, surface: usize) -> Result<Output, Error> {
        if let Some(output) = self.arrived[surface].take() {
            return Ok(output);
        }
        for _ in 0..=SURFACES {
            let output = match self.backend.output() {
                Ok(output) => output,
                Err(error) => return Err(self.fail(error)),
            };
            if output.end_of_stream && output.timestamp_ns == 0 {
                return Err(self.fail(BackendError::Refused));
            }
            let Some(index) = self.images.iter().position(|image| *image == output.image) else {
                return Err(self.fail(BackendError::Malformed));
            };
            if index == surface {
                return Ok(output);
            }
            if self.arrived[index].is_some() {
                return Err(self.fail(BackendError::Malformed));
            }
            self.arrived[index] = Some(output);
        }
        Err(self.fail(BackendError::Malformed))
    }

    pub fn poll(&mut self) -> Result<Option<FrameInfo>, Error> {
        self.active()?;
        let Some(oldest) = self.pending[0] else {
            return Ok(None);
        };
        let Some(frame) = self.held.iter().position(Option::is_none) else {
            return Ok(None);
        };
        if self.generation == u64::MAX {
            self.failed = true;
            return Err(Error::Failed);
        }
        let surface = self.queued[0];
        let ready = match self.backend.ready(surface) {
            Ok(ready) => ready,
            Err(error) => return Err(self.fail(error)),
        };
        if !ready {
            let Some(waited) = self.backend.now_ms().checked_sub(oldest.submitted_ms) else {
                self.failed = true;
                return Err(Error::Invalid);
            };
            if waited > self.config.timeout_ms {
                self.failed = true;
                return Err(Error::Timeout);
            }
            return Ok(None);
        }
        let output = self.metadata(surface)?;
        let size_ok = (output.width == self.config.coded.width()
            && output.height == self.config.coded.height())
            || (output.width == self.config.display.width()
                && output.height == self.config.display.height());
        if !size_ok {
            return Err(self.fail(BackendError::Malformed));
        }
        let Some(unit) = self
            .pending
            .iter()
            .position(|unit| unit.is_some_and(|unit| unit.pts_us * 1000 == output.timestamp_ns))
        else {
            return Err(self.fail(BackendError::Malformed));
        };
        let target = &mut self.frames[frame][..self.config.coded.nv12_bytes()];
        if let Err(error) = self.backend.readback(surface, target) {
            return Err(self.fail(error));
        }
        if let Err(error) = self.backend.release(surface) {
            return Err(self.fail(error));
        }
        let pts_us = self.pending[unit].unwrap().pts_us;
        self.pending.rotate_left(unit + 1);
        for entry in self.pending.iter_mut().skip(SURFACES - unit - 1) {
            *entry = None;
        }
        self.queued.rotate_left(1);
        self.generation += 1;
        let token = FrameToken {
            owner: self.owner,
            index: frame,
            generation: self.generation,
        };
        self.held[frame] = Some(token);
        Ok(Some(FrameInfo {
            token,
            pts_us,
            timestamp_ns: output.timestamp_ns,
            service_color: output.color,
            coded: self.config.coded,
            display: self.config.display,
        }))
    }

    pub fn frame(&self, token: FrameToken) -> Result<&[u8], Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if token.owner != self.owner || self.held.get(token.index) != Some(&Some(token)) {
            return Err(Error::Invalid);
        }
        Ok(&self.frames[token.index][..self.config.coded.nv12_bytes()])
    }

    pub fn release(&mut self, token: FrameToken) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if token.owner != self.owner || self.held.get(token.index) != Some(&Some(token)) {
            return Err(Error::Invalid);
        }
        self.held[token.index] = None;
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), Error> {
        if self.closed {
            return Ok(());
        }
        self.close_attempted = true;
        if self.uncertain {
            self.retired.set(true);
            return Err(Error::Uncertain);
        }
        match self.backend.close() {
            Ok(()) => {
                unsafe { ManuallyDrop::drop(&mut self.backend) };
                self.closed = true;
                self.held.fill(None);
                Ok(())
            }
            Err(error) => {
                self.retired.set(true);
                Err(self.fail(error))
            }
        }
    }

    pub fn retire(&mut self) {
        self.failed = true;
        self.uncertain = true;
        self.retired.set(true);
    }

    pub fn pending_units(&self) -> usize {
        if self.closed {
            0
        } else {
            self.pending.iter().flatten().count()
        }
    }
}

impl<B: Backend> Drop for Decoder<'_, B> {
    fn drop(&mut self) {
        if !self.closed && !self.close_attempted {
            let _ = self.close();
        }
    }
}
