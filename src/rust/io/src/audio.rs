use core::ptr::NonNull;
use moonlight_nx2_core::audio::{self, Policy, Queue, Step, crossfade};
use moonlight_nx2_core::media::HEADER_BYTES;

pub const SLOTS: usize = 16;
pub const SLOT_BYTES: usize = 0x1000;
const ACK_CAPACITY: usize = SLOTS * 2;

/// Media memory the device reads from. Returned to the caller only when the device has
/// provably let go of it.
#[repr(C, align(4096))]
pub struct Slots(pub [[u8; SLOT_BYTES]; SLOTS]);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeviceError {
    Refused,
    Uncertain,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Format {
    pub sample_rate: u32,
    pub channels: u32,
    pub sample_bits: u32,
    pub signed: bool,
}

/// AudioOut operations. The SDK implementation belongs to the runtime crate. `Uncertain`
/// means the device may still own a buffer or the output; nothing is retried after it.
pub trait Device {
    fn open(&mut self, memory: NonNull<Slots>) -> Result<Format, DeviceError>;
    fn append(&mut self, slot: usize, bytes: usize) -> Result<(), DeviceError>;
    fn released(&mut self) -> Result<Option<usize>, DeviceError>;
    fn queued(&mut self) -> Result<u32, DeviceError>;
    fn contains(&mut self, slot: usize) -> Result<bool, DeviceError>;
    fn start(&mut self) -> Result<(), DeviceError>;
    fn stop(&mut self) -> Result<(), DeviceError>;
    fn flush(&mut self) -> Result<(), DeviceError>;
    fn close(&mut self) -> Result<(), DeviceError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Again,
    Invalid,
    Unsupported,
    Refused,
    Uncertain,
    Failed,
}

/// `output_ms` is what the device holds after a pump, and playback starts once it holds that
/// much. It has to outlast the caller's pump period: a 60 Hz loop that misses a frame pumps
/// 33 ms apart.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Config {
    pub sample_rate: u32,
    pub channels: u32,
    pub chunk_bytes: usize,
    pub target_ms: u32,
    pub burst_ms: u32,
    pub window_ms: u32,
    pub output_ms: u32,
    pub fade_frames: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            sample_rate: 48_000,
            channels: 2,
            chunk_bytes: 1920,
            target_ms: 50,
            burst_ms: 100,
            window_ms: 500,
            output_ms: 50,
            fade_frames: 72,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub received: u64,
    pub appended: u64,
    pub released: u64,
    pub dropped: u64,
    pub cuts: u64,
    pub crossfades: u64,
    pub acknowledged: u64,
    pub depth_ms: u32,
    pub max_depth_ms: u32,
    pub polled_starvations: u64,
    pub starved_ms_at_least: u64,
    pub starved_ms_at_most: u64,
    pub longest_pump_gap_ms: u64,
    pub pump_gaps_over_output: u64,
}

