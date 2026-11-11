//! Sunshine's RTP audio stream, ported from moonlight-common-c's RtpAudioQueue and
//! AudioStream: Opus packets in FEC blocks of four data and two parity shards with a fixed
//! parity matrix, then AES-128-CBC per packet when SS_ENC_AUDIO is on. Fixed block pool.

use aes::{
    Aes128,
    cipher::{BlockCipherDecrypt, KeyInit},
};

use crate::rs::{self, Code, Workspace};
use crate::rtp::{self, before16};

pub const DATA_SHARDS: usize = 4;
pub const FEC_SHARDS: usize = 2;
pub const MAX_DATAGRAM: usize = 1400;
pub const MAX_PAYLOAD: usize = MAX_DATAGRAM - rtp::FIXED_HEADER_BYTES;
pub const FEC_HEADER_BYTES: usize = 12;
pub const PAYLOAD_AUDIO: u8 = 97;
pub const PAYLOAD_FEC: u8 = 127;
pub const PARITY_ROWS: [u8; 8] = [0x77, 0x40, 0x38, 0x0e, 0xc7, 0xa7, 0x0d, 0x6c];

const SHARDS: usize = DATA_SHARDS + FEC_SHARDS;
const BLOCKS: usize = 16;
const INITIAL_DROP_MS: u32 = 500;
const OOS_WAIT_US: u64 = 10_000;
/// Whole blocks lost up to this many packets play as concealment; longer gaps are skipped.
const CONCEALED_GAP: usize = 4 * DATA_SHARDS;

#[derive(Clone, Copy)]
pub struct Config {
    /// rikey, when Sunshine encrypts audio (SS_ENC_AUDIO).
    pub key: Option<[u8; 16]>,
    /// rikeyid; packet IVs start from it.
    pub key_id: u32,
    /// `x-nv-aqos.packetDuration`, normally 5.
    pub packet_duration_ms: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Config,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub packets: u64,
    pub invalid: u64,
    pub fec_packets: u64,
    pub out_of_order: u64,
    pub fec_recovered: u64,
    pub lost: u64,
    pub skipped: u64,
    pub undecryptable: u64,
    pub resync_drops: u64,
}

/// One packet in stream order.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Packet {
    /// Opus bytes written to the front of the output buffer.
    Opus {
        sequence: u16,
        timestamp: u32,
        length: usize,
    },
    /// A packet that never arrived and could not be rebuilt: conceal it.
    Lost { sequence: u16 },
}

#[derive(Clone, Copy, Default)]
struct Block {
    base: u16,
    timestamp: u32,
    size: usize,
    missing: [bool; SHARDS],
    data_received: u8,
    fec_received: u8,
    complete: bool,
    next: u8,
    discontinuity: bool,
    queued_us: u64,
}

pub struct Receiver {
    cipher: Option<Aes128>,
    key_id: u32,
    duration_ms: u32,
    scratch: [u8; MAX_DATAGRAM + 1],
    storage: alloc::vec::Vec<u8>,
    blocks: [Block; BLOCKS],
    order: [u8; BLOCKS],
    used: usize,
    code: Code,
    workspace: Workspace,
    next_sequence: u16,
    oldest_base: u16,
    last_oos: u16,
    out_of_order: bool,
    synchronizing: bool,
    to_drop: u32,
    stats: Stats,
}

const BLOCK_BYTES: usize = SHARDS * MAX_PAYLOAD;

impl Receiver {
    pub fn new(config: Config) -> Result<Self, Error> {
        if !(1..=100).contains(&config.packet_duration_ms) {
            return Err(Error::Config);
        }
        let code = Code::with_parity_rows(DATA_SHARDS, FEC_SHARDS, &PARITY_ROWS)
            .map_err(|_| Error::Config)?;
        Ok(Self {
            cipher: config.key.map(|key| Aes128::new(&key.into())),
            key_id: config.key_id,
            duration_ms: config.packet_duration_ms,
            scratch: [0; MAX_DATAGRAM + 1],
            storage: alloc::vec![0; BLOCKS * BLOCK_BYTES],
            blocks: [Block::default(); BLOCKS],
            order: [0; BLOCKS],
            used: 0,
            code,
            workspace: Workspace::new(),
            next_sequence: 0,
            oldest_base: 0,
            last_oos: 0,
            out_of_order: false,
            synchronizing: true,
            to_drop: INITIAL_DROP_MS / config.packet_duration_ms,
            stats: Stats::default(),
        })
    }

