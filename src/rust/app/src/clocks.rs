//! Stream clocks: the CPU, GPU and memory rates each stream mode starts at, and the governor
//! that raises one of them a notch when the stream falls behind. Rates only go up during a
//! stream; the runtime puts the system's own rates back when the stream ends.

pub const CPU: usize = 0;
pub const GPU: usize = 1;
pub const EMC: usize = 2;
pub const CLOCKS: usize = 3;
pub const NAMES: [&str; CLOCKS] = ["cpu", "gpu", "emc"];

/// Seconds in a row the stream has to fall behind before a clock goes up.
pub const BEHIND_SECONDS: u32 = 3;
/// A second falls behind when more than one frame in this many was late, dropped, missed its
/// wake or was refused by the decoder.
pub const BEHIND_ONE_IN: u64 = 10;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub docked: bool,
}

impl Mode {
    fn tier(self) -> usize {
        let pixels = u64::from(self.width) * u64::from(self.height) * u64::from(self.fps);
        match pixels {
            0..=62_208_000 => 0,
            62_208_001..=124_416_000 => 1,
            124_416_001..=248_832_000 => 2,
            _ => 3,
        }
    }
}

/// Rates in MHz by pixel rate: up to 1080p30, 1080p60, 4K30 or 1440p60, and above.
const HANDHELD: [[u32; CLOCKS]; 4] = [
    [614, 230, 1065],
    [714, 307, 1331],
    [816, 384, 1600],
    [1020, 460, 2133],
];
/// Docked, the GPU and the memory also carry the TV output, up to 4K.
const DOCKED: [[u32; CLOCKS]; 4] = [
    [614, 307, 1600],
    [714, 384, 2133],
    [816, 460, 2665],
    [1020, 614, 3200],
];

/// The rates, in MHz, a stream of this mode starts at.
pub fn plan(mode: Mode) -> [u32; CLOCKS] {
    if mode.docked {
        DOCKED[mode.tier()]
    } else {
        HANDHELD[mode.tier()]
    }
}

/// The lowest rate that is at least `target_hz`, from the clock's discrete `rates`, never above
/// the system's `stock_hz`. Without a list the target is used as it is.
pub fn snap(target_hz: u32, stock_hz: u32, rates: &[u32]) -> u32 {
    if rates.is_empty() {
        return target_hz.min(stock_hz);
    }
    rates
        .iter()
        .copied()
        .filter(|&rate| rate >= target_hz && rate <= stock_hz)
        .min()
        .unwrap_or(stock_hz)
}

/// The next rate above `current_hz`, up to `stock_hz`. Without a list it is an eighth of the
/// stock rate higher. None once the clock is back at its stock rate.
pub fn notch_up(current_hz: u32, stock_hz: u32, rates: &[u32]) -> Option<u32> {
    if current_hz >= stock_hz {
        return None;
    }
    if rates.is_empty() {
        return Some(current_hz.saturating_add(stock_hz / 8).min(stock_hz));
    }
    Some(
        rates
            .iter()
            .copied()
            .filter(|&rate| rate > current_hz && rate <= stock_hz)
            .min()
            .unwrap_or(stock_hz),
    )
}

/// The clock to raise: the one furthest below its stock rate, memory first on a tie, since
/// the decoder, the readback and the GPU all share it. None when every clock is at stock.
pub fn pick(current_hz: [u32; CLOCKS], stock_hz: [u32; CLOCKS]) -> Option<usize> {
    [EMC, CPU, GPU]
        .into_iter()
        .filter(|&clock| current_hz[clock] < stock_hz[clock])
        .min_by_key(|&clock| {
            u64::from(current_hz[clock]) * 1000 / u64::from(stock_hz[clock].max(1))
        })
}

/// Running totals of the stream's trouble counters.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Signals {
    pub late: u64,
    pub dropped: u64,
    pub refused: u64,
    pub wake_misses: u64,
}

impl Signals {
    fn total(self) -> u64 {
        self.late + self.dropped + self.refused + self.wake_misses
    }

    pub fn since(self, earlier: Signals) -> Signals {
        Signals {
            late: self.late.saturating_sub(earlier.late),
            dropped: self.dropped.saturating_sub(earlier.dropped),
            refused: self.refused.saturating_sub(earlier.refused),
            wake_misses: self.wake_misses.saturating_sub(earlier.wake_misses),
        }
    }

    fn add(self, other: Signals) -> Signals {
        Signals {
            late: self.late + other.late,
            dropped: self.dropped + other.dropped,
            refused: self.refused + other.refused,
            wake_misses: self.wake_misses + other.wake_misses,
        }
    }
}

/// Watches the trouble counters once a second.
#[derive(Default)]
pub struct Governor {
    last: Option<Signals>,
    behind: u32,
    window: Signals,
}

impl Governor {
    /// Takes this second's totals. Some(the trouble of the seconds behind) when a clock
    /// should go up now; the count starts over after each step.
    pub fn second(&mut self, totals: Signals, fps: u32) -> Option<Signals> {
        let Some(last) = self.last.replace(totals) else {
            return None;
        };
        let second = totals.since(last);
        if second.total() * BEHIND_ONE_IN > u64::from(fps.max(1)) {
            self.behind += 1;
            self.window = self.window.add(second);
        } else {
            self.behind = 0;
            self.window = Signals::default();
        }
        if self.behind < BEHIND_SECONDS {
            return None;
        }
        self.behind = 0;
        Some(core::mem::take(&mut self.window))
    }
}
