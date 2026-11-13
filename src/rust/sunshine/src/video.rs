//! Sunshine's RTP video stream, ported from moonlight-common-c's RtpVideoQueue and
//! VideoDepacketizer: optional AES-GCM per packet, FEC blocks with Reed-Solomon recovery,
//! then whole access units into a small ring. A loss drops frames until the next keyframe
//! and asks for one through `Events`. Memory is allocated once in `Receiver::new`.

use alloc::{vec, vec::Vec};

use aes_gcm::{Aes128Gcm, KeyInit, Nonce, Tag, aead::AeadInOut};

use crate::rs::{self, Code, Shards, Workspace};
use crate::rtp::{self, Clock90k, before16, before24, before32};
use crate::stream::Codec;

pub const NV_HEADER_BYTES: usize = 16;
pub const ENC_HEADER_BYTES: usize = 32;
pub const READY_FRAMES: usize = 4;
pub const MIN_PACKET_SIZE: usize = 64;
pub const MAX_PACKET_SIZE: usize = 4096;

const FLAG_PIC: u8 = 0x1;
const FLAG_EOF: u8 = 0x2;
const FLAG_SOF: u8 = 0x4;
const SLOTS: usize = rs::MAX_SHARDS + 1;
const NONE: u16 = u16::MAX;
const IDR_RETRY_US: u64 = 500_000;
const OOS_COOLDOWN_US: u64 = 300_000_000;

#[derive(Clone, Copy)]
pub struct Config {
    pub format: Codec,
    /// `x-nv-video[0].packetSize`: NV header plus payload per datagram.
    pub packet_size: usize,
    /// rikey, when Sunshine encrypts video (SS_ENC_VIDEO).
    pub key: Option<[u8; 16]>,
    /// Ring capacity for complete access units.
    pub frame_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Config,
}

/// What the control channel hears from video.
pub trait Events {
    fn request_idr(&mut self);
    fn frames_lost(&mut self, _first: u32, _last: u32) {}
    fn fec_status(&mut self, _status: &FecStatus) {}
}

/// SS_FRAME_FEC_STATUS (control packet type 0x5502), sent when a block needed FEC or failed.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct FecStatus {
    pub frame: u32,
    pub highest_sequence: u16,
    pub next_contiguous: u16,
    pub missing_before_highest: u16,
    pub data_packets: u16,
    pub parity_packets: u16,
    pub received_data: u16,
    pub received_parity: u16,
    pub fec_percentage: u8,
    pub block_index: u8,
    pub block_count: u8,
}

impl FecStatus {
    pub const PACKET_TYPE: u16 = 0x5502;

    pub fn encode(&self) -> [u8; 21] {
        let mut out = [0; 21];
        out[..4].copy_from_slice(&self.frame.to_be_bytes());
        let words = [
            self.highest_sequence,
            self.next_contiguous,
            self.missing_before_highest,
            self.data_packets,
            self.parity_packets,
            self.received_data,
            self.received_parity,
        ];
        for (i, word) in words.iter().enumerate() {
            out[4 + i * 2..6 + i * 2].copy_from_slice(&word.to_be_bytes());
        }
        out[18] = self.fec_percentage;
        out[19] = self.block_index;
        out[20] = self.block_count;
        out
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub packets: u64,
    pub bytes: u64,
    /// Packets skipped in the RTP sequence: lost on the way, or still to come out of order.
    pub missing: u64,
    pub invalid: u64,
    pub undecryptable: u64,
    pub rejected: u64,
    pub fec_recovered: u64,
    pub unrecoverable_blocks: u64,
    pub frames: u64,
    pub keyframes: u64,
    pub frames_lost: u64,
    pub waiting_drops: u64,
    pub stall_drops: u64,
    pub oversize: u64,
    pub idr_requests: u64,
}

/// One complete access unit, borrowed until `release`.
#[derive(Clone, Copy, Debug)]
pub struct Frame<'a> {
    pub number: u32,
    pub rtp_timestamp: u32,
    pub pts_us: u64,
    pub keyframe: bool,
    pub received_us: u64,
    pub host_latency: u16,
    pub data: &'a [u8],
}

struct Nv {
    stream_index: u32,
    frame: u32,
    flags: u8,
    block: u8,
    last_block: u8,
    fec_info: u32,
}

