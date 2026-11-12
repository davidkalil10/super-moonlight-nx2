//! The decode and latency choices a console test switches between at run time. The perf-chord
//! build steps them.

extern crate alloc;

use core::sync::atomic::{AtomicBool, AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Path {
    /// Our low-level decoder session, frames copied into the upload slot.
    Copy,
    /// Our low-level session decoding straight into the renderer's frame slots.
    InPlace,
    /// The SDK's `VideoDecoder` object, frames copied by the GPU out of its images when the
    /// renderer can import them, else into the upload slot.
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

/// Every build starts on the SDK decoder taking the newest frame, the console A/B's winner.
/// Only the perf-chord build can step to the others.
#[cfg(feature = "perf-chord")]
const PATHS: [Path; 3] = [Path::Sdk, Path::InPlace, Path::Copy];
#[cfg(not(feature = "perf-chord"))]
const PATHS: [Path; 1] = [Path::Sdk];
#[cfg(feature = "perf-chord")]
const LATENCIES: [Latency; 3] = [Latency::Newest, Latency::Off, Latency::Wake];
#[cfg(not(feature = "perf-chord"))]
const LATENCIES: [Latency; 1] = [Latency::Newest];

static PATH: AtomicU8 = AtomicU8::new(0);
static LATENCY: AtomicU8 = AtomicU8::new(0);
static DECODER_MAX: AtomicBool = AtomicBool::new(false);

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

/// Whether a stream raises the decoder's clock to its highest rate. `clocks` applies it while
/// streaming. It replaced the CPU boost, which takes the GPU down to 306 MHz docked.
pub fn decoder_max() -> bool {
    DECODER_MAX.load(Ordering::Relaxed)
}

pub fn toggle_decoder_max() {
    DECODER_MAX.fetch_xor(true, Ordering::Relaxed);
}

pub fn decoder_clock() -> &'static str {
    if decoder_max() { "max" } else { "default" }
}

/// What a chord set: the path waits for the next stream, latency and the clock apply at once.
pub fn chord_text() -> alloc::string::String {
    alloc::format!(
        "perf: path={:?} from next stream, latency={:?} nvdec={} now",
        path(),
        latency(),
        decoder_clock()
    )
}

pub fn text() -> alloc::string::String {
    alloc::format!(
        "perf: path={:?} latency={:?} nvdec={}",
        path(),
        latency(),
        decoder_clock()
    )
}
