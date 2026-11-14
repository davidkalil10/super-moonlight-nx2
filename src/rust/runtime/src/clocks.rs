//! Stream clocks through `nro/clocks.c`: readings every few seconds, the lower rates of the
//! stream's mode once it has settled, a notch up when it falls behind, and the clocks handed
//! back to the system when the stream ends, the console docks or undocks, the app leaves
//! focus or stops.

extern crate alloc;

use crate::device::log;
use alloc::{format, vec::Vec};
use moonlight_nx2_app::clocks::{self as plan, CLOCKS, Governor, Mode, NAMES, Signals};

const READ_MS: u64 = 5000;
/// A stream runs this long at the system's rates before they are lowered.
const SETTLE_MS: u64 = 2000;
const MAX_RATES: usize = 64;
const RATES_DISCRETE: u32 = 1;

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
    fn moonlightClocksSet(clock: i32, hz: u32) -> u32;
    fn moonlightClocksRates(
        clock: i32,
        rates: *mut u32,
        max: i32,
        kind: *mut u32,
        count: *mut i32,
    ) -> u32;
    fn moonlightClocksRelease() -> u32;
    fn moonlightClocksClose();
}

/// What the clocks follow while a stream is shown.
pub struct Streaming {
    pub mode: Mode,
    pub signals: Signals,
}

struct Lowered {
    mode: Mode,
    stock: [u32; CLOCKS],
    current: [u32; CLOCKS],
    changed: [bool; CLOCKS],
    governor: Governor,
    next_second_ms: u64,
    exhausted: bool,
}

#[derive(Default)]
pub struct Clocks {
    next_read_ms: u64,
    open: bool,
    /// A rate was set since the clocks were last handed back.
    held: bool,
    rates: Option<[Vec<u32>; CLOCKS]>,
    seen: Option<(Mode, u64)>,
    lowered: Option<Lowered>,
    /// The highest rates read under each performance mode and configuration. Rates are only
    /// ever set below them, so no set of ours can raise these.
    stock: Vec<((u32, u32), [u32; CLOCKS])>,
}

fn mhz(hz: u32) -> u32 {
    hz / 1_000_000
}

fn set(clock: usize, hz: u32) -> u32 {
    unsafe { moonlightClocksSet(clock as i32, hz) }
}

fn rates(clock: usize) -> Vec<u32> {
    let mut rates = [0u32; MAX_RATES];
    let (mut kind, mut count) = (0u32, 0i32);
    let result = unsafe {
        moonlightClocksRates(
            clock as i32,
            rates.as_mut_ptr(),
            MAX_RATES as i32,
            &mut kind,
            &mut count,
        )
    };
    let count = usize::try_from(count).unwrap_or(0).min(MAX_RATES);
    let list: Vec<u32> = rates[..count].iter().map(|&hz| mhz(hz)).collect();
    log(&format!(
        "clocks: {} rates result=0x{result:x} type={kind} MHz={list:?}",
        NAMES[clock]
    ));
    if result == 0 && kind == RATES_DISCRETE {
        rates[..count].to_vec()
    } else {
        Vec::new()
    }
}

impl Clocks {
    /// `Err` gives the reason no stream is shown, for the log when the rates go back.
    pub fn tick(&mut self, stream: Result<Streaming, &'static str>, now_ms: u64) {
        let stream = match stream {
            Ok(stream) => stream,
            Err(reason) => {
                self.release(reason);
                self.close();
                return;
            }
        };
        let reading = self.read(now_ms);
        if self.seen.is_none_or(|(mode, _)| mode != stream.mode) {
            if let Some(lowered) = self.lowered.as_ref() {
                let docking = lowered.mode.docked != stream.mode.docked;
                self.release(if docking {
                    "dock-change"
                } else {
                    "mode-change"
                });
            }
            self.seen = Some((stream.mode, now_ms));
        }
        if self.lowered.is_none()
            && let Some((mode, since_ms)) = self.seen
            && now_ms.saturating_sub(since_ms) >= SETTLE_MS
        {
            self.lower(mode, now_ms);
        }
        if let Some(reading) = reading {
            self.reassert(&reading);
        }
        self.govern(&stream, now_ms);
    }

    /// Hands the clocks back and closes the sessions. Safe to call more than once.
    pub fn stop(&mut self) {
        self.release("exit");
        self.close();
    }

    /// Takes a reading into the stock rates of its configuration and returns them.
    fn stock_of(&mut self, reading: &Reading) -> [u32; CLOCKS] {
        let key = (reading.mode, reading.configuration);
        let mut read = [0u32; CLOCKS];
        for clock in 0..CLOCKS {
            if reading.clkrst[clock] == 0 {
                read[clock] = reading.hz[clock];
            }
        }
        match self.stock.iter_mut().find(|(seen, _)| *seen == key) {
            Some((_, stock)) => {
                for clock in 0..CLOCKS {
                    stock[clock] = stock[clock].max(read[clock]);
                }
                *stock
            }
            None => {
                self.stock.push((key, read));
                read
            }
        }
    }

