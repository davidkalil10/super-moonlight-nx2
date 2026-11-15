use moonlight_nx2_ui::settings::Size;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowMode {
    Fixed,
    PerMode {
        docked_width: u32,
        docked_height: u32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameRates {
    pub at_120hz: u32,
    pub at_60hz: u32,
    pub vrr: bool,
}

impl FrameRates {
    /// A frame every refresh at 120 and at 60 Hz. Asking with VRR is what makes the display
    /// prefer 120 Hz where it has it; the handheld panel reports both.
    pub const EVERY_REFRESH: Self = Self {
        at_120hz: 120,
        at_60hz: 60,
        vrr: true,
    };

    pub fn valid(self) -> bool {
        self.at_120hz <= 120 && self.at_60hz <= 60
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Capabilities {
    pub refresh_rates: u64,
    pub hdr_output_formats: u64,
    pub refresh_rates_secondary: u64,
}

const _: () = assert!(size_of::<Capabilities>() == 24 && align_of::<Capabilities>() == 8);

#[derive(Clone, Copy, Debug)]
pub struct Snapshot {
    pub operation_mode: u32,
    pub display_result: u32,
    pub dimensions_result: u32,
    pub width: u32,
    pub height: u32,
    pub rate_result: u32,
    pub nominal_hz: u32,
    pub vrr: bool,
    pub interval_result: u32,
    pub interval_numerator: u16,
    pub interval_denominator: u16,
    pub capabilities_result: u32,
    pub capabilities: Capabilities,
    pub resolution_level_result: u32,
    pub resolution_level: u32,
}

impl Snapshot {
    pub fn operation_mode(&self) -> moonlight_nx2_app::dock::Reading {
        match self.operation_mode {
            0 => moonlight_nx2_app::dock::Reading::Handheld,
            1 => moonlight_nx2_app::dock::Reading::Docked,
            _ => moonlight_nx2_app::dock::Reading::Unknown,
        }
    }
}

#[cfg(target_os = "none")]
pub(crate) fn observe() -> Option<Snapshot> {
    use crate::sdk;
    let window = unsafe { sdk::nwindowGetDefault() };
    if window.is_null() || sdk::process_retired() {
        return None;
    }
    let mut result = Snapshot {
        operation_mode: unsafe { sdk::appletGetOperationMode() },
        display_result: u32::MAX,
        dimensions_result: u32::MAX,
        width: 0,
        height: 0,
        rate_result: u32::MAX,
        nominal_hz: 0,
        vrr: false,
        interval_result: u32::MAX,
        interval_numerator: 0,
        interval_denominator: 0,
        capabilities_result: u32::MAX,
        capabilities: Capabilities::default(),
        resolution_level_result: u32::MAX,
        resolution_level: 0,
    };
    result.dimensions_result =
        unsafe { sdk::nwindowGetDimensions(window, &mut result.width, &mut result.height) };
    result.interval_result = unsafe {
        sdk::nwindowGetPresentInterval(
            window,
            &mut result.interval_numerator,
            &mut result.interval_denominator,
        )
    };
    let mut display = core::ptr::null_mut();
    result.display_result = unsafe { sdk::nwindowGetVi2Display(window, &mut display) };
    if result.display_result != 0 || display.is_null() {
        return Some(result);
    }
    result.rate_result = unsafe {
        sdk::vi2QueryDisplayRefreshRate(display, &mut result.nominal_hz, &mut result.vrr)
    };
    result.capabilities_result =
        unsafe { sdk::vi2QueryDisplayModeCapability(display, &mut result.capabilities) };
    result.resolution_level_result =
        unsafe { sdk::vi2QueryDisplayBufferMaxResolution(display, &mut result.resolution_level) };
    Some(result)
}

/// The decode-capacity build streams 120 fps on a display that stays at 60 Hz: the stream loop
/// takes two units a refresh and shows the newer frame, which measures the decoder without a
/// 120 Hz display.
const FAST_STREAM_AT_60HZ: bool = cfg!(feature = "sdk-video-120-decode");

/// Seconds in a row at 60 Hz before rates above it are taken back. A mode change or a dock
/// change not confirmed yet reads 60 Hz for less than that.
const SLOW_SECONDS: u32 = 3;

/// How long the docked output must stay the same, with no 120 Hz request, before it counts as
/// the console's own mode. A withdrawn request or a dock change takes a moment to settle.
const OUTPUT_SETTLE_NS: u64 = 2_000_000_000;

/// The console's own panel: 1080p at 120 Hz with VRR, offered before a frame is presented.
const HANDHELD: (u32, u32, u32) = (1920, 1080, 120);

/// The per-second present rate and the display modes of each operation mode. Handheld starts
/// at the panel's 1080p120. Docked starts at 60 up to the console's own output (2160p until it
/// is known), and a rate above 60 counts once a full second presented on pace at the layer's
/// size while 120 Hz is requested; it is dropped with the request. The set of the other
/// operation mode is kept, so docking back reuses what was already shown.
pub struct Probe {
    docked: bool,
    requested: bool,
    verified: [moonlight_nx2_app::policy::DisplayCapabilities; 2],
    best: [(u32, u32, u32); 2],
    output: Option<(u32, u32)>,
    seen: Option<(u32, u32, u64)>,
    slow_seconds: u32,
    second_ns: u64,
    presented: u64,
    rate: u32,
}

impl Probe {
    /// Every size up to the largest of its operation mode is offered from the start: the layer
    /// scales, so docked only rates above 60 wait for the TV to present them.
    pub fn new(docked: bool, now_ns: u64, presented: u64) -> Self {
        let mut probe = Self {
            docked,
            requested: false,
            verified: Default::default(),
            best: [HANDHELD, (3840, 2160, 60)],
            output: None,
            seen: None,
            slow_seconds: 0,
            second_ns: now_ns,
            presented,
            rate: 0,
        };
        for index in 0..2 {
            probe.reset(index);
        }
        probe
    }

    /// Starts the set of `index` again: the panel's modes handheld; docked, 60 fps up to the
    /// output and 120 up to 1440p within it. Docked 120 is offered before the TV has shown it,
    /// since only a stream chosen at 120 asks the TV for it; `cap_at_60` takes it back when the
    /// TV stays at 60.
    fn reset(&mut self, index: usize) {
        use moonlight_nx2_app::{
            dock::FAST_HEIGHT,
            policy::{DisplayEvidence, DisplayMode},
        };
        let (best_width, best_height, best_fps) = match index {
            0 => HANDHELD,
            _ => {
                let (width, height) = moonlight_nx2_app::dock::output_ceiling(self.output);
                (width, height, 60)
            }
        };
        self.verified[index] = Default::default();
        for (width, height) in Size::largest_first() {
            if width <= best_width && height <= best_height {
                let fps = if index == 1 && height <= FAST_HEIGHT {
                    120
                } else {
                    best_fps
                };
                let mode = DisplayMode { width, height, fps };
                self.verified[index].record(mode, DisplayEvidence::PresentedAndCloseVerified);
            }
        }
        self.best[index] = (best_width, best_height, best_fps);
    }

    pub fn set_docked(&mut self, docked: bool) {
        self.docked = docked;
        self.slow_seconds = 0;
        self.seen = None;
        if docked {
            self.output = None;
            self.reset(1);
        }
    }

    pub fn requested(&self) -> bool {
        self.requested
    }

    /// The window's 120 Hz request changed. Returns true when the docked set changed: a
    /// withdrawn request drops the 120 fps it verified.
    pub fn set_requested(&mut self, requested: bool) -> bool {
        let dropped = self.docked && self.requested && !requested;
        self.requested = requested;
        self.slow_seconds = 0;
        self.seen = None;
        if dropped {
            self.reset(1);
        }
        dropped
    }

    /// The console's own docked output, once settled without a request.
    pub fn output(&self) -> Option<(u32, u32)> {
        self.output
    }

    /// Call with the window's size on every display poll. Returns true when the docked set
    /// changed because the console's own output did.
    pub fn observe_output(&mut self, now_ns: u64, width: u32, height: u32) -> bool {
        if !self.docked || self.requested || width == 0 || height == 0 {
            return false;
        }
        let since = match self.seen {
            Some((seen_width, seen_height, since))
                if (seen_width, seen_height) == (width, height) =>
            {
                since
            }
            _ => {
                self.seen = Some((width, height, now_ns));
                return false;
            }
        };
        if now_ns.saturating_sub(since) < OUTPUT_SETTLE_NS || self.output == Some((width, height)) {
            return false;
        }
        self.output = Some((width, height));
        let ceiling = moonlight_nx2_app::dock::output_ceiling(self.output);
        if (self.best[1].0, self.best[1].1) == ceiling {
            return false;
        }
        self.reset(1);
        true
    }

    /// The highest rate shown so far in the current operation mode.
    pub fn verified_fps(&self) -> u32 {
        self.best[usize::from(self.docked)].2
    }

    pub fn capabilities(&self) -> moonlight_nx2_app::policy::DisplayCapabilities {
        self.verified[usize::from(self.docked)]
    }

    /// Closes a second of presents; returns the rate once at least a second has elapsed.
    pub fn second(&mut self, now_ns: u64, presented: u64) -> Option<u32> {
        let elapsed = now_ns.saturating_sub(self.second_ns);
        if elapsed < 1_000_000_000 {
            return None;
        }
        let frames = presented.saturating_sub(self.presented);
        self.rate = (frames * 1_000_000_000 / elapsed) as u32;
        self.second_ns = now_ns;
        self.presented = presented;
        Some(self.rate)
    }

    /// Call once per closed second with the display's rate. Returns true when the display
    /// stayed at 60 Hz after rates above it were verified: those modes are now capped at 60.
    pub fn cap_at_60(&mut self, hz: u32) -> bool {
        use moonlight_nx2_app::policy::{DisplayEvidence, DisplayMode};
        let index = usize::from(self.docked);
        let (best_width, best_height, _) = self.best[index];
        if hz != 60
            || self.verified[index].fastest() <= 60
            || FAST_STREAM_AT_60HZ
            || !self.requested
        {
            self.slow_seconds = 0;
            return false;
        }
        self.slow_seconds += 1;
        if self.slow_seconds < SLOW_SECONDS {
            return false;
        }
        self.slow_seconds = 0;
        for (width, height) in Size::largest_first() {
            if width <= best_width && height <= best_height {
                let mode = DisplayMode {
                    width,
                    height,
                    fps: 60,
                };
                self.verified[index].record(mode, DisplayEvidence::PresentedAndCloseVerified);
            }
        }
        self.best[index].2 = 60;
        true
    }

    /// Records 120 for the layer's sizes once the display runs at 120 Hz and the window is
    /// paced at every refresh (`every_refresh`: its present interval is 1/120). Returns true
    /// when the set for the current operation mode grew. The present count is logged, not
    /// judged: a menu that draws slower must not take 120 away from a stream.
    pub fn verify(&mut self, width: u32, height: u32, hz: u32, every_refresh: bool) -> bool {
        use moonlight_nx2_app::policy::{DisplayEvidence, DisplayMode};
        if !(FAST_STREAM_AT_60HZ || (hz == 120 && every_refresh)) {
            return false;
        }
        let fps = 120;
        let index = usize::from(self.docked);
        let (best_width, best_height, best_fps) = self.best[index];
        if width <= best_width && height <= best_height && fps <= best_fps {
            return false;
        }
        let mut grew = false;
        for (size_width, size_height) in Size::largest_first() {
            if size_width <= width && size_height <= height {
                let mode = DisplayMode {
                    width: size_width,
                    height: size_height,
                    fps,
                };
                grew |=
                    self.verified[index].record(mode, DisplayEvidence::PresentedAndCloseVerified);
            }
        }
        if grew {
            self.best[index] = (
                width.max(best_width),
                height.max(best_height),
                fps.max(best_fps),
            );
        }
        grew
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlight_nx2_app::{
        policy::DisplayCapabilities,
        request::{Codec, Options},
    };

    const SECOND: u64 = 1_000_000_000;

    fn mode(width: u32, height: u32, fps: u32) -> Options {
        Options {
            width,
            height,
            fps,
            codec: Codec::Hevc,
            bitrate_kbps: 1,
            sops: false,
            local_audio: false,
            quit_on_stop: false,
            transport: None,
        }
    }

    fn largest_at(set: DisplayCapabilities, fps: u32) -> Option<u32> {
        [2160, 1440, 1080, 720]
            .into_iter()
            .find(|&height| set.supports(&mode(height * 16 / 9, height, fps)))
    }

    pub(super) fn settle_pub(probe: &mut Probe, w: u32, h: u32) -> bool {
        settle(probe, w, h)
    }
    fn settle(probe: &mut Probe, width: u32, height: u32) -> bool {
        probe.observe_output(0, width, height);
        probe.observe_output(OUTPUT_SETTLE_NS, width, height)
    }

    #[test]
    fn docked_sizes_follow_the_console_output_once_settled() {
        let mut probe = Probe::new(true, 0, 0);
        assert_eq!(largest_at(probe.capabilities(), 60), Some(2160));
        probe.observe_output(0, 2560, 1440);
        assert!(!probe.observe_output(SECOND, 2560, 1440));
        assert_eq!(probe.output(), None);
        assert!(probe.observe_output(OUTPUT_SETTLE_NS, 2560, 1440));
        assert_eq!(probe.output(), Some((2560, 1440)));
        assert_eq!(largest_at(probe.capabilities(), 60), Some(1440));
        assert!(settle(&mut probe, 3840, 2160));
        assert_eq!(largest_at(probe.capabilities(), 60), Some(2160));
    }

    #[test]
    fn the_output_is_not_learned_while_120_hz_is_requested() {
        let mut probe = Probe::new(true, 0, 0);
        assert!(!settle(&mut probe, 3840, 2160), "4K is already the ceiling");
        assert_eq!(probe.output(), Some((3840, 2160)));
        probe.set_requested(true);
        assert!(!settle(&mut probe, 2560, 1440));
        assert_eq!(probe.output(), Some((3840, 2160)));
    }

    #[test]
    fn docked_offers_120_up_to_1440p_until_the_tv_stays_at_60() {
        let mut probe = Probe::new(true, 0, 0);
        settle(&mut probe, 3840, 2160);
        assert_eq!(largest_at(probe.capabilities(), 120), Some(1440));
        assert_eq!(largest_at(probe.capabilities(), 60), Some(2160));
        assert_eq!(probe.verified_fps(), 60);
        assert!(!probe.set_requested(true));
        assert!(probe.verify(2560, 1440, 120, true));
        assert_eq!(probe.verified_fps(), 120);
        assert!(probe.set_requested(false));
        assert!(!probe.set_requested(true));
        for _ in 1..SLOW_SECONDS {
            assert!(!probe.cap_at_60(60));
        }
        assert!(probe.cap_at_60(60));
        assert_eq!(largest_at(probe.capabilities(), 120), None);
        assert_eq!(largest_at(probe.capabilities(), 60), Some(2160));
        assert!(probe.set_requested(false));
        assert_eq!(largest_at(probe.capabilities(), 120), Some(1440));
    }

    #[test]
    fn auto_on_a_4k60_tv_steps_to_1440p120_and_asks_for_120_hz() {
        // test2 docked: the TV at 3840x2160@60 level=3, 120 Hz never asked for since 13af459,
        // so 120 fps was never offered.
        use moonlight_nx2_ui::settings::{Setting, Settings};
        let mut probe = Probe::new(true, 0, 0);
        settle(&mut probe, 3840, 2160);
        let context = moonlight_nx2_app::policy::Context {
            docked: true,
            decoder: crate::sdk_modes::capabilities(),
            display: probe.capabilities(),
        };
        let caps = crate::client::ui_capabilities(&context);
        let settings = Settings::default();
        let rows = settings.rows(true, &caps);
        assert_eq!(rows[Setting::Size as usize].value.as_str(), "Auto (2160p)");
        assert_eq!(
            rows[Setting::Fps as usize].value.as_str(),
            "60 fps \u{b7} 120 below 4K"
        );
        assert!(rows[Setting::Fps as usize].can_right);
        let faster = settings.adjust(Setting::Fps, 1, true, &caps).unwrap();
        let options = faster.stream_options(true, &caps);
        assert_eq!((options.height, options.fps), (1440, 120));
        let size = faster.size();
        assert!(moonlight_nx2_app::dock::requests_120hz(
            true,
            (!faster.size_auto()).then(|| (size.width(), size.height())),
            faster.fps(),
            probe.output(),
        ));
    }

    #[test]
    fn docked_h264_1440p_offers_120_before_the_tv_has_shown_it() {
        // test2 on the console: H.264 saved at 60 from test1, so the TV was never asked for
        // 120 Hz and 120 fps was never offered to pick.
        use moonlight_nx2_ui::settings::{Codec, Setting, Settings};
        let mut probe = Probe::new(true, 0, 0);
        settle(&mut probe, 2560, 1440);
        let context = moonlight_nx2_app::policy::Context {
            docked: true,
            decoder: crate::sdk_modes::capabilities(),
            display: probe.capabilities(),
        };
        let caps = crate::client::ui_capabilities(&context);
        let mut settings = Settings::default();
        while settings.codec() != Codec::H264 {
            settings = settings.adjust(Setting::Codec, -1, true, &caps).unwrap();
        }
        settings = settings.adjust(Setting::Fps, -1, true, &caps).unwrap();
        let rows = settings.rows(true, &caps);
        assert_eq!(rows[Setting::Fps as usize].value.as_str(), "60 fps");
        let faster = settings.adjust(Setting::Fps, 1, true, &caps).unwrap();
        let options = faster.stream_options(true, &caps);
        assert_eq!((options.height, options.fps), (1440, 120));
    }

    #[test]
    fn handheld_offers_the_panels_1080p120_before_anything_is_presented() {
        let probe = Probe::new(false, 0, 0);
        assert_eq!(largest_at(probe.capabilities(), 120), Some(1080));
        assert_eq!(probe.verified_fps(), 120);
        let mut docked = Probe::new(true, 0, 0);
        assert_eq!(largest_at(docked.capabilities(), 120), Some(1440));
        assert_eq!(docked.verified_fps(), 60);
        docked.set_docked(false);
        assert_eq!(largest_at(docked.capabilities(), 120), Some(1080));
    }

    #[test]
    fn handheld_1080p_offers_and_picks_120_fps_on_the_first_context() {
        use moonlight_nx2_core::codec::{self, Depth, Evidence};
        use moonlight_nx2_ui::settings::{Setting, Settings};
        let mut decoder = codec::Capabilities::default();
        decoder.record(
            codec::Mode {
                codec: codec::Codec::Av1,
                depth: Depth::Eight,
                maximum: codec::Size::new(3840, 2160).unwrap(),
                fps: 120,
            },
            Evidence::PixelsAndCloseVerified,
        );
        let context = moonlight_nx2_app::policy::Context {
            docked: false,
            decoder,
            display: Probe::new(false, 0, 0).capabilities(),
        };
        let caps = crate::client::ui_capabilities(&context);
        assert!(caps.fps120);
        let settings = Settings::default();
        let options = settings.stream_options(false, &caps);
        assert_eq!((options.height, options.fps), (1080, 120));
        let rows = settings.rows(false, &caps);
        assert_eq!(rows[Setting::Fps as usize].value.as_str(), "120 fps");
    }

    #[test]
    fn handheld_keeps_1080p120_and_only_caps_at_60_while_requested() {
        let mut probe = Probe::new(false, 0, 0);
        assert!(!settle(&mut probe, 1920, 1080));
        probe.set_requested(true);
        assert!(!probe.verify(1920, 1080, 120, true));
        assert_eq!(largest_at(probe.capabilities(), 120), Some(1080));
        assert!(!probe.set_requested(false));
        for _ in 0..SLOW_SECONDS {
            assert!(!probe.cap_at_60(60));
        }
        assert_eq!(largest_at(probe.capabilities(), 120), Some(1080));
    }

    #[test]
    fn docking_forgets_the_last_output() {
        let mut probe = Probe::new(true, 0, 0);
        settle(&mut probe, 2560, 1440);
        probe.set_docked(false);
        probe.set_docked(true);
        assert_eq!(probe.output(), None);
        assert_eq!(largest_at(probe.capabilities(), 60), Some(2160));
    }
}
