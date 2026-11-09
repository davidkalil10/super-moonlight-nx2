//! Portable session policies composed by Driver. SDK resources remain with the runtime.

use crate::{
    bitrate, metrics,
    request::Options,
    service::{ReconfigureError, RuntimeEvent, Service},
    stream::Phase,
};
use moonlight_nx2_core::codec::Capabilities;
use moonlight_nx2_ui::settings::StreamOptions;

pub const DISPLAY_MODES: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DisplayMode {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisplayEvidence {
    Unverified,
    PresentedAndCloseVerified,
}
#[derive(Clone, Copy, Debug, Default)]
pub struct DisplayCapabilities {
    modes: [Option<DisplayMode>; DISPLAY_MODES],
}
impl DisplayCapabilities {
    pub fn record(&mut self, mode: DisplayMode, evidence: DisplayEvidence) -> bool {
        let existing = self.modes.iter().position(|entry| {
            entry.is_some_and(|old| old.width == mode.width && old.height == mode.height)
        });
        if evidence != DisplayEvidence::PresentedAndCloseVerified {
            if let Some(index) = existing {
                self.modes[index] = None;
            }
            return false;
        }
        if moonlight_nx2_core::codec::Size::new(mode.width, mode.height).is_none()
            || !(1..=120).contains(&mode.fps)
        {
            return false;
        }
        let Some(index) = existing.or_else(|| self.modes.iter().position(Option::is_none)) else {
            return false;
        };
        self.modes[index] = Some(mode);
        true
    }
    pub fn supports(&self, options: &Options) -> bool {
        self.modes.iter().flatten().any(|mode| {
            mode.width == options.width
                && mode.height == options.height
                && options.fps > 0
                && options.fps <= mode.fps
        })
    }
}

pub struct Context {
    pub docked: bool,
    pub decoder: Capabilities,
    pub display: DisplayCapabilities,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Epoch {
    pub context: u64,
    pub session: u64,
}

pub const REMOTE_TIMEOUT_US: u64 = 3_000_000;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RemoteQuality {
    #[default]
    Unknown,
    Poor,
    Okay,
}

/// Upstream ENet measurements, distinct from local receive-to-present time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoteRtt {
    pub rtt_ms: u32,
    pub deviation_ms: u32,
}

impl RemoteRtt {
    pub fn rtt_us(self) -> Option<u32> {
        self.rtt_ms.checked_mul(1000)
    }

    pub fn deviation_us(self) -> Option<u32> {
        self.deviation_ms.checked_mul(1000)
    }
}

/// Authoritative remote-only knowledge, received on the local presentation/tick clock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoteSnapshot {
    pub received_us: u64,
    pub rtt: Option<RemoteRtt>,
    pub quality: RemoteQuality,
}

#[derive(Default)]
struct Remote {
    enabled: bool,
    snapshot: Option<RemoteSnapshot>,
    last_received_us: Option<u64>,
}

impl Remote {
    fn at(&self, now_us: u64) -> Option<RemoteSnapshot> {
        self.snapshot.filter(|snapshot| {
            now_us
                .checked_sub(snapshot.received_us)
                .is_some_and(|elapsed| elapsed < REMOTE_TIMEOUT_US)
        })
    }

    fn expire(&mut self, now_us: u64) {
        if self.snapshot.is_some_and(|snapshot| {
            now_us
                .checked_sub(snapshot.received_us)
                .is_some_and(|elapsed| elapsed >= REMOTE_TIMEOUT_US)
        }) {
            self.snapshot = None;
        }
    }

    fn clean(&self, now_us: u64) -> bool {
        self.at(now_us).is_some_and(|snapshot| {
            snapshot.quality == RemoteQuality::Okay
                && snapshot
                    .rtt
                    .is_some_and(|rtt| rtt.rtt_ms <= bitrate::BAD_RTT_MS)
        })
    }
}