fn parse_nv(bytes: &[u8]) -> Option<Nv> {
    let h: &[u8; NV_HEADER_BYTES] = bytes.get(..NV_HEADER_BYTES)?.try_into().ok()?;
    let word = |at: usize| u32::from_le_bytes([h[at], h[at + 1], h[at + 2], h[at + 3]]);
    Some(Nv {
        stream_index: (word(0) >> 8) & 0xff_ffff,
        frame: word(4),
        flags: h[8],
        block: (h[11] >> 4) & 0x3,
        last_block: (h[11] >> 6) & 0x3,
        fec_info: word(12),
    })
}

fn frame_before(x: u32, y: u32) -> bool {
    before16(x as u16, y as u16)
}

pub struct Receiver {
    format: Codec,
    packet_size: usize,
    cipher: Option<Aes128Gcm>,
    pool: Pool,
    spare: u16,
    started: bool,
    last_sequence: Option<u16>,
    unsequenced: u16,
    block: Block,
    current_frame: u32,
    workspace: Workspace,
    depack: Depacketizer,
    ring: Ring,
    clock: Clock90k,
    stats: Stats,
}

#[derive(Default)]
struct Block {
    pending: u16,
    lowest: u16,
    first_parity: u16,
    highest: u16,
    data: u16,
    parity: u16,
    received_data: u16,
    received_parity: u16,
    received_highest: u16,
    next_contiguous: u16,
    missing: u16,
    fec_percentage: u8,
    number: u8,
    last_number: u8,
    fast_path: bool,
    reported_lost: bool,
    header_bytes: usize,
    timestamp: u32,
    out_of_sequence: bool,
    last_oos_pts_us: u64,
}

struct Pool {
    bytes: Vec<u8>,
    stride: usize,
    lengths: Vec<u16>,
    free: Vec<u16>,
    shards: [u16; rs::MAX_SHARDS],
    total: usize,
}

impl Pool {
    fn slot(&self, slot: u16) -> &[u8] {
        let at = slot as usize * self.stride;
        &self.bytes[at..at + self.stride]
    }

    fn slot_mut(&mut self, slot: u16) -> &mut [u8] {
        let at = slot as usize * self.stride;
        &mut self.bytes[at..at + self.stride]
    }

    fn packet(&self, slot: u16) -> &[u8] {
        &self.slot(slot)[ENC_HEADER_BYTES..ENC_HEADER_BYTES + self.lengths[slot as usize] as usize]
    }

    fn release_block(&mut self) {
        for index in 0..self.total {
            let slot = core::mem::replace(&mut self.shards[index], NONE);
            if slot != NONE {
                self.free.push(slot);
            }
        }
        self.total = 0;
    }
}

struct BlockShards<'a> {
    pool: &'a mut Pool,
    length: usize,
    present: &'a [bool],
}

impl Shards for BlockShards<'_> {
    fn count(&self) -> usize {
        self.pool.total
    }

    fn present(&self, shard: usize) -> bool {
        self.present[shard]
    }

    fn shard(&mut self, shard: usize) -> &mut [u8] {
        let slot = self.pool.shards[shard];
        let length = self.length;
        &mut self.pool.slot_mut(slot)[ENC_HEADER_BYTES..ENC_HEADER_BYTES + length]
    }

    fn pair(&mut self, write: usize, read: usize) -> (&mut [u8], &[u8]) {
        let stride = self.pool.stride;
        let (w, r) = (
            self.pool.shards[write] as usize,
            self.pool.shards[read] as usize,
        );
        let range = |slot: usize| {
            slot * stride + ENC_HEADER_BYTES..slot * stride + ENC_HEADER_BYTES + self.length
        };
        let (wr, rr) = (range(w), range(r));
        if w < r {
            let (low, high) = self.pool.bytes.split_at_mut(rr.start);
            (&mut low[wr], &high[..self.length])
        } else {
            let (low, high) = self.pool.bytes.split_at_mut(wr.start);
            (&mut high[..self.length], &low[rr])
        }
    }
}

