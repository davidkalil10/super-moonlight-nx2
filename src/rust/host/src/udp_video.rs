use subtle::ConstantTimeEq;

pub const MAGIC: u32 = 0x3156_4455;
pub const HELLO_MAGIC: u32 = 0x4856_4455;
pub const NACK_MAGIC: u32 = 0x314e_4455;
pub const STATS_MAGIC: u32 = 0x3153_4455;
pub const DROP_MAGIC: u32 = 0x3150_5244;
pub const HEADER_BYTES: usize = 40;
pub const FRAGMENT_BYTES: usize = 1360;
pub const MAX_FRAGMENTS: usize = 0x0fff;
pub const MAX_UNIT_BYTES: usize = FRAGMENT_BYTES * MAX_FRAGMENTS;
pub const MAX_NACK_RANGES: usize = 16;
pub const MAX_NACK_LENGTH: u32 = 256;
pub const STATS_COUNT: usize = 12;
pub const STATS_NAMES: [&str; STATS_COUNT] = [
    "received",
    "lost",
    "repaired",
    "nacks",
    "lateDrops",
    "reorders",
    "drainCalls",
    "drainUs",
    "duplicates",
    "skipped",
    "stale",
    "copies",
];
pub const FLAG_KEYFRAME: u32 = 1;
pub const FLAG_END: u32 = 2;
pub const FLAG_RESEND: u32 = 4;

/// Units the console holds while the oldest one waits for its missing fragments.
const UNIT_SLOTS: f64 = 8.0;
/// Pacing time of a typical keyframe, kept inside the slots a keyframe may wait for.
const KEYFRAME_SPREAD_MS: f64 = 20.0;
/// A fragment is resent again once this long after its last resend.
const RESEND_GAP_MS: f64 = 10.0;

/// The deadline leaves room for two repair rounds at the console's display rate; a unit that
/// still misses it is dropped and answered with a keyframe.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Timing {
    pub deadline_ms: f64,
    pub spread_ms: f64,
    pub pace_bytes_per_ms: f64,
}

impl Timing {
    pub fn new(fps: u32) -> Option<Self> {
        if !(1..=240).contains(&fps) {
            return None;
        }
        let period_ms = 1000.0 / f64::from(fps);
        let keyframe_fit = (UNIT_SLOTS * period_ms - KEYFRAME_SPREAD_MS) / 2.0;
        Some(Self {
            deadline_ms: (3.0 * period_ms).min(keyframe_fit).max(12.0),
            spread_ms: period_ms / 3.0,
            pace_bytes_per_ms: 12_500.0,
        })
    }

    pub fn spread(&self, length: usize) -> f64 {
        self.spread_ms.max(length as f64 / self.pace_bytes_per_ms)
    }

    pub fn frame_deadline(&self, length: usize, keyframe: bool) -> f64 {
        self.deadline_ms * if keyframe { 2.0 } else { 1.0 } + self.spread(length)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidLength,
    InvalidTime,
    Backpressure,
    FrameExhausted,
}

pub struct Unit<'a> {
    pub sequence: u32,
    pub pts_us: u64,
    pub keyframe: bool,
    pub data: &'a [u8],
}