/// One fresh local snapshot. Drop/IDR counters are cumulative within its session; all clocks
/// use the same monotonic microseconds as presentation. Missing measurements stay unknown.
/// Console measurements never supply network RTT. Each snapshot is judged at most once.
#[derive(Clone, Copy, Debug, Default)]
pub struct Telemetry {
    pub at_us: u64,
    pub dropped_total: u32,
    pub idr_requests: u64,
    pub queue_age_us: Option<u32>,
    pub acknowledgement_us: Option<u32>,
    pub console_unit_us: Option<u32>,
    pub console_busy_us: Option<u32>,
    pub console_elapsed_us: Option<u32>,
    pub network_rtt_us: Option<u32>,
    pub connection_poor: Option<bool>,
}
#[derive(Clone, Copy, Debug)]
pub enum Observation {
    Presented {
        received_us: Option<u64>,
        presented_us: u64,
    },
    Received {
        bytes: u32,
    },
    Skipped,
    Telemetry(Telemetry),
    Capacity(metrics::Measurement),
    Ended,
    Failed,
    Closed {
        retained: bool,
    },
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reason {
    PresentationCapacity,
    PresentationOverload,
    BitrateDown,
    BitrateUp,
}
#[derive(Clone, Copy, Debug)]
pub enum Feedback {
    Metrics {
        epoch: Epoch,
        report: metrics::Report,
    },
    Badge {
        epoch: Epoch,
        text: metrics::Line,
        duration_ms: u32,
        frame_counter: bool,
    },
    Reconfigure {
        epoch: Epoch,
        reason: Reason,
        options: Options,
        result: Result<(), ReconfigureError>,
    },
}

#[derive(Clone, Copy)]
struct Pending {
    epoch: Epoch,
    base: Options,
    options: Options,
    reason: Reason,
    bitrate_after: Option<bitrate::Policy>,
}
struct Launch {
    preferences: StreamOptions,
    bitrate: Option<bitrate::Policy>,
    suspended: bool,
}
struct Session {
    epoch: Epoch,
    start_id: u32,
    options: Options,
    opened_us: u64,
    started: bool,
    metrics: metrics::Metrics,
    guard: Option<metrics::FrameRateGuard>,
    telemetry: Telemetry,
    remote: Remote,
    presented: u64,
    last_presented: Option<u64>,
    samples: bool,
    has_telemetry: bool,
    judged_telemetry: Option<u64>,
    last_tick_us: u64,
}
pub(super) struct State {
    context: u64,
    serial: u64,
    managed: bool,
    retired: bool,
    launch: Option<Launch>,
    session: Option<Session>,
    pending: Option<Pending>,
    metrics_out: Option<Feedback>,
    badge_out: Option<Feedback>,
    change_out: Option<Feedback>,
}
impl State {
    pub fn new() -> Self {
        Self {
            context: 0,
            serial: 0,
            managed: false,
            retired: false,
            launch: None,
            session: None,
            pending: None,
            metrics_out: None,
            badge_out: None,
            change_out: None,
        }
    }
    pub fn epoch(&self) -> Option<Epoch> {
        self.session.as_ref().map(|session| session.epoch)
    }
    pub fn next(&mut self) -> Option<Feedback> {
        self.metrics_out
            .take()
            .or_else(|| self.badge_out.take())
            .or_else(|| self.change_out.take())
    }
    fn clear_outputs(&mut self) {
        self.metrics_out = None;
        self.badge_out = None;
        self.change_out = None;
    }
    pub fn context(&mut self, managed: bool) -> bool {
        self.pending = None;
        self.clear_outputs();
        self.managed = managed;
        if let Some(session) = &mut self.session {
            session.guard = None;
            retire_remote(session, self.launch.as_mut());
        }
        let Some(next) = self.context.checked_add(1) else {
            self.retired = true;
            self.managed = false;
            return false;
        };
        self.context = next;
        if let Some(launch) = &mut self.launch {
            launch.suspended = false;
        }
        true
    }
    pub fn launch(&mut self, preferences: StreamOptions) {
        self.pending = None;
        self.launch = Some(Launch {
            preferences,
            bitrate: bitrate::Policy::for_launch(preferences.bitrate_auto),
            suspended: false,
        });
    }
    pub fn cancel(&mut self) {
        self.pending = None;
        self.launch = None;
        if let Some(session) = &mut self.session {
            session.guard = None;
            session.samples = false;
            retire_remote(session, None);
        }
        self.clear_outputs();
    }
    pub fn preferences(&mut self, preferences: StreamOptions) -> bool {
        if self
            .launch
            .as_ref()
            .is_some_and(|launch| !same_preferences(launch.preferences, preferences))
        {
            self.cancel();
            return true;
        }
        if let Some(launch) = &mut self.launch {
            if (
                launch.preferences.stream_info,
                launch.preferences.frame_counter,
            ) != (preferences.stream_info, preferences.frame_counter)
                && let Some(session) = self.session.as_ref().filter(|session| {
                    session.started && session.epoch.context == self.context && session.samples
                })
            {
                self.badge_out = Some(badge(session, preferences));
            }
            launch.preferences = preferences;
        }
        false
    }
    pub fn context_options(&self, mut options: StreamOptions) -> StreamOptions {
        if options.bitrate_auto
            && let Some(scale) = self
                .launch
                .as_ref()
                .and_then(|launch| launch.bitrate.as_ref())
                .and_then(bitrate::Policy::scale)
        {
            options.bitrate_kbps = bitrate::scaled_bitrate(options.bitrate_kbps, scale);
        }
        options
    }
    pub fn opened(
        &mut self,
        start_id: u32,
        options: Options,
        preferences: StreamOptions,
        now_us: u64,
    ) -> bool {
        if self.retired {
            return false;
        }
        let Some(serial) = self.serial.checked_add(1) else {
            self.retired = true;
            return false;
        };
        self.serial = serial;
        self.pending = None;
        self.clear_outputs();
        if self.launch.is_none() {
            self.launch(preferences);
        }
        self.session = Some(Session {
            epoch: Epoch {
                context: self.context,
                session: serial,
            },
            start_id,
            options,
            opened_us: now_us,
            started: false,
            metrics: metrics::Metrics::new(now_us),
            guard: None,
            telemetry: Telemetry::default(),
            remote: Remote::default(),
            presented: 0,
            last_presented: None,
            samples: true,
            has_telemetry: false,
            judged_telemetry: None,
            last_tick_us: now_us,
        });
        true
    }