impl Receiver {
    pub fn new(config: Config) -> Result<Self, Error> {
        if !(MIN_PACKET_SIZE..=MAX_PACKET_SIZE).contains(&config.packet_size)
            || config.frame_bytes < config.packet_size
        {
            return Err(Error::Config);
        }
        let stride = ENC_HEADER_BYTES + rtp::MAX_HEADER_BYTES + config.packet_size + 1;
        let mut free: Vec<u16> = (0..SLOTS as u16).rev().collect();
        let spare = free.pop().expect("slots");
        Ok(Self {
            format: config.format,
            packet_size: config.packet_size,
            cipher: config.key.map(|key| Aes128Gcm::new(&key.into())),
            pool: Pool {
                bytes: vec![0; SLOTS * stride],
                stride,
                lengths: vec![0; SLOTS],
                free,
                shards: [NONE; rs::MAX_SHARDS],
                total: 0,
            },
            spare,
            started: false,
            last_sequence: None,
            unsequenced: 0,
            block: Block::default(),
            current_frame: 1,
            workspace: Workspace::new(),
            depack: Depacketizer::new(),
            ring: Ring::new(config.frame_bytes),
            clock: Clock90k::default(),
            stats: Stats::default(),
        })
    }

    /// Where the next datagram goes; one byte longer than the largest valid datagram.
    pub fn buffer(&mut self) -> &mut [u8] {
        let offset = if self.cipher.is_some() {
            0
        } else {
            ENC_HEADER_BYTES
        };
        let spare = self.spare;
        &mut self.pool.slot_mut(spare)[offset..]
    }

    /// Takes the `length` bytes just received into `buffer`.
    pub fn commit<E: Events>(&mut self, length: usize, now_us: u64, events: &mut E) {
        self.stats.packets += 1;
        self.stats.bytes += length as u64;
        let max = rtp::MAX_HEADER_BYTES + self.packet_size;
        let Some(plain) = self.open(length, max) else {
            return;
        };
        self.pool.lengths[self.spare as usize] = plain as u16;
        if self.add(now_us, events) {
            self.spare = self
                .pool
                .free
                .pop()
                .expect("a block never holds every slot");
        }
    }

    fn open(&mut self, length: usize, max: usize) -> Option<usize> {
        let slot = self.spare;
        let current = self.current_frame;
        let Some(cipher) = &self.cipher else {
            if !(rtp::FIXED_HEADER_BYTES..=max).contains(&length) {
                self.stats.invalid += 1;
                return None;
            }
            return Some(length);
        };
        let bytes = self.pool.slot_mut(slot);
        if !(ENC_HEADER_BYTES + rtp::FIXED_HEADER_BYTES..=ENC_HEADER_BYTES + max).contains(&length)
        {
            self.stats.invalid += 1;
            return None;
        }
        let frame = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        if frame != 0 && frame < current {
            self.stats.rejected += 1;
            self.unsequenced = self.unsequenced.saturating_add(1);
            return None;
        }
        let (header, body) = bytes.split_at_mut(ENC_HEADER_BYTES);
        let nonce = Nonce::<aes_gcm::aead::consts::U12>::try_from(&header[..12]).ok()?;
        let tag = Tag::try_from(&header[16..32]).ok()?;
        let plain = length - ENC_HEADER_BYTES;
        if cipher
            .decrypt_inout_detached(&nonce, &[], (&mut body[..plain]).into(), &tag)
            .is_err()
        {
            self.stats.undecryptable += 1;
            return None;
        }
        Some(plain)
    }

