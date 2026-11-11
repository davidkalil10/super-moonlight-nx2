//! The decode and latency choices a console test switches between at run time. The perf-chord
//! build steps them.

extern crate alloc;

use core::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Path {
    /// Our low-level decoder session, frames copied into the upload slot.
    Copy,
    /// Our low-level session decoding straight into the renderer's frame slots.
    InPlace,
    /// The SDK's `VideoDecoder` object, frames copied into the upload slot. Not working on
    /// the console yet; kept for the comparison.
    Sdk,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Latency {
    /// One frame is taken per turn, when it is already finished.
    Off,
    /// The turn waits for the frame of the unit it submitted, up to half a turn.
    Wake,
    /// As `Wake`, and a newer finished frame replaces one not shown yet.
    Newest,
}

static PATH: AtomicU8 = AtomicU8::new(0);
static LATENCY: AtomicU8 = AtomicU8::new(0);

const PATHS: [Path; 3] = [Path::InPlace, Path::Copy, Path::Sdk];
const LATENCIES: [Latency; 3] = [Latency::Off, Latency::Wake, Latency::Newest];

pub fn path() -> Path {
    PATHS[PATH.load(Ordering::Relaxed) as usize % PATHS.len()]
}

pub fn latency() -> Latency {
    LATENCIES[LATENCY.load(Ordering::Relaxed) as usize % LATENCIES.len()]
}

/// The decode path of the next stream.
pub fn next_path() {
    PATH.store(
        (PATH.load(Ordering::Relaxed) + 1) % PATHS.len() as u8,
        Ordering::Relaxed,
    );
}

pub fn next_latency() {
    LATENCY.store(
        (LATENCY.load(Ordering::Relaxed) + 1) % LATENCIES.len() as u8,
        Ordering::Relaxed,
    );
}

pub fn text() -> alloc::string::String {
    alloc::format!("perf: path={:?} latency={:?}", path(), latency())
}
