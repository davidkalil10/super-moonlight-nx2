extern crate alloc;

use core::{
    alloc::{GlobalAlloc, Layout},
    ffi::c_void,
    panic::PanicInfo,
};

unsafe extern "C" {
    fn moonlightPlatformStart() -> bool;
    fn moonlightPlatformLog(message: *const u8, bytes: usize);
    fn moonlightPlatformFinish() -> bool;
    fn moonlightPlatformAbort() -> !;
    fn moonlightAllocate(bytes: usize, alignment: usize) -> *mut c_void;
    fn moonlightFree(memory: *mut c_void);
}

struct Allocator;

unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { moonlightAllocate(layout.size(), layout.align()).cast() }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, _layout: Layout) {
        unsafe { moonlightFree(pointer.cast()) };
    }
}

#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

#[panic_handler]
fn panic(_info: &PanicInfo<'_>) -> ! {
    unsafe { moonlightPlatformAbort() }
}

pub(super) fn log(message: &str) {
    unsafe { moonlightPlatformLog(message.as_ptr(), message.len()) };
}

#[unsafe(export_name = "moonlightRustMain")]
pub extern "C" fn main() -> i32 {
    if !unsafe { moonlightPlatformStart() } {
        return 1;
    }
    log("Moonlight NX2 Rust frontend; native video behind verified capabilities");
    log("runtime: source revision follows");
    log(match option_env!("MOONLIGHT_REVISION") {
        Some(revision) => revision,
        None => "unknown",
    });
    let passed = crate::native_frontend::run();
    log(if passed {
        "runtime: result PASS"
    } else {
        "runtime: result FAIL"
    });
    let retired = crate::sdk::process_retired();
    if retired {
        log("runtime: retained resources; exit process, restart before another GPU test");
    }
    let closed = unsafe { moonlightPlatformFinish() };
    if retired {
        unsafe { crate::sdk::svcExitProcess() }
    }
    i32::from(!passed || !closed)
}
