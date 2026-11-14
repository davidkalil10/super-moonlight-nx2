//! Decoder session over a `Backend`: bounded submission, a surface ring of N images, and frames
//! read back into caller memory for the presenter.

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
pub const FRAMES: usize = 2;
/// The most units a backend takes before the oldest one's frame is taken; see `Backend::units`.
pub const UNITS: usize = 3;
pub const INPUT_MAX: usize = 1024 * 1024;
static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

/// Rows or columns a decoder may pad its pictures with beyond the stream's size.
const PADDING: u32 = 16;

/// Whether a decoded picture holds the stream: the coded size, or the display size padded by
/// up to `PADDING`, as the SDK decoder gives 1920x1082 for a 1920x1080 stream.
fn fits(output: Output, coded: Size, display: Size) -> bool {
    let padded = |size: u32, wanted: u32| (wanted..=wanted + PADDING).contains(&size);
    (output.width == coded.width() && output.height == coded.height())
        || (padded(output.width, display.width()) && padded(output.height, display.height()))
}

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
    /// The decoder takes no input for now; the same unit is offered again later.
    Busy,
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

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub codec: Codec,
    pub coded: Size,
    pub display: Size,
    pub timeout_ms: u64,
}

pub trait Backend<const N: usize = SURFACES> {
    fn capabilities() -> crate::codec::Capabilities
    where
        Self: Sized,
    {
        crate::codec::Capabilities::default()
    }

    fn open(&mut self, config: Config) -> Result<[u32; N], BackendError>;
    fn submit(&mut self, bytes: &[u8], pts_us: u64) -> Result<(), BackendError>;
    fn ready(&mut self, surface: usize) -> Result<bool, BackendError>;
    fn output(&mut self) -> Result<Output, BackendError>;
    fn readback(&mut self, surface: usize, out: &mut [u8]) -> Result<(), BackendError>;
    fn release(&mut self, surface: usize) -> Result<(), BackendError>;
    fn close(&mut self) -> Result<(), BackendError>;
    fn now_ms(&self) -> u64;

    /// How many units the backend takes before the oldest one's frame is taken, at most
    /// `UNITS`. Two keeps one decoding while the other's frame waits; a backend with images to
    /// spare takes a third, so two decode while a finished frame waits for the display.
    fn units(&self) -> usize {
        2
    }

    /// Waits up to `timeout_ns` for the surface's frame. The default only checks.
    fn wait(&mut self, surface: usize, timeout_ns: u64) -> Result<bool, BackendError> {
        let _ = timeout_ns;
        self.ready(surface)
    }

    /// Where the surface sits when the backend decodes into the presenter's frame slot of the
    /// same index. Such a frame is not read back and stays with the caller until
    /// `Decoder::release_surface`.
    fn placement(&self, surface: usize) -> Option<Placement> {
        let _ = surface;
        None
    }

    /// Whether frames can stay in the backend's own memory, read from there by the caller.
    fn host_images(&self) -> bool {
        false
    }

    /// Where the ready frame of `surface` sits in the backend's memory. Such a frame is not
    /// read back and stays with the caller until `Decoder::release_surface`.
    fn host_image(&self, surface: usize) -> Option<HostImage> {
        let _ = surface;
        None
    }

    /// Whether the backend still closes cleanly after output the decoder could not match to
    /// a unit, as when it owns all of its memory, so such output fails only this session.
    fn closes_after_malformed(&self) -> bool {
        false
    }
}

/// Output the decoder could not match to its surfaces or units.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rejected {
    pub reason: &'static str,
    pub output: Output,
}

/// A decoded NV12 frame left in the backend's memory: `bytes` from the page-aligned `base`,
/// both planes `pitch` bytes a row, the chroma plane half as many rows as the luma plane.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostImage {
    pub base: *mut u8,
    pub bytes: usize,
    pub luma_offset: usize,
    pub chroma_offset: usize,
    pub pitch: u32,
    pub rows: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Hosted {
    pub surface: usize,
    pub image: HostImage,
}

/// The geometry of a frame decoded in place: both planes start a row apart by `stride`, the
/// chroma plane `slice_height` rows after the luma plane at the start of the slot.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Placement {
    pub stride: u32,
    pub slice_height: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Placed {
    pub surface: usize,
    pub placement: Placement,
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
    /// The frame was read into the caller's staging memory, not into a held frame.
    pub staged: bool,
    /// The frame stays in the decoder's surface, which is the presenter's slot of that index.
    pub placed: Option<Placed>,
    /// The frame stays in the backend's memory until its surface is released.
    pub hosted: Option<Hosted>,
}

