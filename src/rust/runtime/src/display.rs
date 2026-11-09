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
