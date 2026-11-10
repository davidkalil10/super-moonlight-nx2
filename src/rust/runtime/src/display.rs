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

/// The per-second present rate and the display modes of each operation mode. Sizes are shown
/// at 60 from the start, up to 1080p handheld and 2160p docked. A rate above 60 counts once a
/// full second presented on pace at the layer's size; the set of the other operation mode is
/// kept, so docking back reuses what was already shown.
pub struct Probe {
    docked: bool,
    verified: [moonlight_nx2_app::policy::DisplayCapabilities; 2],
    best: [(u32, u32, u32); 2],
    slow_seconds: u32,
    second_ns: u64,
    presented: u64,
    rate: u32,
}

impl Probe {
    /// Every size up to the largest of its operation mode is shown at 60 from the start: the
    /// layer scales, so only rates above 60 wait for the display to present them.
    pub fn new(docked: bool, now_ns: u64, presented: u64) -> Self {
        use moonlight_nx2_app::policy::{DisplayEvidence, DisplayMode};
        let best = [(1920, 1080, 60), (3840, 2160, 60)];
        let mut verified: [moonlight_nx2_app::policy::DisplayCapabilities; 2] = Default::default();
        for (set, (best_width, best_height, fps)) in verified.iter_mut().zip(best) {
            for (width, height) in Size::largest_first() {
                if width <= best_width && height <= best_height {
                    let mode = DisplayMode { width, height, fps };
                    set.record(mode, DisplayEvidence::PresentedAndCloseVerified);
                }
            }
        }
        Self {
            docked,
            verified,
            best,
            slow_seconds: 0,
            second_ns: now_ns,
            presented,
            rate: 0,
        }
    }

    pub fn set_docked(&mut self, docked: bool) {
        self.docked = docked;
        self.slow_seconds = 0;
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
        let (best_width, best_height, best_fps) = self.best[index];
        if hz != 60 || best_fps <= 60 || FAST_STREAM_AT_60HZ {
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
        if !FAST_STREAM_AT_60HZ && !(hz == 120 && every_refresh) {
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
