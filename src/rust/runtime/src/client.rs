extern crate alloc;

use alloc::{boxed::Box, vec::Vec};
use moonlight_nx2_app::{
    driver::{Driver, Effect, Ui},
    link::Link,
    service::{Action, RuntimeEvent},
};
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

pub struct SingleList<L> {
    pub link: L,
    sent: bool,
    rejected: bool,
}

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
        self.0.reduce(event)
    }

    fn allow_input(&self) -> bool {
        self.0.allow_input()
    }

    fn stream_options(&self) -> StreamOptions {
        let model = self.0.model();
        model
            .settings()
            .stream_options(model.docked(), model.capabilities())
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
    badge: crate::policy_badge::Badge,
}

fn ui_capabilities(context: &moonlight_nx2_app::policy::Context) -> Capabilities {
    use moonlight_nx2_app::{request, stream};
    let mut result = Capabilities::default();
    for (width, height) in [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)] {
        for fps in [60, 120] {
            for codec in [request::Codec::H264, request::Codec::Av1] {
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
                result.h264 |= codec == request::Codec::H264;
                result.av1 |= codec == request::Codec::Av1;
                result.fps120 |= fps == 120;
                result.docked_sizes |= codec == request::Codec::Av1 && width > 1920;
            }
        }
    }
    result
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
            self.bridge
                .set_stream_stats("FPS --   Bitrate --   Latency --");
        }
        let storage = storage(bytes)?;
        let active = self.bridge.model().screen() == Screen::Streaming
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
        let enabled = View(&mut self.bridge).stream_options().menu_chord;
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

    pub fn paint_policy(
        &mut self,
        bytes: &mut [u8],
        feedback: moonlight_nx2_app::policy::Feedback,
    ) -> Result<bool, Error> {
        if let moonlight_nx2_app::policy::Feedback::Metrics { epoch, report } = feedback
            && self.driver.session_epoch() == Some(epoch)
        {
            let second = report.second;
            let (fps, kbps) = if second.elapsed_us == 0 {
                (
                    alloc::string::String::from("--"),
                    alloc::string::String::from("--"),
                )
            } else {
                (
                    alloc::format!(
                        "{}",
                        u128::from(second.presented) * 1_000_000 / u128::from(second.elapsed_us)
                    ),
                    alloc::format!(
                        "{}",
                        u128::from(second.bytes) * 8_000 / u128::from(second.elapsed_us)
                    ),
                )
            };
            let latency = second
                .receive_to_present
                .map(|value| alloc::format!("{} ms", value.mean_ms()))
                .unwrap_or_else(|| alloc::string::String::from("--"));
            self.bridge.set_stream_stats(&alloc::format!(
                "FPS {fps}   Bitrate {kbps} kbps   Receive to present {latency}"
            ));
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
