//! Latest `StreamStats`, input age, per-stage times and the pending IDR request, published by
//! the video path for the frontend to read each frame.

extern crate alloc;

use alloc::{format, string::String};
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use crate::perf::Path;
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
    let elapsed_ns = ended_ns.saturating_sub(started_ns);
    let site = match stage {
        Stage::Submit => Some(Site::Submit),
        Stage::Poll => Some(Site::Poll),
        Stage::Readback => Some(Site::Readback),
        Stage::Upload => Some(Site::Upload),
        Stage::Output | Stage::Present => None,
    };
    if let Some(site) = site
        && elapsed_ns > frame_ns().unwrap_or(FRAME_DEFAULT_NS)
    {
        overrun(site, elapsed_ns);
    }
    let elapsed_us = u32::try_from(elapsed_ns / 1000).unwrap_or(u32::MAX);
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

static DECODER_PATH: AtomicU32 = AtomicU32::new(0);
static DECODER_SUBMITS: AtomicU32 = AtomicU32::new(0);
static DECODER_BUSY: AtomicU32 = AtomicU32::new(0);
static DECODER_FRAMES: AtomicU32 = AtomicU32::new(0);
static DECODER_ERRORS: AtomicU32 = AtomicU32::new(0);
static DECODE_SUM_US: AtomicU64 = AtomicU64::new(0);
static DECODE_MAX_US: AtomicU32 = AtomicU32::new(0);
static IN_FLIGHT_SUM: AtomicU32 = AtomicU32::new(0);
static IN_FLIGHT_COUNT: AtomicU32 = AtomicU32::new(0);
static IN_FLIGHT_MAX: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Copy)]
pub enum DecoderEvent {
    Submit,
    Busy,
    Error,
}

/// The decode path the counters below belong to, set when a decoder opens.
pub fn decoder_path(path: Path) {
    DECODER_PATH.store(path as u32, Ordering::Relaxed);
}

pub fn decoder(event: DecoderEvent) {
    let counter = match event {
        DecoderEvent::Submit => &DECODER_SUBMITS,
        DecoderEvent::Busy => &DECODER_BUSY,
        DecoderEvent::Error => &DECODER_ERRORS,
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

/// A frame first seen finished, `decode_ns` after its unit was submitted.
pub fn decoded(decode_ns: u64) {
    let decode_us = u32::try_from(decode_ns / 1000).unwrap_or(u32::MAX);
    DECODER_FRAMES.fetch_add(1, Ordering::Relaxed);
    DECODE_SUM_US.fetch_add(u64::from(decode_us), Ordering::Relaxed);
    DECODE_MAX_US.fetch_max(decode_us, Ordering::Relaxed);
}

/// How many units the decoder holds right after one went in, the new one included.
pub fn in_flight(units: usize) {
    let units = u32::try_from(units).unwrap_or(u32::MAX);
    IN_FLIGHT_SUM.fetch_add(units, Ordering::Relaxed);
    IN_FLIGHT_COUNT.fetch_add(1, Ordering::Relaxed);
    IN_FLIGHT_MAX.fetch_max(units, Ordering::Relaxed);
}

/// The decoder counters since the last call as a log line, None when nothing was submitted.
pub fn take_decoder_text() -> Option<String> {
    let submits = DECODER_SUBMITS.swap(0, Ordering::Relaxed);
    let busy = DECODER_BUSY.swap(0, Ordering::Relaxed);
    let frames = DECODER_FRAMES.swap(0, Ordering::Relaxed);
    let errors = DECODER_ERRORS.swap(0, Ordering::Relaxed);
    let sum = DECODE_SUM_US.swap(0, Ordering::Relaxed);
    let max = DECODE_MAX_US.swap(0, Ordering::Relaxed);
    let depth_sum = IN_FLIGHT_SUM.swap(0, Ordering::Relaxed);
    let depth_count = IN_FLIGHT_COUNT.swap(0, Ordering::Relaxed);
    let depth_max = IN_FLIGHT_MAX.swap(0, Ordering::Relaxed);
    let depth_x10 = (depth_sum * 10).checked_div(depth_count).unwrap_or(0);
    let path = match DECODER_PATH.load(Ordering::Relaxed) {
        path if path == Path::Copy as u32 => Path::Copy,
        path if path == Path::InPlace as u32 => Path::InPlace,
        _ => Path::Sdk,
    };
    (submits + busy + frames + errors != 0).then(|| {
        format!(
            "decoder path={path:?} submits={submits} busy={busy} frames={frames} errors={errors} decode mean/max us={}/{max} in_flight mean/max={}.{}/{depth_max}",
            sum.checked_div(u64::from(frames)).unwrap_or(0),
            depth_x10 / 10,
            depth_x10 % 10
        )
    })
}

/// A blocking call of the stream that took longer than a frame.
#[derive(Clone, Copy, Debug)]
pub enum Site {
    Submit,
    Poll,
    Readback,
    Upload,
    /// The present's wait for a flight of the GPU.
    Flight,
    /// The present's wait for a swapchain image.
    Acquire,
}

const SITES: usize = 6;
const SITE_NAMES: [&str; SITES] = ["submit", "poll", "readback", "upload", "flight", "acquire"];
/// The frame overruns are measured against before the display's rate is known.
const FRAME_DEFAULT_NS: u64 = 16_666_667;

static FRAME_NS: AtomicU64 = AtomicU64::new(0);
static OVERRUNS: [AtomicU32; SITES] = [const { AtomicU32::new(0) }; SITES];
static OVERRUN_MAX_US: [AtomicU32; SITES] = [const { AtomicU32::new(0) }; SITES];

/// The display's refresh, which bounds the stream's waits. 0 leaves it unknown.
pub fn set_refresh_hz(hz: u32) {
    let frame_ns = 1_000_000_000u64.checked_div(u64::from(hz)).unwrap_or(0);
    FRAME_NS.store(frame_ns, Ordering::Relaxed);
}

/// One refresh of the display, None until the display reported its rate.
pub fn frame_ns() -> Option<u64> {
    Some(FRAME_NS.load(Ordering::Relaxed)).filter(|frame_ns| *frame_ns != 0)
}

pub fn overrun(site: Site, took_ns: u64) {
    let took_us = u32::try_from(took_ns / 1000).unwrap_or(u32::MAX);
    OVERRUNS[site as usize].fetch_add(1, Ordering::Relaxed);
    OVERRUN_MAX_US[site as usize].fetch_max(took_us, Ordering::Relaxed);
}

/// The overruns since the last call by site, as count/longest ms, None when there were none.
pub fn take_overruns_text() -> Option<String> {
    let mut text = String::new();
    for (site, name) in SITE_NAMES.iter().enumerate() {
        let count = OVERRUNS[site].swap(0, Ordering::Relaxed);
        let max_us = OVERRUN_MAX_US[site].swap(0, Ordering::Relaxed);
        if count != 0 {
            text.push_str(&format!(" {name}={count}/{}", max_us.div_ceil(1000)));
        }
    }
    (!text.is_empty()).then(|| format!("overruns count/max_ms{text}"))
}