    /// RtpvAddPacket. True when the spare slot now belongs to the block.
    fn add<E: Events>(&mut self, now_us: u64, events: &mut E) -> bool {
        let packet = self.pool.packet(self.spare);
        let Some(header) = rtp::Header::parse(packet) else {
            self.stats.invalid += 1;
            return false;
        };
        let Some(nv) = packet.get(header.length..).and_then(parse_nv) else {
            self.stats.invalid += 1;
            return false;
        };
        let seq = header.sequence;
        self.count_missing(seq);
        if self.started && before16(seq, self.block.next_contiguous) {
            self.stats.rejected += 1;
            return false;
        }
        if self.started && frame_before(nv.frame, self.current_frame) {
            self.stats.rejected += 1;
            return false;
        }
        if nv.frame == self.current_frame && nv.block < self.block.number && self.started {
            self.stats.rejected += 1;
            return false;
        }

        let fec_index = ((nv.fec_info & 0x3f_f000) >> 12) as u16;
        let new_block = self.block.pending == 0
            || self.current_frame != nv.frame
            || self.block.number != nv.block;
        if new_block && !self.begin_block(&header, &nv, fec_index, now_us, events) {
            self.stats.rejected += 1;
            return false;
        }

        let block = &mut self.block;
        if before16(block.highest, seq) {
            self.stats.rejected += 1;
            return false;
        }
        let index = seq.wrapping_sub(block.lowest) as usize;
        if index >= self.pool.total || self.pool.shards[index] != NONE {
            self.stats.rejected += 1;
            return false;
        }
        let in_order = block.fast_path && seq == block.next_contiguous;
        if in_order {
            block.next_contiguous = seq.wrapping_add(1);
        } else {
            block.fast_path = false;
        }
        let out_of_sequence =
            !in_order && block.pending > 0 && before16(seq, block.received_highest);
        let pts_us = u64::from(header.timestamp) * 1000 / 90;
        if out_of_sequence {
            block.last_oos_pts_us = pts_us;
            block.out_of_sequence = true;
        } else if block.out_of_sequence && pts_us > block.last_oos_pts_us + OOS_COOLDOWN_US {
            block.out_of_sequence = false;
        }
        self.pool.shards[index] = self.spare;
        block.pending += 1;
        if block.pending == 1 {
            block.missing = block.missing.wrapping_add(seq.wrapping_sub(block.lowest));
            block.received_highest = seq;
        } else if before16(block.received_highest, seq) {
            block.missing = block
                .missing
                .wrapping_add(seq.wrapping_sub(block.received_highest).wrapping_sub(1));
            block.received_highest = seq;
        } else {
            block.missing = block.missing.wrapping_sub(1);
        }
        if before16(seq, block.first_parity) {
            block.received_data += 1;
        } else {
            block.received_parity += 1;
        }

        match self.reconstruct(now_us, events) {
            Recovery::Waiting => {}
            Recovery::Complete => self.complete_block(now_us, events),
            Recovery::Failed => self.fail_block(now_us, events),
        }
        true
    }

    /// Sequence gaps, less the encrypted packets of finished frames dropped before they were
    /// opened: those arrived, only their sequence numbers went unread.
    fn count_missing(&mut self, seq: u16) {
        let arrived = core::mem::take(&mut self.unsequenced);
        match self.last_sequence {
            Some(last) if !before16(last, seq) => return,
            Some(last) => {
                let skipped = seq.wrapping_sub(last) - 1;
                self.stats.missing += u64::from(skipped.saturating_sub(arrived));
            }
            None => {}
        }
        self.last_sequence = Some(seq);
    }

    fn begin_block<E: Events>(
        &mut self,
        header: &rtp::Header,
        nv: &Nv,
        fec_index: u16,
        now_us: u64,
        events: &mut E,
    ) -> bool {
        let same_frame = self.current_frame == nv.frame;
        if self.block.pending != 0 {
            self.report_fec(events);
            self.stats.unrecoverable_blocks += 1;
            if self.block.last_number != 0 && same_frame {
                self.purge();
                if !self.block.reported_lost {
                    self.lost(self.current_frame, now_us, events);
                }
                self.current_frame = self.current_frame.wrapping_add(1);
                self.block.number = 0;
                return false;
            }
        }
        let expected = if same_frame && self.started {
            self.block.number
        } else {
            0
        };
        if nv.block != expected {
            if self.block.pending != 0 || same_frame {
                self.report_fec(events);
            }
            self.purge();
            if !self.block.reported_lost {
                self.lost(self.current_frame, now_us, events);
            }
            self.current_frame = nv.frame.wrapping_add(1);
            self.block.number = 0;
            self.started = true;
            return false;
        }
        self.purge();
        if self.started && !same_frame {
            let previous = nv.frame.wrapping_sub(1);
            if self.current_frame.wrapping_add(1) != nv.frame || !self.block.reported_lost {
                self.lost(previous, now_us, events);
            }
        }
        self.started = true;
        self.current_frame = nv.frame;
        let data = (nv.fec_info >> 22) as u16;
        let percentage = ((nv.fec_info & 0xff0) >> 4) as u16;
        let parity = (data * percentage).div_ceil(100);
        let lowest = header.sequence.wrapping_sub(fec_index);
        let total = data as usize + parity as usize;
        if data == 0 || total > rs::MAX_SHARDS {
            return false;
        }
        let block = &mut self.block;
        *block = Block {
            lowest,
            next_contiguous: lowest,
            data,
            parity,
            fec_percentage: percentage as u8,
            first_parity: lowest.wrapping_add(data),
            highest: lowest.wrapping_add(data + parity).wrapping_sub(1),
            number: nv.block,
            last_number: nv.last_block,
            fast_path: true,
            header_bytes: header.length,
            timestamp: header.timestamp,
            out_of_sequence: block.out_of_sequence,
            last_oos_pts_us: block.last_oos_pts_us,
            ..Block::default()
        };
        self.pool.total = total;
        true
    }

