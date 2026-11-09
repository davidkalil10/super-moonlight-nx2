extern crate alloc;

use crate::sdk;
use core::{ffi::c_void, mem::MaybeUninit};
use moonlight_nx2_core::decoder::BackendError;

pub(crate) fn call<F: FnOnce() -> R, R>(operation: F) -> Result<R, BackendError> {
    call_inner(operation, false)
}

pub(crate) fn call_before_open<F: FnOnce() -> R, R>(operation: F) -> Result<R, BackendError> {
    call_inner(operation, true)
}

fn call_inner<F: FnOnce() -> R, R>(operation: F, clean_refusal: bool) -> Result<R, BackendError> {
    struct Context<F, R> {
        operation: Option<F>,
        result: MaybeUninit<R>,
        called: bool,
    }
    unsafe extern "C" fn invoke<F: FnOnce() -> R, R>(context: *mut c_void) {
        let context = unsafe { &mut *context.cast::<Context<F, R>>() };
        if let Some(operation) = context.operation.take() {
            context.result.write(operation());
            context.called = true;
        }
    }
    unsafe extern "C" {
        fn moonlightNativeOwnerCall(
            callback: unsafe extern "C" fn(*mut c_void),
            context: *mut c_void,
        ) -> u32;
    }
    if sdk::process_retired() {
        return Err(BackendError::Uncertain);
    }
    let mut context = Context {
        operation: Some(operation),
        result: MaybeUninit::uninit(),
        called: false,
    };
    let raw = unsafe {
        moonlightNativeOwnerCall(invoke::<F, R>, (&mut context as *mut Context<F, R>).cast())
    };
    if raw != 0 || !context.called || sdk::process_retired() {
        crate::device::log(&alloc::format!(
            "b2ar: owner call result={raw} callback={} retired={}",
            context.called,
            sdk::process_retired()
        ));
        if clean_refusal && !context.called && !sdk::process_retired() {
            return Err(BackendError::Refused);
        }
        sdk::retire_process();
        return Err(BackendError::Uncertain);
    }
    Ok(unsafe { context.result.assume_init() })
}
