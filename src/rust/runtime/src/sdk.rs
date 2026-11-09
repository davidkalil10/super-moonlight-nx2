use crate::frame_registration::Registry;
use core::{
    cell::UnsafeCell,
    ffi::{c_char, c_void},
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

#[repr(C)]
#[derive(Default)]
pub struct Service {
    pub session: u32,
}
#[repr(C)]
#[derive(Default)]
pub struct Sync {
    pub service: Service,
    pub capacity: u32,
}
#[repr(C)]
#[derive(Default)]
pub struct Gpu {
    pub main: Service,
    pub worker: Service,
}
#[repr(C)]
#[derive(Default)]
pub struct Event {
    pub read: u32,
    pub write: u32,
    pub autoclear: bool,
}
#[repr(C)]
#[derive(Default)]
pub struct TransferMemory {
    pub handle: u32,
    pub bytes: usize,
    pub permission: u32,
    pub source: *mut c_void,
    pub mapped: *mut c_void,
}
#[repr(C)]
#[derive(Default)]
pub struct MemoryInfo {
    pub address: u64,
    pub bytes: u64,
    pub kind: u32,
    pub attributes: u32,
    pub permission: u32,
    pub ipc_references: u32,
    pub device_references: u32,
    pub padding: u32,
}

unsafe extern "C" {
    pub fn appletMainLoop() -> bool;
    pub fn gsvInitialize() -> u32;
    pub fn gsvExit();
    pub fn gsvGetServiceSession() -> *mut Service;
    pub fn gsvOpenSync(sync: *mut Sync) -> u32;
    pub fn gsvSyncClose(sync: *mut Sync);
    pub fn gsvSyncReadCounter(sync: *mut Sync, counter: u32, value: *mut u64, mode: *mut u8)
    -> u32;
    pub fn gsvOpenGpu(gpu: *mut Gpu) -> u32;
    pub fn gsvGpuClose(gpu: *mut Gpu);
    pub fn gsvGpuGetSlotRange(gpu: *mut Gpu, first: *mut u32, last: *mut u32) -> u32;
    pub fn gsvGpuCreateSlotEvent(
        gpu: *mut Gpu,
        slot: u32,
        event: *mut Event,
        autoclear: bool,
    ) -> u32;
    pub fn gsvGpuRegisterClient(gpu: *mut Gpu, name: u64, client: *mut u8) -> u32;
    pub fn gsvGpuReleaseClient(gpu: *mut Gpu, client: u8) -> u32;
    pub fn gsvGpuRegisterMemory(
        gpu: *mut Gpu,
        address: u64,
        bytes: u64,
        client: u8,
        range: *mut u32,
    ) -> u32;
    pub fn gsvGpuUnregisterMemory(gpu: *mut Gpu, range: u32, slot: u32) -> u32;
    pub fn gsvReserveImageMemory(kind: u8, bytes: u64, memory: *mut u32) -> u32;
    pub fn gsvRegisterImageMemory(
        memory: u32,
        address: u64,
        bytes: u64,
        gpu_range: u32,
        offset: u64,
    ) -> u32;
    pub fn gsvReleaseImageMemory(memory: u32) -> u32;
    pub fn eventWait(event: *mut Event, timeout_ns: u64) -> u32;
    pub fn eventClear(event: *mut Event) -> u32;
    pub fn eventClose(event: *mut Event);
    pub fn svcSendSyncRequest(session: u32) -> u32;
    pub fn svcCloseHandle(handle: u32) -> u32;
    pub fn svcUnknown80(address: *mut c_void, bytes: u64, mask: u32, value: u32) -> u32;
    pub fn svcQueryMemory(info: *mut MemoryInfo, page: *mut u32, address: u64) -> u32;
    pub fn svcSleepThread(ns: i64);
    pub fn svcExitProcess() -> !;
    pub fn tmemCreateFromMemory(
        memory: *mut TransferMemory,
        address: *mut c_void,
        bytes: usize,
        permission: u32,
    ) -> u32;
    pub fn tmemCloseHandle(memory: *mut TransferMemory) -> u32;
    pub fn armDCacheFlush(address: *mut c_void, bytes: usize);
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
    pub fn nvInitialize() -> u32;
    pub fn nvExit();
    pub fn nvOpen(fd: *mut u32, path: *const c_char) -> u32;
    pub fn nvClose(fd: u32) -> u32;
    pub fn nvIoctl(fd: u32, request: u32, argument: *mut c_void) -> u32;
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

pub fn permitted_frame_mode() -> Option<u64> {
    unsafe { mutexLock(FRAME_CACHE.mutex.get()) };
    let result = unsafe { &*FRAME_CACHE.registry.get() }.permitted();
    unsafe { mutexUnlock(FRAME_CACHE.mutex.get()) };
    result
}

pub fn tls() -> *mut u8 {
    let pointer;
    unsafe {
        core::arch::asm!("mrs {pointer}, tpidrro_el0", pointer = out(reg) pointer, options(nomem, nostack, preserves_flags))
    };
    pointer
}
