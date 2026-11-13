//! Per-second stream pacing shared between the runtime and the in-stream overlay.

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamStats {
    pub window_ms: u32,
    pub fps_x10: u32,
    pub decode_mean_us: u32,
    pub decode_max_us: u32,
    pub latency_mean_us: u32,
    pub latency_max_us: u32,
    pub input_mean_us: u32,
    pub input_max_us: u32,
    pub presented: u32,
    pub dropped: u32,
    pub idr_requests: u32,
    pub frames_skipped: u32,
    /// Mean host processing the PC reported with its frames, 0 when it reported none.
    pub host_mean_us: u32,
    /// Presented frames whose last packet's arrival is known.
    pub received: u32,
    /// Mean from a frame's last packet being read until its unit went to the decoder.
    pub receive_mean_us: u32,
    /// Mean from a unit's submission until the decoder handed its frame back.
    pub decoder_mean_us: u32,
    /// Mean from a decoded frame until its present returned.
    pub display_mean_us: u32,
}

/// The time the presented frames of a window spent in each stage, summed on one ns clock.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stages {
    pub frames: u32,
    pub received: u32,
    receive_ns: u64,
    decode_ns: u64,
    display_ns: u64,
}

impl Stages {
    /// One presented frame. `received_ns` is None when its arrival is unknown; an arrival
    /// after the submission is left out rather than counted as no wait.
    pub fn record(
        &mut self,
        received_ns: Option<u64>,
        submitted_ns: u64,
        decoded_ns: u64,
        presented_ns: u64,
    ) {
        self.frames = self.frames.saturating_add(1);
        self.decode_ns += decoded_ns.saturating_sub(submitted_ns);
        self.display_ns += presented_ns.saturating_sub(decoded_ns);
        if let Some(waited_ns) = received_ns.and_then(|received| submitted_ns.checked_sub(received))
        {
            self.received = self.received.saturating_add(1);
            self.receive_ns += waited_ns;
        }
    }

    pub fn receive_mean_us(&self) -> Option<u32> {
        mean_us(self.receive_ns, self.received)
    }

    pub fn decode_mean_us(&self) -> Option<u32> {
        mean_us(self.decode_ns, self.frames)
    }

    pub fn display_mean_us(&self) -> Option<u32> {
        mean_us(self.display_ns, self.frames)
    }
}

fn mean_us(sum_ns: u64, count: u32) -> Option<u32> {
    sum_ns
        .checked_div(u64::from(count))
        .map(|mean_ns| u32::try_from(mean_ns / 1000).unwrap_or(u32::MAX))
}
