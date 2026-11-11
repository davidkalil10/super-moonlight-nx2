//! The receive side of a `stream::Negotiated`: receiver configs for video and audio, and the
//! UDP pings Sunshine waits for before it sends to the port they came from.

use crate::{audio, stream::Negotiated, video};

pub const VIDEO_PORT: u16 = 47998;
pub const AUDIO_PORT: u16 = 48000;
pub const PING_PERIOD_US: u64 = 500_000;
/// Sunshine always encodes Opus at 48 kHz.
pub const AUDIO_SAMPLE_RATE: u32 = 48_000;

pub fn video_config(stream: &Negotiated, frame_bytes: usize) -> video::Config {
    video::Config {
        format: stream.codec,
        packet_size: usize::from(stream.packet_size),
        key: stream.video_encrypted().then_some(stream.key.key),
        frame_bytes,
    }
}

pub fn audio_config(stream: &Negotiated) -> audio::Config {
    audio::Config {
        key: stream.audio_encrypted().then_some(stream.key.key),
        key_id: stream.key.key_id,
        packet_duration_ms: u32::from(stream.audio.packet_duration_ms),
    }
}

/// Samples per channel in one audio packet.
pub fn audio_frame_samples(stream: &Negotiated) -> usize {
    (AUDIO_SAMPLE_RATE / 1000) as usize * usize::from(stream.audio.packet_duration_ms)
}

/// The periodic ping: payload then a big-endian count from 1, or "PING".
pub struct Ping {
    payload: Option<[u8; 16]>,
    count: u32,
    due_us: u64,
}

impl Ping {
    pub fn new(payload: Option<[u8; 16]>) -> Self {
        Self {
            payload,
            count: 0,
            due_us: 0,
        }
    }

    /// The datagram to send now, if one is due.
    pub fn poll(&mut self, now_us: u64, out: &mut [u8; 20]) -> Option<usize> {
        if now_us < self.due_us {
            return None;
        }
        self.due_us = now_us.saturating_add(PING_PERIOD_US);
        Some(self.write(out))
    }

    fn write(&mut self, out: &mut [u8; 20]) -> usize {
        match self.payload {
            Some(payload) => {
                self.count = self.count.wrapping_add(1);
                out[..16].copy_from_slice(&payload);
                out[16..].copy_from_slice(&self.count.to_be_bytes());
                20
            }
            None => {
                out[..4].copy_from_slice(b"PING");
                4
            }
        }
    }
}
