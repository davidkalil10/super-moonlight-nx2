//! Video loss recovery: after a sequence gap or a decoder-dropped unit, units are skipped and
//! frames hidden until the next keyframe, with IDR requests limited to one per `IDR_RETRY_MS`.

use crate::codec::Codec;

pub const IDR_RETRY_MS: u64 = 500;
/// Units in a row too big for the decoder before IDR requests back off. Each request makes
/// the PC send another large keyframe, so asking every `IDR_RETRY_MS` only repeats the drop.
pub const OVERSIZE_STREAK: u32 = 3;
pub const OVERSIZE_RETRY_MAX_MS: u64 = 8_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    Decode,
    Skip,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Counters {
    pub idr_requests: u64,
    pub frames_skipped: u64,
}

#[derive(Default)]
pub struct Recovery {
    last: Option<(u32, Decision)>,
    awaiting: bool,
    resume_pts_us: Option<u64>,
    requested_ms: Option<u64>,
    wanted: bool,
    oversized: u32,
    counters: Counters,
}

impl Recovery {
    pub fn unit(&mut self, sequence: u32, keyframe: bool, pts_us: u64, now_ms: u64) -> Decision {
        if let Some((last, decision)) = self.last
            && last == sequence
        {
            return decision;
        }
        let gap = self
            .last
            .is_some_and(|(last, _)| last.wrapping_add(1) != sequence);
        let decision = self.decide(gap, keyframe, pts_us, now_ms);
        self.last = Some((sequence, decision));
        decision
    }

    fn decide(&mut self, gap: bool, keyframe: bool, pts_us: u64, now_ms: u64) -> Decision {
        if keyframe {
            if self.awaiting {
                self.resume_pts_us = Some(pts_us);
            }
            self.awaiting = false;
            return Decision::Decode;
        }
        if gap {
            self.lose(now_ms);
        }
        if !self.awaiting {
            return Decision::Decode;
        }
        self.counters.frames_skipped += 1;
        Decision::Skip
    }

    pub fn lose(&mut self, now_ms: u64) {
        self.awaiting = true;
        self.resume_pts_us = None;
        self.tick(now_ms);
    }

    /// A unit too big for the decoder was dropped. Returns true on the drop that starts the
    /// backoff, so the user can be told once to lower the bitrate.
    pub fn oversized(&mut self, now_ms: u64) -> bool {
        self.oversized = self.oversized.saturating_add(1);
        self.lose(now_ms);
        self.oversized == OVERSIZE_STREAK
    }

    /// A unit went into the decoder, ending any run of oversize drops.
    pub fn fitted(&mut self) {
        self.oversized = 0;
    }

    /// How long to wait between IDR requests: doubling from the third oversize drop in a row.
    pub fn retry_ms(&self) -> u64 {
        match self.oversized.checked_sub(OVERSIZE_STREAK - 1) {
            Some(steps) if steps > 0 => (IDR_RETRY_MS << steps.min(8)).min(OVERSIZE_RETRY_MAX_MS),
            _ => IDR_RETRY_MS,
        }
    }

    pub fn tick(&mut self, now_ms: u64) {
        if !self.awaiting {
            return;
        }
        let retry_ms = self.retry_ms();
        let due = self
            .requested_ms
            .is_none_or(|last| now_ms.saturating_sub(last) >= retry_ms);
        if !due {
            return;
        }
        self.requested_ms = Some(now_ms);
        self.wanted = true;
        self.counters.idr_requests += 1;
    }

    pub fn presentable(&mut self, pts_us: u64) -> bool {
        if self.awaiting {
            self.counters.frames_skipped += 1;
            return false;
        }
        match self.resume_pts_us {
            Some(resume) if pts_us < resume => {
                self.counters.frames_skipped += 1;
                false
            }
            Some(_) => {
                self.resume_pts_us = None;
                true
            }
            None => true,
        }
    }

    pub fn take_request(&mut self) -> bool {
        core::mem::take(&mut self.wanted)
    }

    pub fn awaiting(&self) -> bool {
        self.awaiting
    }

    pub fn counters(&self) -> Counters {
        self.counters
    }
}

pub fn keyframe(codec: Codec, payload: &[u8]) -> bool {
    match codec {
        Codec::H264 => nal_types(payload).any(|header| header & 0x1f == 5),
        Codec::Hevc => nal_types(payload).any(|header| (16..=21).contains(&((header >> 1) & 0x3f))),
        Codec::Av1 => av1_sequence_header(payload),
        Codec::Vp9 => payload.first().is_some_and(|byte| byte & 0x04 == 0),
    }
}

fn nal_types(payload: &[u8]) -> impl Iterator<Item = u8> + '_ {
    payload
        .windows(4)
        .filter(|window| window[..3] == [0, 0, 1])
        .map(|window| window[3])
}

fn av1_sequence_header(payload: &[u8]) -> bool {
    let mut at = 0;
    while at < payload.len() {
        let header = payload[at];
        let kind = (header >> 3) & 0x0f;
        if kind == 1 {
            return true;
        }
        let extension = usize::from(header & 0x04 != 0);
        if header & 0x02 == 0 {
            return false;
        }
        let Some((size, used)) = leb128(&payload[(at + 1 + extension).min(payload.len())..]) else {
            return false;
        };
        let Some(next) = (at + 1 + extension + used).checked_add(size) else {
            return false;
        };
        at = next;
    }
    false
}

fn leb128(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut value = 0usize;
    for (index, byte) in bytes.iter().take(8).enumerate() {
        value |= usize::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
    }
    None
}