    /// Where the next datagram goes; one byte longer than the largest valid one.
    pub fn buffer(&mut self) -> &mut [u8] {
        &mut self.scratch
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// Takes the `length` bytes just received into `buffer`.
    pub fn commit(&mut self, length: usize, now_us: u64) {
        let Some(header) = (length <= MAX_DATAGRAM)
            .then(|| rtp::Header::parse(&self.scratch[..length]))
            .flatten()
        else {
            self.stats.invalid += 1;
            return;
        };
        let body = header.length..length;
        if self.to_drop > 0 {
            if header.payload_type == PAYLOAD_AUDIO {
                self.stats.packets += 1;
                self.to_drop -= 1;
            }
            self.stats.resync_drops += 1;
            return;
        }
        let (base, timestamp, size, shard) = match header.payload_type {
            PAYLOAD_AUDIO => {
                self.stats.packets += 1;
                let seq = header.sequence;
                if !self.synchronizing && before16(seq, self.oldest_base) {
                    self.last_oos = seq;
                    self.out_of_order = true;
                    self.stats.out_of_order += 1;
                } else if self.out_of_order && before16(self.oldest_base, self.last_oos) {
                    self.out_of_order = false;
                }
                let base = seq - seq % DATA_SHARDS as u16;
                let offset = u32::from(seq.wrapping_sub(base)) * self.duration_ms;
                (
                    base,
                    header.timestamp.wrapping_sub(offset),
                    body.len(),
                    (seq - base) as usize,
                )
            }
            PAYLOAD_FEC => {
                self.stats.fec_packets += 1;
                let Some(fec) = self.scratch.get(body.start..body.start + FEC_HEADER_BYTES) else {
                    self.stats.invalid += 1;
                    return;
                };
                let index = fec[0] as usize;
                let base = u16::from_be_bytes([fec[2], fec[3]]);
                let timestamp = u32::from_be_bytes([fec[4], fec[5], fec[6], fec[7]]);
                if index >= FEC_SHARDS || !(base as usize).is_multiple_of(DATA_SHARDS) {
                    self.stats.invalid += 1;
                    return;
                }
                let size = body.len() - FEC_HEADER_BYTES;
                (base, timestamp, size, DATA_SHARDS + index)
            }
            _ => return,
        };
        if size == 0 || size > MAX_PAYLOAD {
            self.stats.invalid += 1;
            return;
        }
        if self.synchronizing && self.oldest_base == 0 {
            self.oldest_base = base.wrapping_add(DATA_SHARDS as u16);
            self.next_sequence = self.oldest_base;
            return;
        }
        if before16(base, self.oldest_base) {
            return;
        }
        let Some(block) = self.block_for(base, timestamp, size, now_us) else {
            return;
        };
        if !self.blocks[block].missing[shard] {
            return;
        }
        let start = if shard < DATA_SHARDS {
            body.start
        } else {
            body.start + FEC_HEADER_BYTES
        };
        let at = block * BLOCK_BYTES + shard * MAX_PAYLOAD;
        self.storage[at..at + size].copy_from_slice(&self.scratch[start..start + size]);
        let entry = &mut self.blocks[block];
        entry.missing[shard] = false;
        if shard < DATA_SHARDS {
            entry.data_received += 1;
        } else {
            entry.fec_received += 1;
        }
        self.complete(block);
    }

    fn block_for(&mut self, base: u16, timestamp: u32, size: usize, now_us: u64) -> Option<usize> {
        let mut position = self.used;
        for i in 0..self.used {
            let index = self.order[i] as usize;
            let block = &self.blocks[index];
            if block.base == base {
                if block.size != size {
                    self.stats.invalid += 1;
                    return None;
                }
                return (!block.complete).then_some(index);
            }
            if before16(base, block.base) {
                position = i;
                break;
            }
        }
        if self.used == BLOCKS {
            if position == 0 {
                return None;
            }
            self.skip_head();
            position -= 1;
        }
        let free = (0..BLOCKS)
            .find(|candidate| !self.order[..self.used].contains(&(*candidate as u8)))
            .expect("a free block");
        self.order.copy_within(position..self.used, position + 1);
        self.order[position] = free as u8;
        self.used += 1;
        self.blocks[free] = Block {
            base,
            timestamp,
            size,
            missing: [true; SHARDS],
            queued_us: now_us,
            ..Block::default()
        };
        Some(free)
    }

    fn complete(&mut self, block: usize) {
        let entry = self.blocks[block];
        if entry.complete || usize::from(entry.data_received + entry.fec_received) < DATA_SHARDS {
            return;
        }
        if usize::from(entry.data_received) == DATA_SHARDS {
            self.blocks[block].complete = true;
            return;
        }
        let at = block * BLOCK_BYTES;
        let region = &mut self.storage[at..at + BLOCK_BYTES];
        let mut shards: [&mut [u8]; SHARDS] = {
            let mut chunks = region.as_chunks_mut::<MAX_PAYLOAD>().0.iter_mut();
            core::array::from_fn(|_| {
                let chunk = chunks.next().expect("six shards");
                &mut chunk[..entry.size]
            })
        };
        let present = entry.missing.map(|missing| !missing);
        let mut slices = rs::Slices {
            shards: &mut shards,
            present: &present,
        };
        if self.workspace.reconstruct(&self.code, &mut slices).is_ok() {
            let recovered = DATA_SHARDS - usize::from(entry.data_received);
            self.stats.fec_recovered += recovered as u64;
            let block = &mut self.blocks[block];
            block.missing[..DATA_SHARDS].fill(false);
            block.complete = true;
        }
    }

    fn skip_head(&mut self) {
        let head = self.order[0] as usize;
        let block = self.blocks[head];
        let left = block.missing[usize::from(block.next)..DATA_SHARDS]
            .iter()
            .filter(|m| **m)
            .count();
        self.stats.lost += left as u64;
        self.free_head();
    }

    fn free_head(&mut self) {
        let head = self.order[0] as usize;
        self.order.copy_within(1..self.used, 0);
        self.used -= 1;
        self.oldest_base = self.blocks[head].base.wrapping_add(DATA_SHARDS as u16);
        if before16(self.next_sequence, self.oldest_base) {
            self.next_sequence = self.oldest_base;
        }
        self.synchronizing = false;
    }

    /// The next packet in order, decrypted into `out`, or None while the head is still
    /// waiting for data or FEC. `out` must hold MAX_PAYLOAD bytes.
    pub fn next(&mut self, now_us: u64, out: &mut [u8]) -> Option<Packet> {
        loop {
            if self.used == 0 {
                return None;
            }
            let head = self.order[0] as usize;
            let block = self.blocks[head];
            if before16(self.next_sequence, block.base) {
                let gap = block.base.wrapping_sub(self.next_sequence);
                self.oldest_base = block.base;
                if usize::from(gap) <= CONCEALED_GAP {
                    let sequence = self.next_sequence;
                    self.next_sequence = sequence.wrapping_add(1);
                    self.stats.lost += 1;
                    return Some(Packet::Lost { sequence });
                }
                self.stats.skipped += u64::from(gap);
                self.next_sequence = block.base;
            }
            let index = self.next_sequence.wrapping_sub(block.base) as usize;
            if index >= DATA_SHARDS {
                self.free_head();
                continue;
            }
            let sequence = self.next_sequence;
            if !block.missing[index] {
                self.advance(head, index);
                let size = block.size;
                let timestamp = block
                    .timestamp
                    .wrapping_add(index as u32 * self.duration_ms);
                out[..size].copy_from_slice(
                    &self.storage[head * BLOCK_BYTES + index * MAX_PAYLOAD..][..size],
                );
                return match self.decrypt(sequence, &mut out[..size]) {
                    Some(length) => Some(Packet::Opus {
                        sequence,
                        timestamp,
                        length,
                    }),
                    None => {
                        self.stats.undecryptable += 1;
                        Some(Packet::Lost { sequence })
                    }
                };
            }
            if !block.discontinuity {
                let timeout = u64::from(self.duration_ms) * DATA_SHARDS as u64 * 1000 + OOS_WAIT_US;
                let later = self.used > 1;
                let waited = now_us.saturating_sub(block.queued_us) > timeout;
                if !later || (self.out_of_order && !waited) {
                    return None;
                }
                self.blocks[head].discontinuity = true;
            }
            self.stats.lost += 1;
            self.advance(head, index);
            return Some(Packet::Lost { sequence });
        }
    }

    fn advance(&mut self, head: usize, index: usize) {
        self.next_sequence = self.next_sequence.wrapping_add(1);
        self.blocks[head].next = index as u8 + 1;
        if index + 1 == DATA_SHARDS {
            self.free_head();
        }
    }

    fn decrypt(&self, sequence: u16, data: &mut [u8]) -> Option<usize> {
        let Some(cipher) = &self.cipher else {
            return Some(data.len());
        };
        if data.is_empty() || data.len() % 16 != 0 {
            return None;
        }
        let mut previous = [0u8; 16];
        previous[..4].copy_from_slice(&self.key_id.wrapping_add(u32::from(sequence)).to_be_bytes());
        for chunk in data.as_chunks_mut::<16>().0 {
            let cipher_block = *chunk;
            let mut block = aes::Block::from(cipher_block);
            cipher.decrypt_block(&mut block);
            for (byte, (plain, prev)) in chunk.iter_mut().zip(block.iter().zip(previous)) {
                *byte = plain ^ prev;
            }
            previous = cipher_block;
        }
        let pad = *data.last()? as usize;
        if pad == 0 || pad > 16 || data[data.len() - pad..].iter().any(|b| *b as usize != pad) {
            return None;
        }
        Some(data.len() - pad)
    }
}