#[derive(Clone, Copy)]
struct Pending {
    pts_us: u64,
    submitted_ms: u64,
}

struct Queue<const N: usize> {
    surfaces: [usize; N],
    length: usize,
}

impl<const N: usize> Queue<N> {
    fn full() -> Self {
        Self {
            surfaces: core::array::from_fn(|index| index),
            length: N,
        }
    }

    fn front(&self) -> Option<usize> {
        (self.length != 0).then(|| self.surfaces[0])
    }

    fn pop(&mut self) {
        self.surfaces.copy_within(1..self.length, 0);
        self.length -= 1;
    }

    fn push(&mut self, surface: usize) {
        self.surfaces[self.length] = surface;
        self.length += 1;
    }
}

pub struct Decoder<'a, B: Backend<N>, const N: usize = SURFACES> {
    owner: u64,
    backend: ManuallyDrop<B>,
    config: Config,
    retired: &'a Cell<bool>,
    frames: [&'a mut [u8]; FRAMES],
    held: [Option<FrameToken>; FRAMES],
    images: [u32; N],
    queued: Queue<N>,
    placed: [bool; N],
    arrived: [Option<Output>; N],
    rejected: Option<Rejected>,
    invalid: Option<&'static str>,
    pending: [Option<Pending>; UNITS],
    generation: u64,
    failed: bool,
    uncertain: bool,
    closed: bool,
    close_attempted: bool,
}

