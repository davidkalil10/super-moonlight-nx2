//! Per-frame glue between the UI model, the service, saved hosts and the input recorder.
//! The runtime keeps SDK objects and media; it receives only the `Effect`s it must carry out.

use crate::hosts::Hosts;
use crate::input::{PadState, Recorder, Touches};
use crate::link::Link;
use crate::media::InputSource;
use crate::policy::{self, Context, Epoch, Feedback, Observation, RemoteSnapshot};
use crate::service::{Action, Notice, Output, Service};
use moonlight_nx2_io::media::MAX_INPUT_BYTES;
use moonlight_nx2_ui::model::{Event, Intent, IntentKind, Model, Step};
use moonlight_nx2_ui::settings::StreamOptions;
use moonlight_nx2_ui::store::{Files, Store};

/// Outputs handled per tick; each can lead to at most two intents.
pub const OUTPUTS_PER_TICK: usize = 64;

/// The UI side the driver feeds. `Model` implements it; CLAUDE2's bridge can too.
pub trait Ui {
    fn reduce(&mut self, event: &Event<'_>) -> Step;
    fn allow_input(&self) -> bool;
    fn stream_options(&self) -> StreamOptions;
    /// Saved preferences for comparison/restoration, never capability evidence.
    fn preferences(&self) -> StreamOptions {
        self.stream_options()
    }
}

impl Ui for Model {
    fn reduce(&mut self, event: &Event<'_>) -> Step {
        Model::reduce(self, event)
    }

    fn allow_input(&self) -> bool {
        Model::allow_input(self)
    }

    fn stream_options(&self) -> StreamOptions {
        self.settings()
            .stream_options(self.docked(), self.capabilities())
    }

    fn preferences(&self) -> StreamOptions {
        let settings = self.settings();
        let mut options =
            settings.stream_options(true, &moonlight_nx2_ui::settings::Capabilities::ALL);
        options.width = settings.size().width();
        options.height = settings.size().height();
        options.fps = settings.fps();
        options.codec = settings.codec();
        if options.bitrate_auto {
            options.bitrate_kbps = crate::bitrate::auto_bitrate(
                options.width,
                options.height,
                options.fps,
                crate::service::options_of(&options).codec,
            );
        }
        options
    }
}

/// Work only the runtime can do. Passed straight to the callback, never stored in bulk.
#[derive(Clone, Copy, Debug)]
#[allow(clippy::large_enum_variant)]
pub enum Effect {
    /// Every service action except saved-host changes, which the driver applies itself.
    Action(Action),
    /// Saving hosts.json failed or it could not be loaded; show the message, nothing is lost.
    HostsError(&'static str),
}

pub struct Driver {
    service: Service,
    hosts: Hosts,
    recorder: Recorder,
    stop_sent: bool,
    policy: policy::State,
    remote_owner: Option<RemoteOwner>,
}

#[derive(Clone, Copy)]
struct RemoteOwner {
    epoch: Epoch,
    generation: u64,
    start_id: u32,
}

impl Driver {
    /// Loads saved hosts; the caller builds the model from `hosts()`.
    pub fn new<F: Files>(store: &mut Store<F>, json: &mut moonlight_nx2_ui::json::Json) -> Self {
        Self {
            service: Service::new(),
            hosts: Hosts::load(store, json),
            recorder: Recorder::new(),
            stop_sent: false,
            policy: policy::State::new(),
            remote_owner: None,
        }
    }

    pub fn service(&self) -> &Service {
        &self.service
    }

    pub fn service_mut(&mut self) -> &mut Service {
        &mut self.service
    }

    pub fn hosts(&self) -> &Hosts {
        &self.hosts
    }

    pub fn session_epoch(&self) -> Option<Epoch> {
        self.policy.epoch()
    }
    pub fn observe(&mut self, epoch: Epoch, event: Observation) -> bool {
        let accepted = self.policy.observe(&mut self.service, epoch, event);
        if accepted
            && matches!(
                event,
                Observation::Ended | Observation::Failed | Observation::Closed { .. }
            )
        {
            self.invalidate_remote();
        }
        accepted
    }
    /// Enables authoritative remote knowledge for this owned epoch; repeated calls retain it.
    pub fn enable_remote(&mut self, epoch: Epoch) -> bool {
        self.policy.enable_remote(&self.service, epoch)
    }
    pub fn observe_remote(&mut self, epoch: Epoch, snapshot: RemoteSnapshot) -> bool {
        self.policy.observe_remote(&self.service, epoch, snapshot)
    }
    pub fn remote_snapshot(&self, epoch: Epoch) -> Option<RemoteSnapshot> {
        self.policy.remote_snapshot(&self.service, epoch)
    }
    pub fn next_policy_output(&mut self) -> Option<Feedback> {
        self.policy.next()
    }

