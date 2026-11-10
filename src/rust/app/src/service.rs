//! Application controller: UI intents to control-v1 requests, correlated replies to UI events,
//! and the stream lifecycle. Behaviour follows src/streamer/ui/service.js; the wire contract is
//! NATIVE-CONTROL-V1.md. All work per call is bounded; nothing is retried or replayed.

use crate::dock;
use crate::link::{Link, LinkError};
use crate::reply::{
    self, Catalog, Code, Descriptor, EventClass, Pin, Quit, Reply, TelemetryEcho, UpstreamStatus,
};
use crate::request::{self, Codec, Op, Options, Request, TelemetryProfile, Transport};
use crate::stream::{self, Phase};
use core::fmt::Write;
use moonlight_nx2_core::codec::Capabilities;
use moonlight_nx2_core::control::Kind as FrameKind;
use moonlight_nx2_ui::model::{Event, Host, Intent, IntentKind, Message};
use moonlight_nx2_ui::settings::{self, StreamOptions};

pub const OUTBOX: usize = 32;
/// Outbox room kept free before reading another frame.
pub const OUTBOX_RESERVE: usize = 8;
pub const QUEUE: usize = 2;
pub const FRAMES_PER_POLL: usize = 8;

/// Client deadlines: the helper limits from service.js plus a margin for the PC side.
pub const LIST_TIMEOUT_MS: u64 = 55_000;
pub const UNPAIR_TIMEOUT_MS: u64 = 40_000;
/// Lets the host's own pairing timeout reply arrive before the console gives up.
pub const PAIR_REPLY_MARGIN_MS: u64 = 10_000;
pub const QUIT_TIMEOUT_MS: u64 = 70_000;
pub const START_TIMEOUT_MS: u64 = 30_000;
pub const STOP_TIMEOUT_MS: u64 = 15_000;
pub const LINK_OPEN_TIMEOUT_MS: u64 = 10_000;
pub const FIRST_FRAME_TIMEOUT_MS: u64 = 20_000;
pub const MEDIA_CLOSE_TIMEOUT_MS: u64 = 10_000;
/// Restarts in a row of a stream whose media failed while the PC still answers.
pub const RESUME_ATTEMPTS: u8 = 3;
/// A stream that then ran this long gets its restarts back.
pub const RESUME_RESET_MS: u64 = 60_000;

#[cfg(test)]
mod wake_tests {
    use super::*;

    #[test]
    fn wake_wait_extends_an_already_started_open_and_cancellation_closes_it() {
        let mut service = Service::new();
        service.link_opening = true;
        service.check_wait(100);
        service.set_link_timeout(100, 25_000);
        service.check_wait(10_101);
        assert!(service.link_opening);
        service.cancel_empty_open();
        assert!(!service.link_opening);
        assert!(matches!(
            service.next_output(),
            Some(Output::Action(Action::CloseControl))
        ));
    }

    #[test]
    fn unverified_start_is_refused_and_open_failure_reports_apps_error() {
        let mut service = Service::new();
        service.link_up = true;
        let options = Options {
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate_kbps: 20_000,
            codec: Codec::H264,
            sops: false,
            local_audio: false,
            quit_on_stop: false,
            transport: None,
        };
        service.start_stream(
            Host::default(),
            moonlight_nx2_ui::model::App::default(),
            options,
            None,
        );
        assert!(service.queue.iter().all(Option::is_none));
        assert!(matches!(
            service.next_output(),
            Some(Output::Ui(Notice::Failed {
                back_apps: Some(true),
                ..
            }))
        ));

        service.phase = Phase::Opening;
        service.media_open = true;
        service.media_failed();
        let mut failed = false;
        let mut close = false;
        while let Some(output) = service.next_output() {
            failed |= matches!(
                output,
                Output::Ui(Notice::Failed {
                    back_apps: Some(true),
                    ..
                })
            );
            close |= matches!(output, Output::Action(Action::CloseMedia));
        }
        assert!(failed && close);
    }
}

/// Owned UI notifications; `Service::ui_event` turns one into a `ui::model::Event`.
#[derive(Clone, Copy, Debug)]
pub enum Notice {
    NotPaired,
    Paired,
    Pin(Pin),
    Listed {
        message: Option<Message>,
    },
    Unpaired,
    QuitDone,
    Stage(Message),
    StreamStarted,
    StreamEnded,
    ConnectionLost {
        host: Option<Host>,
    },
    Failed {
        message: Message,
        back_apps: Option<bool>,
    },
}

/// Work for the runtime or persistence owner.
#[derive(Clone, Copy, Debug)]
pub enum Action {
    /// Save the host after a successful list (uniqueid filled from the list).
    RememberHost(Host),
    ForgetHost(Host),
    RenameHost(Host),
    RefreshHosts,
    /// Send the Wake-on-LAN packet for this PC before the list that follows opens it.
    WakeHost(Host),
    /// Measure the link to the PC helper again and pick Auto's stream shape from it.
    TestNetwork,
    SaveSettings,
    PauseInput,
    ResumeInput,
    /// Drive one player's motors (0/0 stops them). Only sent while streaming with input live;
    /// the runtime stops every motor itself on PauseInput, CloseMedia and CloseControl.
    Rumble(reply::Rumble),
    /// The PC takes no touch: show the note once over the stream.
    TouchNote,
    /// The PC display does not follow the stream: show why over the stream.
    DisplayNote(reply::DisplayUnmatched),
    /// Open video/audio channels for this accepted descriptor; report back with `runtime`.
    OpenMedia(Descriptor),
    /// Drain then close media (`Media::begin_drain`, step until drained or `DrainTimeout`,
    /// then `close`); report `MediaClosed`. After a media failure, close at once.
    CloseMedia,
    /// Close the control connection; cancels pending PC work and stops an owned stream.
    CloseControl,
    /// Open and authenticate a new control connection for a user's list; report
    /// `LinkOpened` or `LinkFailed`. Never sent on its own, only for a fresh user intent.
    OpenControl,
    /// Resources are retained; leave through the process-exit path.
    RetireProcess,
    Exit,
}

#[derive(Clone, Copy, Debug)]
pub enum Output {
    Ui(Notice),
    Action(Action),
}

/// Reports from the runtime that owns sockets, decoder, GPU and audio.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeEvent {
    /// A newly authenticated control connection replaced any earlier one.
    LinkOpened,
    /// An `OpenControl` attempt failed.
    LinkFailed,
    /// The device context changed (dock, display, decoder); its capability evidence is retired.
    DeviceChanged,
    /// The runtime presented a decoded frame from this stream.
    FramePresented,
    /// Media failed while open; the service stops the stream and media closes at once.
    MediaFailed,
    /// Every media channel ended cleanly and drained (`Progress.drained`) while streaming.
    MediaEnded,
    /// Media closed; `retained` when any decoder/GPU/audio resource could not be released.
    MediaClosed { retained: bool },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReconfigureError {
    NotStreaming,
    Invalid,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum QuitOutcome {
    Done,
    Failed,
}

/// What the UI hears when a stop finishes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StopNotice {
    /// `StreamEnded`: the model re-lists from Launching, Streaming or Connecting.
    Ended,
    /// Already reported (failure or connection lost).
    Reported,
    /// A session change: start the same app again once the stop finishes.
    Relaunch,
}

/// The stream to start again after a confirmed stop.
#[derive(Clone, Copy, Debug)]
struct Relaunch {
    host: Host,
    app: moonlight_nx2_ui::model::App,
    options: Options,
    telemetry: Option<TelemetryProfile>,
}

/// A wait with no request deadline of its own.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Wait {
    None,
    Link,
    FirstFrame,
    MediaClose,
}

