use super::{Config, Datagram, MAX_DATAGRAM, MAX_PAYLOAD, Memory, UNIT_SLOTS, wire};
use crate::outbound::Outbound;
use crate::socket::{IoError, Socket, wipe};
use moonlight_nx2_core::media::{Header, MAX_OUTBOUND_BYTES};

const FRAGMENTS: usize = MAX_PAYLOAD.div_ceil(wire::FRAGMENT_BYTES);
const BITMAP_WORDS: usize = FRAGMENTS.div_ceil(64);
const HELLO_PERIOD_US: u64 = 100_000;
const STATS_PERIOD_US: u64 = 1_000_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Again,
    Invalid,
    Clock,
    ConnectTimeout,
    HelloTimeout,
    Ended,
    Io(IoError),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub received: u64,
    pub lost: u64,
    pub repaired: u64,
    pub nacks: u64,
    pub late_drops: u64,
    pub reorders: u64,
    pub drain_calls: u64,
    pub drain_us: u64,
    pub duplicates: u64,
    pub skipped: u64,
    pub stale: u64,
    pub copies: u64,
    pub invalid: u64,
    pub zero_datagrams: u64,
    pub hellos: u64,
    pub acknowledged: u64,
    pub feedback_bytes: usize,
}

impl Stats {
    fn counters(&self) -> [u32; wire::STATS_COUNTERS] {
        [
            self.received,
            self.lost,
            self.repaired,
            self.nacks,
            self.late_drops,
            self.reorders,
            self.drain_calls,
            self.drain_us,
            self.duplicates,
            self.skipped,
            self.stale,
            self.copies,
        ]
        .map(|value| value as u32)
    }
}

#[derive(Debug)]
pub struct Unit<'a> {
    pub transport_frame: u32,
    pub header: Header,
    pub payload: &'a [u8],
    pub keyframe: bool,
    pub known_at_us: u64,
    pub completed_at_us: u64,
}

#[derive(Clone, Copy)]
struct Slot {
    frame: Option<u32>,
    known: Option<u32>,
    known_at: u64,
    completed_at: u64,
    header: Header,
    first_sequence: u32,
    keyframe: bool,
    count: usize,
    received: usize,
    bitmap: [u64; BITMAP_WORDS],
}