    /// Replaces the display/decoder context with independent verified evidence.
    pub fn context_changed<U: Ui>(&mut self, ui: &mut U, context: Context) -> bool {
        self.invalidate_remote();
        if self.policy.preferences(ui.preferences()) {
            self.service.cancel_reconfigure();
        }
        if !self.policy.context(true) {
            self.service
                .runtime(crate::service::RuntimeEvent::DeviceChanged);
            return false;
        }
        self.service
            .runtime(crate::service::RuntimeEvent::DeviceChanged);
        self.service.set_capabilities(context.decoder);
        self.service.set_display_capabilities(context.display);
        self.event(
            ui,
            &Event::OperationMode {
                docked: context.docked,
            },
        );
        let options = self.policy.context_options(ui.stream_options());
        self.service.context_changed(context.docked, &options);
        true
    }

    /// Feeds one UI event (a command word, operation mode, ...) and handles its intents.
    pub fn event<U: Ui>(&mut self, ui: &mut U, event: &Event<'_>) {
        let step = ui.reduce(event);
        self.intents(ui, &step);
    }

    /// One frame: poll control, then route every output to the UI, saved hosts or `effect`.
    pub fn tick<U: Ui, L: Link, F: Files>(
        &mut self,
        ui: &mut U,
        link: &mut L,
        store: &mut Store<F>,
        now_ms: u64,
        effect: &mut impl FnMut(Effect),
    ) {
        let generation = self.service.current_control_generation();
        self.tick_for_generation(ui, link, store, now_ms, generation, effect);
    }

    pub fn tick_for_generation<U: Ui, L: Link, F: Files>(
        &mut self,
        ui: &mut U,
        link: &mut L,
        store: &mut Store<F>,
        now_ms: u64,
        generation: u64,
        effect: &mut impl FnMut(Effect),
    ) {
        if generation != self.service.current_control_generation() {
            self.service.poll_for_generation(link, now_ms, generation);
            return;
        }
        if self.recorder.stopped() && !self.stop_sent {
            self.stop_sent = true;
            let stop = Intent {
                kind: IntentKind::StopStream,
                host: None,
                app: None,
            };
            self.dispatch_intent(ui, &stop);
        }

        if self.policy.preferences(ui.preferences()) {
            self.service.cancel_reconfigure();
            self.invalidate_remote();
        }

        if let Some(now_us) = now_ms.checked_mul(1000) {
            self.apply_upstream(now_us);
        }
        self.service.poll_for_generation(link, now_ms, generation);
        for _ in 0..OUTPUTS_PER_TICK {
            let Some(output) = self.service.next_output() else {
                break;
            };
            self.route(ui, store, output, now_ms.checked_mul(1000), effect);
        }
        if let Some(now_us) = now_ms.checked_mul(1000) {
            self.apply_upstream(now_us);
            self.policy
                .tick(&mut self.service, ui.preferences(), now_us);
        } else {
            self.policy.cancel();
            self.invalidate_remote();
        }
    }

    /// A confirmed operation-mode change (`dock::Monitor`). The old context's capability
    /// evidence is retired and replaced by `capabilities` (the runtime's verified evidence for
    /// the new display/decoder context), the model learns the mode, and a live stream restarts
    /// once in the new mode's options.
    pub fn dock_changed<U: Ui>(
        &mut self,
        ui: &mut U,
        docked: bool,
        capabilities: moonlight_nx2_core::codec::Capabilities,
    ) {
        self.invalidate_remote();
        self.policy.context(false);
        self.service
            .runtime(crate::service::RuntimeEvent::DeviceChanged);
        self.service.set_capabilities(capabilities);
        self.event(ui, &Event::OperationMode { docked });
        let options = ui.stream_options();
        self.service.dock_changed(docked, &options);
    }

    /// A fresh recorder for each stream; the stop chord ends only the stream it was held in.
    pub fn stream_opened(&mut self) {
        self.recorder = Recorder::new();
        self.stop_sent = false;
    }

    /// One media step's input. Only owned Streaming and UI permission forward live input;
    /// other phases release the previous pad/fingers once, including missing touch reads.
    pub fn input<'a, U: Ui>(
        &'a mut self,
        ui: &U,
        pad: &'a PadState,
        touches: Option<&'a Touches>,
    ) -> FrameInput<'a> {
        let streaming = self.service.phase() == crate::stream::Phase::Streaming;
        FrameInput {
            recorder: &mut self.recorder,
            pad,
            touches,
            allowed: streaming && ui.allow_input(),
            failed: false,
        }
    }