    fn purge(&mut self) {
        self.pool.release_block();
        self.block.pending = 0;
    }

    fn report_fec<E: Events>(&self, events: &mut E) {
        let block = &self.block;
        events.fec_status(&FecStatus {
            frame: self.current_frame,
            highest_sequence: block.received_highest,
            next_contiguous: block.next_contiguous,
            missing_before_highest: block.missing,
            data_packets: block.data,
            parity_packets: block.parity,
            received_data: block.received_data,
            received_parity: block.received_parity,
            fec_percentage: block.fec_percentage,
            block_index: block.number,
            block_count: block.last_number + 1,
        });
    }

    fn lost<E: Events>(&mut self, frame: u32, now_us: u64, events: &mut E) {
        self.depack
            .lost(frame, &mut self.ring, &mut self.stats, now_us, events);
    }

    fn reconstruct<E: Events>(&mut self, now_us: u64, events: &mut E) -> Recovery {
        let block = &mut self.block;
        if block.pending < block.data {
            let hopeless = block.missing > block.parity;
            if !block.reported_lost && !block.out_of_sequence && hopeless {
                block.reported_lost = true;
                let frame = self.current_frame;
                self.lost(frame, now_us, events);
            }
            return Recovery::Waiting;
        }
        if block.reported_lost && !block.out_of_sequence {
            block.out_of_sequence = true;
            block.last_oos_pts_us = u64::from(block.timestamp) * 1000 / 90;
        }
        if self.block.received_data == self.block.data {
            return Recovery::Complete;
        }

        let data = self.block.data as usize;
        let length = rtp::MAX_HEADER_BYTES + self.packet_size;
        let mut present = [false; rs::MAX_SHARDS];
        for (index, flag) in present.iter_mut().enumerate().take(self.pool.total) {
            let slot = self.pool.shards[index];
            *flag = slot != NONE;
            if slot != NONE {
                let used = self.pool.lengths[slot as usize] as usize;
                self.pool.slot_mut(slot)[ENC_HEADER_BYTES + used..ENC_HEADER_BYTES + length]
                    .fill(0);
            }
        }
        for index in 0..data {
            if self.pool.shards[index] == NONE {
                let slot = self.pool.free.pop().expect("free slots cover a block");
                self.pool.shards[index] = slot;
                self.pool.lengths[slot as usize] =
                    (self.packet_size + self.block.header_bytes) as u16;
            }
        }
        let code = Code::new(data, self.block.parity as usize).expect("checked shape");
        let mut shards = BlockShards {
            pool: &mut self.pool,
            length,
            present: &present,
        };
        let recovered = self.workspace.reconstruct(&code, &mut shards).is_ok();
        self.report_fec(events);
        if !recovered {
            return Recovery::Failed;
        }
        let missing = data - self.block.received_data as usize;
        for index in (0..data).filter(|&i| !present[i]) {
            let slot = self.pool.shards[index];
            let header_bytes = self.block.header_bytes;
            let bytes = &self.pool.slot(slot)[ENC_HEADER_BYTES + header_bytes..];
            let flags = bytes[8];
            let valid = (index != 0 || flags & FLAG_SOF != 0)
                && (index != data - 1 || flags & FLAG_EOF != 0)
                && (index == 0 || index == data - 1 || flags & FLAG_PIC != 0)
                && flags & !(FLAG_SOF | FLAG_EOF | FLAG_PIC) == 0;
            if !valid {
                return Recovery::Failed;
            }
        }
        self.stats.fec_recovered += missing as u64;
        Recovery::Complete
    }

    fn complete_block<E: Events>(&mut self, now_us: u64, events: &mut E) {
        let data = self.block.data as usize;
        let header_bytes = self.block.header_bytes;
        let frame = self.current_frame;
        let (number, last_number) = (self.block.number, self.block.last_number);
        let timestamp = self.block.timestamp;
        for index in 0..data {
            let slot = self.pool.shards[index];
            let packet = self.pool.packet(slot);
            let Some(body) = packet.get(header_bytes..) else {
                continue;
            };
            let Some(nv) = parse_nv(body) else {
                continue;
            };
            let unit = Packet {
                frame,
                stream_index: nv.stream_index,
                flags: nv.flags,
                block: number,
                last_block: last_number,
                timestamp,
                payload: &body[NV_HEADER_BYTES..],
            };
            self.depack.packet(
                &unit,
                self.format,
                &mut self.ring,
                &mut self.clock,
                &mut self.stats,
                now_us,
                events,
            );
        }
        self.pool.release_block();
        self.block.pending = 0;
        if number < last_number {
            self.block.number += 1;
        } else {
            self.current_frame = frame.wrapping_add(1);
            self.block.number = 0;
        }
    }