    fn owns_remote(&self, service: &Service, epoch: Epoch) -> bool {
        !self.retired
            && epoch.context == self.context
            && matches!(service.phase(), Phase::Opening | Phase::Streaming)
            && self.session.as_ref().is_some_and(|session| {
                session.epoch == epoch
                    && session.samples
                    && service.active_start_id() == Some(session.start_id)
            })
    }

    pub fn enable_remote(&mut self, service: &Service, epoch: Epoch) -> bool {
        if !self.owns_remote(service, epoch) {
            return false;
        }
        let Some(session) = &mut self.session else {
            return false;
        };
        if !session.remote.enabled {
            session.remote.enabled = true;
            apply_remote(session, self.launch.as_mut(), session.last_tick_us);
            self.cancel_remote_up();
        }
        true
    }

    pub fn observe_remote(
        &mut self,
        service: &Service,
        epoch: Epoch,
        snapshot: RemoteSnapshot,
    ) -> bool {
        if !self.owns_remote(service, epoch) {
            return false;
        }
        let Some(session) = &mut self.session else {
            return false;
        };
        if !session.remote.enabled
            || snapshot.received_us < session.opened_us
            || session
                .remote
                .last_received_us
                .is_some_and(|last| snapshot.received_us <= last)
            || session
                .last_tick_us
                .checked_sub(snapshot.received_us)
                .is_some_and(|elapsed| elapsed >= REMOTE_TIMEOUT_US)
        {
            return false;
        }
        session.remote.last_received_us = Some(snapshot.received_us);
        session.remote.snapshot = Some(snapshot);
        apply_remote(session, self.launch.as_mut(), snapshot.received_us);
        if !session.remote.clean(snapshot.received_us) {
            self.cancel_remote_up();
        }
        true
    }

    pub fn remote_snapshot(&self, service: &Service, epoch: Epoch) -> Option<RemoteSnapshot> {
        self.owns_remote(service, epoch)
            .then_some(())
            .and_then(|()| self.session.as_ref()?.remote.snapshot)
    }

