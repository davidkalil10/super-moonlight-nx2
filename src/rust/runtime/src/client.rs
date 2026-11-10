//! Connects the application driver, saved hosts, UI bridge and stream metrics.

extern crate alloc;

use alloc::{boxed::Box, vec::Vec};
#[cfg(any(feature = "diagnostic-control", feature = "host-renderer"))]
use moonlight_nx2_app::link::LinkError;
use moonlight_nx2_app::{
    driver::{Driver, Effect, Ui},
    link::Link,
    service::{Action, RuntimeEvent},
};
#[cfg(any(feature = "diagnostic-control", feature = "host-renderer"))]
use moonlight_nx2_core::control::Frame as ControlFrame;
use moonlight_nx2_ui::{
    bridge::{self, Bridge, Storage},
    composer::Composer,
    glyphs::Glyphs,
    json::Json,
    model::{Event, Screen, Step},
    settings::{Capabilities, StreamOptions},
    store::{Files, Store},
};

pub struct View<'a, F>(&'a mut Bridge<F>);

#[cfg(any(feature = "diagnostic-control", feature = "host-renderer"))]
pub struct SingleList<L> {
    pub link: L,
    sent: bool,
    rejected: bool,
}

#[cfg(any(feature = "diagnostic-control", feature = "host-renderer"))]
impl<L> SingleList<L> {
    pub fn new(link: L) -> Self {
        Self {
            link,
            sent: false,
            rejected: false,
        }
    }
    pub fn sent(&self) -> bool {
        self.sent
    }
    pub fn rejected(&self) -> bool {
        self.rejected
    }
}

#[cfg(any(feature = "diagnostic-control", feature = "host-renderer"))]
impl<L: Link> Link for SingleList<L> {
    fn ready(&self) -> bool {
        self.link.ready()
    }
    fn failed(&self) -> bool {
        self.rejected || self.link.failed()
    }
    fn request(&mut self, payload: &[u8]) -> Result<u32, moonlight_nx2_app::link::LinkError> {
        let listed = moonlight_nx2_app::json::parse(payload)
            .ok()
            .and_then(|value| value.member("op"))
            .is_some_and(|value| value.string_is("list"));
        if self.sent || !listed {
            self.rejected = true;
            return Err(moonlight_nx2_app::link::LinkError::Closed);
        }
        let result = self.link.request(payload);
        self.sent |= result.is_ok();
        result
    }
    fn peek(&self) -> Option<ControlFrame<'_>> {
        self.link.peek()
    }
    fn consume(&mut self) -> Result<(), moonlight_nx2_app::link::LinkError> {
        self.link.consume()
    }
}

impl<F: Files> Ui for View<'_, F> {
    fn reduce(&mut self, event: &Event<'_>) -> Step {
        match event {
            Event::Failed { message, back_apps } => crate::render_platform::log(&alloc::format!(
                "frontend: failed: {} back_apps={back_apps:?}",
                message.unwrap_or("no message")
            )),
            Event::ConnectionLost { .. } => {
                crate::render_platform::log("frontend: connection lost")
            }
            _ => {}
        }
        self.0.reduce(event)
    }

    fn allow_input(&self) -> bool {
        self.0.allow_input()
    }

    fn stream_options(&self) -> StreamOptions {
        let model = self.0.model();
        let options = model
            .settings()
            .stream_options(model.docked(), model.capabilities());
        model
            .link_choice()
            .map_or(options, |choice| choice.apply(options))
    }

    fn preferences(&self) -> StreamOptions {
        self.0.model().preferences()
    }
}

#[derive(Debug)]
pub enum Error {
    Storage,
    Atlas,
    Bridge(bridge::Error),
}

pub struct Frame {
    pub screen: Screen,
    pub interactive: bool,
    pub published: bool,
}

