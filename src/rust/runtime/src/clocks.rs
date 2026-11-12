//! Clock readings every second of a stream, through `nro/clocks.c`, and the decoder's highest
//! clock the perf build can ask for. The sessions are closed and the clock is given back when
//! the stream ends, when it is switched off and when the app stops.

extern crate alloc;

use crate::device::log;
use alloc::format;

const READ_MS: u64 = 1000;
/// The module ids searched once a stream when the decoder's clock does not open by its id.
const SCAN_FIRST: u32 = 0x4000_0001;
const SCAN_COUNT: u32 = 0x80;
const SCAN_MAX: usize = 64;
/// How long after a clock change the clocks are read, so the line shows the new rates.
const SETTLE_MS: u64 = 250;

#[repr(C)]
#[derive(Default)]
struct Reading {
    mode: u32,
    configuration: u32,
    hz: [u32; 5],
    apm: u32,
    clkrst: [u32; 5],
    ids: [u32; 5],
    pcv: u32,
}

const NVDEC: usize = 3;

unsafe extern "C" {
    fn moonlightClocksRead(out: *mut Reading);
    fn moonlightClocksScan(first: u32, count: u32, ids: *mut u32, hz: *mut u32, max: u32) -> u32;
    fn moonlightClocksDecoderRates(
        rates: *mut u32,
        max: i32,
        count: *mut i32,
        kind: *mut u32,
    ) -> u32;
    fn moonlightClocksClose();
    fn moonlightClocksDecoderMax(on: bool, hz: *mut u32) -> u32;
}

#[derive(Default)]
pub struct Clocks {
    next_read_ms: u64,
    open: bool,
    /// The decoder clock last asked for, so a refused request is not repeated every frame.
    asked: bool,
    raised: bool,
    /// Whether this stream logged the module ids and the decoder's rates.
    described: bool,
}

impl Clocks {
    pub fn tick(&mut self, streaming: bool, decoder_max: bool, now_ms: u64) {
        if !streaming {
            self.close();
            return;
        }
        if decoder_max != self.asked {
            self.asked = decoder_max;
            self.set_decoder_max(decoder_max);
            self.next_read_ms = now_ms + SETTLE_MS;
        }
        if now_ms < self.next_read_ms {
            return;
        }
        self.next_read_ms = now_ms + READ_MS;
        self.open = true;
        let first = !core::mem::replace(&mut self.described, true);
        let mut reading = Reading::default();
        unsafe { moonlightClocksRead(&mut reading) };
        let mhz = |hz: u32| hz / 1_000_000;
        log(&format!(
            "clocks: mode={} configuration=0x{:08x} cpu={} gpu={} emc={} nvdec={} vic={} MHz apm=0x{:x} clkrst={:x?}",
            reading.mode,
            reading.configuration,
            mhz(reading.hz[0]),
            mhz(reading.hz[1]),
            mhz(reading.hz[2]),
            mhz(reading.hz[3]),
            mhz(reading.hz[4]),
            reading.apm,
            reading.clkrst
        ));
        if first {
            log(&format!(
                "clocks: module ids={:x?} pcv=0x{:x}",
                reading.ids, reading.pcv
            ));
            if reading.clkrst[NVDEC] == 0 {
                log_decoder_rates();
            } else {
                log_scan();
            }
        }
    }

    /// Gives the clock back and closes the sessions. Safe to call more than once.
    pub fn stop(&mut self) {
        self.close();
    }

    fn set_decoder_max(&mut self, on: bool) {
        let mut hz = 0;
        let result = unsafe { moonlightClocksDecoderMax(on, &mut hz) };
        self.open = true;
        self.raised = on && result == 0;
        log(&format!(
            "clocks: nvdec={} asked={} MHz result=0x{result:x}",
            if on { "max" } else { "default" },
            hz / 1_000_000
        ));
    }

    fn close(&mut self) {
        if self.raised {
            self.set_decoder_max(false);
        }
        self.asked = false;
        self.described = false;
        if core::mem::take(&mut self.open) {
            unsafe { moonlightClocksClose() };
            self.next_read_ms = 0;
        }
    }
}

fn log_decoder_rates() {
    let mut rates = [0u32; 32];
    let (mut count, mut kind) = (0, 0);
    let result = unsafe {
        moonlightClocksDecoderRates(rates.as_mut_ptr(), rates.len() as i32, &mut count, &mut kind)
    };
    let count = usize::try_from(count).unwrap_or(0).min(rates.len());
    let mhz: alloc::vec::Vec<u32> = rates[..count].iter().map(|hz| hz / 1_000_000).collect();
    log(&format!(
        "clocks: nvdec rates result=0x{result:x} type={kind} MHz={mhz:?}"
    ));
}

/// Every module clkrst opens near the first console's ids, with its rate, for finding the
/// decoder's and the image compositor's clocks on this one.
fn log_scan() {
    let mut ids = [0u32; SCAN_MAX];
    let mut hz = [0u32; SCAN_MAX];
    let found = unsafe {
        moonlightClocksScan(
            SCAN_FIRST,
            SCAN_COUNT,
            ids.as_mut_ptr(),
            hz.as_mut_ptr(),
            SCAN_MAX as u32,
        )
    } as usize;
    let mut line = alloc::string::String::from("clocks: modules");
    for (id, hz) in ids.iter().zip(hz.iter()).take(found.min(SCAN_MAX)) {
        line.push_str(&format!(" {id:x}={}", hz / 1_000_000));
    }
    log(&line);
}

impl Drop for Clocks {
    fn drop(&mut self) {
        self.close();
    }
}