    fn cancel_remote_up(&mut self) {
        if self
            .pending
            .is_some_and(|pending| pending.reason == Reason::BitrateUp)
        {
            self.pending = None;
        }
    }
    pub fn observe(&mut self, service: &mut Service, epoch: Epoch, event: Observation) -> bool {
        let Some(session) = self.session.as_mut().filter(|session| {
            session.epoch == epoch && service.active_start_id() == Some(session.start_id)
        }) else {
            return false;
        };
        if let Observation::Closed { retained } = event {
            if !matches!(service.phase(), Phase::Stopping | Phase::Retained) {
                return false;
            }
            retire_remote(session, self.launch.as_mut());
            service.runtime(RuntimeEvent::MediaClosed { retained });
            self.session = None;
            self.pending = None;
            self.clear_outputs();
            if retained {
                self.launch = None;
            }
            return true;
        }
        if epoch.context != self.context
            || self.retired
            || !session.samples
            || !matches!(service.phase(), Phase::Opening | Phase::Streaming)
        {
            return false;
        }
        match event {
            Observation::Presented {
                received_us,
                presented_us,
            } => {
                if presented_us < session.opened_us
                    || session
                        .last_presented
                        .is_some_and(|last| presented_us < last)
                {
                    return false;
                }
                if !session.started {
                    session.started = true;
                    session.metrics = metrics::Metrics::new(presented_us);
                    session.telemetry = Telemetry::default();
                    session.has_telemetry = false;
                    session.judged_telemetry = None;
                    session.guard =
                        metrics::FrameRateGuard::new(session.options.fps, presented_us / 1000).ok();
                    if let Some(policy) = self
                        .launch
                        .as_mut()
                        .and_then(|launch| launch.bitrate.as_mut())
                    {
                        policy.start_session_with_auto(
                            session.options.fps,
                            session.options.bitrate_kbps,
                            bitrate::auto_bitrate(
                                session.options.width,
                                session.options.height,
                                session.options.fps,
                                session.options.codec,
                            ),
                        );
                    }
                    session.remote.expire(presented_us);
                    apply_remote(session, self.launch.as_mut(), presented_us);
                    service.runtime(RuntimeEvent::FramePresented);
                    if let Some(launch) = &self.launch {
                        self.badge_out = Some(badge(session, launch.preferences));
                    }
                }
                session.last_presented = Some(presented_us);
                session.presented = session.presented.saturating_add(1);
                session.metrics.presented(received_us, presented_us);
            }
            Observation::Received { bytes } => session
                .metrics
                .record(metrics::Sample::UnitReceived { bytes }),
            Observation::Skipped => session.metrics.record(metrics::Sample::FrameSkipped),
            Observation::Telemetry(telemetry) => {
                if telemetry.at_us < session.opened_us || telemetry.at_us < session.telemetry.at_us
                {
                    return false;
                }
                session.telemetry = telemetry;
                session.has_telemetry = true;
                session
                    .metrics
                    .record(metrics::Sample::DroppedTotal(telemetry.dropped_total));
                if !session.remote.enabled
                    && let Some(rtt_us) = telemetry.network_rtt_us
                {
                    session
                        .metrics
                        .record(metrics::Sample::NetworkRtt { rtt_us });
                }
            }
            Observation::Capacity(measurement) => {
                if !session.started || self.pending.is_some() {
                    return false;
                }
                let Ok(selection) =
                    metrics::select_frame_rate(session.options.fps, Some(measurement))
                else {
                    return false;
                };
                if selection.effective_fps < session.options.fps {
                    self.pending = Some(rate_pending(
                        session,
                        self.launch.as_ref(),
                        selection.effective_fps,
                        Reason::PresentationCapacity,
                    ));
                }
            }
            Observation::Ended => {
                service.runtime(RuntimeEvent::MediaEnded);
                self.cancel();
            }
            Observation::Failed => {
                service.runtime(RuntimeEvent::MediaFailed);
                self.pending = None;
                if let Some(launch) = &mut self.launch {
                    launch.suspended = true;
                }
                retire_remote(session, self.launch.as_mut());
            }
            Observation::Closed { .. } => unreachable!(),
        }
        true
    }
    pub fn tick(&mut self, service: &mut Service, preferences: StreamOptions, now_us: u64) {
        if self.preferences(preferences) {
            service.cancel_reconfigure();
        }
        if self
            .session
            .as_ref()
            .is_some_and(|session| service.active_start_id() != Some(session.start_id))
        {
            if let Some(session) = &mut self.session {
                retire_remote(session, self.launch.as_mut());
            }
            self.session = None;
            self.pending = None;
            self.clear_outputs();
        }
        if matches!(service.phase(), Phase::HostUncertain | Phase::Retained) {
            self.cancel();
        }
        let Some(session) = &mut self.session else {
            return;
        };
        if now_us < session.last_tick_us {
            self.pending = None;
            session.guard = None;
            if let Some(launch) = &mut self.launch {
                launch.suspended = true;
            }
            session.last_tick_us = now_us;
            session.remote.snapshot = None;
            apply_remote(session, self.launch.as_mut(), now_us);
            return;
        }
        session.last_tick_us = now_us;
        if session.epoch.context != self.context
            || !matches!(service.phase(), Phase::Opening | Phase::Streaming)
        {
            self.pending = None;
            session.guard = None;
            retire_remote(session, self.launch.as_mut());
            return;
        }
        session.remote.expire(now_us);
        apply_remote(session, self.launch.as_mut(), now_us);
        if session.remote.enabled
            && !session.remote.clean(now_us)
            && self
                .pending
                .is_some_and(|pending| pending.reason == Reason::BitrateUp)
        {
            self.pending = None;
        }
        if !session.started || service.phase() != Phase::Streaming {
            self.pending = None;
            session.guard = None;
            return;
        }
        if let Some(pending) = self.pending.take() {
            let current = service.requested_options();
            if pending.epoch == session.epoch
                && current == Some(pending.base)
                && self.managed
                && self.launch.as_ref().is_some_and(|launch| !launch.suspended)
            {
                let result = service.reconfigure_session(pending.options);
                if let Some(launch) = &mut self.launch {
                    if result.is_ok() {
                        if let Some(after) = pending.bitrate_after {
                            launch.bitrate = Some(after);
                        }
                    } else {
                        launch.suspended = true;
                    }
                }
                self.change_out = Some(Feedback::Reconfigure {
                    epoch: pending.epoch,
                    reason: pending.reason,
                    options: pending.options,
                    result,
                });
                if result.is_ok() {
                    session.guard = None;
                    retire_remote(session, self.launch.as_mut());
                    return;
                }
            }
        }
        let Some(report) = session.metrics.tick(now_us) else {
            return;
        };
        self.metrics_out = Some(Feedback::Metrics {
            epoch: session.epoch,
            report,
        });
        if !self.managed
            || self.launch.as_ref().is_none_or(|launch| launch.suspended)
            || self.pending.is_some()
        {
            return;
        }
        let telemetry = session.telemetry;
        if !session.has_telemetry
            || telemetry.at_us < now_us.saturating_sub(report.second.elapsed_us)
            || telemetry.at_us > now_us
            || session
                .judged_telemetry
                .is_some_and(|last| telemetry.at_us <= last)
        {
            return;
        }
        session.judged_telemetry = Some(telemetry.at_us);
        let console = telemetry
            .console_busy_us
            .zip(telemetry.console_elapsed_us)
            .filter(|(_, elapsed)| *elapsed > 0)
            .map(|(busy, elapsed)| metrics::LoopShare {
                busy_ms: f64::from(busy) / 1000.0,
                elapsed_ms: f64::from(elapsed) / 1000.0,
            });
        let sample = metrics::GuardSample {
            at_ms: now_us / 1000,
            presented: session.presented,
            dropped: u64::from(telemetry.dropped_total),
            idr_requests: telemetry.idr_requests,
            queue_age_ms: f64::from(telemetry.queue_age_us.unwrap_or(0)) / 1000.0,
            acknowledgement_ms: f64::from(telemetry.acknowledgement_us.unwrap_or(0)) / 1000.0,
            console_unit_ms: telemetry
                .console_unit_us
                .map(|value| f64::from(value) / 1000.0),
            console,
        };
        if session
            .guard
            .as_mut()
            .and_then(|guard| guard.observe(&sample).ok().flatten())
            .is_some()
        {
            self.pending = Some(rate_pending(
                session,
                self.launch.as_ref(),
                60,
                Reason::PresentationOverload,
            ));
            return;
        }
        let Some(policy) = self
            .launch
            .as_mut()
            .and_then(|launch| launch.bitrate.as_mut())
        else {
            return;
        };
        let mut candidate = *policy;
        if !session.remote.enabled {
            if let Some(poor) = telemetry.connection_poor {
                candidate.connection_status(poor);
            }
            if let Some(rtt_us) = telemetry.network_rtt_us {
                candidate.rtt(rtt_us.div_ceil(1000));
            }
        }
        let stats = bitrate::Stats {
            presented: report.second.presented,
            dropped: u64::from(telemetry.dropped_total),
            idr_requests: telemetry.idr_requests,
            queue_age_ms: telemetry.queue_age_us.unwrap_or(0).div_ceil(1000),
        };
        let clean = !session.remote.enabled || session.remote.clean(now_us);
        match candidate.observe_stats_with_clean(now_us / 1000, &stats, clean) {
            bitrate::Decision::Keep => *policy = candidate,
            bitrate::Decision::Reconfigure(change) => {
                self.pending = Some(Pending {
                    epoch: session.epoch,
                    base: session.options,
                    options: Options {
                        bitrate_kbps: change.bitrate_kbps,
                        ..session.options
                    },
                    reason: match change.reason.direction() {
                        bitrate::Direction::Down => Reason::BitrateDown,
                        bitrate::Direction::Up => Reason::BitrateUp,
                    },
                    bitrate_after: Some(candidate),
                })
            }
        }
    }
}

fn apply_remote(session: &mut Session, launch: Option<&mut Launch>, now_us: u64) {
    if !session.remote.enabled {
        return;
    }
    let snapshot = session.remote.at(now_us);
    let rtt = snapshot.and_then(|snapshot| snapshot.rtt);
    session
        .metrics
        .set_network_rtt(rtt.and_then(RemoteRtt::rtt_us));
    if let Some(policy) = launch.and_then(|launch| launch.bitrate.as_mut()) {
        let poor = snapshot.and_then(|snapshot| match snapshot.quality {
            RemoteQuality::Unknown => None,
            RemoteQuality::Poor => Some(true),
            RemoteQuality::Okay => Some(false),
        });
        policy.remote_status(poor, rtt.map(|rtt| rtt.rtt_ms));
    }
}

fn retire_remote(session: &mut Session, launch: Option<&mut Launch>) {
    if session.remote.enabled {
        session.remote.snapshot = None;
        apply_remote(session, launch, session.last_tick_us);
    }
    session.remote = Remote::default();
}

fn same_preferences(left: StreamOptions, right: StreamOptions) -> bool {
    crate::service::options_of(&left) == crate::service::options_of(&right)
        && left.bitrate_auto == right.bitrate_auto
}
fn rate_pending(session: &Session, launch: Option<&Launch>, fps: u32, reason: Reason) -> Pending {
    let mut options = Options {
        fps,
        ..session.options
    };
    let mut bitrate_after = launch.and_then(|launch| launch.bitrate);
    if let Some(policy) = &mut bitrate_after {
        policy.frame_rate_overload();
        options.bitrate_kbps = bitrate::scaled_bitrate(
            bitrate::auto_bitrate(options.width, options.height, fps, options.codec),
            policy.scale().unwrap_or(1.0),
        );
    }
    Pending {
        epoch: session.epoch,
        base: session.options,
        options,
        reason,
        bitrate_after,
    }
}
fn badge(session: &Session, preferences: StreamOptions) -> Feedback {
    use core::fmt::Write;
    let mut text = metrics::Line::new();
    if (preferences.height, preferences.fps) != (session.options.height, session.options.fps) {
        text = metrics::rate_text(
            preferences.height,
            preferences.fps,
            session.options.height,
            session.options.fps,
        );
    } else if preferences.stream_info {
        let _ = write!(text, "{}p{}", session.options.height, session.options.fps);
    }
    Feedback::Badge {
        epoch: session.epoch,
        text,
        duration_ms: if preferences.stream_info || preferences.frame_counter {
            metrics::STAYS
        } else {
            metrics::SHOW_MS
        },
        frame_counter: preferences.frame_counter,
    }
}
