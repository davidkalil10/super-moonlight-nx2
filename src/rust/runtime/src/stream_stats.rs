use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use moonlight_nx2_core::stats::StreamStats;

const FIELDS: usize = 10;

static VALID: AtomicBool = AtomicBool::new(false);
static ZERO_COPY: AtomicBool = AtomicBool::new(false);
static LATEST: [AtomicU32; FIELDS] = [const { AtomicU32::new(0) }; FIELDS];
static SAMPLED_NS: AtomicU64 = AtomicU64::new(0);
static INPUT_SUM_US: AtomicU64 = AtomicU64::new(0);
static INPUT_COUNT: AtomicU32 = AtomicU32::new(0);
static INPUT_MAX_US: AtomicU32 = AtomicU32::new(0);

pub fn latest() -> Option<StreamStats> {
    if !VALID.load(Ordering::Acquire) {
        return None;
    }
    let field = |index: usize| LATEST[index].load(Ordering::Relaxed);
    Some(StreamStats {
        window_ms: field(0),
        fps_x10: field(1),
        decode_mean_us: field(2),
        decode_max_us: field(3),
        latency_mean_us: field(4),
        latency_max_us: field(5),
        input_mean_us: field(6),
        input_max_us: field(7),
        presented: field(8),
        dropped: field(9),
        zero_copy: ZERO_COPY.load(Ordering::Relaxed),
    })
}

pub fn publish(stats: StreamStats) {
    let fields = [
        stats.window_ms,
        stats.fps_x10,
        stats.decode_mean_us,
        stats.decode_max_us,
        stats.latency_mean_us,
        stats.latency_max_us,
        stats.input_mean_us,
        stats.input_max_us,
        stats.presented,
        stats.dropped,
    ];
    for (slot, value) in LATEST.iter().zip(fields) {
        slot.store(value, Ordering::Relaxed);
    }
    ZERO_COPY.store(stats.zero_copy, Ordering::Relaxed);
    VALID.store(true, Ordering::Release);
}

pub fn clear() {
    VALID.store(false, Ordering::Release);
    take_input();
}

pub fn input_sampled(now_ns: u64) {
    SAMPLED_NS.store(now_ns, Ordering::Relaxed);
}

pub fn input_sent(now_ns: u64) {
    let sampled = SAMPLED_NS.load(Ordering::Relaxed);
    if sampled == 0 {
        return;
    }
    let age_us = u32::try_from(now_ns.saturating_sub(sampled) / 1000).unwrap_or(u32::MAX);
    INPUT_SUM_US.fetch_add(u64::from(age_us), Ordering::Relaxed);
    INPUT_COUNT.fetch_add(1, Ordering::Relaxed);
    INPUT_MAX_US.fetch_max(age_us, Ordering::Relaxed);
}

pub fn take_input() -> (u32, u32) {
    let sum = INPUT_SUM_US.swap(0, Ordering::Relaxed);
    let count = INPUT_COUNT.swap(0, Ordering::Relaxed);
    let max = INPUT_MAX_US.swap(0, Ordering::Relaxed);
    let mean = sum.checked_div(u64::from(count)).unwrap_or(0);
    (u32::try_from(mean).unwrap_or(u32::MAX), max)
}