#[derive(Clone, Copy, Debug)]
struct Queued {
    op: Op,
    host: Host,
    app: Option<moonlight_nx2_ui::model::App>,
    options: Option<Options>,
    telemetry: Option<TelemetryProfile>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpstreamObservation {
    pub control_generation: u64,
    pub start_id: u32,
    pub sequence: u32,
    pub snapshot: crate::policy::RemoteSnapshot,
}

#[derive(Clone, Copy, Debug)]
struct Pending {
    id: u32,
    op: Op,
    host: Host,
    deadline_ms: u64,
    abandoned: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub requests: u64,
    pub replies: u64,
    pub stale: u64,
    pub malformed: u64,
    pub deadlines: u64,
    /// Outputs dropped because the outbox was full.
    pub outbox_full: u64,
    /// Polls that left frames unread to keep outbox room.
    pub deferred: u64,
    pub upstream_statuses: u64,
    pub advisory_errors: u64,
}

pub struct Service {
    link_up: bool,
    control_generation: u64,
    link_opening: bool,
    link_timeout_ms: u64,
    pending: Option<Pending>,
    queue: [Option<Queued>; QUEUE],
    catalog: Catalog,
    phase: Phase,
    requested: Option<Options>,
    transport: Option<Transport>,
    telemetry: Option<TelemetryProfile>,
    requested_telemetry: Option<TelemetryProfile>,
    active_start_generation: Option<u64>,
    telemetry_negotiated: bool,
    telemetry_live: bool,
    upstream_sequence: u32,
    upstream_receipt_ms: Option<u64>,
    upstream_observation: Option<UpstreamObservation>,
    prepared_at_us: Option<u64>,
    active_start_id: Option<u32>,
    stream_failure_reported: bool,
    display: Option<crate::policy::DisplayCapabilities>,
    automatic_start: bool,
    stream_host: Option<Host>,
    /// A start answered by an early stop; its own late reply is dropped.
    superseded: Option<Pending>,
    docked: bool,
    stream_app: Option<moonlight_nx2_ui::model::App>,
    relaunch: Option<Relaunch>,
    stop_done: bool,
    stop_notice: StopNotice,
    wait: Wait,
    wait_deadline_ms: u64,
    media_open: bool,
    media_closing: bool,
    upstream: bool,
    /// The overlay paused stream input; PC rumble is dropped until it resumes.
    input_paused: bool,
    streamed: bool,
    now_ms: u64,
    resumes: u8,
    resumed_ms: u64,
    quit_outcome: Option<QuitOutcome>,
    capabilities: Capabilities,
    outbox: [Option<Output>; OUTBOX],
    outbox_head: usize,
    outbox_len: usize,
    payload: [u8; request::MAX_REQUEST_BYTES],
    stats: Stats,
}

impl Default for Service {
    fn default() -> Self {
        Self::new()
    }
}

impl Service {
    /// About 40 KiB; keep one instance rather than putting it on a small stack.
    pub fn new() -> Self {
        Self {
            link_up: false,
            control_generation: 0,
            link_opening: false,
            link_timeout_ms: LINK_OPEN_TIMEOUT_MS,
            pending: None,
            queue: [None; QUEUE],
            catalog: Catalog::new(),
            phase: Phase::Idle,
            requested: None,
            transport: None,
            telemetry: None,
            requested_telemetry: None,
            active_start_generation: None,
            telemetry_negotiated: false,
            telemetry_live: false,
            upstream_sequence: 0,
            upstream_receipt_ms: None,
            upstream_observation: None,
            prepared_at_us: None,
            active_start_id: None,
            stream_failure_reported: false,
            display: None,
            automatic_start: false,
            stream_host: None,
            superseded: None,
            docked: false,
            stream_app: None,
            relaunch: None,
            stop_done: false,
            stop_notice: StopNotice::Reported,
            wait: Wait::None,
            wait_deadline_ms: 0,
            media_open: false,
            media_closing: false,
            upstream: false,
            input_paused: false,
            streamed: false,
            now_ms: 0,
            resumes: 0,
            resumed_ms: 0,
            quit_outcome: None,
            capabilities: Capabilities::default(),
            outbox: [None; OUTBOX],
            outbox_head: 0,
            outbox_len: 0,
            payload: [0; request::MAX_REQUEST_BYTES],
            stats: Stats::default(),
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// No request pending or queued and no stream: a side request (box art) may use the link.
    pub fn idle(&self) -> bool {
        self.link_up
            && self.phase == Phase::Idle
            && self.pending.is_none()
            && self.superseded.is_none()
            && self.queue[0].is_none()
    }

    pub fn set_link_timeout(&mut self, now_ms: u64, timeout_ms: u64) {
        self.link_timeout_ms = timeout_ms.max(LINK_OPEN_TIMEOUT_MS);
        if self.wait == Wait::Link {
            self.wait_deadline_ms = now_ms.saturating_add(self.link_timeout_ms);
        }
    }

    pub fn catalog(&self) -> &Catalog {
        &self.catalog
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    pub fn link_up(&self) -> bool {
        self.link_up
    }

    pub fn pending_op(&self) -> Option<Op> {
        self.pending.map(|pending| pending.op)
    }

    pub fn active_start_id(&self) -> Option<u32> {
        self.active_start_id
    }

    pub fn requested_options(&self) -> Option<Options> {
        self.requested
    }
    pub fn current_control_generation(&self) -> u64 {
        self.control_generation
    }
    pub fn requested_telemetry_profile(&self) -> Option<TelemetryProfile> {
        self.requested.and(self.requested_telemetry)
    }
    pub fn set_telemetry_profile(&mut self, telemetry: Option<TelemetryProfile>) {
        self.telemetry = telemetry;
    }
    pub fn telemetry_negotiated(&self) -> bool {
        self.telemetry_negotiated && self.active_start_generation == Some(self.control_generation)
    }
    pub fn upstream_observation(&self) -> Option<UpstreamObservation> {
        self.upstream_observation
    }
    pub(crate) fn take_upstream_before(&mut self, now_us: u64) -> Option<UpstreamObservation> {
        if self
            .upstream_observation
            .is_some_and(|observation| observation.snapshot.received_us < now_us)
        {
            self.upstream_observation.take()
        } else {
            None
        }
    }
    pub(crate) fn discard_upstream(&mut self) {
        self.upstream_observation = None;
        self.telemetry_live = false;
    }
    pub(crate) fn telemetry_prepared_at_us(&self) -> Option<u64> {
        self.telemetry_negotiated()
            .then_some(self.prepared_at_us)
            .flatten()
    }
    pub fn stream_host(&self) -> Option<Host> {
        self.stream_host
    }
    pub fn set_display_capabilities(&mut self, display: crate::policy::DisplayCapabilities) {
        self.display = Some(display);
    }
    pub fn supports_options(&self, options: &Options) -> bool {
        stream::supported(&self.capabilities, options)
            && self
                .display
                .as_ref()
                .is_none_or(|display| display.supports(options))
    }

    /// Replaces verified device evidence; a stream only starts in a supported mode.
    pub fn docked(&self) -> bool {
        self.docked
    }

    /// A confirmed operation-mode change (`dock::Monitor`). `settings` are the UI's options for
    /// the new mode. A live stream stops and starts again once in the newest mode; a user stop
    /// wins; saved settings are never changed. Capability evidence must already match the new
    /// device context (`Driver::dock_changed` retires and replaces it first).
    pub fn dock_changed(&mut self, docked: bool, settings: &StreamOptions) {
        if docked == self.docked {
            return;
        }
        self.context_changed(docked, settings);
    }

    /// A fresh display/decoder context requires old media to close even when dock state agrees.
    pub fn context_changed(&mut self, docked: bool, settings: &StreamOptions) {
        self.docked = docked;

        let relaunching = self.stop_notice == StopNotice::Relaunch;
        let live = matches!(
            self.phase,
            Phase::Starting | Phase::Opening | Phase::Streaming
        );
        let relaunch_pending = self.phase == Phase::Stopping && relaunching;
        if !live && !relaunch_pending {
            return;
        }
        let (Some(host), Some(app)) = (self.stream_host, self.stream_app) else {
            return;
        };

        let mut options = dock::session_options(options_of(settings), docked, &self.capabilities);
        options.transport = self
            .requested
            .map_or(self.transport, |requested| requested.transport);
        self.relaunch = Some(Relaunch {
            host,
            app,
            options,
            telemetry: self.requested_telemetry,
        });
        match self.phase {
            Phase::Starting => self.stop_stream_with(StopNotice::Relaunch),
            Phase::Opening | Phase::Streaming => self.begin_stop(false, StopNotice::Relaunch),
            _ => {}
        }
    }

    pub fn set_capabilities(&mut self, capabilities: Capabilities) {
        self.capabilities = capabilities;
    }

    /// Transport for future starts. Already queued requests and their descriptors keep the
    /// original choice. Production chooses UDP explicitly; None keeps diagnostic TCP bytes.
    pub fn set_transport(&mut self, transport: Option<Transport>) {
        self.transport = transport;
    }

    /// Cancels a staged automatic restart without undoing a stop already sent to the host.
    pub fn cancel_reconfigure(&mut self) {
        if self.phase == Phase::Stopping && self.stop_notice == StopNotice::Relaunch {
            self.relaunch = None;
            self.stop_notice = StopNotice::Ended;
        } else if self.automatic_start && matches!(self.phase, Phase::Starting | Phase::Opening) {
            self.stop_stream();
        }
    }

    /// Applies a local frame-rate/bitrate recommendation through a confirmed stop and fresh
    /// capability check. Saved settings and the current session's transport remain unchanged.
    /// Only an already presented stream can be reconfigured; uncertain starts are never replayed.
    pub fn reconfigure_session(&mut self, mut options: Options) -> Result<(), ReconfigureError> {
        if self.phase != Phase::Streaming || !self.link_up {
            return Err(ReconfigureError::NotStreaming);
        }
        let (Some(host), Some(app), Some(current)) =
            (self.stream_host, self.stream_app, self.requested)
        else {
            return Err(ReconfigureError::NotStreaming);
        };
        options.transport = current.transport;
        if !options.is_valid() {
            return Err(ReconfigureError::Invalid);
        }
        if !self.supports_options(&options) {
            return Err(ReconfigureError::Unsupported);
        }
        if options == current {
            return Ok(());
        }
        self.relaunch = Some(Relaunch {
            host,
            app,
            options,
            telemetry: self.requested_telemetry,
        });
        self.begin_stop(false, StopNotice::Relaunch);
        Ok(())
    }

    pub fn next_output(&mut self) -> Option<Output> {
        if self.outbox_len == 0 {
            return None;
        }
        let slot = &mut self.outbox[self.outbox_head];
        let output = slot.take();
        wipe_slot(slot);
        self.outbox_head = (self.outbox_head + 1) % OUTBOX;
        self.outbox_len -= 1;
        output
    }

    /// The UI event for a notice; `Listed` borrows the current catalog.
    pub fn ui_event<'a>(&'a self, notice: &'a Notice) -> Event<'a> {
        match notice {
            Notice::NotPaired => Event::NotPaired,
            Notice::Paired => Event::Paired,
            Notice::Pin(pin) => Event::Pin {
                pin: Some(pin.digits()),
                url: Some(pin.url.as_str()),
                timeout_s: pin
                    .timeout_s
                    .unwrap_or(request::DEFAULT_PAIR_TIMEOUT_S)
                    .min(request::DEFAULT_PAIR_TIMEOUT_S),
            },
            Notice::Listed { message } => Event::Listed {
                apps: self.catalog.apps(),
                current_game: self.catalog.current_game(),
                message: message.as_ref().map(|text| text.as_str()),
            },
            Notice::Unpaired => Event::Unpaired,
            Notice::QuitDone => Event::QuitDone,
            Notice::Stage(message) => Event::Stage {
                message: Some(message.as_str()),
            },
            Notice::StreamStarted => Event::StreamStarted,
            Notice::StreamEnded => Event::StreamEnded,
            Notice::ConnectionLost { host } => Event::ConnectionLost {
                host: host.as_ref(),
            },
            Notice::Failed { message, back_apps } => Event::Failed {
                message: Some(message.as_str()),
                back_apps: *back_apps,
            },
        }
    }

    /// Handles one UI intent. Requests are queued and sent by the next `poll`.
    pub fn intent(&mut self, intent: &Intent, settings: &StreamOptions) {
        let host = intent.host.unwrap_or_default();

        match intent.kind {
            IntentKind::List => self.enqueue_op(Op::List, host),
            IntentKind::Pair => self.enqueue_op(Op::Pair, host),
            IntentKind::UnpairHost => self.enqueue_op(Op::Unpair, host),
            IntentKind::QuitHost => self.quit_host(host),
            IntentKind::Launch => self.launch(host, intent.app, settings),
            IntentKind::StopStream => self.stop_stream(),
            IntentKind::CancelList => self.abandon(Op::List),
            IntentKind::CancelPair => self.cancel_pair(),
            IntentKind::RememberHost => self.act(Action::RememberHost(host)),
            IntentKind::RemoveHost => self.act(Action::ForgetHost(host)),
            IntentKind::RenameHost => self.act(Action::RenameHost(host)),
            IntentKind::RefreshHosts => self.act(Action::RefreshHosts),
            IntentKind::WakeHost => self.act(Action::WakeHost(host)),
            IntentKind::TestNetwork => self.act(Action::TestNetwork),
            IntentKind::SaveSettings => self.act(Action::SaveSettings),
            IntentKind::PauseInput => {
                self.input_paused = true;
                self.act(Action::PauseInput)
            }
            IntentKind::ResumeInput => {
                self.input_paused = false;
                self.act(Action::ResumeInput)
            }
            IntentKind::Exit => self.act(Action::Exit),
            IntentKind::Covers => {}
        }
    }

    /// Handles one runtime report.
    pub fn runtime(&mut self, event: RuntimeEvent) {
        match event {
            RuntimeEvent::LinkOpened => self.link_opened(),
            RuntimeEvent::LinkFailed => self.link_failed(),
            RuntimeEvent::DeviceChanged => {
                self.discard_upstream();
                self.capabilities.retire();
                if self.display.is_some() {
                    self.display = Some(crate::policy::DisplayCapabilities::default());
                }
            }
            RuntimeEvent::FramePresented => self.frame_presented(),
            RuntimeEvent::MediaFailed => self.media_failed(),
            RuntimeEvent::MediaEnded => self.host_ended(),
            RuntimeEvent::MediaClosed { retained } => self.media_closed(retained),
        }
    }

    /// Reads correlated replies, enforces deadlines and sends queued requests.
    pub fn poll<L: Link>(&mut self, link: &mut L, now_ms: u64) {
        self.poll_for_generation(link, now_ms, self.control_generation);
    }

    pub fn poll_for_generation<L: Link>(&mut self, link: &mut L, now_ms: u64, generation: u64) {
        if generation != self.control_generation {
            self.stats.stale += 1;
            return;
        }
        self.now_ms = now_ms;
        self.check_wait(now_ms);
        if !self.link_up {
            return;
        }

        for _ in 0..FRAMES_PER_POLL {
            if self.outbox_free() < OUTBOX_RESERVE {
                self.stats.deferred += 1;
                break;
            }
            if !self.link_up || !self.read_one(link, now_ms) {
                break;
            }
        }

        if !self.link_up {
            return;
        }

        if link.failed() && link.peek().is_none() {
            self.link_lost();
            return;
        }

        self.check_deadline(now_ms);
        self.send_next(link, now_ms);
    }

    fn link_opened(&mut self) {
        self.link_timeout_ms = LINK_OPEN_TIMEOUT_MS;
        self.discard_upstream();
        self.telemetry_negotiated = false;
        let Some(generation) = self.control_generation.checked_add(1) else {
            self.close_control();
            self.link_lost();
            return;
        };
        self.control_generation = generation;
        self.link_up = true;
        self.link_opening = false;
        if let Some(stale) = self.pending.take()
            && !stale.abandoned
        {
            self.operation_failed(stale, "the connection to the PC helper was replaced", true);
        }
        if self.phase == Phase::HostUncertain {
            self.phase = Phase::Idle;
            self.active_start_id = None;
        }
    }

    fn link_failed(&mut self) {
        self.link_timeout_ms = LINK_OPEN_TIMEOUT_MS;
        if !self.link_opening {
            return;
        }
        self.link_opening = false;
        self.fail_queue("the PC helper did not answer");
    }

    /// Reports every queued request as failed; none is dropped silently.
    fn fail_queue(&mut self, reason: &str) {
        let queued = core::mem::replace(&mut self.queue, [None; QUEUE]);
        for item in queued.into_iter().flatten() {
            let pending = Pending {
                id: 0,
                op: item.op,
                host: item.host,
                deadline_ms: 0,
                abandoned: false,
            };
            self.operation_failed(pending, reason, false);
        }
    }

    fn close_control(&mut self) {
        self.discard_upstream();
        self.telemetry_negotiated = false;
        if !self.link_up {
            return;
        }
        self.link_up = false;
        self.act(Action::CloseControl);
    }

    /// Bounds the waits that no request deadline covers.
    fn check_wait(&mut self, now_ms: u64) {
        let wait = self.current_wait();
        if wait != self.wait {
            self.wait = wait;
            self.wait_deadline_ms = now_ms.saturating_add(if wait == Wait::Link {
                self.link_timeout_ms
            } else {
                wait_limit_ms(wait)
            });
            return;
        }
        if wait == Wait::None || now_ms < self.wait_deadline_ms {
            return;
        }

        self.stats.deadlines += 1;
        self.wait = Wait::None;
        match wait {
            Wait::Link => self.link_failed(),
            Wait::FirstFrame => self.media_failed(),
            Wait::MediaClose => self.media_closed(true),
            Wait::None => {}
        }
    }

    fn current_wait(&self) -> Wait {
        if self.link_opening {
            return Wait::Link;
        }
        if self.phase == Phase::Opening {
            return Wait::FirstFrame;
        }
        if self.media_closing {
            return Wait::MediaClose;
        }
        Wait::None
    }

    fn outbox_free(&self) -> usize {
        OUTBOX - self.outbox_len
    }

    fn push(&mut self, output: Output) {
        if self.outbox_len == OUTBOX {
            self.stats.outbox_full += 1;
            return;
        }
        let tail = (self.outbox_head + self.outbox_len) % OUTBOX;
        self.outbox[tail] = Some(output);
        self.outbox_len += 1;
    }

    fn notify(&mut self, notice: Notice) {
        self.push(Output::Ui(notice));
    }

    fn act(&mut self, action: Action) {
        self.push(Output::Action(action));
    }

    fn fail(&mut self, back_apps: Option<bool>, args: core::fmt::Arguments<'_>) {
        let mut message = Message::new();
        let _ = message.write_fmt(args);
        self.notify(Notice::Failed { message, back_apps });
    }

    fn enqueue_op(&mut self, op: Op, host: Host) {
        self.enqueue(Queued {
            op,
            host,
            app: None,
            options: None,
            telemetry: None,
        });
    }

    fn enqueue(&mut self, queued: Queued) -> bool {
        let back_apps = Some(matches!(queued.op, Op::Start | Op::Quit));
        if !self.link_up && !self.reconnect_for(&queued) {
            self.fail(back_apps, format_args!("The PC helper is not connected"));
            return false;
        }

        let Some(slot) = self.queue.iter_mut().find(|slot| slot.is_none()) else {
            self.fail(
                back_apps,
                format_args!("The PC is still busy with an earlier request"),
            );
            return false;
        };
        *slot = Some(queued);
        true
    }

    /// A user's host operation may ask for a new connection, one attempt at a time. Start and
    /// stop never reconnect: they follow a fresh list or belong to the old connection.
    fn reconnect_for(&mut self, queued: &Queued) -> bool {
        let host_op = matches!(queued.op, Op::List | Op::Pair | Op::Unpair | Op::Quit);
        if self.link_opening {
            return host_op;
        }
        let idle = matches!(self.phase, Phase::Idle | Phase::HostUncertain);
        if !host_op || !idle {
            return false;
        }

        self.link_opening = true;
        self.act(Action::OpenControl);
        true
    }

    fn quit_host(&mut self, host: Host) {
        let streaming = matches!(
            self.phase,
            Phase::Opening | Phase::Streaming | Phase::Starting
        );
        if streaming {
            self.stop_stream();
        }
        self.enqueue_op(Op::Quit, host);
    }

    fn launch(
        &mut self,
        host: Host,
        app: Option<moonlight_nx2_ui::model::App>,
        settings: &StreamOptions,
    ) {
        let Some(app) = app else {
            return;
        };

        if self.phase != Phase::Idle {
            self.refuse_launch_phase();
            return;
        }

        let Some((listed, truncated)) = self.catalog.find(app.id) else {
            self.fail(
                Some(true),
                format_args!("That app is no longer on the PC; open the PC again to refresh"),
            );
            return;
        };
        if truncated {
            self.fail(
                Some(true),
                format_args!("The app's name is too long for the console to launch"),
            );
            return;
        }
        let app = *listed;

        let running = self.catalog.current_game();
        if running != 0 && running != app.id {
            self.fail(
                Some(true),
                format_args!("Another app is still running on the PC; quit it first"),
            );
            return;
        }

        let mut options =
            dock::session_options(options_of(settings), self.docked, &self.capabilities);
        options.transport = self.transport;
        self.automatic_start = false;
        self.resumes = 0;
        self.start_stream(host, app, options, self.telemetry);
    }

    /// Queues a start after the capability gate; shared by a launch and a dock relaunch.
    fn start_stream(
        &mut self,
        host: Host,
        app: moonlight_nx2_ui::model::App,
        options: Options,
        telemetry: Option<TelemetryProfile>,
    ) {
        if !self.supports_options(&options) {
            let codec = options.codec.name();
            let (width, height, fps) = (options.width, options.height, options.fps);
            self.fail(
                Some(true),
                format_args!("This console cannot play {codec} at {width}x{height} {fps} fps yet"),
            );
            return;
        }

        let queued = self.enqueue(Queued {
            op: Op::Start,
            host,
            app: Some(app),
            options: Some(options),
            telemetry,
        });
        if !queued {
            return;
        }

        self.phase = Phase::Starting;
        self.requested = Some(options);
        self.requested_telemetry = telemetry;
        self.active_start_generation = None;
        self.telemetry_negotiated = false;
        self.telemetry_live = false;
        self.upstream_sequence = 0;
        self.upstream_receipt_ms = None;
        self.upstream_observation = None;
        self.prepared_at_us = None;
        self.active_start_id = None;
        self.stream_failure_reported = false;
        self.stream_host = Some(host);
        self.stream_app = Some(app);
        self.upstream = false;
        self.streamed = false;
    }

    fn refuse_launch_phase(&mut self) {
        match self.phase {
            Phase::Retained => self.fail(
                Some(true),
                format_args!("Restart Moonlight: the last stream kept console resources"),
            ),
            Phase::HostUncertain => self.fail(
                Some(true),
                format_args!("The PC may still be streaming; reconnect to the PC helper first"),
            ),
            _ => self.fail(Some(true), format_args!("A stream is still closing")),
        }
    }

    /// A user stop; it also cancels a pending dock relaunch.
    fn stop_stream(&mut self) {
        self.relaunch = None;
        if self.phase == Phase::Stopping && self.stop_notice == StopNotice::Relaunch {
            self.stop_notice = StopNotice::Ended;
            return;
        }
        self.stop_stream_with(StopNotice::Ended);
    }

    fn stop_stream_with(&mut self, notice: StopNotice) {
        match self.phase {
            Phase::Starting => {
                let queued = self.drop_queued(Op::Start);
                if queued {
                    self.phase = Phase::Idle;
                    self.finish_relaunch_or(Notice::StreamEnded, notice);
                } else {
                    self.begin_stop(false, notice);
                }
            }
            Phase::Opening | Phase::Streaming => self.begin_stop(false, notice),
            _ => {}
        }
    }

    /// After a stop: start the dock relaunch, or tell the UI the stream ended.
    fn finish_relaunch_or(&mut self, ended: Notice, notice: StopNotice) {
        let relaunch = self.relaunch.take();
        match (notice, relaunch) {
            (StopNotice::Relaunch, Some(next)) if self.phase == Phase::Idle => {
                self.automatic_start = true;
                self.start_stream(next.host, next.app, next.options, next.telemetry);
            }
            (StopNotice::Relaunch, _) => self.fail(
                Some(true),
                format_args!("The stream stopped for the session change and could not start again"),
            ),
            (StopNotice::Ended, _) => self.notify(ended),
            (StopNotice::Reported, _) => {}
        }
    }

    /// The PC's relay treats media EOF before its stop as a failure, so local media normally
    /// closes once the stop result arrives; `close_now` is for media that already failed.
    fn begin_stop(&mut self, close_now: bool, notice: StopNotice) {
        self.discard_upstream();
        self.phase = Phase::Stopping;
        self.stop_done = false;
        self.stop_notice = notice;
        if close_now {
            self.close_media();
        }
        let host = self.stream_host.unwrap_or_default();
        self.enqueue_front(Queued {
            op: Op::Stop,
            host,
            app: None,
            options: None,
            telemetry: None,
        });
    }

    /// Stop goes ahead of a queued quit so quit-on-return stops first, as service.js did.
    fn enqueue_front(&mut self, queued: Queued) {
        if !self.link_up {
            self.stop_done = true;
            self.close_media();
            self.finish_stop();
            return;
        }
        let last = self.queue[QUEUE - 1].take();
        self.queue.rotate_right(1);
        self.queue[0] = Some(queued);
        if let Some(dropped) = last {
            let pending = Pending {
                id: 0,
                op: dropped.op,
                host: dropped.host,
                deadline_ms: 0,
                abandoned: false,
            };
            self.operation_failed(pending, "the stop had to go first", false);
        }
    }

    fn drop_queued(&mut self, op: Op) -> bool {
        let Some(slot) = self
            .queue
            .iter_mut()
            .find(|slot| slot.is_some_and(|q| q.op == op))
        else {
            return false;
        };
        *slot = None;
        self.compact_queue();
        true
    }

    fn compact_queue(&mut self) {
        if self.queue[0].is_none() {
            self.queue.rotate_left(1);
        }
    }

    fn abandon(&mut self, op: Op) {
        self.drop_queued(op);
        self.cancel_empty_open();
        if op == Op::List {
            self.quit_outcome = None;
        }
        if let Some(pending) = &mut self.pending
            && pending.op == op
        {
            pending.abandoned = true;
        }
    }

    /// Pairing has no cancel request; closing control cancels it on the PC.
    fn cancel_pair(&mut self) {
        self.drop_queued(Op::Pair);
        self.cancel_empty_open();
        let pairing = self.pending.is_some_and(|pending| pending.op == Op::Pair);
        if !pairing {
            return;
        }

        self.pending = None;
        self.close_control();
        self.fail_queue("pairing was cancelled");
    }

    fn cancel_empty_open(&mut self) {
        if self.link_opening && self.queue.iter().all(Option::is_none) {
            self.link_opening = false;
            self.link_timeout_ms = LINK_OPEN_TIMEOUT_MS;
            self.act(Action::CloseControl);
        }
    }

    fn send_next<L: Link>(&mut self, link: &mut L, now_ms: u64) {
        if !link.ready() {
            return;
        }
        let Some(queued) = self.queue[0] else {
            return;
        };
        if self.pending.is_some() && !self.stop_may_overtake(&queued) {
            return;
        }

        let written = self.write_request(&queued);
        let length = match written {
            Ok(length) => length,
            Err(error) => {
                self.queue[0] = None;
                self.compact_queue();
                self.request_refused(&queued, error);
                return;
            }
        };

        let sent = link.request(&self.payload[..length]);
        self.payload[..length].fill(0);
        match sent {
            Ok(id) => {
                self.queue[0] = None;
                self.compact_queue();
                self.stats.requests += 1;
                if queued.op == Op::Start {
                    self.active_start_id = Some(id);
                    self.active_start_generation = Some(self.control_generation);
                }
                let deadline_ms = now_ms.saturating_add(timeout_ms(queued.op));
                self.pending = Some(Pending {
                    id,
                    op: queued.op,
                    host: queued.host,
                    deadline_ms,
                    abandoned: false,
                });
                self.request_sent(&queued);
            }
            Err(LinkError::Again) => {}
            Err(LinkError::Closed) => self.link_lost(),
        }
    }

    /// The PC accepts stop while start is still in preflight; it answers start `cancelled`,
    /// then stop. The start moves aside so both replies stay correlated.
    fn stop_may_overtake(&mut self, queued: &Queued) -> bool {
        let start_pending = self.pending.is_some_and(|pending| pending.op == Op::Start);
        if queued.op != Op::Stop || !start_pending || self.superseded.is_some() {
            return false;
        }
        self.superseded = self.pending.take();
        true
    }

    fn write_request(&mut self, queued: &Queued) -> Result<usize, request::Error> {
        let host = queued.host.address.as_str();
        let app = queued.app.map(|app| app.name);
        let request = match queued.op {
            Op::Pair => Request::Pair {
                host,
                timeout_seconds: request::DEFAULT_PAIR_TIMEOUT_S,
            },
            Op::List => Request::List { host },
            Op::Unpair => Request::Unpair { host },
            Op::Quit => Request::Quit { host },
            Op::Stop => Request::Stop,
            Op::Start => Request::Start {
                host,
                app: app.as_ref().map(|name| name.as_str()).unwrap_or(""),
                options: queued.options.ok_or(request::Error::InvalidOptions)?,
            },
        };
        request.write_with_telemetry(&mut self.payload, queued.telemetry)
    }

    fn request_sent(&mut self, queued: &Queued) {
        if queued.op == Op::Start {
            let mut message = Message::new();
            let _ = write!(message, "Preparing the stream");
            self.notify(Notice::Stage(message));
        }
    }

    fn request_refused(&mut self, queued: &Queued, error: request::Error) {
        if queued.op == Op::Start {
            self.phase = Phase::Idle;
            self.requested = None;
        }
        let back_apps = Some(matches!(queued.op, Op::Start | Op::Quit));
        self.fail(
            back_apps,
            format_args!("The console could not send {}: {error:?}", queued.op.name()),
        );
    }

    /// Reads, decodes and consumes one frame. Returns false when none was ready.
    fn read_one<L: Link>(&mut self, link: &mut L, now_ms: u64) -> bool {
        let Some(frame) = link.peek() else {
            return false;
        };
        let id = frame.header.request_id;
        let kind = frame.header.kind;
        let decoded = reply::decode(kind, id, frame.payload);
        let outcome = if kind == FrameKind::Event && id == 0 && self.telemetry_negotiated() {
            match reply::classify_event(frame.payload) {
                EventClass::UpstreamStatus => match decoded {
                    Ok(Reply::UpstreamStatus(status)) => Outcome::Upstream(status),
                    _ => Outcome::InvalidAdvisory,
                },
                EventClass::Rumble => match decoded {
                    Ok(Reply::Rumble(rumble)) => Outcome::Owned(Reply::Rumble(rumble)),
                    _ => Outcome::InvalidAdvisory,
                },
                EventClass::Touch => match decoded {
                    Ok(Reply::Touch { supported }) => Outcome::Owned(Reply::Touch { supported }),
                    _ => Outcome::InvalidAdvisory,
                },
                EventClass::HostDisplay => match decoded {
                    Ok(Reply::HostDisplay(reason)) => Outcome::Owned(Reply::HostDisplay(reason)),
                    _ => Outcome::InvalidAdvisory,
                },
                EventClass::Unknown => Outcome::IgnoredEvent,
                EventClass::Lifecycle | EventClass::Unclassifiable
                    if decoded.is_err() && self.telemetry_negotiated() =>
                {
                    Outcome::CorruptLifecycle
                }
                _ => self.classify(id, decoded),
            }
        } else {
            self.classify(id, decoded)
        };
        let _ = link.consume();

        self.stats.replies += 1;
        self.dispatch(id, kind, outcome, now_ms);
        true
    }

    /// Copies everything needed out of the borrowed payload before it is consumed.
    fn classify(&mut self, id: u32, decoded: Result<Reply<'_>, reply::Error>) -> Outcome {
        let reply = match decoded {
            Ok(reply) => reply,
            Err(error) => return Outcome::Malformed(error),
        };

        if id != 0 && self.superseded.is_some_and(|start| start.id == id) {
            if let Reply::Descriptor(mut descriptor)
            | Reply::DescriptorWithTelemetry { mut descriptor, .. } = reply
            {
                descriptor.wipe();
            }
            return Outcome::Superseded;
        }
        let current = self.pending.filter(|pending| pending.id == id);
        if id != 0 && current.is_none() {
            return Outcome::Stale;
        }

        match reply {
            Reply::Listed(value) => {
                let abandoned = current.is_some_and(|pending| pending.abandoned);
                if abandoned {
                    return Outcome::Abandoned;
                }
                if current.is_some_and(|pending| pending.op != Op::List) {
                    return Outcome::Malformed(reply::Error::Shape);
                }
                match self.catalog.decode(value) {
                    Ok(()) => Outcome::Listed,
                    Err(error) => Outcome::Malformed(error),
                }
            }
            Reply::Pin(pin) => Outcome::Owned(Reply::Pin(pin)),
            Reply::Paired { already } => Outcome::Owned(Reply::Paired { already }),
            Reply::Unpaired { already } => Outcome::Owned(Reply::Unpaired { already }),
            Reply::Quit(quit) => Outcome::Owned(Reply::Quit(quit)),
            Reply::Stopped => Outcome::Owned(Reply::Stopped),
            Reply::Connected => Outcome::Owned(Reply::Connected),
            Reply::Ended => Outcome::Owned(Reply::Ended),
            Reply::StreamFailed { start_id, code } => {
                Outcome::Owned(Reply::StreamFailed { start_id, code })
            }
            Reply::Descriptor(descriptor) => Outcome::Descriptor(descriptor),
            Reply::DescriptorWithTelemetry { descriptor, echo } => {
                Outcome::DescriptorEcho(descriptor, echo)
            }
            Reply::UpstreamStatus(status) => Outcome::Upstream(status),
            Reply::Rumble(rumble) => Outcome::Owned(Reply::Rumble(rumble)),
            Reply::Touch { supported } => Outcome::Owned(Reply::Touch { supported }),
            Reply::HostDisplay(reason) => Outcome::Owned(Reply::HostDisplay(reason)),
            Reply::Failure { code, message } => Outcome::Owned(Reply::Failure { code, message }),
        }
    }

    fn dispatch(&mut self, id: u32, kind: FrameKind, outcome: Outcome, now_ms: u64) {
        match outcome {
            Outcome::Stale => self.stats.stale += 1,
            Outcome::Superseded => self.superseded = None,
            Outcome::Malformed(error) => self.malformed(id, kind, error),
            Outcome::Listed => self.listed(),
            Outcome::Descriptor(mut descriptor) => {
                self.descriptor(&descriptor, None, now_ms);
                descriptor.wipe();
            }
            Outcome::DescriptorEcho(mut descriptor, echo) => {
                self.descriptor(&descriptor, Some(echo), now_ms);
                descriptor.wipe();
            }
            Outcome::Upstream(status) => self.upstream_status(status, now_ms),
            Outcome::InvalidAdvisory => {
                self.stats.malformed += 1;
                if self.telemetry_negotiated() {
                    self.stats.advisory_errors += 1;
                }
            }
            Outcome::IgnoredEvent => self.stats.malformed += 1,
            Outcome::CorruptLifecycle => {
                self.stats.malformed += 1;
                self.close_control();
                self.link_lost();
            }
            Outcome::Abandoned => self.pending = None,
            Outcome::Owned(reply) if id == 0 => self.lifecycle(reply),
            Outcome::Owned(reply) => self.reply(reply),
        }
    }

    /// A bad progress event leaves pairing running; a bad reply to start leaves ownership of a
    /// prepared stream uncertain, so control closes.
    fn malformed(&mut self, id: u32, kind: FrameKind, error: reply::Error) {
        self.stats.malformed += 1;
        if id != 0 && self.superseded.is_some_and(|start| start.id == id) {
            self.superseded = None;
            return;
        }
        let Some(pending) = self.pending.filter(|pending| pending.id == id && id != 0) else {
            return;
        };
        if pending.op == Op::Pair && kind == FrameKind::Event {
            return;
        }
        self.pending = None;
        if pending.abandoned {
            return;
        }

        let reason = match error {
            reply::Error::TooLarge => "the PC's reply exceeds what the console can hold",
            _ => "the PC sent a reply the console does not understand",
        };
        self.operation_failed(pending, reason, pending.op == Op::Start);
    }

    fn listed(&mut self) {
        let Some(pending) = self.pending.take() else {
            return;
        };

        let mut host = pending.host;
        let uniqueid = self.catalog.uniqueid();
        if !uniqueid.is_empty() {
            host.uniqueid = moonlight_nx2_ui::model::Address::of(uniqueid);
        }
        if let Some(mac) = self.catalog.mac() {
            host.mac = Some(mac);
        }
        self.act(Action::RememberHost(host));

        let message = self.quit_message();
        self.notify(Notice::Listed { message });
    }

    /// The message service.js `quitMessage` showed on the list after a quit.
    fn quit_message(&mut self) -> Option<Message> {
        let outcome = self.quit_outcome.take()?;
        let running = self.catalog.current_game() != 0;
        let text = match (outcome, running) {
            (QuitOutcome::Done, false) => "Quit confirmed",
            (QuitOutcome::Done, true) => "Quit failed: the host game is still running",
            (QuitOutcome::Failed, false) => {
                "Host closed the game on its own; the quit request failed"
            }
            (QuitOutcome::Failed, true) => "Quit failed: the host refused",
        };
        Some(Message::of(text))
    }

    fn reply(&mut self, reply: Reply<'_>) {
        if let Reply::Pin(pin) = reply {
            let pairing = self
                .pending
                .is_some_and(|pending| pending.op == Op::Pair && !pending.abandoned);
            if pairing {
                self.notify(Notice::Pin(pin));
            }
            return;
        }

        let Some(pending) = self.pending.take() else {
            return;
        };
        if pending.abandoned {
            return;
        }

        match (pending.op, reply) {
            (Op::Pair, Reply::Paired { .. }) => self.notify(Notice::Paired),
            (Op::Unpair, Reply::Unpaired { .. }) => self.notify(Notice::Unpaired),
            (Op::Quit, Reply::Quit(quit)) => self.quit_done(quit),
            (Op::Stop, Reply::Stopped) => self.stopped(),
            (
                Op::List,
                Reply::Failure {
                    code: Code::NotPaired,
                    ..
                },
            ) => {
                self.quit_outcome = None;
                self.notify(Notice::NotPaired);
            }
            (Op::Pair, Reply::Failure { message, .. }) if !message.as_str().is_empty() => self
                .fail(
                    Some(false),
                    format_args!("Pairing failed: {}", message.as_str()),
                ),
            (_, Reply::Failure { code, .. }) => {
                let uncertain =
                    matches!(code, Code::Timeout | Code::BackendFailed | Code::Cancelled);
                self.operation_failed(pending, code.message(), uncertain)
            }
            _ => {
                self.stats.malformed += 1;
                self.operation_failed(pending, "the PC answered a different request", false);
            }
        }
    }

    fn quit_done(&mut self, quit: Quit) {
        self.quit_outcome = Some(if quit.cancelled {
            QuitOutcome::Done
        } else {
            QuitOutcome::Failed
        });
        self.notify(Notice::QuitDone);
    }

    /// `uncertain`: the PC may have acted, so a start leaves its stream ownership unknown.
    fn operation_failed(&mut self, pending: Pending, reason: &str, uncertain: bool) {
        let name = pending.host.name.as_str();
        match pending.op {
            Op::List => {
                self.quit_outcome = None;
                self.fail(Some(false), format_args!("Cannot reach {name}: {reason}"));
            }
            Op::Pair => self.fail(Some(false), format_args!("Pairing failed: {reason}")),
            Op::Unpair => self.fail(Some(false), format_args!("Unpairing failed: {reason}")),
            Op::Quit => {
                self.quit_outcome = Some(QuitOutcome::Failed);
                self.notify(Notice::QuitDone);
            }
            Op::Start => self.start_failed(reason, uncertain),
            Op::Stop => self.stop_failed(reason),
        }
    }

    fn start_failed(&mut self, reason: &str, uncertain: bool) {
        self.discard_upstream();
        self.telemetry_negotiated = false;
        self.relaunch = None;
        self.requested = None;
        self.phase = if uncertain {
            Phase::HostUncertain
        } else {
            Phase::Idle
        };
        if uncertain {
            self.close_control();
        } else {
            self.active_start_id = None;
        }
        self.stream_failure_reported = true;
        self.fail(
            Some(true),
            format_args!("The stream did not start: {reason}"),
        );
    }

    /// A failed stop keeps ownership uncertain; closing control is the bounded cleanup.
    fn stop_failed(&mut self, reason: &str) {
        self.superseded = None;
        self.relaunch = None;
        self.stream_failure_reported = true;
        self.phase = if self.media_open {
            Phase::Stopping
        } else {
            Phase::HostUncertain
        };
        self.stop_done = true;
        self.stop_notice = StopNotice::Reported;
        self.close_media();
        self.close_control();
        self.fail(
            Some(true),
            format_args!("The PC did not confirm the stop: {reason}"),
        );
        self.fail_queue("the stop failed");
        self.finish_stop();
    }

    fn descriptor(&mut self, descriptor: &Descriptor, echo: Option<TelemetryEcho>, now_ms: u64) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        let requested = self.requested;
        let starting = pending.op == Op::Start && self.phase == Phase::Starting;
        if !starting || requested.is_none() {
            self.stats.malformed += 1;
            return;
        }

        let check = requested.map(|options| {
            stream::check(descriptor, &options)?;
            stream::check_telemetry(echo, self.requested_telemetry)
        });
        if let Some(Err(mismatch)) = check {
            self.stream_failure_reported = true;
            self.begin_stop(false, StopNotice::Reported);
            self.fail(
                Some(true),
                format_args!("The PC offered a different stream ({mismatch:?}); it was refused"),
            );
            return;
        }

        self.phase = Phase::Opening;
        self.telemetry_negotiated = self.requested_telemetry.is_some();
        self.telemetry_live = self.telemetry_negotiated;
        self.prepared_at_us = now_ms.checked_mul(1000);
        self.media_open = true;
        self.input_paused = false;
        self.act(Action::OpenMedia(*descriptor));
    }

    fn upstream_status(&mut self, status: UpstreamStatus, now_ms: u64) {
        if !self.telemetry_negotiated() {
            self.stats.malformed += 1;
            return;
        }
        let owned = self.telemetry_live
            && self.upstream
            && self.active_start_id == Some(status.start_id)
            && matches!(self.phase, Phase::Opening | Phase::Streaming);
        let fresh = status.sequence > self.upstream_sequence
            && self.upstream_receipt_ms.is_none_or(|last| now_ms >= last);
        let Some(received_us) = now_ms.checked_mul(1000).filter(|_| owned && fresh) else {
            self.stats.stale += 1;
            return;
        };
        self.upstream_sequence = status.sequence;
        self.upstream_receipt_ms = Some(now_ms);
        self.upstream_observation = Some(UpstreamObservation {
            control_generation: self.control_generation,
            start_id: status.start_id,
            sequence: status.sequence,
            snapshot: crate::policy::RemoteSnapshot {
                received_us,
                rtt: status.rtt,
                quality: status.quality,
            },
        });
        self.stats.upstream_statuses += 1;
    }

    fn lifecycle(&mut self, reply: Reply<'_>) {
        match reply {
            Reply::Connected => {
                let opening = matches!(self.phase, Phase::Opening | Phase::Streaming);
                if opening && !self.upstream {
                    self.upstream = true;
                    self.notify(Notice::Stage(Message::of(
                        "Connected; waiting for the first frame",
                    )));
                }
            }
            Reply::Ended => self.host_ended(),
            Reply::StreamFailed { start_id, code } => self.stream_failed(start_id, code),
            Reply::Rumble(rumble) if self.phase == Phase::Streaming && !self.input_paused => {
                self.act(Action::Rumble(rumble))
            }
            Reply::Rumble(_) => self.stats.stale += 1,
            Reply::Touch { supported: false } if self.phase == Phase::Streaming => {
                self.act(Action::TouchNote)
            }
            Reply::Touch { .. } => self.stats.stale += 1,
            Reply::HostDisplay(reason) if self.phase == Phase::Streaming => {
                self.act(Action::DisplayNote(reason))
            }
            Reply::HostDisplay(_) => self.stats.stale += 1,
            _ => self.stats.malformed += 1,
        }
    }

    fn stream_failed(&mut self, start_id: u32, code: Code) {
        if self.active_start_id != Some(start_id)
            || !matches!(
                self.phase,
                Phase::Opening | Phase::Streaming | Phase::Stopping
            )
        {
            self.stats.stale += 1;
            return;
        }
        if self.stream_failure_reported {
            return;
        }
        self.stream_failure_reported = true;
        self.relaunch = None;
        if self.phase != Phase::Stopping {
            self.begin_stop(false, StopNotice::Reported);
        } else {
            self.stop_notice = StopNotice::Reported;
        }
        self.fail(
            Some(true),
            format_args!("The stream failed: {}", code.message()),
        );
    }

    /// The PC ended the stream on its own.
    fn host_ended(&mut self) {
        if !matches!(self.phase, Phase::Opening | Phase::Streaming) {
            return;
        }
        self.phase = Phase::Stopping;
        self.discard_upstream();
        self.stop_done = true;
        self.stop_notice = StopNotice::Ended;
        if !self.streamed {
            self.stream_failure_reported = true;
            self.stop_notice = StopNotice::Reported;
            self.fail(
                Some(true),
                format_args!("The stream did not start: the PC ended it before the first frame"),
            );
        }
        self.close_media();
        self.finish_stop();
    }

    fn stopped(&mut self) {
        self.superseded = None;
        self.stop_done = true;
        self.close_media();
        self.finish_stop();
    }

    fn frame_presented(&mut self) {
        if self.phase != Phase::Opening {
            return;
        }
        self.phase = Phase::Streaming;
        self.automatic_start = false;
        self.streamed = true;
        self.notify(Notice::StreamStarted);
    }

    fn media_failed(&mut self) {
        if !matches!(self.phase, Phase::Opening | Phase::Streaming) {
            return;
        }
        let streamed = self.streamed;
        if streamed && self.resume() {
            return;
        }
        let notice = if streamed {
            StopNotice::Ended
        } else {
            StopNotice::Reported
        };
        self.begin_stop(true, notice);
        if !streamed {
            self.stream_failure_reported = true;
            self.fail(
                Some(true),
                format_args!("The stream did not start: the console could not play it"),
            );
        }
    }

    /// Starts a playing stream again after its media failed: an outage the control link
    /// survived should cost a pause, not the session.
    fn resume(&mut self) -> bool {
        if self.now_ms.saturating_sub(self.resumed_ms) >= RESUME_RESET_MS {
            self.resumes = 0;
        }
        let (Some(host), Some(app), Some(options)) =
            (self.stream_host, self.stream_app, self.requested)
        else {
            return false;
        };
        if !self.link_up || self.resumes == RESUME_ATTEMPTS {
            return false;
        }
        self.resumes += 1;
        self.resumed_ms = self.now_ms;
        self.relaunch = Some(Relaunch {
            host,
            app,
            options,
            telemetry: self.requested_telemetry,
        });
        self.begin_stop(true, StopNotice::Relaunch);
        true
    }

    fn close_media(&mut self) {
        if !self.media_open || self.media_closing {
            return;
        }
        self.media_closing = true;
        self.act(Action::CloseMedia);
    }

    fn media_closed(&mut self, retained: bool) {
        self.discard_upstream();
        self.media_open = false;
        self.media_closing = false;
        if retained {
            self.phase = Phase::Retained;
            self.act(Action::RetireProcess);
            self.fail(
                Some(true),
                format_args!("Restart Moonlight: the stream kept console resources"),
            );
            return;
        }
        self.finish_stop();
    }

    /// Ends the stop once both the PC and the local media have finished.
    fn finish_stop(&mut self) {
        let finished = self.stop_done && !self.media_open;
        if self.phase != Phase::Stopping || !finished {
            return;
        }

        self.phase = if self.link_up {
            Phase::Idle
        } else {
            Phase::HostUncertain
        };
        self.requested = None;
        self.requested_telemetry = None;
        self.telemetry_negotiated = false;
        self.active_start_id = None;
        self.streamed = false;
        let notice = core::mem::replace(&mut self.stop_notice, StopNotice::Reported);
        self.finish_relaunch_or(Notice::StreamEnded, notice);
    }

    fn check_deadline(&mut self, now_ms: u64) {
        let Some(pending) = self.pending else {
            return;
        };
        if now_ms < pending.deadline_ms {
            return;
        }

        self.stats.deadlines += 1;
        self.pending = None;
        self.close_control();
        if !pending.abandoned {
            self.operation_failed(pending, "the PC did not answer in time", true);
        }
        self.fail_queue("the PC did not answer in time");
    }

    /// The control connection ended: fail pending work, close media, never replay.
    fn link_lost(&mut self) {
        self.discard_upstream();
        self.telemetry_negotiated = false;
        self.superseded = None;
        let pending = self.pending.take();
        self.link_up = false;

        let streaming = matches!(
            self.phase,
            Phase::Opening | Phase::Streaming | Phase::Stopping
        );
        if streaming {
            self.phase = Phase::Stopping;
            self.stop_done = true;
            self.stop_notice = StopNotice::Reported;
            self.close_media();
            self.streamed = false;
            self.notify(Notice::ConnectionLost {
                host: self.stream_host,
            });
            self.fail_queue("the connection to the PC helper closed");
            self.finish_stop();
            return;
        }

        if let Some(pending) = pending
            && !pending.abandoned
        {
            self.operation_failed(pending, "the connection to the PC helper closed", true);
        }
        self.fail_queue("the connection to the PC helper closed");
    }
}

enum Outcome {
    Stale,
    /// The reply to a start that an early stop overtook.
    Superseded,
    Malformed(reply::Error),
    Listed,
    Descriptor(Descriptor),
    DescriptorEcho(Descriptor, TelemetryEcho),
    Upstream(UpstreamStatus),
    InvalidAdvisory,
    IgnoredEvent,
    CorruptLifecycle,
    /// The reply to a request the UI abandoned.
    Abandoned,
    /// A decoded reply with no borrowed data.
    Owned(Reply<'static>),
}

fn wait_limit_ms(wait: Wait) -> u64 {
    match wait {
        Wait::None => 0,
        Wait::Link => LINK_OPEN_TIMEOUT_MS,
        Wait::FirstFrame => FIRST_FRAME_TIMEOUT_MS,
        Wait::MediaClose => MEDIA_CLOSE_TIMEOUT_MS,
    }
}

/// Clears a taken outbox slot so descriptor tokens do not linger in it.
fn wipe_slot(slot: &mut Option<Output>) {
    let bytes = (slot as *mut Option<Output>).cast::<u8>();
    for offset in 0..core::mem::size_of::<Option<Output>>() {
        // SAFETY: `offset` is inside the slot, which is exclusively borrowed.
        unsafe { core::ptr::write_volatile(bytes.add(offset), 0) };
    }
    // SAFETY: the zeroed bytes were never read; the slot is valid again before returning.
    unsafe { core::ptr::write(slot, None) };
}

fn timeout_ms(op: Op) -> u64 {
    match op {
        Op::List => LIST_TIMEOUT_MS,
        Op::Unpair => UNPAIR_TIMEOUT_MS,
        Op::Quit => QUIT_TIMEOUT_MS,
        Op::Pair => u64::from(request::DEFAULT_PAIR_TIMEOUT_S) * 1000 + PAIR_REPLY_MARGIN_MS,
        Op::Start => START_TIMEOUT_MS,
        Op::Stop => STOP_TIMEOUT_MS,
    }
}

/// Wire options from the UI's settings in use. Quit-on-return stays a console rule.
pub fn options_of(settings: &StreamOptions) -> Options {
    let codec = match settings.codec {
        settings::Codec::H264 => Codec::H264,
        settings::Codec::Av1 => Codec::Av1,
        settings::Codec::Hevc => Codec::Hevc,
    };

    Options {
        width: settings.width,
        height: settings.height,
        fps: settings.fps,
        bitrate_kbps: settings.bitrate_kbps,
        codec,
        sops: settings.optimise,
        local_audio: settings.host_audio,
        quit_on_stop: false,
        transport: None,
    }
}