pub struct Client<F> {
    pub driver: Box<Driver>,
    pub bridge: Box<Bridge<F>>,
    composer: Composer,
    hosts: Store<F>,
    ui_schedule: crate::hid::UiSchedule,
    menu_chord: crate::hid::MenuChord,
    stats_epoch: Option<moonlight_nx2_app::policy::Epoch>,
    network_stats: Option<moonlight_nx2_app::metrics::Second>,
    native_stats: Option<moonlight_nx2_core::stats::StreamStats>,
    badge: crate::policy_badge::Badge,
}

fn ui_capabilities(context: &moonlight_nx2_app::policy::Context) -> Capabilities {
    use moonlight_nx2_app::{request, stream};
    let mut result = Capabilities {
        verified_modes: Some([0; 3]),
        ..Capabilities::default()
    };
    for (width, height) in [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)] {
        for fps in [60, 120] {
            if height == 2160 && fps == 120 {
                continue;
            }
            for codec in [
                request::Codec::H264,
                request::Codec::Av1,
                request::Codec::Hevc,
            ] {
                let options = request::Options {
                    width,
                    height,
                    fps,
                    codec,
                    bitrate_kbps: 1,
                    sops: false,
                    local_audio: false,
                    quit_on_stop: false,
                    transport: None,
                };
                if !stream::supported(&context.decoder, &options)
                    || !context.display.supports(&options)
                {
                    continue;
                }
                let ui_codec = match codec {
                    request::Codec::H264 => moonlight_nx2_ui::settings::Codec::H264,
                    request::Codec::Av1 => moonlight_nx2_ui::settings::Codec::Av1,
                    request::Codec::Hevc => moonlight_nx2_ui::settings::Codec::Hevc,
                };
                let size = match height {
                    720 => moonlight_nx2_ui::settings::Size::P720,
                    1080 => moonlight_nx2_ui::settings::Size::P1080,
                    1440 => moonlight_nx2_ui::settings::Size::P1440,
                    _ => moonlight_nx2_ui::settings::Size::P2160,
                };
                result.verify_mode(ui_codec, size, fps);
                result.h264 |= codec == request::Codec::H264;
                result.hevc |= codec == request::Codec::Hevc;
                result.av1 |= codec == request::Codec::Av1;
                result.fps120 |= fps == 120;
                result.docked_sizes |= width > 1920;
            }
        }
    }
    result
}

fn stream_stats_text(
    network: Option<moonlight_nx2_app::metrics::Second>,
    native: Option<moonlight_nx2_core::stats::StreamStats>,
) -> alloc::string::String {
    let fps = native
        .map(|s| alloc::format!("{}.{:01}", s.fps_x10 / 10, s.fps_x10 % 10))
        .or_else(|| {
            network.filter(|s| s.elapsed_us > 0).map(|s| {
                alloc::format!(
                    "{}",
                    u128::from(s.presented) * 1_000_000 / u128::from(s.elapsed_us)
                )
            })
        })
        .unwrap_or_else(|| alloc::string::String::from("--"));
    let bitrate = network
        .filter(|s| s.elapsed_us > 0)
        .map(|s| alloc::format!("{}", u128::from(s.bytes) * 8_000 / u128::from(s.elapsed_us)))
        .unwrap_or_else(|| alloc::string::String::from("--"));
    let millis = |us: u32| alloc::format!("{}.{:01}", us / 1000, (us % 1000) / 100);
    let decode = native
        .filter(|s| s.presented > 0)
        .map(|s| millis(s.decode_mean_us))
        .unwrap_or_else(|| alloc::string::String::from("--"));
    let present = native
        .filter(|s| s.presented > 0)
        .map(|s| millis(s.latency_mean_us))
        .unwrap_or_else(|| alloc::string::String::from("--"));
    let input = native
        .filter(|s| s.input_mean_us != 0 || s.input_max_us != 0)
        .map(|s| millis(s.input_mean_us))
        .unwrap_or_else(|| alloc::string::String::from("--"));
    alloc::format!(
        "FPS {fps} | {bitrate} kbps | Decode {decode} ms | Present {present} ms | Input {input} ms"
    )
}

fn storage(bytes: &mut [u8]) -> Result<&mut Storage, Error> {
    bytes.try_into().map_err(|_| Error::Storage)
}