    fn fail_block<E: Events>(&mut self, now_us: u64, events: &mut E) {
        self.stats.unrecoverable_blocks += 1;
        let frame = self.current_frame;
        self.purge();
        if !self.block.reported_lost {
            self.lost(frame, now_us, events);
        }
        self.current_frame = frame.wrapping_add(1);
        self.block.number = 0;
    }

    pub fn peek(&self) -> Option<Frame<'_>> {
        self.ring.peek()
    }

    pub fn release(&mut self) {
        self.ring.release();
    }

    pub fn ready(&self) -> usize {
        self.ring.count
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }
}

enum Recovery {
    Waiting,
    Complete,
    Failed,
}

struct Packet<'a> {
    frame: u32,
    stream_index: u32,
    flags: u8,
    block: u8,
    last_block: u8,
    timestamp: u32,
    payload: &'a [u8],
}

struct Depacketizer {
    next_frame: u32,
    last_stream_index: u32,
    waiting_for_idr: bool,
    last_idr_request_us: Option<u64>,
    keyframe: bool,
    last_payload_length: u16,
    host_latency: u16,
    timestamp: u32,
}

impl Depacketizer {
    fn new() -> Self {
        Self {
            next_frame: 1,
            last_stream_index: u32::MAX,
            waiting_for_idr: true,
            last_idr_request_us: None,
            keyframe: false,
            last_payload_length: 0,
            host_latency: 0,
            timestamp: 0,
        }
    }

    fn request_idr<E: Events>(&mut self, stats: &mut Stats, now_us: u64, events: &mut E) {
        let due = self
            .last_idr_request_us
            .is_none_or(|last| now_us.saturating_sub(last) >= IDR_RETRY_US);
        if due {
            self.last_idr_request_us = Some(now_us);
            stats.idr_requests += 1;
            events.request_idr();
        }
    }

    fn lose<E: Events>(
        &mut self,
        first: u32,
        last: u32,
        ring: &mut Ring,
        stats: &mut Stats,
        now_us: u64,
        events: &mut E,
    ) {
        ring.abandon();
        self.mark_lost(first, last, stats, now_us, events);
    }

    fn mark_lost<E: Events>(
        &mut self,
        first: u32,
        last: u32,
        stats: &mut Stats,
        now_us: u64,
        events: &mut E,
    ) {
        if !self.waiting_for_idr {
            self.waiting_for_idr = true;
            stats.frames_lost += u64::from(last.wrapping_sub(first)) + 1;
            events.frames_lost(first, last);
        }
        self.request_idr(stats, now_us, events);
    }

    /// notifyFrameLost from the FEC queue.
    fn lost<E: Events>(
        &mut self,
        frame: u32,
        ring: &mut Ring,
        stats: &mut Stats,
        now_us: u64,
        events: &mut E,
    ) {
        if !self.waiting_for_idr {
            self.next_frame = frame.wrapping_add(1);
        }
        self.lose(frame, frame, ring, stats, now_us, events);
    }

