//! Adaptive bitrate policy: port of Civ7 bitrate-adaptation.js and the `--bitrate-scale` rule of
//! its `sessionBitrate`. moonlight-common-c fixes the bitrate per session, so the JS ended a
//! session after a sustained bad window and relaunched Auto at a session-only scale.
//!
//! This policy is pure and bounded: fed one stats sample per second, it only recommends. Control-v1
//! has no bitrate-change or scale operation, so acting on a [`Decision::Reconfigure`] means an
//! explicit stop and a new start through the controller's usual gates, with the start options'
//! bitrate from [`scaled_bitrate`]. Saved settings stay Auto; the scale lives here, per launch.

/// Stats seconds after each session start that are not judged, for the startup keyframe burst.
pub const WARMUP_SECONDS: u32 = 5;
/// Rolling window of judged seconds.
pub const WINDOW_SECONDS: usize = 10;
/// Bad seconds within the window that step the bitrate down, once per launch.
pub const BAD_SECONDS_TO_STEP_DOWN: u32 = 6;
/// Access units dropped in one second that make it bad.
pub const BAD_DROPS_PER_SECOND: u64 = 5;
/// Host queue age, in frame times, that makes a second bad.
pub const BAD_QUEUE_AGE_FRAMES: f64 = 3.0;
/// Estimated round trip that makes a second bad.
pub const BAD_RTT_MS: u32 = 80;
/// A second above 60 fps presenting below this share of the rate is the frame-rate guard's.
pub const PRESENTATION_SHARE: f64 = 0.9;
pub const STEP_DOWN_FACTOR: f64 = 0.75;
pub const FLOOR_KBPS: u32 = 5000;
pub const STEP_KBPS: u32 = 100;
/// Consecutive clean seconds on a lowered bitrate before the one step up.
pub const CLEAN_SECONDS_TO_STEP_UP: u32 = 120;
/// Stats seconds of a launch, warmups included, between two recommendations.
pub const HOLD_OFF_SECONDS: u64 = 60;
/// Distinct frame rates whose unscaled Auto bitrate is remembered; the oldest is forgotten.
pub const MAX_RATES: usize = 8;

/// Auto defaults are whole Mbps, which recovers one from a scaled session bitrate.
const AUTO_STEP_KBPS: f64 = 1000.0;
const FULL_SCALE: f64 = 1.0;

/// session/bitrate.js Auto table, interpolated by pixel count and scaled for rate/codec.
/// This computes a session value only; codec, size and cadence still require evidence.
pub fn auto_bitrate(width: u32, height: u32, fps: u32, codec: crate::request::Codec) -> u32 {
    const TABLE: [(u64, f64); 6] = [
        (640 * 360, 1.0),
        (854 * 480, 2.0),
        (1280 * 720, 5.0),
        (1920 * 1080, 10.0),
        (2560 * 1440, 20.0),
        (3840 * 2160, 40.0),
    ];
    let pixels = u64::from(width) * u64::from(height);
    let mut factor = 40.0;
    for (index, (limit, value)) in TABLE.iter().enumerate() {
        if pixels > *limit {
            continue;
        }
        factor = if index == 0 || pixels == *limit {
            *value
        } else {
            let (lower, base) = TABLE[index - 1];
            (pixels - lower) as f64 / (*limit - lower) as f64 * (*value - base) + base
        };
        break;
    }
    let linear = if fps <= 60 {
        f64::from(fps)
    } else {
        sqrt(f64::from(fps) / 60.0) * 60.0
    };
    let share = if codec == crate::request::Codec::Av1 {
        0.7
    } else {
        1.0
    };
    (round(factor * (linear / 30.0) * share) as u32).saturating_mul(1000)
}

fn sqrt(value: f64) -> f64 {
    let mut estimate = value.max(1.0);
    for _ in 0..32 {
        estimate = (estimate + value / estimate) * 0.5;
    }
    estimate
}

/// One civ7-stats second. `dropped` and `idr_requests` are cumulative for the session; a value
/// below the previous one is taken as a counter restart, as the JS did.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Stats {
    pub presented: u32,
    pub dropped: u64,
    pub idr_requests: u64,
    pub queue_age_ms: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Direction {
    Down,
    Up,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reason {
    /// Enough bad seconds in the window; steps the scale down once per launch.
    SustainedLoss,
    /// A long clean streak on a lowered scale; steps back up once per launch.
    CleanStretch,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SustainedLoss => "sustained-loss",
            Self::CleanStretch => "clean-stretch",
        }
    }

    pub fn direction(self) -> Direction {
        match self {
            Self::SustainedLoss => Direction::Down,
            Self::CleanStretch => Direction::Up,
        }
    }
}