fn badge_storage(
    bytes: &mut [u8],
) -> Result<&mut [u8; moonlight_nx2_ui::badge::STORAGE_BYTES], Error> {
    bytes
        .get_mut(..moonlight_nx2_ui::badge::STORAGE_BYTES)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(Error::Storage)
}

impl<F: Files + Clone> Client<F> {
    pub fn new(bytes: &mut [u8], atlas: &[u8], files: F, epoch: u32) -> Result<Self, Error> {
        let mut hosts = Store::new(files.clone());
        let mut json = Box::new(Json::new());
        let mut driver = Box::new(Driver::new(&mut hosts, &mut json));
        let service = driver.service_mut();
        service.set_telemetry_profile(Some(
            moonlight_nx2_app::request::TelemetryProfile::UpstreamV1,
        ));
        if !cfg!(feature = "video-tcp") {
            service.set_transport(Some(moonlight_nx2_app::request::Transport::UdpV1));
        }
        let mut bridge = Box::new(Bridge::new(
            storage(bytes)?,
            driver.hosts().hosts(),
            Some(Store::new(files)),
            Capabilities::default(),
            epoch,
        ));
        driver.event(&mut View(&mut bridge), &Event::Attached);
        if let Some(error) = driver.hosts().load_error() {
            bridge.set_status(Some(error.message()));
        }
        Ok(Self {
            driver,
            bridge,
            composer: Composer::new(Glyphs::new(atlas).ok_or(Error::Atlas)?, 0),
            hosts,
            ui_schedule: crate::hid::UiSchedule::default(),
            menu_chord: crate::hid::MenuChord::default(),
            stats_epoch: None,
            network_stats: None,
            native_stats: None,
            badge: crate::policy_badge::Badge::default(),
        })
    }

    pub fn event(&mut self, event: &Event<'_>) {
        self.driver.event(&mut View(&mut self.bridge), event);
    }