    #[allow(clippy::too_many_arguments)]
    fn packet<E: Events>(
        &mut self,
        packet: &Packet<'_>,
        format: Codec,
        ring: &mut Ring,
        clock: &mut Clock90k,
        stats: &mut Stats,
        now_us: u64,
        events: &mut E,
    ) {
        let frame = packet.frame;
        let flags = packet.flags;
        let first = {
            let f = flags & !FLAG_PIC;
            (f == FLAG_SOF | FLAG_EOF || f == FLAG_SOF) && packet.block == 0
        };
        let last = flags & FLAG_EOF != 0 && packet.block == packet.last_block;
        if before32(frame, self.next_frame) {
            return;
        }
        let expected = self.last_stream_index.wrapping_add(1) & 0xff_ffff;
        if before24(packet.stream_index, expected)
            || (flags & FLAG_SOF == 0 && packet.stream_index != expected)
        {
            self.next_frame = frame.wrapping_add(1);
            self.lose(frame, frame, ring, stats, now_us, events);
            return;
        }
        if first {
            if before32(self.next_frame, frame) {
                let missed = self.next_frame;
                self.lose(missed, frame.wrapping_sub(1), ring, stats, now_us, events);
            }
            self.next_frame = frame;
            self.keyframe = false;
            self.timestamp = packet.timestamp;
            ring.begin();
        }
        self.last_stream_index = packet.stream_index;
        if !ring.assembling {
            return;
        }

        let mut data = packet.payload;
        let mut header_bytes = 0;
        if first && !data.is_empty() {
            if data.len() >= 4 && data[3] == 2 {
                self.keyframe = true;
            }
            if data.len() >= 3 {
                self.host_latency = u16::from_le_bytes([data[1], data[2]]);
            }
            if format == Codec::Av1 && data.len() >= 6 {
                self.last_payload_length = u16::from_le_bytes([data[4], data[5]]);
            }
            header_bytes = if data[0] == 0x01 { 8 } else { 24 };
            if data.len() >= header_bytes {
                data = &data[header_bytes..];
            }
            if format != Codec::Av1 {
                data = strip_prefix_nals(format, data);
            }
        }
        if format != Codec::Av1 {
            if first {
                match nal_type(format, data) {
                    Some(t) if t == parameter_set_start(format) => self.keyframe = true,
                    Some(t) if t == picture_parameter_set(format) => data = skip_to_next_nal(data),
                    _ => {}
                }
            }
        } else if last {
            let total = self.last_payload_length as usize;
            if total > header_bytes && total - header_bytes <= data.len() {
                data = &data[..total - header_bytes];
            } else {
                self.next_frame = frame.wrapping_add(1);
                self.lose(frame, frame, ring, stats, now_us, events);
                return;
            }
        }
        match ring.append(data) {
            Append::Done => {}
            Append::Evicted(count) => {
                stats.stall_drops += count as u64;
                self.mark_lost(frame, frame, stats, now_us, events);
            }
            Append::TooBig => {
                stats.oversize += 1;
                self.next_frame = frame.wrapping_add(1);
                self.lose(frame, frame, ring, stats, now_us, events);
                return;
            }
        }

        if last {
            self.next_frame = frame.wrapping_add(1);
            if self.waiting_for_idr && !self.keyframe {
                stats.waiting_drops += 1;
                ring.abandon();
                self.request_idr(stats, now_us, events);
                return;
            }
            let meta = Meta {
                start: 0,
                length: 0,
                number: frame,
                rtp_timestamp: self.timestamp,
                pts_us: clock.micros(self.timestamp),
                keyframe: self.keyframe,
                received_us: now_us,
                host_latency: self.host_latency,
            };
            let evicted = ring.finish(meta);
            if evicted > 0 {
                stats.stall_drops += evicted as u64;
                if !self.keyframe {
                    ring.release_newest();
                    self.mark_lost(frame, frame, stats, now_us, events);
                    return;
                }
            }
            self.waiting_for_idr = false;
            stats.frames += 1;
            stats.keyframes += u64::from(self.keyframe);
        }
    }
}

fn annexb_start(data: &[u8]) -> Option<usize> {
    if data.len() <= 3 || data[0] != 0 || data[1] != 0 {
        return None;
    }
    match data[2] {
        0 if data.len() > 4 && data[3] == 1 => Some(4),
        1 => Some(3),
        _ => None,
    }
}

fn nal_type(format: Codec, data: &[u8]) -> Option<u8> {
    let start = annexb_start(data)?;
    let byte = data[start];
    Some(match format {
        Codec::H264 => byte & 0x1f,
        _ => (byte & 0x7e) >> 1,
    })
}

fn skip_to_next_nal(data: &[u8]) -> &[u8] {
    let mut data = match annexb_start(data) {
        Some(start) => &data[start..],
        None => data,
    };
    while !data.is_empty() && annexb_start(data).is_none() {
        data = &data[1..];
    }
    data
}

fn access_unit_delimiter(format: Codec) -> u8 {
    if format == Codec::H264 { 9 } else { 35 }
}

fn sei(format: Codec) -> u8 {
    if format == Codec::H264 { 6 } else { 39 }
}

fn parameter_set_start(format: Codec) -> u8 {
    if format == Codec::H264 { 7 } else { 32 }
}