    fn route<U: Ui, F: Files>(
        &mut self,
        ui: &mut U,
        store: &mut Store<F>,
        output: Output,
        now_us: Option<u64>,
        effect: &mut impl FnMut(Effect),
    ) {
        match output {
            Output::Ui(notice) => self.notify(ui, &notice),
            Output::Action(action @ (Action::RememberHost(_) | Action::ForgetHost(_))) => {
                self.save_host(ui, store, &action, effect);
            }
            Output::Action(action) => {
                if matches!(action, Action::OpenMedia(_)) {
                    if !matches!(
                        self.service.phase(),
                        crate::stream::Phase::Opening | crate::stream::Phase::Streaming
                    ) {
                        self.service
                            .runtime(crate::service::RuntimeEvent::MediaClosed { retained: false });
                        return;
                    }
                    let opened = match (
                        self.service.active_start_id(),
                        self.service.requested_options(),
                        now_us,
                    ) {
                        (Some(id), Some(options), Some(now)) => {
                            let prepared = self
                                .service
                                .telemetry_prepared_at_us()
                                .filter(|prepared| *prepared <= now)
                                .unwrap_or(now);
                            self.policy.opened(id, options, ui.preferences(), prepared)
                        }
                        _ => false,
                    };
                    if !opened {
                        self.service
                            .runtime(crate::service::RuntimeEvent::MediaFailed);
                        self.service
                            .runtime(crate::service::RuntimeEvent::MediaClosed { retained: false });
                        return;
                    }
                    self.stream_opened();
                    if self.service.telemetry_negotiated()
                        && let (Some(epoch), Some(start_id)) =
                            (self.policy.epoch(), self.service.active_start_id())
                    {
                        self.remote_owner = Some(RemoteOwner {
                            epoch,
                            generation: self.service.current_control_generation(),
                            start_id,
                        });
                        self.policy.enable_remote(&self.service, epoch);
                    }
                }
                effect(Effect::Action(action));
            }
        }
    }

    fn notify<U: Ui>(&mut self, ui: &mut U, notice: &Notice) {
        let step = ui.reduce(&self.service.ui_event(notice));
        self.intents(ui, &step);
    }

    fn save_host<U: Ui, F: Files>(
        &mut self,
        ui: &mut U,
        store: &mut Store<F>,
        action: &Action,
        effect: &mut impl FnMut(Effect),
    ) {
        match self.hosts.apply(action, store) {
            Ok(true) => {
                let step = ui.reduce(&Event::Hosts {
                    hosts: self.hosts.hosts(),
                });
                self.intents(ui, &step);
            }
            Ok(false) => {}
            Err(error) => effect(Effect::HostsError(error.message())),
        }
    }

    /// Dispatches an intent the UI already reduced, without reducing its event a second time.
    pub fn dispatch_intent<U: Ui>(&mut self, ui: &U, intent: &Intent) {
        let options = ui.stream_options();
        if self.policy.preferences(ui.preferences()) {
            self.service.cancel_reconfigure();
            self.invalidate_remote();
        }
        match intent.kind {
            IntentKind::Launch => self.policy.launch(ui.preferences()),
            IntentKind::StopStream
            | IntentKind::CancelList
            | IntentKind::CancelPair
            | IntentKind::Exit => {
                self.invalidate_remote();
                self.policy.cancel();
                self.service.cancel_reconfigure();
            }
            IntentKind::List
            | IntentKind::Pair
            | IntentKind::UnpairHost
            | IntentKind::RemoveHost
            | IntentKind::QuitHost => {
                self.invalidate_remote();
                self.policy.cancel();
                self.service.cancel_reconfigure();
                self.service.intent(
                    &Intent {
                        kind: IntentKind::StopStream,
                        host: None,
                        app: None,
                    },
                    &options,
                );
            }
            _ => {}
        }
        self.service.intent(intent, &options);
    }

    fn intents<U: Ui>(&mut self, ui: &U, step: &Step) {
        if self.policy.preferences(ui.preferences()) {
            self.service.cancel_reconfigure();
            self.invalidate_remote();
        }
        for intent in step.intents() {
            self.dispatch_intent(ui, intent);
        }
    }

    fn invalidate_remote(&mut self) {
        self.remote_owner = None;
        self.service.discard_upstream();
    }

    fn apply_upstream(&mut self, now_us: u64) {
        let Some(owner) = self.remote_owner else {
            return;
        };
        if owner.generation != self.service.current_control_generation() {
            self.policy.cancel();
            self.invalidate_remote();
            return;
        }
        if self.policy.epoch() != Some(owner.epoch)
            || self.service.active_start_id() != Some(owner.start_id)
            || !self.service.telemetry_negotiated()
            || !matches!(
                self.service.phase(),
                crate::stream::Phase::Opening | crate::stream::Phase::Streaming
            )
        {
            self.invalidate_remote();
            return;
        }
        let Some(observation) = self.service.take_upstream_before(now_us) else {
            return;
        };
        if observation.control_generation == owner.generation
            && observation.start_id == owner.start_id
        {
            self.policy
                .observe_remote(&self.service, owner.epoch, observation.snapshot);
        }
    }
}

/// `media::InputSource` for one frame. An oversize record ends the stream, as the JS did.
pub struct FrameInput<'a> {
    recorder: &'a mut Recorder,
    pad: &'a PadState,
    touches: Option<&'a Touches>,
    allowed: bool,
    failed: bool,
}

impl FrameInput<'_> {
    /// True when a record exceeded the bound; report `MediaFailed`.
    pub fn failed(&self) -> bool {
        self.failed
    }
}

impl InputSource for FrameInput<'_> {
    fn take(&mut self, out: &mut [u8; MAX_INPUT_BYTES]) -> usize {
        match self
            .recorder
            .record_frame(self.pad, self.touches, self.allowed, out)
        {
            Ok(length) => length,
            Err(_) => {
                self.failed = true;
                0
            }
        }
    }
}