impl Default for Slot {
    fn default() -> Self {
        Self {
            frame: None,
            known: None,
            known_at: 0,
            completed_at: 0,
            header: Header {
                payload_bytes: 0,
                sequence: 0,
                pts_us: 0,
            },
            first_sequence: 0,
            keyframe: false,
            count: 0,
            received: 0,
            bitmap: [0; BITMAP_WORDS],
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CloseError {
    pub feedback: Option<IoError>,
    pub datagram: Option<IoError>,
}

/// Eight caller-owned unit slots. A ready head is held until its ACK or explicit drop is
/// queued on the TCP feedback connection. No fragment overwrites another live unit.
pub struct Receiver<'a, S: Socket, D: Datagram> {
    feedback: S,
    datagram: D,
    units: &'a mut [u8],
    outbound: Outbound<'a>,
    config: Config,
    slots: [Slot; UNIT_SLOTS],
    next_frame: u32,
    end_frame: Option<u32>,
    end_sequence: Option<u32>,
    expected_sequence: u32,
    ranges: [wire::Range; wire::NACK_RANGES],
    range_count: usize,
    awaiting_keyframe: bool,
    feedback_connected: bool,
    datagram_connected: bool,
    token_bytes: usize,
    hello: [u8; 68],
    heard: bool,
    last_hello: Option<u64>,
    last_stats: u64,
    last_us: u64,
    connect_deadline: u64,
    hello_deadline: Option<u64>,
    failure: Option<Error>,
    stats: Stats,
}

fn token_valid(token: &[u8; 64]) -> bool {
    token
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

impl<'a, S: Socket, D: Datagram> Receiver<'a, S, D> {
    pub fn open(
        mut config: Config,
        memory: Memory<'a>,
        feedback: S,
        datagram: D,
        now_us: u64,
    ) -> Result<Self, (Error, S, D)> {
        let size_ok = (1..=MAX_PAYLOAD).contains(&config.max_payload)
            && memory.units.len() >= config.max_payload * UNIT_SLOTS;
        let output_ok = (20 + crate::media::MAX_INPUT_BYTES..=MAX_OUTBOUND_BYTES)
            .contains(&memory.feedback.len());
        let timing_ok = (1000..=2_000_000).contains(&config.deadline_us)
            && config.spread_us <= 1_000_000
            && (100..=1_000_000).contains(&config.pace_bytes_per_ms)
            && (100..=60_000).contains(&config.hello_ms)
            && config.connect_timeout_us > 0;
        let budget_ok = (1..=256).contains(&config.datagram_budget);
        let tokens_ok = token_valid(&config.feedback_token) && token_valid(&config.udp_token);
        let connect_deadline = now_us.checked_add(config.connect_timeout_us);
        let hello_deadline = now_us.checked_add(u64::from(config.hello_ms) * 1000);
        if !size_ok
            || !output_ok
            || !timing_ok
            || !budget_ok
            || !tokens_ok
            || connect_deadline.is_none()
            || hello_deadline.is_none()
        {
            wipe(&mut config.feedback_token);
            wipe(&mut config.udp_token);
            return Err((Error::Invalid, feedback, datagram));
        }
        let hello = wire::hello(&config.udp_token).unwrap();
        let mut outbound = Outbound::new(memory.feedback);
        outbound.push(&[&config.feedback_token]);
        wipe(&mut config.feedback_token);
        wipe(&mut config.udp_token);
        Ok(Self {
            feedback,
            datagram,
            units: memory.units,
            outbound,
            config,
            slots: [Slot::default(); UNIT_SLOTS],
            next_frame: 0,
            end_frame: None,
            end_sequence: None,
            expected_sequence: 0,
            ranges: [wire::Range::default(); wire::NACK_RANGES],
            range_count: 0,
            awaiting_keyframe: false,
            feedback_connected: false,
            datagram_connected: false,
            token_bytes: 64,
            hello,
            heard: false,
            last_hello: None,
            last_stats: now_us,
            last_us: now_us,
            connect_deadline: connect_deadline.unwrap(),
            hello_deadline: None,
            failure: None,
            stats: Stats::default(),
        })
    }

    fn failed(&mut self, error: Error) -> Result<(), Error> {
        self.failure = Some(error);
        Err(error)
    }

    fn connect(&mut self, now_us: u64) -> Result<bool, Error> {
        if !self.feedback_connected {
            match self.feedback.poll_connect() {
                Ok(ready) => self.feedback_connected = ready,
                Err(error) if error.is_retry() => {}
                Err(error) => return self.failed(Error::Io(error)).map(|()| false),
            }
        }
        if !self.datagram_connected {
            match self.datagram.poll_connect() {
                Ok(ready) => self.datagram_connected = ready,
                Err(error) if error.is_retry() => {}
                Err(error) => return self.failed(Error::Io(error)).map(|()| false),
            }
        }
        let ready = self.feedback_connected && self.datagram_connected;
        if !ready && now_us >= self.connect_deadline {
            return self.failed(Error::ConnectTimeout).map(|()| false);
        }
        Ok(ready)
    }

    fn flush(&mut self) -> Result<(), Error> {
        let before = self.outbound.queued();
        let result = self.outbound.flush(&mut self.feedback);
        self.token_bytes = self
            .token_bytes
            .saturating_sub(before - self.outbound.queued());
        match result {
            Ok(_) => Ok(()),
            Err(error) => self.failed(Error::Io(error)),
        }
    }

    fn hello(&mut self, now_us: u64) -> Result<(), Error> {
        if self.heard {
            return Ok(());
        }
        let deadline = match self.hello_deadline {
            Some(deadline) => deadline,
            None => {
                let Some(deadline) = now_us.checked_add(u64::from(self.config.hello_ms) * 1000)
                else {
                    return self.failed(Error::Clock);
                };
                self.hello_deadline = Some(deadline);
                deadline
            }
        };
        if now_us >= deadline {
            return self.failed(Error::HelloTimeout);
        }
        if self
            .last_hello
            .is_some_and(|last| now_us - last < HELLO_PERIOD_US)
        {
            return Ok(());
        }
        match self.datagram.send(&self.hello) {
            Ok(()) => {
                self.last_hello = Some(now_us);
                self.stats.hellos += 1;
                Ok(())
            }
            Err(error) if error.is_retry() => Ok(()),
            Err(error) => self.failed(Error::Io(error)),
        }
    }

    fn mark_known(&mut self, frame: u32, now_us: u64) {
        let slot = &mut self.slots[frame as usize % UNIT_SLOTS];
        if slot.known != Some(frame) {
            slot.known = Some(frame);
            slot.known_at = now_us;
        }
    }

    fn track(&mut self, sequence: u32, resend: bool, end: bool) {
        match wire::serial_delta(sequence, self.expected_sequence) {
            Some(delta) if delta < 0 => {
                if !resend {
                    self.stats.reorders += 1;
                }
            }
            Some(delta) => {
                let mut left = delta as u32;
                self.stats.lost += u64::from(left);
                let mut first = self.expected_sequence;
                while left > 0 && self.range_count < wire::NACK_RANGES {
                    let count = left.min(wire::NACK_RANGE_LIMIT);
                    self.ranges[self.range_count] = wire::Range {
                        first,
                        length: count,
                    };
                    self.range_count += 1;
                    first = first.wrapping_add(count);
                    left -= count;
                }
                self.expected_sequence = if end {
                    sequence
                } else {
                    sequence.wrapping_add(1)
                };
            }
            None => self.stats.invalid += 1,
        }
    }

    fn accept(&mut self, packet: &[u8], now_us: u64) {
        let parsed = match wire::parse(packet, self.config.max_payload) {
            Ok(parsed) => parsed,
            Err(_) => {
                self.stats.invalid += 1;
                return;
            }
        };
        let sequence = match parsed {
            wire::Packet::Data(fragment) => fragment.datagram_sequence,
            wire::Packet::End { sequence, .. } => sequence,
        };
        if wire::serial_delta(sequence, self.expected_sequence).is_none() {
            self.stats.invalid += 1;
            return;
        }
        match parsed {
            wire::Packet::End { sequence, frames } => {
                let within = frames >= self.next_frame
                    && u64::from(frames) <= u64::from(self.next_frame) + UNIT_SLOTS as u64;
                let consistent = self.end_frame.is_none_or(|end| end == frames)
                    && self.end_sequence.is_none_or(|end| end == sequence)
                    && self.slots.iter().all(|slot| {
                        slot.frame.is_none_or(|frame| {
                            frame < frames
                                && Self::before_end(
                                    frame,
                                    slot.first_sequence,
                                    slot.count,
                                    frames,
                                    sequence,
                                )
                        })
                    });
                if !within || !consistent {
                    self.stats.invalid += 1;
                    return;
                }
                self.track(sequence, false, true);
                self.end_frame = Some(frames);
                self.end_sequence = Some(sequence);
                for frame in self.next_frame..frames {
                    self.mark_known(frame, now_us);
                }
            }
            wire::Packet::Data(fragment) => {
                let frame = fragment.transport_frame;
                if frame < self.next_frame {
                    self.stats.stale += 1;
                    return;
                }
                let outside = frame == u32::MAX
                    || u64::from(frame) >= u64::from(self.next_frame) + UNIT_SLOTS as u64
                    || self.end_frame.is_some_and(|end| {
                        frame >= end
                            || !Self::before_end(
                                frame,
                                fragment.first_sequence(),
                                fragment.count,
                                end,
                                self.end_sequence.unwrap(),
                            )
                    });
                if outside {
                    self.stats.invalid += 1;
                    return;
                }
                let index = frame as usize % UNIT_SLOTS;
                let old = self.slots[index];
                let metadata_ok = old.frame.is_none()
                    || (old.frame == Some(frame)
                        && old.header == fragment.header
                        && old.count == fragment.count
                        && old.keyframe == fragment.keyframe()
                        && old.first_sequence == fragment.first_sequence());
                if !metadata_ok {
                    self.stats.invalid += 1;
                    return;
                }
                for known in self.next_frame..=frame {
                    self.mark_known(known, now_us);
                }
                if self.slots[index].frame.is_none() {
                    let slot = &mut self.slots[index];
                    slot.frame = Some(frame);
                    slot.header = fragment.header;
                    slot.first_sequence = fragment.first_sequence();
                    slot.keyframe = fragment.keyframe();
                    slot.count = fragment.count;
                }
                self.track(
                    fragment.datagram_sequence,
                    fragment.flags & wire::RESEND != 0,
                    false,
                );
                let bit = 1u64 << (fragment.index % 64);
                let slot = &mut self.slots[index];
                if slot.bitmap[fragment.index / 64] & bit != 0 {
                    self.stats.duplicates += 1;
                    return;
                }
                let start = index * self.config.max_payload + fragment.index * wire::FRAGMENT_BYTES;
                self.units[start..start + fragment.payload.len()].copy_from_slice(fragment.payload);
                slot.bitmap[fragment.index / 64] |= bit;
                slot.received += 1;
                if slot.received == slot.count {
                    slot.completed_at = now_us;
                }
                self.stats.received += 1;
                self.stats.copies += 1;
                if fragment.flags & wire::RESEND != 0 {
                    self.stats.repaired += 1;
                }
            }
        }
        self.heard = true;
        wipe(&mut self.hello);
    }

    fn before_end(frame: u32, first: u32, count: usize, frames: u32, sequence: u32) -> bool {
        let after = first.wrapping_add(count as u32);
        if frame + 1 == frames {
            after == sequence
        } else {
            wire::serial_delta(sequence, after).is_some_and(|delta| delta >= 0)
        }
    }

    fn advance(&mut self) {
        self.slots[self.next_frame as usize % UNIT_SLOTS] = Slot::default();
        self.next_frame += 1;
    }

    fn drop_head(&mut self, reason: wire::DropReason) -> Result<(), Error> {
        let record = wire::drop_record(self.next_frame, reason);
        if !self.outbound.push(&[&record]) {
            return Err(Error::Again);
        }
        match reason {
            wire::DropReason::Late => {
                self.stats.late_drops += 1;
                self.awaiting_keyframe = true;
            }
            wire::DropReason::Skipped => self.stats.skipped += 1,
        }
        self.advance();
        Ok(())
    }

    fn settle(&mut self, now_us: u64) {
        for _ in 0..UNIT_SLOTS {
            if self.receive_ended() {
                break;
            }
            let slot = &self.slots[self.next_frame as usize % UNIT_SLOTS];
            let seen = slot.frame == Some(self.next_frame);
            let reason = if self.awaiting_keyframe && seen && !slot.keyframe {
                wire::DropReason::Skipped
            } else {
                if seen && slot.received == slot.count {
                    break;
                }
                if slot.known != Some(self.next_frame) {
                    break;
                }
                let duration = if seen {
                    let base = self.config.deadline_us * if slot.keyframe { 2 } else { 1 };
                    let paced = (u64::from(slot.header.payload_bytes) * 1000)
                        .div_ceil(u64::from(self.config.pace_bytes_per_ms));
                    base + self.config.spread_us.max(paced)
                } else {
                    self.config.deadline_us
                };
                if now_us - slot.known_at <= duration {
                    break;
                }
                if self.awaiting_keyframe {
                    wire::DropReason::Skipped
                } else {
                    wire::DropReason::Late
                }
            };
            if self.drop_head(reason).is_err() {
                break;
            }
        }
    }

    fn report(&mut self, now_us: u64) -> Result<(), Error> {
        let mut packet = [0; 8 + wire::NACK_RANGES * 8];
        if self.receive_ended() {
            self.range_count = 0;
            return Ok(());
        }
        if self.range_count > 0 {
            let length = wire::nack(&self.ranges[..self.range_count], &mut packet).unwrap();
            match self.datagram.send(&packet[..length]) {
                Ok(()) => {
                    self.range_count = 0;
                    self.stats.nacks += 1;
                }
                Err(error) if error.is_retry() => return Ok(()),
                Err(error) => return self.failed(Error::Io(error)),
            }
        }
        if self.heard && now_us - self.last_stats >= STATS_PERIOD_US {
            let length = wire::stats(&self.stats.counters(), &mut packet).unwrap();
            match self.datagram.send(&packet[..length]) {
                Ok(()) => self.last_stats = now_us,
                Err(error) if error.is_retry() => {}
                Err(error) => return self.failed(Error::Io(error)),
            }
        }
        Ok(())
    }

    pub fn pump(&mut self, now_us: u64) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if now_us < self.last_us {
            return Err(Error::Clock);
        }
        self.last_us = now_us;
        if !self.connect(now_us)? {
            return Ok(());
        }
        self.flush()?;
        if self.token_bytes > 0 {
            if now_us >= self.connect_deadline {
                return self.failed(Error::ConnectTimeout);
            }
            return Ok(());
        }
        if self.receive_ended() {
            return Err(Error::Ended);
        }
        self.hello(now_us)?;
        let started = self.datagram.now_us();
        let mut packet = [0; MAX_DATAGRAM + 1];
        for _ in 0..self.config.datagram_budget {
            self.stats.drain_calls += 1;
            match self.datagram.recv(&mut packet) {
                Ok(0) => self.stats.zero_datagrams += 1,
                Ok(count) if count <= packet.len() => self.accept(&packet[..count], now_us),
                Ok(_) => return self.failed(Error::Io(IoError::Failed)),
                Err(error) if error.is_retry() => break,
                Err(error) => return self.failed(Error::Io(error)),
            }
        }
        if let (Some(start), Some(end)) = (started, self.datagram.now_us())
            && let Some(elapsed) = end.checked_sub(start)
        {
            self.stats.drain_us += elapsed;
        }
        self.settle(now_us);
        self.report(now_us)?;
        if self.receive_ended() {
            Err(Error::Ended)
        } else {
            Ok(())
        }
    }

    pub fn peek(&self) -> Option<Unit<'_>> {
        if self.failure.is_some() {
            return None;
        }
        let index = self.next_frame as usize % UNIT_SLOTS;
        let slot = &self.slots[index];
        let ready = slot.frame == Some(self.next_frame) && slot.received == slot.count;
        if !ready || (self.awaiting_keyframe && !slot.keyframe) {
            return None;
        }
        let start = index * self.config.max_payload;
        Some(Unit {
            transport_frame: self.next_frame,
            header: slot.header,
            payload: &self.units[start..start + slot.header.payload_bytes as usize],
            keyframe: slot.keyframe,
            known_at_us: slot.known_at,
            completed_at_us: slot.completed_at,
        })
    }

    pub fn acknowledge(&mut self, input: &[u8]) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if input.len() > crate::media::MAX_INPUT_BYTES {
            return Err(Error::Invalid);
        }
        let Some(unit) = self.peek() else {
            return Err(Error::Again);
        };
        let header = unit.header.encode();
        let keyframe = unit.keyframe;
        let length = (input.len() as u32).to_le_bytes();
        if !self.outbound.push(&[&header, &length, input]) {
            return Err(Error::Again);
        }
        if keyframe {
            self.awaiting_keyframe = false;
        }
        self.stats.acknowledged += 1;
        self.advance();
        Ok(())
    }