fn picture_parameter_set(format: Codec) -> u8 {
    if format == Codec::H264 { 8 } else { 34 }
}

fn strip_prefix_nals(format: Codec, mut data: &[u8]) -> &[u8] {
    if annexb_start(data).is_none() {
        data = skip_to_next_nal(data);
    }
    if nal_type(format, data) == Some(access_unit_delimiter(format)) {
        data = skip_to_next_nal(data);
    }
    while nal_type(format, data) == Some(sei(format)) {
        data = skip_to_next_nal(data);
    }
    data
}

#[derive(Clone, Copy, Default)]
struct Meta {
    start: usize,
    length: usize,
    number: u32,
    rtp_timestamp: u32,
    pts_us: u64,
    keyframe: bool,
    received_us: u64,
    host_latency: u16,
}

enum Append {
    Done,
    Evicted(usize),
    TooBig,
}

/// Complete frames in arrival order plus the one being assembled, each contiguous.
struct Ring {
    bytes: Vec<u8>,
    ready: [Meta; READY_FRAMES],
    head: usize,
    count: usize,
    assembling: bool,
    start: usize,
    length: usize,
}

impl Ring {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: vec![0; capacity],
            ready: [Meta::default(); READY_FRAMES],
            head: 0,
            count: 0,
            assembling: false,
            start: 0,
            length: 0,
        }
    }

    fn newest(&self) -> Option<&Meta> {
        (self.count > 0).then(|| &self.ready[(self.head + self.count - 1) % READY_FRAMES])
    }

    fn begin(&mut self) {
        self.start = self.newest().map_or(0, |meta| meta.start + meta.length);
        self.length = 0;
        self.assembling = true;
    }

    fn abandon(&mut self) {
        self.assembling = false;
        self.length = 0;
    }

    fn limit(&self, from: usize) -> usize {
        (0..self.count)
            .map(|i| self.ready[(self.head + i) % READY_FRAMES].start)
            .filter(|&start| start >= from)
            .min()
            .unwrap_or(self.bytes.len())
    }

    fn flush(&mut self) -> usize {
        let count = self.count;
        self.count = 0;
        self.head = 0;
        count
    }

    fn append(&mut self, data: &[u8]) -> Append {
        let mut evicted = 0;
        loop {
            let end = self.start + self.length + data.len();
            if end <= self.limit(self.start) {
                self.bytes[self.start + self.length..end].copy_from_slice(data);
                self.length += data.len();
                return if evicted > 0 {
                    Append::Evicted(evicted)
                } else {
                    Append::Done
                };
            }
            let wrapped = self.length + data.len();
            if self.start > 0
                && self.limit(self.start) == self.bytes.len()
                && wrapped <= self.limit(0)
            {
                self.bytes
                    .copy_within(self.start..self.start + self.length, 0);
                self.start = 0;
                continue;
            }
            if self.count > 0 {
                evicted += self.flush();
                continue;
            }
            if self.start > 0 && wrapped <= self.bytes.len() {
                self.bytes
                    .copy_within(self.start..self.start + self.length, 0);
                self.start = 0;
                continue;
            }
            self.abandon();
            return Append::TooBig;
        }
    }

    /// Queues the assembled frame; returns how many older frames a full ring dropped.
    fn finish(&mut self, mut meta: Meta) -> usize {
        self.assembling = false;
        let evicted = if self.count == READY_FRAMES {
            self.flush()
        } else {
            0
        };
        meta.start = self.start;
        meta.length = self.length;
        let at = (self.head + self.count) % READY_FRAMES;
        self.ready[at] = meta;
        self.count += 1;
        evicted
    }

    fn release_newest(&mut self) {
        self.count = self.count.saturating_sub(1);
    }

    fn peek(&self) -> Option<Frame<'_>> {
        if self.count == 0 {
            return None;
        }
        let meta = &self.ready[self.head];
        Some(Frame {
            number: meta.number,
            rtp_timestamp: meta.rtp_timestamp,
            pts_us: meta.pts_us,
            keyframe: meta.keyframe,
            received_us: meta.received_us,
            host_latency: meta.host_latency,
            data: &self.bytes[meta.start..meta.start + meta.length],
        })
    }

    fn release(&mut self) {
        if self.count > 0 {
            self.head = (self.head + 1) % READY_FRAMES;
            self.count -= 1;
        }
    }
}
