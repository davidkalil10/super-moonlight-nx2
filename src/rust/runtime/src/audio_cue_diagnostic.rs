use crate::{audio_device::Audout, device::log, sdk};
use core::{
    cell::UnsafeCell,
    fmt::{self, Write},
    sync::atomic::{AtomicBool, Ordering},
};
use moonlight_nx2_io::{
    audio::{Retained, SLOT_BYTES, SLOTS, Slots},
    audio_cue,
};

struct Storage(UnsafeCell<Slots>);
unsafe impl Sync for Storage {}
static STORAGE: Storage = Storage(UnsafeCell::new(Slots([[0; SLOT_BYTES]; SLOTS])));
static TAKEN: AtomicBool = AtomicBool::new(false);

struct Clock;
impl audio_cue::Clock for Clock {
    fn now_ms(&mut self) -> u64 {
        (unsafe { sdk::moonlightNowNs() }) / 1_000_000
    }
    fn idle(&mut self) {
        unsafe { sdk::svcSleepThread(1_000_000) };
    }
}

struct Lines {
    bytes: [u8; 512],
    length: usize,
}
impl Write for Lines {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        for byte in text.bytes() {
            if byte == b'\n' {
                log(core::str::from_utf8(&self.bytes[..self.length]).map_err(|_| fmt::Error)?);
                self.length = 0;
            } else {
                if self.length == self.bytes.len() {
                    return Err(fmt::Error);
                }
                self.bytes[self.length] = byte;
                self.length += 1;
            }
        }
        Ok(())
    }
}

pub fn check() -> bool {
    if TAKEN.swap(true, Ordering::AcqRel) {
        log("cue: storage already used; refusing to run");
        return false;
    }
    let slots = unsafe { &mut *STORAGE.0.get() };
    let (report, retained) = audio_cue::run(&mut Clock, Audout::new(), slots);
    let mut out = Lines {
        bytes: [0; 512],
        length: 0,
    };
    let logged = report.write(&mut out).is_ok();
    if !logged {
        log("cue: report formatting failed");
    }
    match retained {
        Retained::Returned(device, _) => {
            let _ = writeln!(out, "cue.last_sdk_result=0x{:08x}", device.last_result());
        }
        Retained::Kept => sdk::retire_process(),
    }
    logged && report.passed()
}