    /// Hosts mDNS found; returns the error to show when they could not be saved.
    pub fn discovered(&mut self, found: &[moonlight_nx2_ui::model::Host]) -> Option<&'static str> {
        self.driver
            .discovered(&mut View(&mut self.bridge), &mut self.hosts, found)
    }

    pub fn set_status(&mut self, text: Option<&str>) {
        self.bridge.set_status(text);
    }

    pub fn set_presence(
        &mut self,
        address: &moonlight_nx2_ui::model::Address,
        presence: moonlight_nx2_ui::presence::Presence,
    ) {
        self.bridge.set_presence(address, presence);
    }

    pub fn set_link(
        &mut self,
        choice: Option<moonlight_nx2_ui::link_choice::LinkChoice>,
        note: &str,
    ) {
        self.bridge.set_link(choice, note);
    }

    pub fn set_system_status(&mut self, text: &str) {
        self.bridge.set_system_status(text);
    }

    /// Stops the stream as the stop chord does; the app keeps running on the PC.
    pub fn stop_stream(&mut self) {
        let stop = moonlight_nx2_ui::model::Intent {
            kind: moonlight_nx2_ui::model::IntentKind::StopStream,
            host: None,
            app: None,
        };
        self.driver.dispatch_intent(&View(&mut self.bridge), &stop);
    }

    /// A one-line note over the stream, such as the low-battery warning.
    pub fn toast(&mut self, bytes: &mut [u8], line: &str, now_ns: u64) -> Result<bool, Error> {
        let storage = badge_storage(bytes)?;
        let active = self.driver.session_epoch();
        self.badge
            .note(self.composer.glyphs_mut(), storage, active, line, now_ns);
        Ok(active.is_some())
    }

    pub fn has_cover(&self, app: u32) -> bool {
        self.composer.has_cover(app)
    }

    pub fn clear_covers(&mut self) {
        self.composer.clear_covers();
        self.bridge.invalidate();
    }

    pub fn install_cover(&mut self, app: u32, png: &[u8]) -> bool {
        let Some(tile) = moonlight_nx2_ui::png::tile(png, 240, 135) else {
            return false;
        };
        self.composer.set_cover(app, tile);
        self.bridge.invalidate();
        true
    }

    pub fn runtime(&mut self, event: RuntimeEvent) {
        self.driver.service_mut().runtime(event);
    }

    pub fn input<'a>(
        &'a mut self,
        frame: &'a crate::hid::FrameInput,
    ) -> moonlight_nx2_app::driver::FrameInput<'a> {
        self.driver.input(
            &View(&mut self.bridge),
            &frame.pad,
            Some(&frame.extra),
            Some(&frame.touches),
        )
    }

    pub fn menu_input(
        &mut self,
        input: &crate::hid::FrameInput,
        now_ms: u64,
        bytes: &mut [u8],
    ) -> Result<(), Error> {
        let epoch = self.driver.session_epoch();
        if self.stats_epoch != epoch {
            self.stats_epoch = epoch;
            self.network_stats = None;
            self.native_stats = None;
            self.refresh_stream_stats();
        }
        let storage = storage(bytes)?;
        let active = self.bridge.model().screen() == Screen::Streaming
            && self
                .bridge
                .model()
                .settings()
                .on(moonlight_nx2_ui::settings::Setting::MenuChord)
            && self.driver.service().phase() == moonlight_nx2_app::stream::Phase::Streaming
            && self.bridge.overlay_ready(storage);
        if self.menu_chord.update(input, active, now_ms) && self.bridge.show_overlay(storage) {
            self.event(&Event::Command {
                op: moonlight_nx2_ui::model::Op::Chord,
                item: 0,
                value: 0,
            });
        }
        Ok(())
    }

    pub fn needs_ui_compute(&mut self, input: &crate::hid::FrameInput, frame: &Frame) -> bool {
        let enabled = self
            .bridge
            .model()
            .settings()
            .on(moonlight_nx2_ui::settings::Setting::MenuChord);
        self.ui_schedule
            .needs_compute(input, frame.interactive, enabled)
    }

    pub fn dock_changed(
        &mut self,
        docked: bool,
        capabilities: moonlight_nx2_core::codec::Capabilities,
    ) {
        self.driver
            .dock_changed(&mut View(&mut self.bridge), docked, capabilities);
    }

    pub fn context_changed(&mut self, context: moonlight_nx2_app::policy::Context) -> bool {
        self.badge.invalidate();
        self.bridge.set_capabilities(ui_capabilities(&context));
        let accepted = self
            .driver
            .context_changed(&mut View(&mut self.bridge), context);
        if !accepted {
            self.bridge.set_capabilities(Capabilities::default());
        }
        accepted
    }

    pub fn requested_options(&self) -> Option<moonlight_nx2_app::request::Options> {
        self.driver.service().requested_options()
    }

    pub fn session_epoch(&self) -> Option<moonlight_nx2_app::policy::Epoch> {
        self.driver.session_epoch()
    }

    pub fn observe(
        &mut self,
        epoch: moonlight_nx2_app::policy::Epoch,
        observation: moonlight_nx2_app::policy::Observation,
    ) -> bool {
        self.driver.observe(epoch, observation)
    }

    pub fn next_policy_output(&mut self) -> Option<moonlight_nx2_app::policy::Feedback> {
        self.driver.next_policy_output()
    }

    fn refresh_stream_stats(&mut self) {
        self.bridge
            .set_stream_stats(&stream_stats_text(self.network_stats, self.native_stats));
    }

    pub fn update_native_stats(&mut self, stats: Option<moonlight_nx2_core::stats::StreamStats>) {
        let stats = if self.driver.session_epoch().is_some() {
            stats
        } else {
            None
        };
        if self.native_stats != stats {
            self.native_stats = stats;
            self.refresh_stream_stats();
        }
    }

    /// The PC takes no touch: says so over the stream, as the Civ7 badge does.
    pub fn touch_note(&mut self, bytes: &mut [u8], now_ms: u64) -> Result<(), Error> {
        self.badge.note(
            self.composer.glyphs_mut(),
            badge_storage(bytes)?,
            self.driver.session_epoch(),
            moonlight_nx2_ui::badge::TOUCH_NOTE,
            now_ms.saturating_mul(1_000_000),
        );
        Ok(())
    }

    pub fn paint_policy(
        &mut self,
        bytes: &mut [u8],
        feedback: moonlight_nx2_app::policy::Feedback,
    ) -> Result<bool, Error> {
        if let moonlight_nx2_app::policy::Feedback::Reconfigure {
            reason,
            options,
            result,
            ..
        } = feedback
        {
            crate::render_platform::log(&alloc::format!(
                "policy: {reason:?} asks for {}x{}@{} {} kbps: {result:?}",
                options.width,
                options.height,
                options.fps,
                options.bitrate_kbps
            ));
        }
        if let moonlight_nx2_app::policy::Feedback::Metrics { epoch, report } = feedback
            && self.driver.session_epoch() == Some(epoch)
        {
            self.network_stats = Some(report.second);
            self.refresh_stream_stats();
        }
        let storage = badge_storage(bytes)?;
        Ok(self.badge.apply(
            self.composer.glyphs_mut(),
            storage,
            self.driver.session_epoch(),
            feedback,
        ))
    }

    pub fn policy_badge_error(&self) -> Option<&'static str> {
        self.badge.failure()
    }

    pub fn frame<L: Link>(
        &mut self,
        bytes: &mut [u8],
        link: &mut L,
        now_ms: u64,
        effect: &mut impl FnMut(Effect),
    ) -> Result<Frame, Error> {
        let bytes = storage(bytes)?;
        self.bridge.poll(bytes, now_ms.saturating_mul(1_000_000));
        let intents: Vec<_> = self.bridge.take_intents(bridge::MAX_QUEUED).collect();
        for intent in intents {
            self.driver
                .dispatch_intent(&View(&mut self.bridge), &intent);
        }
        let mut effects = Vec::with_capacity(moonlight_nx2_app::driver::OUTPUTS_PER_TICK);
        self.driver.tick(
            &mut View(&mut self.bridge),
            link,
            &mut self.hosts,
            now_ms,
            &mut |action| effects.push(action),
        );
        for action in effects {
            match action {
                Effect::Action(Action::SaveSettings) => self.bridge.persist_settings(),
                Effect::HostsError(message) => {
                    self.event(&Event::Failed {
                        message: Some(message),
                        back_apps: Some(false),
                    });
                }
                other => effect(other),
            }
        }
        let published = self
            .bridge
            .publish(bytes, &mut self.composer, now_ms.saturating_mul(1_000_000))
            .map_err(Error::Bridge)?;
        self.badge.frame(
            self.composer.glyphs_mut(),
            badge_storage(bytes)?,
            self.driver.session_epoch(),
            now_ms.saturating_mul(1_000_000),
        );
        Ok(Frame {
            screen: self.bridge.model().screen(),
            interactive: self.bridge.interactive(bytes),
            published,
        })
    }

    pub fn close(&mut self, bytes: &mut [u8]) -> Result<(), Error> {
        let bytes = storage(bytes)?;
        self.badge.stop(badge_storage(bytes)?);
        self.bridge.close(bytes);
        Ok(())
    }
}

#[cfg(test)]
mod overlay_stats_tests {
    use super::*;

    #[test]
    fn native_timing_is_displayed_only_when_observed() {
        let unknown = stream_stats_text(None, None);
        assert!(unknown.contains("Present -- ms"));
        let native = moonlight_nx2_core::stats::StreamStats {
            fps_x10: 599,
            decode_mean_us: 1250,
            latency_mean_us: 3450,
            presented: 60,
            ..Default::default()
        };
        let text = stream_stats_text(None, Some(native));
        assert!(text.contains("FPS 59.9"));
        assert!(text.contains("Decode 1.2 ms"));
        assert!(text.contains("Present 3.4 ms"));
        assert!(text.contains("Input -- ms"));
    }
}
