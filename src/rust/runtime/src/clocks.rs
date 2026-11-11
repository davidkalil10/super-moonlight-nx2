//! Clock readings while streaming, and the decoder clock a docked stream asks for, through
//! `nro/clocks.c`.

extern crate alloc;

use crate::{device::log, sdk};
use alloc::format;

const READ_MS: u64 = 5000;
const DOCKED: u32 = 1;

#[repr(C)]
#[derive(Default)]
struct Reading {
    mode: u32,
    configuration: u32,
    hz: [u32; 4],
    mm_nvdec_hz: u32,
    apm: u32,
    clkrst: [u32; 4],
    mm: u32,
}

#[repr(C)]
#[derive(Default)]
struct Request {
    mode: u32,
    saved_configuration: u32,
    configuration: u32,
    nvdec_hz: u32,
    apm: u32,
    nvdec: u32,
}

unsafe extern "C" {
    fn moonlightClocksRead(out: *mut Reading);
    fn moonlightClocksRequest(configuration: u32, out: *mut Request);
    fn moonlightClocksRelease() -> u32;
}

#[derive(Default)]
pub struct Clocks {
    next_read_ms: u64,
    requested: bool,
}

impl Clocks {
    /// Logs the clocks every few seconds of a stream, and holds the fastest decoder clock
    /// while a docked stream runs with the perf clocks switched on.
    pub fn tick(&mut self, streaming: bool, now_ms: u64) {
        let wanted = streaming
            && crate::perf::clocks()
            && unsafe { sdk::appletGetOperationMode() } == DOCKED;
        if wanted != self.requested {
            self.requested = wanted;
            if wanted {
                let mut request = Request::default();
                unsafe { moonlightClocksRequest(0, &mut request) };
                log(&format!(
                    "clocks: request mode={} configuration=0x{:08x} apm=0x{:x} nvdec_hz={} nvdec=0x{:x}",
                    request.mode,
                    request.saved_configuration,
                    request.apm,
                    request.nvdec_hz,
                    request.nvdec
                ));
            } else {
                let result = unsafe { moonlightClocksRelease() };
                log(&format!("clocks: release result=0x{result:x}"));
            }
            self.next_read_ms = now_ms;
        }
        if !streaming || now_ms < self.next_read_ms {
            return;
        }
        self.next_read_ms = now_ms + READ_MS;
        let mut reading = Reading::default();
        unsafe { moonlightClocksRead(&mut reading) };
        let mhz = |hz: u32| hz / 1_000_000;
        log(&format!(
            "clocks: mode={} configuration=0x{:08x} cpu={} gpu={} emc={} nvdec={} mm_nvdec={} MHz apm=0x{:x} clkrst={:x?} mm=0x{:x}",
            reading.mode,
            reading.configuration,
            mhz(reading.hz[0]),
            mhz(reading.hz[1]),
            mhz(reading.hz[2]),
            mhz(reading.hz[3]),
            mhz(reading.mm_nvdec_hz),
            reading.apm,
            reading.clkrst,
            reading.mm
        ));
    }
}

impl Drop for Clocks {
    fn drop(&mut self) {
        if self.requested {
            unsafe { moonlightClocksRelease() };
        }
    }
}
