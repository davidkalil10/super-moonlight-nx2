//! Connects the application driver, saved hosts, UI bridge and stream metrics.

extern crate alloc;

use alloc::{boxed::Box, vec::Vec};
use moonlight_nx2_app::{
    driver::{Driver, Effect, Ui},
    link::Link,
    service::{Action, RuntimeEvent},
};
#[cfg(feature = "host-renderer")]
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

#[cfg(feature = "host-renderer")]
pub struct SingleList<L> {
    pub link: L,
    sent: bool,
    rejected: bool,
}

#[cfg(feature = "host-renderer")]
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

#[cfg(feature = "host-renderer")]
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
            .stream_settings()
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
    #[cfg(feature = "ui-pattern")]
    filter_step: usize,
    #[cfg(feature = "ui-page-check")]
    page_checks: u32,
    #[cfg(feature = "ui-page-check")]
    page_check_bad: u32,
    composer: Composer,
    hosts: Store<F>,
    ui_schedule: crate::hid::UiSchedule,
    menu_chord: crate::hid::MenuChord,
    stats_epoch: Option<moonlight_nx2_app::policy::Epoch>,
    network_stats: Option<moonlight_nx2_app::metrics::Second>,
    native_stats: Option<moonlight_nx2_core::stats::StreamStats>,
    session_us: u64,
    badge: crate::policy_badge::Badge,
    pad_overlay: moonlight_nx2_app::pad_overlay::Overlay,
    pad_shown: bool,
}

