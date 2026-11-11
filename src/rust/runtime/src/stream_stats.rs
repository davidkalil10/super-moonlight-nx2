//! Latest `StreamStats`, input age, per-stage times and the pending IDR request, published by
//! the video path for the frontend to read each frame.

extern crate alloc;

use alloc::{format, string::String};
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use moonlight_nx2_core::stats::StreamStats;

const FIELDS: usize = 12;

static VALID: AtomicBool = AtomicBool::new(false);
static IDR_WANTED: AtomicBool = AtomicBool::new(false);
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
        idr_requests: field(10),
        frames_skipped: field(11),
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
        stats.idr_requests,
        stats.frames_skipped,
    ];
    for (slot, value) in LATEST.iter().zip(fields) {
        slot.store(value, Ordering::Relaxed);
    }
    VALID.store(true, Ordering::Release);
}

pub fn clear() {
    VALID.store(false, Ordering::Release);
    IDR_WANTED.store(false, Ordering::Release);
    take_input();
    take_stages();
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

/// Where a frame's time goes between its unit arriving and its present returning.
#[derive(Clone, Copy)]
pub enum Stage {
    /// Handing one unit to the decoder.
    Submit,
    /// One decoder poll, with or without a frame.
    Poll,
    /// From a unit's submission until its frame is taken; a multiple of the loop period.
    Output,
    /// Copying a decoded frame out of the decoder's image.
    Readback,
    /// Putting a frame in the renderer's upload slot.
    Upload,
    /// One present call.
    Present,
}

const STAGES: usize = 6;

#[derive(Clone, Copy, Default)]
pub struct StageTime {
    pub count: u32,
    pub mean_us: u32,
    pub max_us: u32,
}

struct StageTotal {
    sum_us: AtomicU64,
    count: AtomicU32,
    max_us: AtomicU32,
}

static READBACK_SUM_US: AtomicU64 = AtomicU64::new(0);
static READBACK_COUNT: AtomicU32 = AtomicU32::new(0);

static STAGE_TOTALS: [StageTotal; STAGES] = [const {
    StageTotal {
        sum_us: AtomicU64::new(0),
        count: AtomicU32::new(0),
        max_us: AtomicU32::new(0),
    }
}; STAGES];

pub fn stage(stage: Stage, started_ns: u64, ended_ns: u64) {
    let elapsed_us = u32::try_from(ended_ns.saturating_sub(started_ns) / 1000).unwrap_or(u32::MAX);
    let total = &STAGE_TOTALS[stage as usize];
    total
        .sum_us
        .fetch_add(u64::from(elapsed_us), Ordering::Relaxed);
    total.count.fetch_add(1, Ordering::Relaxed);
    total.max_us.fetch_max(elapsed_us, Ordering::Relaxed);
    if matches!(stage, Stage::Readback) {
        READBACK_SUM_US.fetch_add(u64::from(elapsed_us), Ordering::Relaxed);
        READBACK_COUNT.fetch_add(1, Ordering::Relaxed);
    }
}

/// The mean readback time since the last call, kept apart from the session totals the stream
/// report takes. None when no frame was read back.
pub fn take_readback_mean_us() -> Option<u32> {
    let sum = READBACK_SUM_US.swap(0, Ordering::Relaxed);
    let count = READBACK_COUNT.swap(0, Ordering::Relaxed);
    sum.checked_div(u64::from(count))
        .map(|mean| u32::try_from(mean).unwrap_or(u32::MAX))
}

/// The stage times since the last call, in `Stage` order.
pub fn take_stages() -> [StageTime; STAGES] {
    core::array::from_fn(|index| {
        let total = &STAGE_TOTALS[index];
        let sum_us = total.sum_us.swap(0, Ordering::Relaxed);
        let count = total.count.swap(0, Ordering::Relaxed);
        let mean_us = sum_us.checked_div(u64::from(count)).unwrap_or(0);
        StageTime {
            count,
            mean_us: u32::try_from(mean_us).unwrap_or(u32::MAX),
            max_us: total.max_us.swap(0, Ordering::Relaxed),
        }
    })
}

/// The stage times since the last call, as the text of a log line.
pub fn take_stages_text() -> String {
    let [submit, poll, output, readback, upload, present] =
        take_stages().map(|stage| format!("{}x{}/{}", stage.count, stage.mean_us, stage.max_us));
    format!(
        "stages count x mean/max us submit={submit} poll={poll} output={output} readback={readback} upload={upload} present={present}"
    )
}

static WAKE_SUM_US: AtomicU64 = AtomicU64::new(0);
static WAKE_MAX_US: AtomicU32 = AtomicU32::new(0);
static WAKE_HITS: AtomicU32 = AtomicU32::new(0);
static WAKE_MISSES: AtomicU32 = AtomicU32::new(0);
static WAKE_BUDGET_SUM_US: AtomicU64 = AtomicU64::new(0);

/// One wait of a turn for its unit's frame: how long, out of what budget, and whether the
/// frame came.
pub fn wake(waited_ns: u64, budget_ns: u64, hit: bool) {
    let waited_us = u32::try_from(waited_ns / 1000).unwrap_or(u32::MAX);
    WAKE_SUM_US.fetch_add(u64::from(waited_us), Ordering::Relaxed);
    WAKE_MAX_US.fetch_max(waited_us, Ordering::Relaxed);
    WAKE_BUDGET_SUM_US.fetch_add(budget_ns / 1000, Ordering::Relaxed);
    if hit {
        WAKE_HITS.fetch_add(1, Ordering::Relaxed);
    } else {
        WAKE_MISSES.fetch_add(1, Ordering::Relaxed);
    }
}

/// The waits since the last call as a log line, None when the turns did not wait.
pub fn take_wake_text() -> Option<String> {
    let hits = WAKE_HITS.swap(0, Ordering::Relaxed);
    let misses = WAKE_MISSES.swap(0, Ordering::Relaxed);
    let sum = WAKE_SUM_US.swap(0, Ordering::Relaxed);
    let max = WAKE_MAX_US.swap(0, Ordering::Relaxed);
    let budget = WAKE_BUDGET_SUM_US.swap(0, Ordering::Relaxed);
    let count = u64::from(hits + misses);
    (count != 0).then(|| {
        format!(
            "wake count x mean/max us waited={count}x{}/{max} budget_mean={} hits={hits} misses={misses}",
            sum / count,
            budget / count
        )
    })
}

pub fn request_idr() {
    IDR_WANTED.store(true, Ordering::Release);
}

pub fn take_idr_request() -> bool {
    IDR_WANTED.swap(false, Ordering::AcqRel)
}
