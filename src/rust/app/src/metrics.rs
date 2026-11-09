//! Stream metrics: frame rate, receive-to-present time and the rate badge (port of Civ7
//! frame-rate.js and rate-badge.js).
//!
//! [`Metrics`] takes the stream's [`Sample`]s and closes a [`Second`] once a second: the frame
//! counter line's figures, the console's receive-to-present time and, apart from it, the
//! network round trip the PC reports. [`FrameRateGuard`] and [`select_frame_rate`] are the
//! high-rate session decisions. The text helpers build badge strings byte for byte as the JS
//! does, into fixed [`Line`]s. Everything is bounded and allocates nothing.

use core::fmt::Write;

pub use moonlight_nx2_ui::badge::{
    Line, NOTE_MS, SHOW_MS, STAYS, TOUCH_NOTE, counter_text, rate_text,
};

/// One counter window, as the PC's civ7-stats interval.
pub const WINDOW_US: u64 = 1_000_000;
/// A presented share of the rate below this is too slow (frame-rate.js `RATE_MARGIN`).
pub const RATE_MARGIN: f64 = 0.9;
/// A loop block busy for this share of its time is saturated (frame-rate.js `BUSY_SHARE`).
pub const BUSY_SHARE: f64 = 0.9;
/// Presented frames a measurement needs (frame-rate.js `MEASUREMENT_FLOOR`).
pub const MEASUREMENT_FLOOR: u32 = 12;
/// `Number.MAX_SAFE_INTEGER`: the guard refuses counters past it, as the JS did.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// The largest µs a loop block word carries (video-stream.js `micro`).
pub const WORD_MAX_US: u64 = 0xffff_fffe;

const SEPARATOR: &str = " \u{b7} ";
const ARROW: &str = " \u{25b8} ";

/// `Math.round`: the nearest integer, halves toward +infinity, in f64.
fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value.abs() >= 4_503_599_627_370_496.0 {
        return value;
    }

    let whole = value as i64 as f64;
    let fraction = value - whole;
    if fraction >= 0.5 {
        whole + 1.0
    } else if fraction < -0.5 {
        whole - 1.0
    } else {
        whole
    }
}

/// latency.js `round`: `Math.round(value * 100)` hundredths.
fn hundredths(value: f64) -> f64 {
    js_round(value * 100.0)
}

/// "AV1 ▸ H.264": what was asked for, then what runs.
pub fn change_text(from: &str, to: &str) -> Line {
    let mut out = Line::new();
    let _ = write!(out, "{from}{ARROW}{to}");
    out
}

/// Several changes on one badge, joined by " · ". Text past the line's capacity is cut at a
/// character boundary.
pub fn badge_text(changes: &[&str]) -> Line {
    let mut out = Line::new();
    for (index, change) in changes.iter().enumerate() {
        if index > 0 {
            out.push_str(SEPARATOR);
        }
        out.push_str(change);
    }
    out
}

/// One stream event the runtime reports to [`Metrics::record`].
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Sample {
    /// A video unit arrived from the PC.
    UnitReceived { bytes: u32 },
    /// A unit decoded but skipped to catch up.
    FrameSkipped,
    /// A frame's present returned; `received_us` is its unit's arrival on the same clock.
    FramePresented { received_us: u64, presented_us: u64 },
    /// The cumulative count of units dropped before decode, as reported.
    DroppedTotal(u32),
    /// The network round trip the PC measured; never mixed into receive-to-present.
    NetworkRtt { rtt_us: u32 },
}

/// Mean and max ms from a unit's arrival to its present, in hundredths of a ms as latency.js
/// rounds them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReceiveToPresent {
    pub mean_centis: u32,
    pub max_centis: u32,
}

impl ReceiveToPresent {
    /// The counter's figure: `Math.round(mean)`.
    pub fn mean_ms(&self) -> u32 {
        js_round(f64::from(self.mean_centis) / 100.0) as u32
    }
}