    pub fn drop_ready(&mut self, reason: wire::DropReason) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let Some(unit) = self.peek() else {
            return Err(Error::Again);
        };
        if reason == wire::DropReason::Skipped && unit.keyframe {
            return Err(Error::Invalid);
        }
        self.drop_head(reason)
    }

    pub fn receive_ended(&self) -> bool {
        self.end_frame.is_some_and(|end| self.next_frame >= end)
    }

    pub fn drained(&self) -> bool {
        self.failure.is_none() && self.receive_ended() && self.outbound.queued() == 0
    }

    pub fn failure(&self) -> Option<Error> {
        self.failure
    }

    pub fn stats(&self) -> Stats {
        Stats {
            feedback_bytes: self.outbound.queued(),
            ..self.stats
        }
    }

    pub fn close(mut self) -> (Result<(), CloseError>, Stats) {
        let failure = CloseError {
            feedback: self.feedback.close().err(),
            datagram: self.datagram.close().err(),
        };
        let stats = self.stats();
        if failure == CloseError::default() {
            (Ok(()), stats)
        } else {
            (Err(failure), stats)
        }
    }
}

impl<S: Socket, D: Datagram> Drop for Receiver<'_, S, D> {
    fn drop(&mut self) {
        wipe(&mut self.hello);
    }
}
