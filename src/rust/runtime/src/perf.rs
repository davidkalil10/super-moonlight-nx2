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

/// The perf-chord build starts on the SDK decoder with the turn waking for its frame, the
/// choices under test; the others keep the shipped `InPlace` and `Off`.
#[cfg(feature = "perf-chord")]
const FIRST: (u8, u8) = (2, 1);
#[cfg(not(feature = "perf-chord"))]
const FIRST: (u8, u8) = (0, 0);

static PATH: AtomicU8 = AtomicU8::new(FIRST.0);
static LATENCY: AtomicU8 = AtomicU8::new(FIRST.1);
static BOOST: AtomicBool = AtomicBool::new(false);

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

/// Whether a stream asks for the CPU boost mode. `clocks` applies it while streaming.
pub fn boost() -> bool {
    BOOST.load(Ordering::Relaxed)
}

pub fn toggle_boost() {
    BOOST.fetch_xor(true, Ordering::Relaxed);
}

/// What a chord set: the path waits for the next stream, latency and boost apply at once.
pub fn chord_text() -> alloc::string::String {
    alloc::format!(
        "perf: path={:?} from next stream, latency={:?} boost={} now",
        path(),
        latency(),
        if boost() { "on" } else { "off" }
    )
}

pub fn text() -> alloc::string::String {
    alloc::format!(
        "perf: path={:?} latency={:?} boost={}",
        path(),
        latency(),
        if boost() { "on" } else { "off" }
    )
}