    fn read(&mut self, now_ms: u64) -> Option<Reading> {
        if now_ms < self.next_read_ms {
            return None;
        }
        self.next_read_ms = now_ms + READ_MS;
        self.open = true;
        let mut reading = Reading::default();
        unsafe { moonlightClocksRead(&mut reading) };
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
        self.stock_of(&reading);
        Some(reading)
    }

    fn lower(&mut self, mode: Mode, now_ms: u64) {
        self.open = true;
        let mut reading = Reading::default();
        unsafe { moonlightClocksRead(&mut reading) };
        let stock = self.stock_of(&reading);
        self.held = true;
        let rates = self
            .rates
            .get_or_insert_with(|| core::array::from_fn(rates));
        let targets = plan::plan(mode);
        let mut current = stock;
        let mut changed = [false; CLOCKS];
        let mut results = [0u32; CLOCKS];
        for clock in 0..CLOCKS {
            if stock[clock] == 0 {
                continue;
            }
            let target = plan::snap(targets[clock] * 1_000_000, stock[clock], &rates[clock]);
            if target < stock[clock] {
                results[clock] = set(clock, target);
                if results[clock] == 0 {
                    current[clock] = target;
                    changed[clock] = true;
                }
            }
        }
        log(&format!(
            "clocks: set cpu={} gpu={} emc={} MHz reason=start mode={}x{}@{} docked={} stock={}/{}/{} results={results:x?}",
            mhz(current[0]),
            mhz(current[1]),
            mhz(current[2]),
            mode.width,
            mode.height,
            mode.fps,
            mode.docked,
            mhz(stock[0]),
            mhz(stock[1]),
            mhz(stock[2])
        ));
        self.lowered = Some(Lowered {
            mode,
            stock,
            current,
            changed,
            governor: Governor::default(),
            next_second_ms: now_ms,
            exhausted: false,
        });
    }

    fn govern(&mut self, stream: &Streaming, now_ms: u64) {
        let Some(lowered) = self.lowered.as_mut() else {
            return;
        };
        if now_ms < lowered.next_second_ms {
            return;
        }
        lowered.next_second_ms = now_ms + 1000;
        let Some(behind) = lowered.governor.second(stream.signals, stream.mode.fps) else {
            return;
        };
        let trouble = format!(
            "presented={} arrived={} dropped={} link_lost={} wake_misses={}",
            behind.presented, behind.arrived, behind.dropped, behind.link_lost, behind.wake_misses
        );
        let Some(clock) = plan::pick(lowered.current, lowered.stock) else {
            if !core::mem::replace(&mut lowered.exhausted, true) {
                log(&format!(
                    "clocks: set nothing reason=behind {trouble}; every clock is at its stock rate"
                ));
            }
            return;
        };
        let rates = self
            .rates
            .as_ref()
            .map_or(&[][..], |rates| &rates[clock][..]);
        let Some(hz) = plan::notch_up(lowered.current[clock], lowered.stock[clock], rates) else {
            return;
        };
        let result = set(clock, hz);
        log(&format!(
            "clocks: set {}={} MHz reason=behind {trouble} result=0x{result:x}",
            NAMES[clock],
            mhz(hz)
        ));
        lowered.current[clock] = if result == 0 {
            hz
        } else {
            lowered.stock[clock]
        };
        lowered.changed[clock] |= result == 0;
    }

    /// Sets a lowered clock again when the reading shows the system put its own rate back.
    fn reassert(&mut self, reading: &Reading) {
        let Some(lowered) = self.lowered.as_mut() else {
            return;
        };
        for clock in 0..CLOCKS {
            let read = reading.hz[clock];
            let current = lowered.current[clock];
            if !lowered.changed[clock]
                || current >= lowered.stock[clock]
                || read < lowered.stock[clock]
            {
                continue;
            }
            let result = set(clock, lowered.current[clock]);
            log(&format!(
                "clocks: set {}={} MHz reason=reasserted read={} result=0x{result:x}",
                NAMES[clock],
                mhz(lowered.current[clock]),
                mhz(read)
            ));
        }
    }

    /// Closes our sessions and has the system apply its configuration again, then checks
    /// the reading; a clock still below its stock rate is set to it, which is logged.
    fn release(&mut self, reason: &str) {
        self.seen = None;
        self.lowered = None;
        if !core::mem::take(&mut self.held) {
            return;
        }
        self.open = true;
        let result = unsafe { moonlightClocksRelease() };
        let mut reading = Reading::default();
        unsafe { moonlightClocksRead(&mut reading) };
        let stock = self.stock_of(&reading);
        let mut fallback = Vec::new();
        for clock in 0..CLOCKS {
            if reading.clkrst[clock] == 0 && reading.hz[clock] < stock[clock] {
                let set = set(clock, stock[clock]);
                fallback.push(format!("{}={}:0x{set:x}", NAMES[clock], mhz(stock[clock])));
            }
        }
        self.held = !fallback.is_empty();
        log(&format!(
            "clocks: released reason={reason} apm=0x{result:x} configuration=0x{:08x} read={}/{}/{} stock={}/{}/{} MHz fallback={fallback:?}",
            reading.configuration,
            mhz(reading.hz[0]),
            mhz(reading.hz[1]),
            mhz(reading.hz[2]),
            mhz(stock[0]),
            mhz(stock[1]),
            mhz(stock[2])
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
        self.stop();
    }
}