/// One closed counter window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Second {
    pub elapsed_us: u64,
    pub units: u32,
    pub bytes: u64,
    pub presented: u32,
    pub caught_up: u32,
    pub dropped_total: u32,
    /// None when no frame of the window was timed.
    pub receive_to_present: Option<ReceiveToPresent>,
    /// The last round trip the PC reported, kept across windows.
    pub network_rtt_us: Option<u32>,
}

impl Second {
    /// The console figure for `ui::badge::Controller::stats`: -1 shows a dash.
    pub fn console_ms(&self) -> i64 {
        self.receive_to_present
            .map_or(-1, |latency| i64::from(latency.mean_ms()))
    }
}

/// What [`Metrics::tick`] closed: the window and whether the counter line changed with it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Report {
    pub second: Second,
    pub line_changed: bool,
}

/// The frame counter line and its state (the quad badge's `observe` in rate-badge.js):
/// drops since the previous second and the last console figure.
#[derive(Clone, Copy, Debug)]
pub struct Counter {
    line: Line,
    dropped: i64,
    console_ms: i64,
}

impl Counter {
    pub fn new() -> Self {
        Self {
            line: counter_text(-1, -1, -1, -1),
            dropped: 0,
            console_ms: -1,
        }
    }

    /// The line before the first second is all dashes.
    pub fn line(&self) -> &str {
        self.line.as_str()
    }

    /// Takes one second; true when the line changed. A dropped total below the previous one
    /// (a reset or a u32 wrap) counts as no drops and becomes the new base, as the JS did.
    pub fn observe(&mut self, second: &Second) -> bool {
        self.console_ms = second.console_ms();
        let total = i64::from(second.dropped_total);
        let dropped = total.saturating_sub(self.dropped).max(0);
        self.dropped = total;

        let line = counter_text(
            i64::from(second.presented),
            i64::from(second.caught_up),
            dropped,
            self.console_ms,
        );
        if line == self.line {
            return false;
        }
        self.line = line;
        true
    }
}

impl Default for Counter {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Window {
    units: u32,
    bytes: u64,
    presented: u32,
    caught_up: u32,
    timed: u32,
    sum_us: u64,
    max_us: u64,
}

impl Window {
    /// The loop block's figures: sums past a u32 word saturate as video-stream.js `micro` does.
    fn receive_to_present(&self) -> Option<ReceiveToPresent> {
        if self.timed == 0 {
            return None;
        }

        let sum_ms = self.sum_us.min(WORD_MAX_US) as f64 / 1000.0;
        let max_ms = self.max_us.min(WORD_MAX_US) as f64 / 1000.0;
        Some(ReceiveToPresent {
            mean_centis: hundredths(sum_ms / f64::from(self.timed)) as u32,
            max_centis: hundredths(max_ms) as u32,
        })
    }
}

/// Per-second stream metrics on one monotonic µs clock.
///
/// A tick before the window's start (a clock rollback) discards the open window and starts a
/// new one there. A tick a second or more after the start closes one window over the whole gap,
/// as a late PC timer did. A present that returned before its unit arrived counts as presented
/// but its time is dropped. Window counts saturate.
#[derive(Clone, Copy, Debug)]
pub struct Metrics {
    started_us: u64,
    window: Window,
    dropped_total: u32,
    network_rtt_us: Option<u32>,
    counter: Counter,
}

impl Metrics {
    pub fn new(now_us: u64) -> Self {
        Self {
            started_us: now_us,
            window: Window::default(),
            dropped_total: 0,
            network_rtt_us: None,
            counter: Counter::new(),
        }
    }

    pub fn record(&mut self, sample: Sample) {
        let window = &mut self.window;
        match sample {
            Sample::UnitReceived { bytes } => {
                window.units = window.units.saturating_add(1);
                window.bytes = window.bytes.saturating_add(u64::from(bytes));
            }
            Sample::FrameSkipped => window.caught_up = window.caught_up.saturating_add(1),
            Sample::FramePresented {
                received_us,
                presented_us,
            } => {
                window.presented = window.presented.saturating_add(1);
                if let Some(latency) = presented_us.checked_sub(received_us) {
                    window.timed = window.timed.saturating_add(1);
                    window.sum_us = window.sum_us.saturating_add(latency);
                    window.max_us = window.max_us.max(latency);
                }
            }
            Sample::DroppedTotal(total) => self.dropped_total = total,
            Sample::NetworkRtt { rtt_us } => self.network_rtt_us = Some(rtt_us),
        }
    }

