use moonlight_nx2_core::media::Header;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

const BYTE_LIMIT: usize = 2 * 1024 * 1024;
const IDR_INTERVAL: Duration = Duration::from_secs(2);
const IDR_RETRY: Duration = Duration::from_millis(500);

pub struct Unit {
    pub header: Header,
    pub keyframe: bool,
    pub payload: Vec<u8>,
    at: Instant,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Accepted { request_idr: bool },
    Dropped { request_idr: bool },
    Full { request_idr: bool },
}

pub struct Queue {
    units: VecDeque<Unit>,
    bytes: usize,
    fps: u32,
    max_units: usize,
    hard_units: usize,
    max_age_ms: f64,
    samples: VecDeque<f64>,
    keyframe_in_flight: Option<u32>,
    keyframe_acked_at: Option<Instant>,
    last_drop: Option<Instant>,
    requested_at: Option<Instant>,
    unanswered: bool,
    dropping: bool,
}

impl Queue {
    pub fn new(fps: u32) -> Option<Self> {
        if !(1..=120).contains(&fps) {
            return None;
        }
        let max_units = 4usize.max((fps as usize).div_ceil(8));
        Some(Self {
            units: VecDeque::new(),
            bytes: 0,
            fps,
            max_units,
            hard_units: (max_units * 2).max((fps as usize).div_ceil(4)),
            max_age_ms: (6000.0 / f64::from(fps)).max(50.0),
            samples: VecDeque::new(),
            keyframe_in_flight: None,
            keyframe_acked_at: None,
            last_drop: None,
            requested_at: None,
            unanswered: false,
            dropping: false,
        })
    }
    pub fn len(&self) -> usize {
        self.units.len()
    }
    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }
    pub fn front(&self) -> Option<&Unit> {
        self.units.front()
    }
    fn keyed(&self) -> bool {
        self.keyframe_in_flight.is_some() || self.units.front().is_some_and(|unit| unit.keyframe)
    }
    fn clear(&mut self) {
        self.units.clear();
        self.bytes = 0;
    }
    fn request_idr(&mut self, now: Instant) -> bool {
        if self.unanswered
            && self
                .requested_at
                .is_some_and(|last| now.saturating_duration_since(last) < IDR_RETRY)
        {
            return false;
        }
        self.requested_at = Some(now);
        self.unanswered = true;
        true
    }
    fn age_limit_ms(&self) -> f64 {
        if self.samples.is_empty() {
            return self.max_age_ms;
        }
        let mut sorted: Vec<_> = self.samples.iter().copied().collect();
        sorted.sort_by(f64::total_cmp);
        (sorted[sorted.len() / 2] + 2000.0 / f64::from(self.fps))
            .max(self.max_age_ms)
            .min(self.max_age_ms * 2.0)
    }
    pub fn offer(
        &mut self,
        header: Header,
        keyframe: bool,
        payload: &[u8],
        now: Instant,
    ) -> Outcome {
        if payload.is_empty()
            || payload.len() != header.payload_bytes as usize
            || payload.len() > crate::assemble::MAX_VIDEO_BYTES
        {
            return Outcome::Dropped { request_idr: false };
        }
        if keyframe {
            self.clear();
            self.dropping = false;
            self.unanswered = false;
        } else if self.dropping {
            return Outcome::Dropped {
                request_idr: self.request_idr(now),
            };
        }
        if payload.len() > BYTE_LIMIT - self.bytes {
            if self.keyed() {
                return Outcome::Full {
                    request_idr: self.request_idr(now),
                };
            }
            self.clear();
            self.dropping = true;
            self.last_drop = Some(now);
            return Outcome::Dropped {
                request_idr: self.request_idr(now),
            };
        }
        self.bytes += payload.len();
        self.units.push_back(Unit {
            header,
            keyframe,
            payload: payload.to_vec(),
            at: now,
        });
        let full = self.units.len() > self.hard_units;
        if self.keyed() {
            return Outcome::Accepted {
                request_idr: full && self.request_idr(now),
            };
        }
        let first = self.units.front().expect("queued unit");
        let start = self
            .keyframe_acked_at
            .map_or(first.at, |ack| ack.max(first.at));
        let aged =
            now.saturating_duration_since(start).as_secs_f64() * 1000.0 > self.age_limit_ms();
        let overdue = full || self.units.len() > self.max_units || aged;
        let held = !full
            && self
                .last_drop
                .is_some_and(|last| now.saturating_duration_since(last) < IDR_INTERVAL);
        if overdue && !held {
            self.clear();
            self.dropping = true;
            self.last_drop = Some(now);
            return Outcome::Dropped {
                request_idr: self.request_idr(now),
            };
        }
        Outcome::Accepted { request_idr: false }
    }
    pub fn sent(&mut self, now: Instant) -> Option<Unit> {
        let unit = self.units.pop_front()?;
        self.bytes -= unit.payload.len();
        if self.keyframe_in_flight.is_none() && !unit.keyframe {
            let start = self
                .keyframe_acked_at
                .map_or(unit.at, |ack| ack.max(unit.at));
            self.samples
                .push_back(now.saturating_duration_since(start).as_secs_f64() * 1000.0);
            if self.samples.len() > self.fps as usize {
                self.samples.pop_front();
            }
        }
        if unit.keyframe {
            self.keyframe_in_flight = Some(unit.header.sequence);
        }
        Some(unit)
    }
    pub fn acknowledged(&mut self, sequence: u32, now: Instant) {
        if self.keyframe_in_flight == Some(sequence) {
            self.keyframe_in_flight = None;
            self.keyframe_acked_at = Some(now);
        }
    }

    pub fn lost(&mut self, sequence: u32, now: Instant) -> bool {
        if self.keyframe_in_flight == Some(sequence) {
            self.keyframe_in_flight = None;
        }
        if let Some(index) = self.units.iter().position(|unit| unit.keyframe) {
            for _ in 0..index {
                let removed = self.units.pop_front().expect("queued unit");
                self.bytes -= removed.payload.len();
            }
            return false;
        }
        if self.keyframe_in_flight.is_some_and(|key| {
            let distance = key.wrapping_sub(sequence);
            distance != 0 && distance < 0x8000_0000
        }) {
            return false;
        }
        self.clear();
        self.dropping = true;
        self.request_idr(now)
    }
}