impl<'a, B: Backend<N>, const N: usize> Decoder<'a, B, N> {
    pub fn open(
        mut backend: B,
        config: Config,
        retired: &'a Cell<bool>,
        frames: [&'a mut [u8]; FRAMES],
    ) -> Result<Self, Error> {
        if retired.get() {
            return Err(Error::Retired);
        }
        if N < 2
            || !config.coded.contains(config.display)
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
            held: [None; FRAMES],
            images: [0; N],
            queued: Queue::full(),
            placed: [false; N],
            arrived: [None; N],
            rejected: None,
            invalid: None,
            pending: [None; UNITS],
            generation: 0,
            failed: false,
            uncertain: false,
            closed: false,
            close_attempted: false,
        };
        match opened {
            Ok(images) => {
                let repeated = (1..N).any(|index| images[..index].contains(&images[index]));
                if images.contains(&0) || repeated {
                    decoder.fail(BackendError::Malformed);
                    let _ = decoder.close();
                    return Err(Error::Uncertain);
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
        if error == BackendError::Malformed && self.backend.closes_after_malformed() {
            return Error::Refused;
        }
        if error.uncertain() {
            self.uncertain = true;
            self.retired.set(true);
            return Error::Uncertain;
        }
        match error {
            BackendError::Busy | BackendError::Refused => Error::Refused,
            BackendError::Invalid => {
                self.invalid.get_or_insert("backend");
                Error::Invalid
            }
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
        if bytes.is_empty() {
            return Err(self.invalid("empty unit"));
        }
        if bytes.len() > INPUT_MAX {
            return Err(self.invalid("unit over INPUT_MAX"));
        }
        if pts_us.checked_mul(1000).is_none() {
            return Err(self.invalid("timestamp range"));
        }
        if self
            .pending
            .iter()
            .flatten()
            .any(|unit| unit.pts_us == pts_us)
        {
            return Err(self.invalid("timestamp already pending"));
        }
        if self.pending_units() >= self.units() {
            return Err(Error::Again);
        }
        let Some(index) = self.pending.iter().position(Option::is_none) else {
            return Err(Error::Again);
        };
        match self.backend.submit(bytes, pts_us) {
            Ok(()) => {}
            Err(BackendError::Busy) => return Err(Error::Again),
            Err(error) => return Err(self.fail(error)),
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
        for _ in 0..=N {
            let output = match self.backend.output() {
                Ok(output) => output,
                Err(error) => return Err(self.fail(error)),
            };
            if output.end_of_stream && output.timestamp_ns == 0 {
                return Err(self.fail(BackendError::Refused));
            }
            let Some(index) = self.images.iter().position(|image| *image == output.image) else {
                return Err(self.reject("unknown image", output));
            };
            if index == surface {
                return Ok(output);
            }
            if self.arrived[index].is_some() {
                return Err(self.reject("image twice", output));
            }
            self.arrived[index] = Some(output);
        }
        Err(self.fail(BackendError::Malformed))
    }

    fn invalid(&mut self, reason: &'static str) -> Error {
        self.invalid = Some(reason);
        Error::Invalid
    }

    /// What the last `Error::Invalid` was returned for.
    pub fn invalid_reason(&self) -> Option<&'static str> {
        self.invalid
    }

    fn reject(&mut self, reason: &'static str, output: Output) -> Error {
        self.rejected = Some(Rejected { reason, output });
        self.fail(BackendError::Malformed)
    }

    /// The output that failed the decoder, when it failed on output it could not match.
    pub fn rejected(&self) -> Option<Rejected> {
        self.rejected
    }

    fn next_token(&mut self, index: usize) -> FrameToken {
        self.generation += 1;
        FrameToken {
            owner: self.owner,
            index,
            generation: self.generation,
        }
    }

    pub fn poll(&mut self) -> Result<Option<FrameInfo>, Error> {
        self.poll_into(None)
    }

    /// Waits up to `timeout_ns` for the oldest unit's frame without taking it. False when
    /// nothing is pending or the frame did not finish in time.
    pub fn wait(&mut self, timeout_ns: u64) -> Result<bool, Error> {
        self.active()?;
        if self.pending[0].is_none() {
            return Ok(false);
        }
        let Some(surface) = self.queued.front() else {
            return Ok(false);
        };
        match self.backend.wait(surface, timeout_ns) {
            Ok(ready) => Ok(ready),
            Err(error) => Err(self.fail(error)),
        }
    }

    /// Whether frames are decoded into the presenter's slots in place.
    pub fn in_place(&self) -> bool {
        self.backend.placement(0).is_some()
    }

    /// Whether frames may stay with the caller until `release_surface`: in place or in the
    /// backend's memory.
    pub fn holds_frames(&self) -> bool {
        self.in_place() || self.backend.host_images()
    }

    pub fn holds_surface(&self, surface: usize) -> bool {
        !self.closed && self.placed.get(surface) == Some(&true)
    }

    /// Gives a surface taken in place back to the decoder, once the presenter no longer reads
    /// its slot.
    pub fn release_surface(&mut self, surface: usize) -> Result<(), Error> {
        self.active()?;
        if !self.holds_surface(surface) {
            return Err(self.invalid("surface not held"));
        }
        if let Err(error) = self.backend.release(surface) {
            return Err(self.fail(error));
        }
        self.placed[surface] = false;
        self.queued.push(surface);
        Ok(())
    }

    /// Polls like `poll`, but reads a copied frame straight into `staging` when it holds a
    /// coded NV12 frame, sparing the caller a second copy. `frame` has no bytes for it.
    pub fn poll_into(&mut self, staging: Option<&mut [u8]>) -> Result<Option<FrameInfo>, Error> {
        self.active()?;
        let Some(oldest) = self.pending[0] else {
            return Ok(None);
        };
        let Some(surface) = self.queued.front() else {
            return Ok(None);
        };
        let Some(frame) = self.held.iter().position(Option::is_none) else {
            return Ok(None);
        };
        if self.generation == u64::MAX {
            self.failed = true;
            return Err(Error::Failed);
        }
        let staging = staging.filter(|staging| staging.len() >= self.config.coded.nv12_bytes());
        let ready = match self.backend.ready(surface) {
            Ok(ready) => ready,
            Err(error) => return Err(self.fail(error)),
        };
        if !ready {
            let Some(waited) = self.backend.now_ms().checked_sub(oldest.submitted_ms) else {
                self.failed = true;
                return Err(self.invalid("clock before submission"));
            };
            if waited > self.config.timeout_ms {
                self.failed = true;
                return Err(Error::Timeout);
            }
            return Ok(None);
        }
        let output = self.metadata(surface)?;
        if !fits(output, self.config.coded, self.config.display) {
            return Err(self.reject("size", output));
        }
        let Some(unit) = self
            .pending
            .iter()
            .position(|unit| unit.is_some_and(|unit| unit.pts_us * 1000 == output.timestamp_ns))
        else {
            return Err(self.reject("timestamp", output));
        };

        let placed = self
            .backend
            .placement(surface)
            .map(|placement| Placed { surface, placement });
        let hosted = placed
            .is_none()
            .then(|| self.backend.host_image(surface))
            .flatten()
            .map(|image| Hosted { surface, image });
        let staged = staging.is_some() && placed.is_none() && hosted.is_none();
        let token = self.next_token(frame);
        if placed.is_some() || hosted.is_some() {
            self.queued.pop();
            self.placed[surface] = true;
        } else {
            let bytes = self.config.coded.nv12_bytes();
            let target = match staging {
                Some(staging) => &mut staging[..bytes],
                None => &mut self.frames[frame][..bytes],
            };
            if let Err(error) = self.backend.readback(surface, target) {
                return Err(self.fail(error));
            }
            if let Err(error) = self.backend.release(surface) {
                return Err(self.fail(error));
            }
            self.queued.pop();
            self.queued.push(surface);
            self.held[frame] = Some(token);
        }

        let pts_us = self.pending[unit].unwrap().pts_us;
        self.pending.rotate_left(unit + 1);
        for entry in self.pending.iter_mut().skip(UNITS - unit - 1) {
            *entry = None;
        }
        Ok(Some(FrameInfo {
            token,
            pts_us,
            timestamp_ns: output.timestamp_ns,
            service_color: output.color,
            coded: self.config.coded,
            display: self.config.display,
            staged,
            placed,
            hosted,
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
        if token.owner != self.owner {
            return Err(self.invalid("token of another decoder"));
        }
        if self.held.get(token.index) != Some(&Some(token)) {
            return Err(self.invalid("token not held"));
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
                self.placed.fill(false);
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

    /// How many units the decoder takes before the oldest one's frame is taken.
    pub fn units(&self) -> usize {
        self.backend.units().clamp(1, UNITS)
    }

    pub fn pending_units(&self) -> usize {
        if self.closed {
            0
        } else {
            self.pending.iter().flatten().count()
        }
    }
}

impl<B: Backend<N>, const N: usize> Drop for Decoder<'_, B, N> {
    fn drop(&mut self) {
        if !self.closed && !self.close_attempted {
            let _ = self.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(width: u32, height: u32) -> Output {
        Output {
            image: 1,
            width,
            height,
            display_width: width,
            display_height: height,
            color: 1,
            timestamp_ns: 0,
            end_of_stream: false,
        }
    }

    #[test]
    fn padded_pictures_fit_the_stream() {
        let coded = Size::new(1920, 1088).unwrap();
        let display = Size::new(1920, 1080).unwrap();
        for (width, height) in [(1920, 1080), (1920, 1082), (1920, 1088), (1936, 1096)] {
            assert!(
                fits(output(width, height), coded, display),
                "{width}x{height}"
            );
        }
        for (width, height) in [(1920, 1078), (1904, 1080), (1920, 1098), (3840, 2160)] {
            assert!(
                !fits(output(width, height), coded, display),
                "{width}x{height}"
            );
        }
    }

    struct Queued(usize);

    impl Backend for Queued {
        fn open(&mut self, _config: Config) -> Result<[u32; SURFACES], BackendError> {
            Ok([1, 2])
        }
        fn submit(&mut self, _bytes: &[u8], _pts_us: u64) -> Result<(), BackendError> {
            Ok(())
        }
        fn ready(&mut self, _surface: usize) -> Result<bool, BackendError> {
            Ok(false)
        }
        fn output(&mut self) -> Result<Output, BackendError> {
            Err(BackendError::Invalid)
        }
        fn readback(&mut self, _surface: usize, _out: &mut [u8]) -> Result<(), BackendError> {
            Ok(())
        }
        fn release(&mut self, _surface: usize) -> Result<(), BackendError> {
            Ok(())
        }
        fn close(&mut self) -> Result<(), BackendError> {
            Ok(())
        }
        fn now_ms(&self) -> u64 {
            0
        }
        fn units(&self) -> usize {
            self.0
        }
    }

    #[test]
    fn a_backend_with_spare_images_takes_a_third_unit() {
        let size = Size::new(16, 16).unwrap();
        let config = Config {
            codec: Codec::Av1,
            coded: size,
            display: size,
            timeout_ms: 0,
        };
        for (units, taken) in [(2, 2), (3, 3), (9, UNITS)] {
            let retired = Cell::new(false);
            let (mut a, mut b) = ([0; 384], [0; 384]);
            let mut decoder =
                Decoder::open(Queued(units), config, &retired, [&mut a, &mut b]).unwrap();
            for pts_us in 1..=taken as u64 {
                decoder.submit(&[1], pts_us).unwrap();
            }
            assert_eq!(decoder.submit(&[1], 99), Err(Error::Again), "{units}");
            assert_eq!(decoder.pending_units(), taken);
        }
    }
}