    /// Replaces only upstream RTT knowledge, without resetting the local counter window.
    pub fn set_network_rtt(&mut self, rtt_us: Option<u32>) {
        self.network_rtt_us = rtt_us;
    }

    /// Counts every actual presentation; an unknown arrival contributes no latency sample.
    pub fn presented(&mut self, received_us: Option<u64>, presented_us: u64) {
        if let Some(received_us) = received_us {
            self.record(Sample::FramePresented {
                received_us,
                presented_us,
            });
        } else {
            self.window.presented = self.window.presented.saturating_add(1);
        }
    }

    /// Closes the window once a second has passed since it started.
    pub fn tick(&mut self, now_us: u64) -> Option<Report> {
        let Some(elapsed_us) = now_us.checked_sub(self.started_us) else {
            self.restart(now_us);
            return None;
        };
        if elapsed_us < WINDOW_US {
            return None;
        }

        let window = &self.window;
        let second = Second {
            elapsed_us,
            units: window.units,
            bytes: window.bytes,
            presented: window.presented,
            caught_up: window.caught_up,
            dropped_total: self.dropped_total,
            receive_to_present: window.receive_to_present(),
            network_rtt_us: self.network_rtt_us,
        };
        let line_changed = self.counter.observe(&second);
        self.restart(now_us);
        Some(Report {
            second,
            line_changed,
        })
    }

    pub fn counter(&self) -> &Counter {
        &self.counter
    }