fn write_u32(out: &mut [u8], offset: usize, value: u32) {
    out[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

pub fn packetize(
    frame: u32,
    first_seq: u32,
    unit: Unit<'_>,
    max_unit: usize,
) -> Result<Vec<Vec<u8>>, Error> {
    if unit.data.is_empty() || unit.data.len() > max_unit || unit.data.len() > MAX_UNIT_BYTES {
        return Err(Error::InvalidLength);
    }
    let count = unit.data.len().div_ceil(FRAGMENT_BYTES);
    let flags = if unit.keyframe { FLAG_KEYFRAME } else { 0 };
    let mut datagrams = Vec::with_capacity(count);
    for (index, chunk) in unit.data.chunks(FRAGMENT_BYTES).enumerate() {
        let mut datagram = vec![0; HEADER_BYTES + chunk.len()];
        write_u32(&mut datagram, 0, MAGIC);
        write_u32(
            &mut datagram,
            4,
            index as u32 | (count as u32) << 12 | flags << 24,
        );
        write_u32(&mut datagram, 8, first_seq.wrapping_add(index as u32));
        write_u32(&mut datagram, 12, frame);
        write_u32(&mut datagram, 16, unit.data.len() as u32);
        write_u32(&mut datagram, 20, unit.sequence);
        datagram[24..32].copy_from_slice(&unit.pts_us.to_le_bytes());
        datagram[HEADER_BYTES..].copy_from_slice(chunk);
        datagrams.push(datagram);
    }
    Ok(datagrams)
}

pub fn end_datagram(frames: u32, sequence: u32) -> [u8; HEADER_BYTES] {
    let mut datagram = [0; HEADER_BYTES];
    write_u32(&mut datagram, 0, MAGIC);
    write_u32(&mut datagram, 4, FLAG_END << 24);
    write_u32(&mut datagram, 8, sequence);
    write_u32(&mut datagram, 12, frames);
    datagram
}

pub fn is_hello(message: &[u8], token: &[u8; 64]) -> bool {
    message.len() == 68
        && u32::from_le_bytes(message[..4].try_into().expect("length checked")) == HELLO_MAGIC
        && bool::from(message[4..].ct_eq(token))
}

fn header(message: &[u8], magic: u32, item_bytes: usize, limit: usize) -> Option<usize> {
    if message.len() < 8 || u32::from_le_bytes(message[..4].try_into().ok()?) != magic {
        return None;
    }
    let declared = u32::from_le_bytes(message[4..8].try_into().ok()?) as usize;
    if declared > limit || message.len() != 8 + declared * item_bytes {
        return None;
    }
    Some(declared)
}

pub fn read_nack(message: &[u8]) -> Option<Vec<(u32, u32)>> {
    let count = header(message, NACK_MAGIC, 8, MAX_NACK_RANGES)?;
    (0..count)
        .map(|index| {
            let offset = 8 + index * 8;
            let first = u32::from_le_bytes(
                message[offset..offset + 4]
                    .try_into()
                    .expect("length checked"),
            );
            let length = u32::from_le_bytes(
                message[offset + 4..offset + 8]
                    .try_into()
                    .expect("length checked"),
            );
            (1..=MAX_NACK_LENGTH)
                .contains(&length)
                .then_some((first, length))
        })
        .collect()
}

pub fn read_stats(message: &[u8]) -> Option<Vec<u32>> {
    let count = header(message, STATS_MAGIC, 4, STATS_COUNT)?;
    Some(
        (0..count)
            .map(|index| {
                let offset = 8 + index * 4;
                u32::from_le_bytes(
                    message[offset..offset + 4]
                        .try_into()
                        .expect("length checked"),
                )
            })
            .collect(),
    )
}

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

pub const MAX_BUFFERED_DATAGRAM_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_BUFFERED_DATAGRAMS: usize = 8 * MAX_FRAGMENTS;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Counters {
    pub units: u64,
    pub datagrams: u64,
    pub resent: u64,
    pub nacks: u64,
    pub expired: u64,
    pub repeated: u64,
    pub probes: u64,
}

struct Scheduled {
    datagram: Arc<[u8]>,
    due_at: f64,
}

struct Retained {
    datagram: Arc<[u8]>,
    deadline_at: f64,
    resent_at: Option<f64>,
}

pub struct Sender {
    timing: Timing,
    max_unit: usize,
    queue: VecDeque<Scheduled>,
    retained: HashMap<u32, Retained>,
    retained_order: VecDeque<u32>,
    retained_bytes: usize,
    queued_bytes: usize,
    newest: Option<Arc<[u8]>>,
    probe_at: f64,
    next_sequence: u32,
    next_frame: u32,
    pace_free: f64,
    counters: Counters,
}

impl Sender {
    pub fn new(fps: u32, max_unit: usize) -> Result<Self, Error> {
        let timing = Timing::new(fps).ok_or(Error::InvalidLength)?;
        if max_unit == 0 || max_unit > MAX_UNIT_BYTES {
            return Err(Error::InvalidLength);
        }
        Ok(Self {
            timing,
            max_unit,
            queue: VecDeque::new(),
            retained: HashMap::new(),
            retained_order: VecDeque::new(),
            retained_bytes: 0,
            queued_bytes: 0,
            newest: None,
            probe_at: f64::INFINITY,
            next_sequence: 0,
            next_frame: 0,
            pace_free: f64::NEG_INFINITY,
            counters: Counters::default(),
        })
    }

    pub fn timing(&self) -> Timing {
        self.timing
    }

    pub fn use_profile_timing(&mut self) {
        self.timing.deadline_ms = (self.timing.deadline_ms * 1000.0).round() / 1000.0;
        self.timing.spread_ms = (self.timing.spread_ms * 1000.0).round() / 1000.0;
    }
    pub fn pending(&self) -> usize {
        self.queue.len()
    }
    pub fn frames(&self) -> u32 {
        self.next_frame
    }
    pub fn counters(&self) -> Counters {
        self.counters
    }

    fn prune(&mut self, now_ms: f64) {
        while let Some(sequence) = self.retained_order.front().copied() {
            let Some(entry) = self.retained.get(&sequence) else {
                self.retained_order.pop_front();
                continue;
            };
            if entry.deadline_at >= now_ms {
                break;
            }
            self.retained_bytes -= entry.datagram.len();
            self.retained.remove(&sequence);
            self.retained_order.pop_front();
        }
    }

    pub fn enqueue(&mut self, unit: Unit<'_>, now_ms: f64) -> Result<u32, Error> {
        if !now_ms.is_finite() || now_ms < 0.0 {
            return Err(Error::InvalidTime);
        }
        if unit.data.is_empty() || unit.data.len() > self.max_unit {
            return Err(Error::InvalidLength);
        }
        if self.next_frame == u32::MAX {
            return Err(Error::FrameExhausted);
        }
        self.prune(now_ms);
        let fragments = unit.data.len().div_ceil(FRAGMENT_BYTES);
        let bytes = unit
            .data
            .len()
            .checked_add(fragments * HEADER_BYTES)
            .ok_or(Error::Backpressure)?;
        let requested = bytes.checked_mul(2).ok_or(Error::Backpressure)?;
        let used = self.retained_bytes + self.queued_bytes;
        if requested > MAX_BUFFERED_DATAGRAM_BYTES - used
            || fragments > MAX_BUFFERED_DATAGRAMS - self.queue.len()
            || fragments > MAX_BUFFERED_DATAGRAMS - self.retained.len()
            || (0..fragments).any(|index| {
                self.retained
                    .contains_key(&self.next_sequence.wrapping_add(index as u32))
            })
        {
            return Err(Error::Backpressure);
        }
        let frame = self.next_frame;
        let length = unit.data.len();
        let keyframe = unit.keyframe;
        let datagrams = packetize(frame, self.next_sequence, unit, self.max_unit)?;
        let start = now_ms.max(self.pace_free);
        let ticks = self.timing.spread(length).ceil().max(1.0) as usize;
        let per_tick = datagrams.len().div_ceil(ticks);
        let deadline = start + self.timing.frame_deadline(length, keyframe);
        for (index, datagram) in datagrams.into_iter().enumerate() {
            let sequence = self.next_sequence.wrapping_add(index as u32);
            let datagram: Arc<[u8]> = datagram.into();
            self.retained_bytes += datagram.len();
            self.queued_bytes += datagram.len();
            self.queue.push_back(Scheduled {
                datagram: Arc::clone(&datagram),
                due_at: start + (index / per_tick) as f64,
            });
            self.retained.insert(
                sequence,
                Retained {
                    datagram: Arc::clone(&datagram),
                    deadline_at: deadline,
                    resent_at: None,
                },
            );
            self.retained_order.push_back(sequence);
            self.newest = Some(datagram);
        }
        self.probe_at = deadline + self.timing.deadline_ms;
        self.next_sequence = self.next_sequence.wrapping_add(fragments as u32);
        self.next_frame += 1;
        self.counters.units += 1;
        self.pace_free = start + fragments.div_ceil(per_tick) as f64;
        Ok(frame)
    }

    fn stamp(&mut self, datagram: &[u8], now_ms: f64, resend: bool) -> Vec<u8> {
        let mut output = datagram.to_vec();
        if resend {
            let packed = u32::from_le_bytes(output[4..8].try_into().expect("packet header"));
            write_u32(&mut output, 4, packed | FLAG_RESEND << 24);
        }
        let micros = (now_ms * 1000.0).floor().rem_euclid(4_294_967_296.0) as u32;
        write_u32(&mut output, 32, micros);
        self.counters.datagrams += 1;
        output
    }

    pub fn flush(&mut self, now_ms: f64) -> Result<(Option<f64>, Vec<Vec<u8>>), Error> {
        if !now_ms.is_finite() || now_ms < 0.0 {
            return Err(Error::InvalidTime);
        }
        let mut output = Vec::new();
        while self.queue.front().is_some_and(|item| item.due_at <= now_ms) {
            let scheduled = self.queue.pop_front().expect("queued datagram");
            self.queued_bytes -= scheduled.datagram.len();
            output.push(self.stamp(&scheduled.datagram, now_ms, false));
        }
        Ok((
            self.queue
                .front()
                .map(|item| (item.due_at - now_ms).max(0.0)),
            output,
        ))
    }

    pub fn nack(&mut self, ranges: &[(u32, u32)], now_ms: f64) -> Result<Vec<Vec<u8>>, Error> {
        if !now_ms.is_finite() || now_ms < 0.0 {
            return Err(Error::InvalidTime);
        }
        self.counters.nacks += 1;
        let mut output = Vec::new();
        for &(first, count) in ranges.iter().take(MAX_NACK_RANGES) {
            for offset in 0..count.min(MAX_NACK_LENGTH) {
                let sequence = first.wrapping_add(offset);
                let Some(entry) = self.retained.get_mut(&sequence) else {
                    self.counters.expired += 1;
                    continue;
                };
                if entry.deadline_at < now_ms {
                    self.counters.expired += 1;
                    continue;
                }
                if entry
                    .resent_at
                    .is_some_and(|at| now_ms - at < RESEND_GAP_MS)
                {
                    self.counters.repeated += 1;
                    continue;
                }
                entry.resent_at = Some(now_ms);
                let datagram = Arc::clone(&entry.datagram);
                output.push(self.stamp(&datagram, now_ms, true));
                self.counters.resent += 1;
            }
        }
        Ok(output)
    }

    pub fn probe(&mut self, now_ms: f64) -> Result<(Option<f64>, Option<Vec<u8>>), Error> {
        if !now_ms.is_finite() || now_ms < 0.0 {
            return Err(Error::InvalidTime);
        }
        let Some(newest) = self.newest.clone() else {
            return Ok((None, None));
        };
        if self.probe_at > now_ms {
            return Ok((Some(self.probe_at - now_ms), None));
        }
        if !self.queue.is_empty() {
            return Ok((Some(1.0), None));
        }
        let datagram = self.stamp(&newest, now_ms, true);
        self.counters.probes += 1;
        self.probe_at = now_ms + self.timing.deadline_ms;
        Ok((Some(self.timing.deadline_ms), Some(datagram)))
    }

    pub fn end(&self) -> [u8; HEADER_BYTES] {
        end_datagram(self.next_frame, self.next_sequence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_frame_index_stops_before_wrap() {
        let mut sender = Sender::new(60, 1).unwrap();
        sender.next_frame = u32::MAX - 1;
        let unit = || Unit {
            sequence: 0,
            pts_us: 0,
            keyframe: false,
            data: &[1],
        };
        assert_eq!(sender.enqueue(unit(), 0.0), Ok(u32::MAX - 1));
        assert_eq!(sender.enqueue(unit(), 0.0), Err(Error::FrameExhausted));
        assert_eq!(sender.frames(), u32::MAX);
        assert_eq!(
            u32::from_le_bytes(sender.end()[12..16].try_into().unwrap()),
            u32::MAX
        );
    }

    #[test]
    fn a_fragment_is_resent_again_once_the_gap_has_passed() {
        let mut sender = Sender::new(60, 4096).unwrap();
        let unit = Unit {
            sequence: 0,
            pts_us: 0,
            keyframe: false,
            data: &[1; 3000],
        };
        sender.enqueue(unit, 0.0).unwrap();
        assert_eq!(sender.nack(&[(1, 1)], 1.0).unwrap().len(), 1);
        assert!(
            sender
                .nack(&[(1, 1)], 1.0 + RESEND_GAP_MS / 2.0)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            sender.nack(&[(1, 1)], 1.0 + RESEND_GAP_MS).unwrap().len(),
            1
        );
        let late = sender.timing().frame_deadline(3000, false) + 1.0;
        assert!(sender.nack(&[(1, 1)], late).unwrap().is_empty());
        let counters = sender.counters();
        assert_eq!(
            (counters.resent, counters.repeated, counters.expired),
            (2, 1, 1)
        );
    }

    #[test]
    fn the_deadline_allows_repair_and_a_waiting_keyframe_fits_the_console_slots() {
        assert_eq!(Timing::new(60).unwrap().deadline_ms, 50.0);
        for fps in [30, 60, 90, 120] {
            let timing = Timing::new(fps).unwrap();
            let period_ms = 1000.0 / f64::from(fps);
            assert!(timing.deadline_ms > 2.0 * period_ms);
            assert!(timing.frame_deadline(250_000, true) <= UNIT_SLOTS * period_ms + 1e-9);
        }
    }
}
