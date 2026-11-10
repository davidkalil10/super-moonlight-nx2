use crate::frame_registration::Registry;
use core::{
    cell::UnsafeCell,
    ffi::c_void,
    sync::atomic::{AtomicBool, Ordering},
};

static RETIRED: AtomicBool = AtomicBool::new(false);

pub fn retire_process() {
    RETIRED.store(true, Ordering::Release);
}

pub fn process_retired() -> bool {
    RETIRED.load(Ordering::Acquire)
}

pub const BAD_INPUT: u32 = (11 << 9) | 345;

unsafe extern "C" {
    pub fn armDCacheFlush(address: *mut c_void, bytes: usize);
    pub fn appletMainLoop() -> bool;
    pub fn svcSleepThread(ns: i64);
    pub fn svcExitProcess() -> !;
    pub fn moonlightNowNs() -> u64;
    pub fn mutexLock(mutex: *mut u32);
    pub fn mutexUnlock(mutex: *mut u32);
    pub fn nwindowGetDefault() -> *mut c_void;
    pub fn nwindowSetDimensions(window: *mut c_void, width: u32, height: u32) -> u32;
    pub fn nwindowGetDimensions(window: *mut c_void, width: *mut u32, height: *mut u32) -> u32;
    pub fn nwindowSetModeDimensions(
        window: *mut c_void,
        handheld_width: u32,
        handheld_height: u32,
        docked_width: u32,
        docked_height: u32,
    ) -> u32;
    pub fn nwindowSetFrameRates(window: *mut c_void, at_120hz: u32, at_60hz: u32, vrr: bool)
    -> u32;
    pub fn nwindowGetPresentInterval(
        window: *mut c_void,
        numerator: *mut u16,
        denominator: *mut u16,
    ) -> u32;
    pub fn nwindowSetSwapInterval(window: *mut c_void, interval: u32) -> u32;
    pub fn nwindowGetVi2Display(window: *mut c_void, display: *mut *mut c_void) -> u32;
    pub fn vi2QueryDisplayRefreshRate(display: *mut c_void, hz: *mut u32, vrr: *mut bool) -> u32;
    pub fn vi2QueryDisplayModeCapability(
        display: *mut c_void,
        capabilities: *mut crate::display::Capabilities,
    ) -> u32;
    pub fn vi2QueryDisplayBufferMaxResolution(display: *mut c_void, level: *mut u32) -> u32;
    pub fn appletGetOperationMode() -> u32;
    pub fn nwindowReleaseVi2Layer(window: *mut c_void) -> u32;
    fn __real_gsvRegisterFrame(requested: u64, permitted: *mut u64) -> u32;
}

struct FrameCache {
    mutex: UnsafeCell<u32>,
    registry: UnsafeCell<Registry>,
}
unsafe impl core::marker::Sync for FrameCache {}
static FRAME_CACHE: FrameCache = FrameCache {
    mutex: UnsafeCell::new(0),
    registry: UnsafeCell::new(Registry::new()),
};

/// # Safety
/// A non-null output must name a writable u64; the SDK owns the request's lifetime.
#[unsafe(export_name = "__wrap_gsvRegisterFrame")]
pub unsafe extern "C" fn register_frame(requested: u64, output: *mut u64) -> u32 {
    unsafe { mutexLock(FRAME_CACHE.mutex.get()) };
    let registry = unsafe { &mut *FRAME_CACHE.registry.get() };
    let result = registry.register(requested, BAD_INPUT, |mode| {
        let mut permitted = 0;
        let result = unsafe { __real_gsvRegisterFrame(mode, &mut permitted) };
        if result == 0 {
            Ok(permitted)
        } else {
            Err(result)
        }
    });
    let code = match result {
        Ok(permitted) => {
            if !output.is_null() {
                unsafe { output.write(permitted) };
            }
            0
        }
        Err(result) => result,
    };
    unsafe { mutexUnlock(FRAME_CACHE.mutex.get()) };
    code
}
