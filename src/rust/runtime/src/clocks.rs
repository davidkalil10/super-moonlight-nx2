//! Clock readings every few seconds of a stream, through `nro/clocks.c`, and the CPU boost
//! mode the perf build can ask for. The sessions are closed and the boost is given back when
//! the stream ends, when it is switched off and when the app stops.

extern crate alloc;

use crate::device::log;
use alloc::format;

const READ_MS: u64 = 5000;
/// How long after a boost change the clocks are read, so the line shows the new rates.
const SETTLE_MS: u64 = 250;

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
    fn moonlightClocksBoost(on: bool) -> u32;
}

#[derive(Default)]
pub struct Clocks {
    next_read_ms: u64,
    open: bool,
    /// The boost last asked for, so a refused request is not repeated every frame.
    asked: bool,
    boosted: bool,
}

impl Clocks {
    pub fn tick(&mut self, streaming: bool, boost: bool, now_ms: u64) {
        if !streaming {
            self.close();
            return;
        }
        if boost != self.asked {
            self.asked = boost;
            self.set_boost(boost);
            self.next_read_ms = now_ms + SETTLE_MS;
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

    /// Gives the boost back and closes the sessions. Safe to call more than once.
    pub fn stop(&mut self) {
        self.close();
    }

    fn set_boost(&mut self, on: bool) {
        let result = unsafe { moonlightClocksBoost(on) };
        self.boosted = on && result == 0;
        log(&format!(
            "clocks: boost={} result=0x{result:x}",
            if on { "on" } else { "off" }
        ));
    }

    fn close(&mut self) {
        if self.boosted {
            self.set_boost(false);
        }
        self.asked = false;
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
