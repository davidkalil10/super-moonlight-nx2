use ash::vk;
use core::{
    ffi::c_void,
    mem, ptr,
    sync::atomic::{AtomicUsize, Ordering},
};
use std::alloc::{self, Layout};

static LIVE: AtomicUsize = AtomicUsize::new(0);
static CALLS: AtomicUsize = AtomicUsize::new(0);
static FAIL_AT: AtomicUsize = AtomicUsize::new(0);

struct Callbacks(vk::AllocationCallbacks);
unsafe impl Sync for Callbacks {}
static CALLBACKS: Callbacks = Callbacks(vk::AllocationCallbacks {
    p_user_data: ptr::null_mut(),
    pfn_allocation: Some(allocate),
    pfn_reallocation: Some(reallocate),
    pfn_free: Some(release),
    pfn_internal_allocation: None,
    pfn_internal_free: None,
});

#[repr(C)]
struct Header {
    base: *mut u8,
    bytes: usize,
    allocation: usize,
    alignment: usize,
}

unsafe extern "system" fn allocate(
    _user: *mut c_void,
    bytes: usize,
    alignment: usize,
    _scope: vk::SystemAllocationScope,
) -> *mut c_void {
    let alignment = alignment.max(mem::align_of::<Header>());
    if !alignment.is_power_of_two() {
        return ptr::null_mut();
    }
    let Some(prefix) = mem::size_of::<Header>()
        .checked_add(alignment - 1)
        .map(|size| size & !(alignment - 1))
    else {
        return ptr::null_mut();
    };
    let Some(size) = prefix.checked_add(bytes.max(1)) else {
        return ptr::null_mut();
    };
    let Ok(layout) = Layout::from_size_align(size, alignment) else {
        return ptr::null_mut();
    };
    let base = unsafe { alloc::alloc(layout) };
    if base.is_null() {
        return ptr::null_mut();
    }
    let pointer = unsafe { base.add(prefix) };
    unsafe {
        pointer
            .sub(mem::size_of::<Header>())
            .cast::<Header>()
            .write(Header {
                base,
                bytes,
                allocation: size,
                alignment,
            })
    };
    LIVE.fetch_add(1, Ordering::AcqRel);
    pointer.cast()
}

unsafe extern "system" fn release(_user: *mut c_void, memory: *mut c_void) {
    if memory.is_null() {
        return;
    }
    let header = unsafe {
        memory
            .cast::<u8>()
            .sub(mem::size_of::<Header>())
            .cast::<Header>()
            .read()
    };
    let layout = Layout::from_size_align(header.allocation, header.alignment).unwrap();
    unsafe { alloc::dealloc(header.base, layout) };
    LIVE.fetch_sub(1, Ordering::AcqRel);
}

unsafe extern "system" fn reallocate(
    user: *mut c_void,
    original: *mut c_void,
    bytes: usize,
    alignment: usize,
    scope: vk::SystemAllocationScope,
) -> *mut c_void {
    if original.is_null() {
        return unsafe { allocate(user, bytes, alignment, scope) };
    }
    if bytes == 0 {
        unsafe { release(user, original) };
        return ptr::null_mut();
    }
    let target = unsafe { allocate(user, bytes, alignment, scope) };
    if target.is_null() {
        return target;
    }
    let previous = unsafe {
        &*original
            .cast::<u8>()
            .sub(mem::size_of::<Header>())
            .cast::<Header>()
    };
    unsafe {
        ptr::copy_nonoverlapping(
            original.cast::<u8>(),
            target.cast::<u8>(),
            previous.bytes.min(bytes),
        );
        release(user, original)
    };
    target
}

pub fn allocator() -> &'static vk::AllocationCallbacks {
    &CALLBACKS.0
}
pub fn point() -> Result<(), vk::Result> {
    let call = CALLS.fetch_add(1, Ordering::AcqRel) + 1;
    if FAIL_AT.load(Ordering::Acquire) == call {
        Err(vk::Result::ERROR_OUT_OF_HOST_MEMORY)
    } else {
        Ok(())
    }
}
pub fn fail_at(call: usize) {
    CALLS.store(0, Ordering::Release);
    FAIL_AT.store(call, Ordering::Release);
}
pub fn calls() -> usize {
    CALLS.load(Ordering::Acquire)
}
pub fn live() -> usize {
    LIVE.load(Ordering::Acquire)
}