/// A recommended reconfiguration, with the JS decision's figures.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reconfigure {
    pub reason: Reason,
    pub from_kbps: u32,
    /// The scaled Auto bitrate for the session's rate; another rate uses [`scaled_bitrate`].
    pub bitrate_kbps: u32,
    /// The new session-only factor on Auto, in (0, 1]; the JS passed it as `--bitrate-scale`.
    pub scale: f64,
    pub fps: u32,
    pub bad_seconds: u32,
    pub window_seconds: u32,
    pub clean_seconds: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Decision {
    /// Keep streaming as configured.
    Keep,
    /// The session should end and the next one start at the new scale. The policy has committed
    /// the scale and stops judging this session until [`Policy::start_session`].
    Reconfigure(Reconfigure),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScaleError {
    /// A scale applies to Auto only; a manual bitrate is never adapted.
    NeedsAuto,
    /// The scale is not in (0, 1].
    OutOfRange,
}

/// `scaledBitrate`: the Auto default scaled down in 100 kbps steps, never below the 5 Mbps floor
/// unless Auto itself is lower. A scale of 1 or more keeps Auto; a NaN or negative scale gives
/// the floor, where the JS gave NaN.
pub fn scaled_bitrate(auto_kbps: u32, scale: f64) -> u32 {
    if scale >= FULL_SCALE {
        return auto_kbps;
    }

    let step = f64::from(STEP_KBPS);
    let lowered = floor(f64::from(auto_kbps) * scale / step) * step;
    auto_kbps.min(FLOOR_KBPS).max(lowered as u32)
}

/// `sessionBitrate` after `--bitrate` resolved to `kbps`: an optional scale needs Auto and a
/// factor in (0, 1].
pub fn session_bitrate(
    kbps: u32,
    bitrate_auto: bool,
    scale: Option<f64>,
) -> Result<u32, ScaleError> {
    let Some(scale) = scale else {
        return Ok(kbps);
    };
    if !bitrate_auto {
        return Err(ScaleError::NeedsAuto);
    }
    if !(scale > 0.0 && scale <= FULL_SCALE) {
        return Err(ScaleError::OutOfRange);
    }

    Ok(scaled_bitrate(kbps, scale))
}

/// The judged seconds of a session, oldest overwritten first.
#[derive(Clone, Copy, Debug, Default)]
struct Window {
    bad: [bool; WINDOW_SECONDS],
    next: usize,
    len: usize,
}

impl Window {
    fn push(&mut self, bad: bool) {
        self.bad[self.next] = bad;
        self.next = (self.next + 1) % WINDOW_SECONDS;
        self.len = (self.len + 1).min(WINDOW_SECONDS);
    }

    fn bad_seconds(&self) -> u32 {
        self.bad.iter().filter(|bad| **bad).count() as u32
    }
}

/// Unscaled Auto bitrates per frame rate, in first-seen order like the JS Map.
#[derive(Clone, Copy, Debug, Default)]
struct Rates {
    entries: [(u32, u32); MAX_RATES],
    len: usize,
}

impl Rates {
    fn get(&self, fps: u32) -> Option<u32> {
        let entries = &self.entries[..self.len];
        entries
            .iter()
            .find(|(rate, _)| *rate == fps)
            .map(|(_, kbps)| *kbps)
    }

    fn set(&mut self, fps: u32, kbps: u32) {
        if let Some(entry) = self.entries[..self.len]
            .iter_mut()
            .find(|(rate, _)| *rate == fps)
        {
            entry.1 = kbps;
            return;
        }
        if self.len == MAX_RATES {
            self.entries.copy_within(1.., 0);
            self.len -= 1;
        }
        self.entries[self.len] = (fps, kbps);
        self.len += 1;
    }
}

#[derive(Clone, Copy, Debug)]
struct Session {
    fps: u32,
    kbps: u32,
    auto_kbps: u32,
    seconds: u32,
    dropped: u64,
    idr_requests: u64,
    poor: Option<bool>,
    rtt_ms: Option<u32>,
    window: Window,
    clean_streak: u32,
    decided: bool,
}

impl Session {
    fn is_bad_second(&self, stats: &Stats, drops: u64, idrs: u64) -> bool {
        let frame_ms = 1000.0 / f64::from(self.fps);
        let network_bad =
            self.poor == Some(true) || self.rtt_ms.is_some_and(|rtt| rtt > BAD_RTT_MS);
        let backlog_bad = drops >= BAD_DROPS_PER_SECOND || idrs > 0;
        let queue_bad = f64::from(stats.queue_age_ms) > frame_ms * BAD_QUEUE_AGE_FRAMES;

        network_bad || backlog_bad || queue_bad
    }

    fn is_presentation_overload(&self, stats: &Stats) -> bool {
        if self.fps <= 60 {
            return false;
        }

        f64::from(stats.presented) < f64::from(self.fps) * PRESENTATION_SHARE
    }
}

/// One per user launch with Auto bitrate, fed every session it starts: at most one step down and
/// one back up, [`HOLD_OFF_SECONDS`] apart. Without stats samples it never recommends.
///
/// `now_ms` must come from a monotonic clock. A sample at or before the previous one is not a
/// new second and is ignored; an earlier one (a rollback or a wrapped tick) also re-anchors the
/// clock there, so one bad timestamp costs one sample. Gaps of any length count as one second,
/// as each JS stats line did, and the cumulative counters carry what happened during them.
#[derive(Clone, Copy, Debug)]
pub struct Policy {
    scale: Option<f64>,
    stepped_down: bool,
    stepped_up: bool,
    launch_seconds: u64,
    decided_at: Option<u64>,
    session: Option<Session>,
    rates: Rates,
    clock_ms: Option<u64>,
    rejected: u32,
}

impl Policy {
    /// A policy for a launch whose saved bitrate is Auto; a manual bitrate is never adapted.
    pub fn for_launch(bitrate_auto: bool) -> Option<Self> {
        bitrate_auto.then(|| Self {
            scale: None,
            stepped_down: false,
            stepped_up: false,
            launch_seconds: 0,
            decided_at: None,
            session: None,
            rates: Rates::default(),
            clock_ms: None,
            rejected: 0,
        })
    }

    /// The session-only factor on Auto, or None while Auto has not been lowered.
    pub fn scale(&self) -> Option<f64> {
        self.scale
    }

    /// Stats samples ignored for a non-advancing `now_ms`.
    pub fn rejected_samples(&self) -> u32 {
        self.rejected
    }

    /// A session is streaming at `fps` and `bitrate_kbps` (the JS `video-rate` line).
    pub fn start_session(&mut self, fps: u32, bitrate_kbps: u32) {
        let started = self.scale.unwrap_or(FULL_SCALE);
        if started == FULL_SCALE {
            self.rates.set(fps, bitrate_kbps);
        }
        let estimate = round(f64::from(bitrate_kbps) / started / AUTO_STEP_KBPS) * AUTO_STEP_KBPS;
        let auto_kbps = self.rates.get(fps).unwrap_or(estimate as u32);

        self.session = Some(Session {
            fps,
            kbps: bitrate_kbps,
            auto_kbps,
            seconds: 0,
            dropped: 0,
            idr_requests: 0,
            poor: Some(false),
            rtt_ms: Some(0),
            window: Window::default(),
            clean_streak: 0,
            decided: false,
        });
    }

    /// A new size/codec can share a rate with an earlier dock context. Its known Auto
    /// baseline replaces that rate's old estimate without resetting the launch's step budget.
    pub fn start_session_with_auto(&mut self, fps: u32, bitrate_kbps: u32, auto_kbps: u32) {
        self.rates.set(fps, auto_kbps);
        self.start_session(fps, bitrate_kbps);
    }

    /// The connection-status line: poor latches until the next status.
    pub fn connection_status(&mut self, poor: bool) {
        if let Some(session) = self.judged_session() {
            session.poor = Some(poor);
        }
    }

    /// The latest estimated round trip.
    pub fn rtt(&mut self, rtt_ms: u32) {
        if let Some(session) = self.judged_session() {
            session.rtt_ms = Some(rtt_ms);
        }
    }

    pub(crate) fn remote_status(&mut self, poor: Option<bool>, rtt_ms: Option<u32>) {
        if let Some(session) = &mut self.session {
            session.poor = poor;
            session.rtt_ms = rtt_ms;
            if poor != Some(false) || rtt_ms.is_none_or(|rtt| rtt > BAD_RTT_MS) {
                session.clean_streak = 0;
            }
        }
    }

    /// The frame-rate guard ended this session; it is not judged further.
    pub fn frame_rate_overload(&mut self) {
        if let Some(session) = self.judged_session() {
            session.decided = true;
        }
    }

    /// One stats second at `now_ms`.
    pub fn observe_stats(&mut self, now_ms: u64, stats: &Stats) -> Decision {
        self.observe_stats_with_clean(now_ms, stats, true)
    }

    pub(crate) fn observe_stats_with_clean(
        &mut self,
        now_ms: u64,
        stats: &Stats,
        clean: bool,
    ) -> Decision {
        if !self.advance_clock(now_ms) {
            return Decision::Keep;
        }
        let Some(mut session) = self.judged_session().copied() else {
            return Decision::Keep;
        };

        let decision = self.judge(&mut session, stats, clean);
        self.session = Some(session);
        decision
    }

    fn judged_session(&mut self) -> Option<&mut Session> {
        self.session.as_mut().filter(|session| !session.decided)
    }

    fn advance_clock(&mut self, now_ms: u64) -> bool {
        let Some(last) = self.clock_ms else {
            self.clock_ms = Some(now_ms);
            return true;
        };
        if now_ms > last {
            self.clock_ms = Some(now_ms);
            return true;
        }

        self.clock_ms = Some(now_ms);
        self.rejected = self.rejected.saturating_add(1);
        false
    }

    fn judge(&mut self, session: &mut Session, stats: &Stats, clean: bool) -> Decision {
        let drops = delta(stats.dropped, session.dropped);
        let idrs = delta(stats.idr_requests, session.idr_requests);
        session.dropped = stats.dropped;
        session.idr_requests = stats.idr_requests;
        session.seconds = session.seconds.saturating_add(1);
        self.launch_seconds = self.launch_seconds.saturating_add(1);

        if session.seconds <= WARMUP_SECONDS || session.is_presentation_overload(stats) {
            return Decision::Keep;
        }

        let bad = session.is_bad_second(stats, drops, idrs);
        session.window.push(bad);
        session.clean_streak = match bad || !clean {
            true => 0,
            false => session.clean_streak.saturating_add(1),
        };

        if self.holding_off() {
            return Decision::Keep;
        }

        let can_step_down = !self.stepped_down && session.kbps > FLOOR_KBPS;
        if can_step_down && session.window.bad_seconds() >= BAD_SECONDS_TO_STEP_DOWN {
            let next = self.scale.unwrap_or(FULL_SCALE) * STEP_DOWN_FACTOR;
            return self.decide(session, next, Reason::SustainedLoss);
        }

        if let Some(scale) = self.scale
            && scale < FULL_SCALE
            && !self.stepped_up
            && session.clean_streak >= CLEAN_SECONDS_TO_STEP_UP
        {
            let next = FULL_SCALE.min(scale / STEP_DOWN_FACTOR);
            return self.decide(session, next, Reason::CleanStretch);
        }

        Decision::Keep
    }

    fn holding_off(&self) -> bool {
        match self.decided_at {
            Some(at) => self.launch_seconds - at < HOLD_OFF_SECONDS,
            None => false,
        }
    }

    fn decide(&mut self, session: &mut Session, next: f64, reason: Reason) -> Decision {
        session.decided = true;
        self.scale = Some(next);
        self.decided_at = Some(self.launch_seconds);
        match reason.direction() {
            Direction::Down => self.stepped_down = true,
            Direction::Up => self.stepped_up = true,
        }

        Decision::Reconfigure(Reconfigure {
            reason,
            from_kbps: session.kbps,
            bitrate_kbps: scaled_bitrate(session.auto_kbps, next),
            scale: next,
            fps: session.fps,
            bad_seconds: session.window.bad_seconds(),
            window_seconds: session.window.len as u32,
            clean_seconds: session.clean_streak,
        })
    }
}

/// The JS `delta`: a counter below its previous value restarted from zero.
fn delta(value: u64, previous: u64) -> u64 {
    if value >= previous {
        value - previous
    } else {
        value
    }
}

/// `Math.floor` for the non-negative values here; negatives and NaN give 0.
fn floor(value: f64) -> f64 {
    value as u64 as f64
}

/// `Math.round` for the non-negative values here: halves round up, exactly as the JS did.
fn round(value: f64) -> f64 {
    let whole = floor(value);
    if value - whole >= 0.5 {
        whole + 1.0
    } else {
        whole
    }
}