    fn restart(&mut self, now_us: u64) {
        self.started_us = now_us;
        self.window = Window::default();
    }
}

/// A presentation measurement before a high-rate session.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Measurement {
    pub frames: u32,
    pub elapsed_us: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Selection {
    pub requested_fps: u32,
    pub effective_fps: u32,
    pub measured_fps: Option<f64>,
    /// The JS `reason: 'presentation-capacity'`: the console presents below the request.
    pub capacity_limited: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SelectError {
    /// The rate is outside 1..=120.
    InvalidRate,
    /// Fewer than 12 frames, or no elapsed time.
    InvalidMeasurement,
    /// The console presents below 90% of 30 fps.
    TooSlow,
}

fn valid_rate(fps: u32) -> bool {
    (1..=120).contains(&fps)
}

/// frame-rate.js `selectFrameRate`: the request when the console keeps up with it, else the
/// highest of 60 and 30 below it that it does keep up with.
pub fn select_frame_rate(
    requested_fps: u32,
    measurement: Option<Measurement>,
) -> Result<Selection, SelectError> {
    if !valid_rate(requested_fps) {
        return Err(SelectError::InvalidRate);
    }
    let Some(Measurement { frames, elapsed_us }) = measurement else {
        return Ok(Selection {
            requested_fps,
            effective_fps: requested_fps,
            measured_fps: None,
            capacity_limited: false,
        });
    };
    if frames < MEASUREMENT_FLOOR || elapsed_us == 0 {
        return Err(SelectError::InvalidMeasurement);
    }

    let elapsed_ms = elapsed_us as f64 / 1000.0;
    let measured = f64::from(frames) * 1000.0 / elapsed_ms;
    let keeps_up = |rate: u32| measured >= f64::from(rate) * RATE_MARGIN;
    let effective_fps = if keeps_up(requested_fps) {
        requested_fps
    } else {
        [60, 30]
            .into_iter()
            .find(|rate| *rate < requested_fps && keeps_up(*rate))
            .ok_or(SelectError::TooSlow)?
    };
    Ok(Selection {
        requested_fps,
        effective_fps,
        measured_fps: Some(measured),
        capacity_limited: effective_fps != requested_fps,
    })
}

/// The console's loop block of a second: busy and elapsed ms.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LoopShare {
    pub busy_ms: f64,
    pub elapsed_ms: f64,
}

/// One second for the guard; the counters are cumulative.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GuardSample {
    pub at_ms: u64,
    pub presented: u64,
    pub dropped: u64,
    pub idr_requests: u64,
    pub queue_age_ms: f64,
    pub acknowledgement_ms: f64,
    pub console_unit_ms: Option<f64>,
    pub console: Option<LoopShare>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Limit {
    /// The console's busy time per unit exceeds the frame period.
    Console,
    Transport,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ConsoleCost {
    pub unit_ms: f64,
    pub limit: Limit,
}

/// A sustained overload: end this session and run the next at 60.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Overload {
    pub from: u32,
    pub to: u32,
    pub measured_fps: f64,
    pub elapsed_ms: u64,
    pub dropped: u64,
    pub idr_requests: u64,
    pub starved_ms: u64,
    pub console: Option<ConsoleCost>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GuardError {
    InvalidRate,
    InvalidWindow,
    /// A negative or non-finite time, or a counter past `MAX_SAFE_INTEGER`; nothing changed.
    InvalidSample,
}

#[derive(Clone, Copy, Debug, Default)]
struct Short {
    ms: u64,
    frames: u64,
    drops: u64,
    idrs: u64,
}

impl Short {
    fn add(&mut self, other: &Short) {
        self.ms = self.ms.saturating_add(other.ms);
        self.frames = self.frames.saturating_add(other.frames);
        self.drops = self.drops.saturating_add(other.drops);
        self.idrs = self.idrs.saturating_add(other.idrs);
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Previous {
    at_ms: u64,
    presented: u64,
    dropped: u64,
    idr_requests: u64,
}

/// frame-rate.js `createFrameRateGuard`: watches a session above 60 fps and recommends one
/// fall back to 60 after `sustained_ms` of overloaded short seconds.
///
/// A second whose time or counters went backwards (clock rollback, reset or wrapped counters),
/// that came under 250 ms or over 2500 ms after the previous one, or that kept up, restarts
/// the window. Console unit costs use constant storage even when a loop block is delayed.
#[derive(Clone, Copy, Debug)]
pub struct FrameRateGuard {
    fps: u32,
    started_at_ms: u64,
    warmup_ms: u64,
    sustained_ms: u64,
    previous: Previous,
    bad: Short,
    bad_unit_sum: Option<f64>,
    bad_units: u32,
    pending: Short,
    pending_unit_sum: Option<f64>,
    pending_count: u32,
    starved_ms: u64,
    recommended: bool,
}

impl FrameRateGuard {
    /// The JS defaults: 1500 ms warm-up, 3000 ms sustained.
    pub fn new(fps: u32, started_at_ms: u64) -> Result<Self, GuardError> {
        Self::with_window(fps, started_at_ms, 1500, 3000)
    }

    pub fn with_window(
        fps: u32,
        started_at_ms: u64,
        warmup_ms: u64,
        sustained_ms: u64,
    ) -> Result<Self, GuardError> {
        if !valid_rate(fps) {
            return Err(GuardError::InvalidRate);
        }
        if sustained_ms < 1000 {
            return Err(GuardError::InvalidWindow);
        }
        Ok(Self {
            fps,
            started_at_ms,
            warmup_ms,
            sustained_ms,
            previous: Previous {
                at_ms: started_at_ms,
                ..Previous::default()
            },
            bad: Short::default(),
            bad_unit_sum: Some(0.0),
            bad_units: 0,
            pending: Short::default(),
            pending_unit_sum: Some(0.0),
            pending_count: 0,
            starved_ms: 0,
            recommended: false,
        })
    }

    pub fn observe(&mut self, sample: &GuardSample) -> Result<Option<Overload>, GuardError> {
        let counters = [sample.presented, sample.dropped, sample.idr_requests];
        let times = [sample.queue_age_ms, sample.acknowledgement_ms];
        if counters.iter().any(|value| *value > MAX_SAFE_INTEGER)
            || times.iter().any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(GuardError::InvalidSample);
        }

        let previous = self.previous;
        let warmed_up = previous.at_ms >= self.started_at_ms.saturating_add(self.warmup_ms);
        self.previous = Previous {
            at_ms: sample.at_ms,
            presented: sample.presented,
            dropped: sample.dropped,
            idr_requests: sample.idr_requests,
        };
        if self.fps <= 60 || self.recommended {
            return Ok(None);
        }

        let deltas = (
            sample.at_ms.checked_sub(previous.at_ms),
            sample.presented.checked_sub(previous.presented),
            sample.dropped.checked_sub(previous.dropped),
            sample.idr_requests.checked_sub(previous.idr_requests),
        );
        let (Some(ms), Some(frames), Some(drops), Some(idrs)) = deltas else {
            self.reset();
            return Ok(None);
        };
        if !warmed_up || !(250..=2500).contains(&ms) {
            self.reset();
            return Ok(None);
        }

        let fps = f64::from(self.fps);
        let measured = frames as f64 * 1000.0 / ms as f64;
        let frame_ms = 1000.0 / fps;
        let pressure = drops >= 2
            || idrs > 0
            || sample.queue_age_ms > frame_ms * 2.0
            || sample.acknowledgement_ms > frame_ms * 4.0;
        if measured >= fps * RATE_MARGIN || !pressure {
            self.reset();
            return Ok(None);
        }

        self.pending.add(&Short {
            ms,
            frames,
            drops,
            idrs,
        });
        if let Some(unit_ms) = sample.console_unit_ms.filter(|value| value.is_finite()) {
            self.pending_unit_sum = finite_sum(self.pending_unit_sum, Some(unit_ms));
            if let Some(count) = self.pending_count.checked_add(1) {
                self.pending_count = count;
            } else {
                self.pending_unit_sum = None;
            }
        }
        if let Some(share) = sample.console {
            self.settle(share);
        }
        if self.bad.ms < self.sustained_ms {
            return Ok(None);
        }

        self.recommended = true;
        Ok(Some(Overload {
            from: self.fps,
            to: 60,
            measured_fps: self.bad.frames as f64 * 1000.0 / self.bad.ms as f64,
            elapsed_ms: self.bad.ms,
            dropped: self.bad.drops,
            idr_requests: self.bad.idrs,
            starved_ms: self.starved_ms,
            console: self.console_cost(frame_ms),
        }))
    }

    /// Short seconds wait for the next loop block; its idle share says overloaded or starved.
    fn settle(&mut self, share: LoopShare) {
        if share.busy_ms >= share.elapsed_ms * BUSY_SHARE {
            self.bad.add(&self.pending);
            self.bad_unit_sum = finite_sum(self.bad_unit_sum, self.pending_unit_sum);
            if let Some(count) = self.bad_units.checked_add(self.pending_count) {
                self.bad_units = count;
            } else {
                self.bad_unit_sum = None;
            }
        } else {
            self.starved_ms = self.starved_ms.saturating_add(self.pending.ms);
        }
        self.pending = Short::default();
        self.pending_unit_sum = Some(0.0);
        self.pending_count = 0;
    }

    fn console_cost(&self, frame_ms: f64) -> Option<ConsoleCost> {
        if self.bad_units == 0 {
            return None;
        }

        let mean = self.bad_unit_sum? / f64::from(self.bad_units);
        let unit_ms = if mean.abs() >= 4_503_599_627_370_496.0 {
            mean
        } else {
            hundredths(mean) / 100.0
        };
        let limit = if unit_ms > frame_ms {
            Limit::Console
        } else {
            Limit::Transport
        };
        Some(ConsoleCost { unit_ms, limit })
    }

    fn reset(&mut self) {
        self.bad = Short::default();
        self.bad_unit_sum = Some(0.0);
        self.bad_units = 0;
        self.pending = Short::default();
        self.pending_unit_sum = Some(0.0);
        self.pending_count = 0;
    }
}

fn finite_sum(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    let sum = left? + right?;
    sum.is_finite().then_some(sum)
}
