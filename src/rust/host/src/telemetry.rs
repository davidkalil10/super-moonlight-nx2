use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RttLine {
    event: String,
    ms: u32,
    #[serde(rename = "varianceMs")]
    deviation: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QualityLine {
    event: String,
    status: String,
}

pub(crate) enum Observation {
    Rtt(u32, u32),
    Quality(Quality),
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Quality {
    Unknown,
    Poor,
}

pub(crate) fn parse(line: &[u8]) -> Option<Observation> {
    if let Ok(value) = serde_json::from_slice::<RttLine>(line)
        && value.event == "rtt"
    {
        return Some(Observation::Rtt(value.ms, value.deviation));
    }
    let value: QualityLine = serde_json::from_slice(line).ok()?;
    if value.event != "connection-status" {
        return None;
    }
    match value.status.as_str() {
        "poor" => Some(Observation::Quality(Quality::Poor)),
        "okay" => Some(Observation::Quality(Quality::Unknown)),
        _ => None,
    }
}

#[derive(Serialize)]
pub(crate) struct Snapshot {
    event: &'static str,
    start_id: u32,
    sequence: u32,
    rtt_ms: Option<u32>,
    rtt_deviation_ms: Option<u32>,
    connection: Quality,
}

pub(crate) struct Producer {
    start_id: u32,
    sequence: u32,
    next: Option<Instant>,
    rtt: Option<(u32, u32, Instant)>,
    quality: Quality,
}

impl Producer {
    pub(crate) fn new(start_id: u32) -> Self {
        Self {
            start_id,
            sequence: 0,
            next: None,
            rtt: None,
            quality: Quality::Unknown,
        }
    }

    pub(crate) fn observe(&mut self, observation: Observation, now: Instant) {
        match observation {
            Observation::Rtt(ms, deviation) => self.rtt = Some((ms, deviation, now)),
            Observation::Quality(quality) => self.quality = quality,
        }
    }

    pub(crate) fn snapshot(&mut self, now: Instant) -> Option<Snapshot> {
        if self.next.is_some_and(|next| now < next) {
            return None;
        }
        let sequence = self.sequence.checked_add(1)?;
        self.sequence = sequence;
        self.next = Some(now + Duration::from_secs(1));
        let rtt = self.rtt.filter(|(_, _, observed)| {
            now.saturating_duration_since(*observed) < Duration::from_secs(3)
        });
        Some(Snapshot {
            event: "upstream_status",
            start_id: self.start_id,
            sequence,
            rtt_ms: rtt.map(|(ms, _, _)| ms),
            rtt_deviation_ms: rtt.map(|(_, deviation, _)| deviation),
            connection: self.quality,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_exhaustion_stops_advisory_without_wrapping() {
        let now = Instant::now();
        let mut producer = Producer::new(7);
        producer.sequence = u32::MAX - 1;
        assert_eq!(producer.snapshot(now).unwrap().sequence, u32::MAX);
        assert!(producer.snapshot(now + Duration::from_secs(1)).is_none());
        assert!(producer.snapshot(now + Duration::from_secs(10)).is_none());
    }
}
