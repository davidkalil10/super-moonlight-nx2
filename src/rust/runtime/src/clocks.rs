//! Clock readings every few seconds of a stream, through `nro/clocks.c`. Nothing is changed,
//! and the sessions are closed when the stream ends.

extern crate alloc;

use crate::device::log;
use alloc::format;

const READ_MS: u64 = 5000;

#[repr(C)]
#[derive(Default)]
struct Reading {
    mode: u32,
    configuration: u32,
    hz: [u32; 4],
    apm: u32,
    clkrst: [u32; 4],
}

unsafe extern "C" {
    fn moonlightClocksRead(out: *mut Reading);
    fn moonlightClocksClose();
}

#[derive(Default)]
pub struct Clocks {
    next_read_ms: u64,
    open: bool,
}

impl Clocks {
    pub fn tick(&mut self, streaming: bool, now_ms: u64) {
        if !streaming {
            self.close();
            return;
        }
        if now_ms < self.next_read_ms {
            return;
        }
        self.next_read_ms = now_ms + READ_MS;
        self.open = true;
        let mut reading = Reading::default();
        unsafe { moonlightClocksRead(&mut reading) };
        let mhz = |hz: u32| hz / 1_000_000;
        log(&format!(
            "clocks: mode={} configuration=0x{:08x} cpu={} gpu={} emc={} nvdec={} MHz apm=0x{:x} clkrst={:x?}",
            reading.mode,
            reading.configuration,
            mhz(reading.hz[0]),
            mhz(reading.hz[1]),
            mhz(reading.hz[2]),
            mhz(reading.hz[3]),
            reading.apm,
            reading.clkrst
        ));
    }

    fn close(&mut self) {
        if core::mem::take(&mut self.open) {
            unsafe { moonlightClocksClose() };
            self.next_read_ms = 0;
        }
    }
}

impl Drop for Clocks {
    fn drop(&mut self) {
        self.close();
    }
}