/// What the caller gets back after open fails or close. `Kept` means the device may still
/// read the memory or hold the output: never reuse either, and restart the process before
/// opening audio again.
pub enum Retained<D> {
    Returned(D, &'static mut Slots),
    Kept,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Slot {
    Free,
    Waiting,
    Output,
}

#[derive(Clone, Copy)]
struct Entry {
    header: [u8; HEADER_BYTES],
    done: bool,
}

/// Console PCM output with Moonlight's jitter queue. Contract and ownership:
/// moonlight-nx2-dev/src/rust/io/README.md.
pub struct Output<D: Device> {
    device: D,
    memory: NonNull<Slots>,
    config: Config,
    queue: Queue,
    slots: [Slot; SLOTS],
    entry_of: [Option<usize>; SLOTS],
    entries: [Entry; ACK_CAPACITY],
    entry_head: usize,
    entry_count: usize,
    overflow_drops: u64,
    start_chunks: usize,
    fade: [u8; SLOT_BYTES],
    fade_bytes: usize,
    fade_pending: bool,
    started: bool,
    failed: bool,
    uncertain: bool,
    last_pump: Option<u64>,
    last_playing: u64,
    starved_since: Option<u64>,
    stats: Stats,
}

/// The queue policy and how many chunks make `output_ms`.
fn policy(config: &Config) -> Result<(Policy, usize), Error> {
    let rate_ok = (8_000..=192_000).contains(&config.sample_rate);
    let channels_ok = (1..=8).contains(&config.channels);
    if !rate_ok || !channels_ok {
        return Err(Error::Invalid);
    }

    let frame_bytes = config.channels as usize * 2;
    let chunk_ok = (frame_bytes..=SLOT_BYTES).contains(&config.chunk_bytes);
    if !chunk_ok || !config.chunk_bytes.is_multiple_of(frame_bytes) {
        return Err(Error::Invalid);
    }
    let fade_ok = config.fade_frames as usize <= config.chunk_bytes / frame_bytes;
    if !fade_ok {
        return Err(Error::Invalid);
    }

    let scaled = config.chunk_bytes as u64 * 1_000_000;
    let byte_rate = u64::from(config.sample_rate) * frame_bytes as u64;
    if !scaled.is_multiple_of(byte_rate) {
        return Err(Error::Unsupported);
    }
    let chunk_us = scaled / byte_rate;
    let ms = |value: u32| u64::from(value) * 1000;
    let policy = Policy::new(
        chunk_us,
        ms(config.target_ms),
        ms(config.burst_ms),
        ms(config.window_ms),
        ms(config.output_ms),
    )
    .map_err(|_| Error::Invalid)?;
    Ok((policy, (ms(config.output_ms) / chunk_us) as usize))
}

fn format_matches(config: &Config, format: &Format) -> bool {
    let rate_ok = format.sample_rate == config.sample_rate;
    let channels_ok = format.channels == config.channels;
    let sample_ok = format.sample_bits == 16 && format.signed;
    rate_ok && channels_ok && sample_ok
}

/// A slot the device does not currently own; callers index only Free or dropped slots.
fn slot_ptr(memory: NonNull<Slots>, slot: usize) -> *mut [u8; SLOT_BYTES] {
    unsafe { &raw mut (*memory.as_ptr()).0[slot] }
}

fn device_error(error: DeviceError) -> Error {
    match error {
        DeviceError::Refused => Error::Refused,
        DeviceError::Uncertain => Error::Uncertain,
    }
}

impl<D: Device> Output<D> {
    pub fn open(
        config: Config,
        mut device: D,
        memory: &'static mut Slots,
    ) -> Result<Self, (Error, Retained<D>)> {
        let (policy, start_chunks) = match policy(&config) {
            Ok(policy) => policy,
            Err(error) => return Err((error, Retained::Returned(device, memory))),
        };
        for slot in memory.0.iter_mut() {
            slot.fill(0);
        }
        let memory = NonNull::from(memory);

        let format = match device.open(memory) {
            Ok(format) => format,
            Err(DeviceError::Uncertain) => return Err((Error::Uncertain, Retained::Kept)),
            Err(DeviceError::Refused) => {
                let memory = unsafe { &mut *memory.as_ptr() };
                return Err((Error::Refused, Retained::Returned(device, memory)));
            }
        };

        let output = Self {
            device,
            memory,
            config,
            queue: Queue::new(policy),
            slots: [Slot::Free; SLOTS],
            entry_of: [None; SLOTS],
            entries: [Entry {
                header: [0; HEADER_BYTES],
                done: false,
            }; ACK_CAPACITY],
            entry_head: 0,
            entry_count: 0,
            overflow_drops: 0,
            start_chunks,
            fade: [0; SLOT_BYTES],
            fade_bytes: config.fade_frames as usize * config.channels as usize * 2,
            fade_pending: false,
            started: false,
            failed: false,
            uncertain: false,
            last_pump: None,
            last_playing: 0,
            starved_since: None,
            stats: Stats::default(),
        };
        if format_matches(&config, &format) {
            return Ok(output);
        }
        match output.close() {
            (Ok(()), retained) => Err((Error::Unsupported, retained)),
            (Err(error), retained) => Err((error, retained)),
        }
    }

    fn fail(&mut self, error: DeviceError) -> Error {
        self.failed = true;
        if error == DeviceError::Uncertain {
            self.uncertain = true;
        }
        device_error(error)
    }

    fn slot_mut(&mut self, slot: usize) -> &mut [u8; SLOT_BYTES] {
        unsafe { &mut *slot_ptr(self.memory, slot) }
    }

    /// Copies PCM into a free slot, or drops it while preserving ordered acknowledgement.
    /// `Again` means the bounded acknowledgement queue is full; the caller keeps the record.
    pub fn push(&mut self, header: &[u8; HEADER_BYTES], payload: &[u8]) -> Result<(), Error> {
        if self.failed {
            return Err(Error::Failed);
        }
        if payload.len() != self.config.chunk_bytes {
            return Err(Error::Invalid);
        }
        if self.entry_count == ACK_CAPACITY {
            return Err(Error::Again);
        }
        let slot = self.slots.iter().position(|state| *state == Slot::Free);
        let position = (self.entry_head + self.entry_count) % ACK_CAPACITY;
        self.entries[position] = Entry {
            header: *header,
            done: slot.is_none(),
        };
        self.entry_count += 1;
        self.stats.received += 1;
        let Some(slot) = slot else {
            self.overflow_drops += 1;
            self.stats.dropped += 1;
            return Ok(());
        };

        self.slot_mut(slot)[..payload.len()].copy_from_slice(payload);
        self.entry_of[slot] = Some(position);
        self.slots[slot] = Slot::Waiting;
        if !self.queue.push(slot as u8) {
            self.failed = true;
            return Err(Error::Failed);
        }
        Ok(())
    }

    fn finish(&mut self, slot: usize) {
        if let Some(position) = self.entry_of[slot].take() {
            self.entries[position].done = true;
        }
        self.slots[slot] = Slot::Free;
    }

    fn track_gap(&mut self, now_ms: u64) {
        if let Some(last) = self.last_pump {
            let gap = now_ms - last;
            self.stats.longest_pump_gap_ms = self.stats.longest_pump_gap_ms.max(gap);
            if gap > u64::from(self.config.output_ms) {
                self.stats.pump_gaps_over_output += 1;
            }
        }
        self.last_pump = Some(now_ms);
    }

    fn collect_released(&mut self) -> Result<(), Error> {
        for _ in 0..SLOTS {
            let slot = match self.device.released() {
                Ok(Some(slot)) => slot,
                Ok(None) => break,
                Err(error) => return Err(self.fail(error)),
            };
            let known = slot < SLOTS && self.slots[slot] == Slot::Output;
            if !known || !self.queue.release() {
                return Err(self.fail(DeviceError::Uncertain));
            }
            self.finish(slot);
            self.stats.released += 1;
        }
        Ok(())
    }

    fn poll_starvation(&mut self, now_ms: u64) -> Result<(), Error> {
        if !self.started || self.starved_since.is_some() {
            return Ok(());
        }
        if self.queue.output_count() > 1 {
            self.last_playing = now_ms;
            return Ok(());
        }
        let count = self.device.queued().map_err(|error| self.fail(error))?;
        if count > 0 {
            self.last_playing = now_ms;
            return Ok(());
        }
        self.stats.polled_starvations += 1;
        self.starved_since = Some(now_ms);
        Ok(())
    }

    fn end_starvation(&mut self, now_ms: u64) {
        if let Some(since) = self.starved_since.take() {
            self.stats.starved_ms_at_least += now_ms - since;
            self.stats.starved_ms_at_most += now_ms - self.last_playing;
        }
    }

    fn append(&mut self, slot: usize, now_ms: u64) -> Result<(), Error> {
        if self.fade_pending {
            let bytes = self.fade_bytes;
            let target = unsafe { &mut *slot_ptr(self.memory, slot) };
            let target = &mut target[..bytes];
            let _ = crossfade(
                &self.fade[..bytes],
                target,
                self.config.fade_frames,
                self.config.channels,
            );
            self.fade_pending = false;
            self.stats.crossfades += 1;
        }

        let result = self.device.append(slot, self.config.chunk_bytes);
        if result != Err(DeviceError::Refused) {
            self.slots[slot] = Slot::Output;
        }
        result.map_err(|error| self.fail(error))?;
        self.stats.appended += 1;
        self.end_starvation(now_ms);
        Ok(())
    }

    fn apply(&mut self, step: &Step, now_ms: u64) -> Result<(), Error> {
        if let Some(&first) = step.dropped().first()
            && !self.fade_pending
            && self.fade_bytes > 0
        {
            let bytes = self.fade_bytes;
            let source = unsafe { &*slot_ptr(self.memory, first as usize) };
            self.fade[..bytes].copy_from_slice(&source[..bytes]);
            self.fade_pending = true;
        }
        for &slot in step.dropped() {
            self.finish(slot as usize);
        }
        for &slot in step.appended() {
            self.append(slot as usize, now_ms)?;
        }

        if self.started || self.queue.output_count() < self.start_chunks {
            return Ok(());
        }
        self.device.start().map_err(|error| self.fail(error))?;
        self.started = true;
        self.last_playing = now_ms;
        Ok(())
    }

    fn copy_queue_stats(&mut self) {
        let queue: audio::Stats = self.queue.stats();
        self.stats.dropped = queue.dropped + self.overflow_drops;
        self.stats.cuts = queue.cuts;
        self.stats.depth_ms = (queue.depth_us / 1000) as u32;
        self.stats.max_depth_ms = (queue.max_depth_us / 1000) as u32;
    }

    /// Collects released buffers, paces the queue and appends to the device. Call at least
    /// every `output_ms`. Failures are sticky.
    pub fn pump(&mut self, now_ms: u64) -> Result<(), Error> {
        if self.failed {
            return Err(Error::Failed);
        }
        if self.last_pump.is_some_and(|last| now_ms < last) || now_ms > u64::MAX / 1000 {
            return Err(Error::Invalid);
        }

        self.track_gap(now_ms);
        let mut result = self.collect_released();
        if result.is_ok() {
            result = self.poll_starvation(now_ms);
        }
        if result.is_ok() {
            result = match self.queue.step(now_ms * 1000) {
                Ok(step) => self.apply(&step, now_ms),
                Err(_) => Err(Error::Invalid),
            };
        }
        self.copy_queue_stats();
        result
    }

    /// The oldest record's header once its buffer has played or been dropped, in push order.
    pub fn take_acknowledgement(&mut self) -> Option<[u8; HEADER_BYTES]> {
        if self.entry_count == 0 || !self.entries[self.entry_head].done {
            return None;
        }
        let header = self.entries[self.entry_head].header;
        self.entry_head = (self.entry_head + 1) % ACK_CAPACITY;
        self.entry_count -= 1;
        self.stats.acknowledged += 1;
        Some(header)
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    fn drain(&mut self) -> Result<(), Error> {
        let mut result = Ok(());
        if self.started
            && let Err(error) = self.device.stop()
        {
            result = Err(self.fail(error));
        }
        if self.uncertain {
            return result;
        }
        if let Err(error) = self.device.flush() {
            let error = self.fail(error);
            result = result.and(Err(error));
        }
        if self.uncertain {
            return result;
        }
        for _ in 0..SLOTS * 2 {
            match self.device.released() {
                Ok(Some(slot)) if slot < SLOTS && self.slots[slot] == Slot::Output => {
                    self.finish(slot)
                }
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(error) => return result.and(Err(self.fail(error))),
            }
        }
        result
    }

    fn holds_buffers(&mut self) -> bool {
        for slot in 0..SLOTS {
            if self.slots[slot] != Slot::Output {
                continue;
            }
            match self.device.contains(slot) {
                Ok(false) => self.finish(slot),
                Ok(true) => return true,
                Err(error) => {
                    self.fail(error);
                    return true;
                }
            }
        }
        false
    }

    /// Stops, flushes and closes. The memory and device come back only when no buffer is
    /// still queued and every call succeeded; otherwise they are `Kept`.
    pub fn close(mut self) -> (Result<(), Error>, Retained<D>) {
        if self.uncertain {
            return (Err(Error::Uncertain), Retained::Kept);
        }
        let result = self.drain();
        if self.uncertain || self.holds_buffers() {
            let error = if self.uncertain {
                Error::Uncertain
            } else {
                Error::Failed
            };
            return (Err(error), Retained::Kept);
        }
        if let Err(error) = self.device.close() {
            let error = self.fail(error);
            return (result.and(Err(error)), Retained::Kept);
        }
        let memory = unsafe { &mut *self.memory.as_ptr() };
        (result, Retained::Returned(self.device, memory))
    }
}
