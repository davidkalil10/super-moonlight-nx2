//! Once-a-second figures for the console hop, written to the host log.

use std::time::{Duration, Instant};

const PERIOD: Duration = Duration::from_secs(1);

#[derive(Default)]
struct Second {
    offered: u32,
    dropped: u32,
    sent: u32,
    acknowledged: u32,
    lost: u32,
    idr_requests: u32,
    bytes: u64,
    acknowledgement_ms: Vec<f64>,
}

#[derive(Default)]
struct AudioSecond {
    sent: u32,
    acknowledged: u32,
    dropped_before: u64,
}

pub struct RelayStats {
    started: Option<Instant>,
    second: Second,
    audio: AudioSecond,
}

impl RelayStats {
    pub fn new() -> Self {
        Self {
            started: None,
            second: Second::default(),
            audio: AudioSecond::default(),
        }
    }

    /// One access unit reached the send queue and `discarded` queued ones left it unsent.
    pub fn offered(&mut self, discarded: usize) {
        self.second.offered += 1;
        self.second.dropped += discarded as u32;
    }

    pub fn sent(&mut self, bytes: usize) {
        self.second.sent += 1;
        self.second.bytes += bytes as u64;
    }

    pub fn acknowledged(&mut self, elapsed: Duration) {
        self.second.acknowledged += 1;
        self.second
            .acknowledgement_ms
            .push(elapsed.as_secs_f64() * 1000.0);
    }

    pub fn lost(&mut self) {
        self.second.lost += 1;
    }

    pub fn idr_requested(&mut self) {
        self.second.idr_requests += 1;
    }

    pub fn audio_sent(&mut self) {
        self.audio.sent += 1;
    }

    pub fn audio_acknowledged(&mut self) {
        self.audio.acknowledged += 1;
    }

    /// The audio line for the second `line` just closed. `dropped` is the count of chunks
    /// discarded since the stream began because the console took them too slowly.
    pub fn audio_line(&mut self, dropped: u64, queued: usize) -> String {
        let line = format!(
            "relay: audio sent={} acked={} dropped={} queued={queued}",
            self.audio.sent,
            self.audio.acknowledged,
            dropped - self.audio.dropped_before,
        );
        self.audio = AudioSecond {
            dropped_before: dropped,
            ..AudioSecond::default()
        };
        line
    }

    /// The closed second's line, at most once a second.
    pub fn line(&mut self, now: Instant, window: usize, queued: usize) -> Option<String> {
        let started = *self.started.get_or_insert(now);
        if now.saturating_duration_since(started) < PERIOD {
            return None;
        }
        self.started = Some(now);
        let mut second = std::mem::take(&mut self.second);
        second.acknowledgement_ms.sort_by(f64::total_cmp);
        let samples = &second.acknowledgement_ms;
        let at = |share: f64| {
            samples
                .get(((samples.len() as f64 * share).ceil() as usize).saturating_sub(1))
                .copied()
                .unwrap_or(0.0)
        };
        Some(format!(
            "relay: offered={} sent={} acked={} dropped={} lost={} idr={} kbps={} ack_ms p50={:.1} p90={:.1} max={:.1} window={window} queued={queued}",
            second.offered,
            second.sent,
            second.acknowledged,
            second.dropped,
            second.lost,
            second.idr_requests,
            second.bytes * 8 / 1000,
            at(0.5),
            at(0.9),
            at(1.0),
        ))
    }
}

impl Default for RelayStats {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_is_reported_once_and_then_starts_over() {
        let start = Instant::now();
        let mut stats = RelayStats::new();
        assert_eq!(stats.line(start, 3, 0), None);
        for sample in [4, 8, 40] {
            stats.offered(0);
            stats.sent(125_000);
            stats.acknowledged(Duration::from_millis(sample));
        }
        stats.offered(2);
        stats.lost();
        stats.idr_requested();
        assert_eq!(stats.line(start + Duration::from_millis(999), 3, 1), None);
        assert_eq!(
            stats.line(start + PERIOD, 3, 1).unwrap(),
            "relay: offered=4 sent=3 acked=3 dropped=2 lost=1 idr=1 kbps=3000 ack_ms p50=8.0 p90=40.0 max=40.0 window=3 queued=1"
        );
        assert_eq!(stats.line(start + PERIOD + PERIOD / 2, 3, 0), None);
        assert_eq!(
            stats.line(start + PERIOD * 2, 2, 0).unwrap(),
            "relay: offered=0 sent=0 acked=0 dropped=0 lost=0 idr=0 kbps=0 ack_ms p50=0.0 p90=0.0 max=0.0 window=2 queued=0"
        );
    }

    #[test]
    fn the_audio_line_counts_each_second_on_its_own() {
        let mut stats = RelayStats::new();
        for _ in 0..3 {
            stats.audio_sent();
        }
        stats.audio_acknowledged();
        assert_eq!(
            stats.audio_line(40, 2),
            "relay: audio sent=3 acked=1 dropped=40 queued=2"
        );
        stats.audio_sent();
        assert_eq!(
            stats.audio_line(45, 0),
            "relay: audio sent=1 acked=0 dropped=5 queued=0"
        );
    }
}
