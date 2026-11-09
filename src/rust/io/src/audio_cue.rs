use crate::audio::{self, Device, Output, Retained, Slots};
use core::fmt::{self, Write};
use moonlight_nx2_core::media::Header;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
pub const CHUNK_FRAMES: u32 = 480;
pub const CHUNKS: u32 = 300;
pub const CHUNK_BYTES: usize = 1920;
pub const DEADLINE_MS: u64 = 4500;

const SINE: [i16; 96] = [
    0, 268, 535, 799, 1060, 1317, 1567, 1812, 2048, 2276, 2493, 2701, 2896, 3080, 3250, 3406, 3547,
    3674, 3784, 3879, 3956, 4017, 4061, 4087, 4096, 4087, 4061, 4017, 3956, 3879, 3784, 3674, 3547,
    3406, 3250, 3080, 2896, 2701, 2493, 2276, 2048, 1812, 1567, 1317, 1060, 799, 535, 268, 0, -268,
    -535, -799, -1060, -1317, -1567, -1812, -2048, -2276, -2493, -2701, -2896, -3080, -3250, -3406,
    -3547, -3674, -3784, -3879, -3956, -4017, -4061, -4087, -4096, -4087, -4061, -4017, -3956,
    -3879, -3784, -3674, -3547, -3406, -3250, -3080, -2896, -2701, -2493, -2276, -2048, -1812,
    -1567, -1317, -1060, -799, -535, -268,
];

pub fn sample(frame: u32) -> i16 {
    let step = match frame / CHUNK_FRAMES {
        50..=124 => 2,
        175..=249 => 1,
        _ => return 0,
    };
    SINE[(frame as usize * step) % SINE.len()]
}

pub trait Clock {
    fn now_ms(&mut self) -> u64;
    fn idle(&mut self);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    Open(audio::Error),
    Playback(audio::Error),
    Clock,
    Deadline,
    Acknowledgement,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Report {
    pub failure: Option<Failure>,
    pub close: Option<audio::Error>,
    pub chunks: u32,
    pub acknowledgements: u32,
    pub audio: audio::Stats,
    pub elapsed_ms: u64,
    pub returned: bool,
}

impl Report {
    pub fn passed(&self) -> bool {
        self.failure.is_none()
            && self.close.is_none()
            && self.returned
            && self.chunks == CHUNKS
            && self.acknowledgements == CHUNKS
            && self.audio.received == u64::from(CHUNKS)
            && self.audio.appended == u64::from(CHUNKS)
            && self.audio.released == u64::from(CHUNKS)
            && self.audio.acknowledged == u64::from(CHUNKS)
            && self.audio.dropped == 0
            && self.audio.cuts == 0
            && self.audio.crossfades == 0
    }

    pub fn write(&self, out: &mut impl Write) -> fmt::Result {
        writeln!(
            out,
            "cue.transfer={}",
            if self.passed() { "PASS" } else { "FAIL" }
        )?;
        writeln!(out, "cue.audibility=UNVERIFIED")?;
        writeln!(
            out,
            "cue.rate=48000 channels=2 frames=144000 bytes=576000 duration_ms=3000 peak=4096"
        )?;
        writeln!(
            out,
            "cue.windows_ms=silence:0-500,tone1000:500-1250,silence:1250-1750,tone500:1750-2500,silence:2500-3000"
        )?;
        writeln!(
            out,
            "cue.chunks={} acknowledgements={} elapsed_ms={}",
            self.chunks, self.acknowledgements, self.elapsed_ms
        )?;
        writeln!(out, "cue.audio={:?}", self.audio)?;
        writeln!(
            out,
            "cue.failure={:?} close={:?} returned={}",
            self.failure, self.close, self.returned
        )
    }
}

fn header(sequence: u32) -> Header {
    Header {
        payload_bytes: CHUNK_BYTES as u32,
        sequence,
        pts_us: u64::from(sequence) * 10_000,
    }
}

fn drive<C: Clock, D: Device>(
    clock: &mut C,
    output: &mut Output<D>,
    start: u64,
    report: &mut Report,
) -> Result<(), Failure> {
    let mut last = start;
    let mut bytes = [0; CHUNK_BYTES];
    loop {
        let now = clock.now_ms();
        if now < last {
            return Err(Failure::Clock);
        }
        last = now;
        let elapsed = now - start;
        if elapsed >= DEADLINE_MS {
            return Err(Failure::Deadline);
        }
        if report.chunks < CHUNKS && elapsed >= u64::from(report.chunks) * 10 {
            for frame in 0..CHUNK_FRAMES {
                let value = sample(report.chunks * CHUNK_FRAMES + frame).to_le_bytes();
                let offset = frame as usize * 4;
                bytes[offset..offset + 2].copy_from_slice(&value);
                bytes[offset + 2..offset + 4].copy_from_slice(&value);
            }
            match output.push(&header(report.chunks).encode(), &bytes) {
                Ok(()) => report.chunks += 1,
                Err(audio::Error::Again) => {}
                Err(error) => return Err(Failure::Playback(error)),
            }
        }
        output.pump(now).map_err(Failure::Playback)?;
        for _ in 0..audio::SLOTS {
            let Some(ack) = output.take_acknowledgement() else {
                break;
            };
            if report.acknowledgements >= CHUNKS || ack != header(report.acknowledgements).encode()
            {
                return Err(Failure::Acknowledgement);
            }
            report.acknowledgements += 1;
        }
        if report.chunks == CHUNKS && report.acknowledgements == CHUNKS {
            return Ok(());
        }
        clock.idle();
    }
}

pub fn run<C: Clock, D: Device>(
    clock: &mut C,
    device: D,
    slots: &'static mut Slots,
) -> (Report, Retained<D>) {
    let start = clock.now_ms();
    let mut report = Report::default();
    let mut output = match Output::open(audio::Config::default(), device, slots) {
        Ok(output) => output,
        Err((error, retained)) => {
            report.failure = Some(Failure::Open(error));
            report.returned = matches!(&retained, Retained::Returned(..));
            return (report, retained);
        }
    };
    report.failure = drive(clock, &mut output, start, &mut report).err();
    report.audio = output.stats();
    let (result, retained) = output.close();
    report.close = result.err();
    report.returned = matches!(&retained, Retained::Returned(..));
    let end = clock.now_ms();
    if end < start {
        report.failure = Some(Failure::Clock);
    }
    report.elapsed_ms = end.saturating_sub(start);
    (report, retained)
}