pub(crate) fn ui_capabilities(context: &moonlight_nx2_app::policy::Context) -> Capabilities {
    use moonlight_nx2_app::{request, stream};
    let mut result = Capabilities {
        verified_modes: Some([0; 3]),
        ..Capabilities::default()
    };
    for size in moonlight_nx2_ui::settings::Size::ALL {
        let (width, height) = (size.width(), size.height());
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
                result.verify_mode(codec.into(), size, fps);
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

/// The frame rate comes from the policy's one-second windows when there is one: the same
/// presented count the stream log reports. The video path's own window is the fallback.
fn presented_fps_x10(
    network: Option<moonlight_nx2_app::metrics::Second>,
    native: Option<moonlight_nx2_core::stats::StreamStats>,
) -> Option<u32> {
    network
        .filter(|second| second.elapsed_us > 0)
        .map(|second| {
            let fps_x10 = u128::from(second.presented) * 10_000_000 / u128::from(second.elapsed_us);
            u32::try_from(fps_x10).unwrap_or(u32::MAX)
        })
        .or_else(|| native.map(|stats| stats.fps_x10))
}

fn stream_readout(
    network: Option<moonlight_nx2_app::metrics::Second>,
    native: Option<moonlight_nx2_core::stats::StreamStats>,
    bitrate_kbps: Option<u32>,
    session_us: u64,
) -> moonlight_nx2_ui::readout::StreamReadout {
    moonlight_nx2_ui::readout::StreamReadout {
        fps_x10: presented_fps_x10(network, native),
        bitrate_kbps,
        decode_us: native.filter(|s| s.presented > 0).map(|s| s.decode_mean_us),
        network_us: network.and_then(|second| second.network_rtt_us),
        session_s: u32::try_from(session_us / 1_000_000).unwrap_or(u32::MAX),
    }
}

/// The latency stages of the full badge: the host and network figures the PC reports, then
/// the console's own from the video path's window.
fn latency(
    network: Option<moonlight_nx2_app::metrics::Second>,
    native: Option<moonlight_nx2_core::stats::StreamStats>,
) -> moonlight_nx2_ui::badge::Latency {
    let presented = native.filter(|stats| stats.presented > 0);
    moonlight_nx2_ui::badge::Latency {
        host_us: native
            .map(|stats| stats.host_mean_us)
            .filter(|host_us| *host_us != 0),
        rtt_us: network.and_then(|second| second.network_rtt_us),
        queue_us: presented
            .filter(|stats| stats.received > 0)
            .map(|stats| stats.receive_mean_us),
        wait_us: presented.map(|stats| stats.decoder_wait_mean_us),
        decode_us: presented.map(|stats| stats.decoder_mean_us),
        present_us: presented.map(|stats| stats.display_mean_us),
    }
}

/// The stats line of the stream menu, from the readout the badge shows.
fn stream_stats_text(
    readout: &moonlight_nx2_ui::readout::StreamReadout,
    native: Option<moonlight_nx2_core::stats::StreamStats>,
) -> alloc::string::String {
    let missing = || alloc::string::String::from("--");
    let millis = |us: u32| alloc::format!("{}.{:01}", us / 1000, (us % 1000) / 100);
    let fps = readout
        .fps_x10
        .map(|fps_x10| alloc::format!("{}.{:01}", fps_x10 / 10, fps_x10 % 10))
        .unwrap_or_else(missing);
    let bitrate = readout
        .bitrate_kbps
        .map(|kbps| alloc::format!("{kbps}"))
        .unwrap_or_else(missing);
    let decode = readout.decode_us.map(millis).unwrap_or_else(missing);
    let present = native
        .filter(|s| s.presented > 0)
        .map(|s| millis(s.latency_mean_us))
        .unwrap_or_else(missing);
    let input = native
        .filter(|s| s.input_mean_us != 0 || s.input_max_us != 0)
        .map(|s| millis(s.input_mean_us))
        .unwrap_or_else(missing);
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
        bridge.load_extras(driver.hosts().extras());
        driver.event(&mut View(&mut bridge), &Event::Attached);
        if let Some(error) = driver.hosts().load_error() {
            bridge.set_status(Some(error.message()));
        }
        Ok(Self {
            driver,
            bridge,
            #[cfg(feature = "ui-pattern")]
            filter_step: 2,
            #[cfg(feature = "ui-page-check")]
            page_checks: 0,
            #[cfg(feature = "ui-page-check")]
            page_check_bad: 0,
            composer: Composer::new(Glyphs::new(atlas).ok_or(Error::Atlas)?, 0),
            hosts,
            ui_schedule: crate::hid::UiSchedule::default(),
            menu_chord: crate::hid::MenuChord::default(),
            stats_epoch: None,
            network_stats: None,
            native_stats: None,
            session_us: 0,
            badge: crate::policy_badge::Badge::default(),
            pad_overlay: moonlight_nx2_app::pad_overlay::Overlay::new(),
            pad_shown: false,
        })
    }

    /// Shows the on-screen gamepad with `pressed` held and its sticks' knobs, or hides it.
    /// Returns the storage bytes drawn, to flush.
    pub fn draw_virtual_pad(
        &mut self,
        bytes: &mut [u8],
        pad: Option<(u32, [(i16, i16); 2])>,
    ) -> Option<core::ops::Range<usize>> {
        use moonlight_nx2_app::pad_overlay::BYTES;
        use moonlight_nx2_core::frame::{PAD_OFFSET, PAD_VISIBLE};
        let visible = bytes.get_mut(PAD_VISIBLE..PAD_VISIBLE + 4)?;
        visible.copy_from_slice(&u32::from(pad.is_some()).to_le_bytes());
        if !core::mem::replace(&mut self.pad_shown, pad.is_some()) {
            self.pad_overlay.reset();
        }
        let (pressed, knobs) = pad?;
        let settings = self.bridge.model().stream_settings();
        let nintendo =
            settings.button_layout() == moonlight_nx2_ui::settings::ButtonLayout::Nintendo;
        let area = bytes.get_mut(PAD_OFFSET..PAD_OFFSET + BYTES)?;
        self.pad_overlay
            .draw(
                self.composer.glyphs_mut(),
                area,
                pressed,
                knobs,
                settings.pad_opacity(),
                nintendo,
            )
            .map(|range| PAD_OFFSET + range.start..PAD_OFFSET + range.end)
    }

    fn save_extras(&mut self) {
        let extras = self.bridge.model().extras();
        if let Err(error) = self.driver.hosts_mut().save_extras(extras, &mut self.hosts) {
            self.bridge.set_status(Some(error.message()));
        }
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

    pub fn set_console_dark(&mut self, dark: Option<bool>) {
        self.bridge.set_console_dark(dark);
    }

    pub fn set_readout(&mut self, readout: moonlight_nx2_ui::readout::Readout) {
        self.bridge.set_readout(readout);
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
        let Some(tile) =
            moonlight_nx2_ui::png::tile(png, Composer::COVER_SIZE.0, Composer::COVER_SIZE.1)
        else {
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
        now_ms: u64,
    ) -> moonlight_nx2_app::driver::FrameInput<'a> {
        self.driver.input(
            &View(&mut self.bridge),
            &frame.pad,
            Some(&frame.extra),
            Some(&frame.touches),
            now_ms,
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
            self.session_us = 0;
            self.refresh_stream_stats();
        }
        let storage = storage(bytes)?;
        #[cfg(feature = "ui-page-check")]
        {
            self.bridge.enable_check(storage);
            if let Some(agrees) = self.bridge.check_page(storage) {
                self.page_checks += 1;
                self.page_check_bad += u32::from(!agrees);
                if !agrees || self.page_checks.is_multiple_of(20) {
                    crate::render_platform::log(&alloc::format!(
                        "ui: page body checksum agrees={agrees} checked={} mismatched={}",
                        self.page_checks,
                        self.page_check_bad
                    ));
                }
            }
        }
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

    /// Steps normal, pattern 1 and pattern 2.
    #[cfg(feature = "ui-pattern")]
    pub fn cycle_pattern(&mut self) {
        self.bridge.set_pattern((self.bridge.pattern() + 1) % 3);
    }

    /// Steps the scaling filter the shaders use: exact, bilinear, Lanczos.
    #[cfg(feature = "ui-pattern")]
    pub fn cycle_filter(&mut self, bytes: &mut [u8]) {
        const MODES: [u32; 3] = [1, 2, 3];
        self.filter_step = (self.filter_step + 1) % MODES.len();
        if let Ok(storage) = storage(bytes) {
            self.bridge.set_filter(storage, MODES[self.filter_step]);
        }
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
        let readout = stream_readout(
            self.network_stats,
            self.native_stats,
            self.driver.session_bitrate_kbps(),
            self.session_us,
        );
        self.bridge
            .set_stream_stats(&stream_stats_text(&readout, self.native_stats));
        self.bridge.set_stream(readout);
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
        self.stream_note(bytes, now_ms, moonlight_nx2_ui::badge::TOUCH_NOTE)
    }

    /// Shows one line from the PC over the stream.
    pub fn stream_note(&mut self, bytes: &mut [u8], now_ms: u64, line: &str) -> Result<(), Error> {
        self.badge.note(
            self.composer.glyphs_mut(),
            badge_storage(bytes)?,
            self.driver.session_epoch(),
            line,
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
            self.session_us += report.second.elapsed_us;
            self.network_stats = Some(report.second);
            self.refresh_stream_stats();
            self.badge
                .set_latency(&latency(self.network_stats, self.native_stats));
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
            if intent.kind == moonlight_nx2_ui::model::IntentKind::SaveExtras {
                self.save_extras();
                continue;
            }
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
        let unknown = stream_stats_text(&stream_readout(None, None, None, 0), None);
        assert!(unknown.contains("Present -- ms"));
        let native = moonlight_nx2_core::stats::StreamStats {
            fps_x10: 599,
            decode_mean_us: 1250,
            latency_mean_us: 3450,
            presented: 60,
            ..Default::default()
        };
        let text = stream_stats_text(&stream_readout(None, Some(native), None, 0), Some(native));
        assert!(text.contains("FPS 59.9"));
        assert!(text.contains("Decode 1.2 ms"));
        assert!(text.contains("Present 3.4 ms"));
        assert!(text.contains("Input -- ms"));
    }

    #[test]
    fn the_latency_line_leaves_out_what_was_not_measured() {
        assert_eq!(
            latency(None, None),
            moonlight_nx2_ui::badge::Latency::default()
        );
        let native = moonlight_nx2_core::stats::StreamStats {
            presented: 60,
            decoder_wait_mean_us: 1300,
            decoder_mean_us: 5200,
            display_mean_us: 8000,
            receive_mean_us: 400,
            ..Default::default()
        };
        let shown = latency(None, Some(native));
        assert_eq!(
            (shown.host_us, shown.rtt_us, shown.queue_us),
            (None, None, None)
        );
        assert_eq!(
            (shown.wait_us, shown.decode_us, shown.present_us),
            (Some(1300), Some(5200), Some(8000))
        );
        let native = moonlight_nx2_core::stats::StreamStats {
            host_mean_us: 2100,
            received: 60,
            ..native
        };
        let second = moonlight_nx2_app::metrics::Second {
            elapsed_us: 1_000_000,
            units: 60,
            bytes: 0,
            presented: 60,
            caught_up: 0,
            dropped_total: 0,
            receive_to_present: None,
            network_rtt_us: Some(3000),
        };
        let shown = latency(Some(second), Some(native));
        assert_eq!(
            moonlight_nx2_ui::badge::latency_text(&shown).as_str(),
            "host 2.1 rtt 3.0 queue 0.4 wait 1.3 decode 5.2 present 8.0 ms"
        );
    }
}

#[cfg(test)]
mod presented_rate_tests {
    use super::*;
    use moonlight_nx2_app::metrics::Second;
    use moonlight_nx2_core::stats::StreamStats;

    fn second(presented: u32, elapsed_us: u64) -> Second {
        Second {
            elapsed_us,
            units: presented,
            bytes: 0,
            presented,
            caught_up: 0,
            dropped_total: 0,
            receive_to_present: None,
            network_rtt_us: None,
        }
    }

    #[test]
    fn the_sheet_shows_frames_presented_per_second_of_the_policy_window() {
        let video_window = StreamStats {
            fps_x10: 300,
            presented: 30,
            ..Default::default()
        };
        let window = second(60, 1_000_000);
        assert_eq!(
            presented_fps_x10(Some(window), Some(video_window)),
            Some(600)
        );
        assert_eq!(
            presented_fps_x10(Some(second(59, 1_001_000)), None),
            Some(589)
        );
    }

    #[test]
    fn the_sheet_and_the_overlay_text_read_the_same_figure() {
        let window = second(60, 1_000_000);
        let video_window = StreamStats {
            fps_x10: 300,
            presented: 30,
            ..Default::default()
        };
        let readout = stream_readout(Some(window), Some(video_window), Some(31_500), 0);
        assert_eq!(readout.fps_x10, Some(600));
        assert_eq!(readout.bitrate_kbps, Some(31_500));
        assert!(stream_stats_text(&readout, Some(video_window)).contains("FPS 60.0"));
    }

    #[test]
    fn without_a_closed_window_the_video_path_supplies_the_figure() {
        let video_window = StreamStats {
            fps_x10: 599,
            presented: 60,
            ..Default::default()
        };
        assert_eq!(presented_fps_x10(None, Some(video_window)), Some(599));
        assert_eq!(
            presented_fps_x10(Some(second(0, 0)), Some(video_window)),
            Some(599)
        );
        assert_eq!(presented_fps_x10(None, None), None);
    }
}
