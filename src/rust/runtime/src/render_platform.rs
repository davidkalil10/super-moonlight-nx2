use ash::{Entry, Instance, vk};
#[cfg(target_os = "none")]
extern crate alloc;
use core::ffi::c_char;

#[cfg(target_os = "none")]
pub(crate) use crate::{
    device::log,
    sdk::{process_retired, retire_process},
};

pub fn flush_cpu_cache(address: *mut u8, bytes: usize) {
    #[cfg(target_os = "none")]
    unsafe {
        crate::sdk::armDCacheFlush(address.cast(), bytes);
    }
    #[cfg(not(target_os = "none"))]
    let _ = (address, bytes);
}

pub fn now_ns() -> u64 {
    #[cfg(target_os = "none")]
    {
        unsafe { crate::sdk::moonlightNowNs() }
    }
    #[cfg(not(target_os = "none"))]
    {
        host::now_ns()
    }
}

pub fn sleep_ns(ns: u64) {
    #[cfg(target_os = "none")]
    unsafe {
        crate::sdk::svcSleepThread(i64::try_from(ns).unwrap_or(i64::MAX));
    }
    #[cfg(not(target_os = "none"))]
    std::thread::sleep(std::time::Duration::from_nanos(ns));
}

pub fn extensions() -> [*const c_char; 2] {
    [ash::khr::surface::NAME.as_ptr(), {
        #[cfg(target_os = "none")]
        {
            ash::nn::vi_surface::NAME.as_ptr()
        }
        #[cfg(not(target_os = "none"))]
        {
            ash::ext::headless_surface::NAME.as_ptr()
        }
    }]
}

pub fn create_surface(
    entry: &Entry,
    instance: &Instance,
    config: &crate::render::Config,
    layer: &mut bool,
    allocator: Option<&vk::AllocationCallbacks>,
) -> Result<vk::SurfaceKHR, vk::Result> {
    #[cfg(target_os = "none")]
    unsafe {
        let window = crate::sdk::nwindowGetDefault();
        if window.is_null() {
            return Err(vk::Result::ERROR_INITIALIZATION_FAILED);
        }
        *layer = true;
        let code = match config.window_mode {
            crate::display::WindowMode::Fixed => {
                crate::sdk::nwindowSetDimensions(window, config.width, config.height)
            }
            crate::display::WindowMode::PerMode {
                docked_width,
                docked_height,
            } => crate::sdk::nwindowSetModeDimensions(
                window,
                config.width,
                config.height,
                docked_width,
                docked_height,
            ),
        };
        if code != 0 {
            log(&alloc::format!(
                "render: window dimensions result=0x{code:x}"
            ));
            return Err(vk::Result::ERROR_INITIALIZATION_FAILED);
        }
        set_frame_rates(config.frame_rates);
        ash::nn::vi_surface::Instance::load(entry, instance).create_vi_surface(
            &vk::ViSurfaceCreateInfoNN::default().window(window),
            allocator,
        )
    }
    #[cfg(not(target_os = "none"))]
    unsafe {
        let _ = (config, layer);
        ash::ext::headless_surface::Instance::load(entry, instance)
            .create_headless_surface(&vk::HeadlessSurfaceCreateInfoEXT::default(), allocator)
    }
}

/// Asks the display for 120 Hz and VRR with `rates`, or withdraws both: the window then
/// presents every 1/60 s and the console picks its own output mode again.
pub fn set_frame_rates(rates: Option<crate::display::FrameRates>) {
    #[cfg(target_os = "none")]
    unsafe {
        let window = crate::sdk::nwindowGetDefault();
        match rates {
            Some(rates) => {
                let code = crate::sdk::nwindowSetFrameRates(
                    window,
                    rates.at_120hz,
                    rates.at_60hz,
                    rates.vrr,
                );
                log(&alloc::format!(
                    "render: window frame rates {}/{} vrr={} result=0x{code:x}",
                    rates.at_120hz,
                    rates.at_60hz,
                    rates.vrr
                ));
            }
            None => {
                let interval = crate::sdk::nwindowSetSwapInterval(window, 1);
                let vrr = crate::sdk::nwindowSetVrr(window, false);
                log(&alloc::format!(
                    "render: window interval 1/60, 120Hz and VRR request withdrawn result=0x{interval:x}/0x{vrr:x}"
                ));
            }
        }
    }
    #[cfg(not(target_os = "none"))]
    {
        let _ = rates;
    }
}

pub fn release_layer() -> u32 {
    set_frame_rates(None);
    #[cfg(target_os = "none")]
    {
        unsafe { crate::sdk::nwindowReleaseVi2Layer(crate::sdk::nwindowGetDefault()) }
    }
    #[cfg(not(target_os = "none"))]
    {
        0
    }
}

#[cfg(not(target_os = "none"))]
mod host {
    use core::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    static RETIRED: AtomicBool = AtomicBool::new(false);
    pub fn log(message: &str) {
        eprintln!("{message}");
    }
    pub fn now_ns() -> u64 {
        static CLOCK: OnceLock<std::time::Instant> = OnceLock::new();
        CLOCK
            .get_or_init(std::time::Instant::now)
            .elapsed()
            .as_nanos() as u64
    }
    pub fn retire_process() {
        RETIRED.store(true, Ordering::Release);
    }
    pub fn process_retired() -> bool {
        RETIRED.load(Ordering::Acquire)
    }
}
#[cfg(not(target_os = "none"))]
pub use host::*;
