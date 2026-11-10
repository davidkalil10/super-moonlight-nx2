//! Measures the console to helper link before a launch and picks Auto's stream shape from it.
//!
//! The measurement is a bounded exchange of `probe` requests: a few empty ones for the round
//! trip, then padded replies for throughput. It runs over whatever carries the requests, and
//! [`Burst`] accumulates the same figures, plus loss, from numbered datagrams. In-stream
//! adaptation is `bitrate.rs`; this module only decides what a launch starts with, and
//! [`LinkQuality`] is the result both can read.

use core::fmt::Write;

use moonlight_nx2_ui::text::Text;

use crate::bitrate::auto_bitrate;
use crate::request::Codec;

/// Empty requests timed for the round trip.
pub const ECHOES: usize = 5;
/// Padding asked for in each throughput reply; it fits one control frame.
pub const CHUNK_BYTES: u32 = 32_768;
pub const MAX_CHUNKS: usize = 24;
/// Throughput replies are not requested past this long after the first one.
pub const TRANSFER_US: u64 = 600_000;
/// The whole measurement gives up here with what it has.
pub const LIMIT_US: u64 = 1_500_000;
/// Faster than any stream needs; a LAN reply inside the clock's resolution reads as this.
pub const CEILING_KBPS: u32 = 200_000;

/// Share of the measured throughput a stream may use.
const USABLE_PERCENT: u64 = 60;
/// A shape is worth starting when the link carries at least this share of its usual bitrate.
const MINIMUM_PERCENT: u64 = 50;
const UNSTEADY_JITTER_US: u32 = 30_000;
const UNSTEADY_RTT_US: u32 = 60_000;
const UNSTEADY_LOSS_PERMILLE: u32 = 20;
pub const FLOOR_KBPS: u32 = 3_000;
const STEP_KBPS: u32 = 500;

pub type Note = Text<95>;
pub type Request = Text<63>;

/// What carried the measurement. A stream hop retransmits, so it cannot show loss.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Hop {
    Stream,
    Datagram,
}

/// The measured link, for the pre-launch choice and for anything that adapts later.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LinkQuality {
    pub hop: Hop,
    pub throughput_kbps: u32,
    pub rtt_us: u32,
    /// Spread between the fastest and slowest round trip.
    pub jitter_us: u32,
    pub loss_permille: Option<u32>,
}

impl LinkQuality {
    pub fn unsteady(&self) -> bool {
        self.jitter_us > UNSTEADY_JITTER_US
            || self.rtt_us > UNSTEADY_RTT_US
            || self
                .loss_permille
                .is_some_and(|loss| loss > UNSTEADY_LOSS_PERMILLE)
    }

    /// The bitrate a stream can count on: a share of the throughput, halved on an unsteady link.
    pub fn usable_kbps(&self) -> u32 {
        let share = u64::from(self.throughput_kbps) * USABLE_PERCENT / 100;
        let usable = if self.unsteady() { share / 2 } else { share };
        usable as u32
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Measured(LinkQuality),
    /// The helper does not know the `probe` request.
    Unsupported,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Step {
    Send { sequence: u32, bytes: u32 },
    Wait,
    Done(Outcome),
}

/// The `probe` request for one step.
pub fn request(sequence: u32, bytes: u32) -> Request {
    let mut out = Request::new();
    let _ = write!(
        out,
        r#"{{"op":"probe","sequence":{sequence},"bytes":{bytes}}}"#
    );
    out
}

#[derive(Clone, Copy, Debug)]
struct Outstanding {
    sent_us: u64,
    bytes: u32,
}

/// One measurement over a request/reply link. The caller sends what `step` asks for, reports
/// `sent` and each `reply`, and stops at `Step::Done`.
#[derive(Clone, Copy, Debug)]
pub struct Session {
    started_us: u64,
    sequence: u32,
    outstanding: Option<Outstanding>,
    rtts: [u32; ECHOES],
    rtt_count: usize,
    rates: [u32; MAX_CHUNKS],
    rate_count: usize,
    transfer_started_us: Option<u64>,
    outcome: Option<Outcome>,
}

impl Session {
    pub fn new(now_us: u64) -> Self {
        Self {
            started_us: now_us,
            sequence: 0,
            outstanding: None,
            rtts: [0; ECHOES],
            rtt_count: 0,
            rates: [0; MAX_CHUNKS],
            rate_count: 0,
            transfer_started_us: None,
            outcome: None,
        }
    }

    pub fn step(&mut self, now_us: u64) -> Step {
        if let Some(outcome) = self.outcome {
            return Step::Done(outcome);
        }
        if now_us.saturating_sub(self.started_us) >= LIMIT_US {
            return Step::Done(self.finish());
        }
        if self.outstanding.is_some() {
            return Step::Wait;
        }
        if self.rtt_count < ECHOES {
            return Step::Send {
                sequence: self.sequence,
                bytes: 0,
            };
        }
        let transferring = self
            .transfer_started_us
            .is_none_or(|started| now_us.saturating_sub(started) < TRANSFER_US);
        if self.rate_count < MAX_CHUNKS && transferring {
            return Step::Send {
                sequence: self.sequence,
                bytes: CHUNK_BYTES,
            };
        }
        Step::Done(self.finish())
    }

    pub fn sent(&mut self, bytes: u32, now_us: u64) {
        self.outstanding = Some(Outstanding {
            sent_us: now_us,
            bytes,
        });
        self.sequence += 1;
        if bytes > 0 && self.transfer_started_us.is_none() {
            self.transfer_started_us = Some(now_us);
        }
    }

    /// The reply to the outstanding request arrived with `payload_bytes` of payload.
    pub fn reply(&mut self, payload_bytes: usize, now_us: u64) {
        let Some(outstanding) = self.outstanding.take() else {
            return;
        };
        let elapsed_us = now_us.saturating_sub(outstanding.sent_us);
        if outstanding.bytes == 0 {
            self.rtts[self.rtt_count] = u32::try_from(elapsed_us).unwrap_or(u32::MAX);
            self.rtt_count += 1;
            return;
        }
        let round_trip = u64::from(
            self.rtts[..self.rtt_count]
                .iter()
                .copied()
                .min()
                .unwrap_or(0),
        );
        let transfer_us = elapsed_us.saturating_sub(round_trip).max(1);
        let kbps = (payload_bytes as u64 * 8 * 1000 / transfer_us).min(u64::from(CEILING_KBPS));
        self.rates[self.rate_count] = kbps as u32;
        self.rate_count += 1;
    }

    /// The rate of each throughput reply so far, in kbps. Sorted once the session is done.
    pub fn rates(&self) -> &[u32] {
        &self.rates[..self.rate_count]
    }

    /// The helper answered the request with an error.
    pub fn refused(&mut self) {
        self.outstanding = None;
        self.outcome = Some(Outcome::Unsupported);
    }

    pub fn failed(&mut self) {
        self.outstanding = None;
        self.outcome = Some(Outcome::Failed);
    }

    fn finish(&mut self) -> Outcome {
        let rtts = &mut self.rtts[..self.rtt_count];
        let rates = &mut self.rates[..self.rate_count];
        let outcome = if rtts.is_empty() || rates.is_empty() {
            Outcome::Failed
        } else {
            rtts.sort_unstable();
            rates.sort_unstable();
            // A reply that waited for the caller's next slice reads slow, never fast, so the
            // upper quartile is closer to the link than the median.
            Outcome::Measured(LinkQuality {
                hop: Hop::Stream,
                throughput_kbps: rates[rates.len() * 3 / 4],
                rtt_us: rtts[rtts.len() / 2],
                jitter_us: rtts[rtts.len() - 1] - rtts[0],
                loss_permille: None,
            })
        };
        self.outstanding = None;
        self.outcome = Some(outcome);
        outcome
    }
}

/// Figures from a burst of numbered datagrams, where missing ones are loss.
#[derive(Clone, Copy, Debug, Default)]
pub struct Burst {
    expected: u32,
    received: u32,
    bytes_after_first: u64,
    first_us: Option<u64>,
    last_us: u64,
}

impl Burst {
    pub fn new(expected: u32) -> Self {
        Self {
            expected,
            ..Self::default()
        }
    }

    pub fn datagram(&mut self, bytes: usize, now_us: u64) {
        if self.received == self.expected {
            return;
        }
        self.received += 1;
        match self.first_us {
            None => self.first_us = Some(now_us),
            Some(_) => self.bytes_after_first += bytes as u64,
        }
        self.last_us = now_us;
    }

    /// None until two datagrams arrived; the round trip comes from the request link.
    pub fn quality(&self, rtt_us: u32, jitter_us: u32) -> Option<LinkQuality> {
        let first_us = self.first_us.filter(|_| self.received >= 2)?;
        let elapsed_us = self.last_us.saturating_sub(first_us).max(1);
        let kbps = (self.bytes_after_first * 8 * 1000 / elapsed_us).min(u64::from(CEILING_KBPS));
        let lost = u64::from(self.expected - self.received);
        Some(LinkQuality {
            hop: Hop::Datagram,
            throughput_kbps: kbps as u32,
            rtt_us,
            jitter_us,
            loss_permille: Some((lost * 1000 / u64::from(self.expected)) as u32),
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Grade {
    Good,
    Fair,
    Weak,
}

/// The stream shape the settings ask for. Its rate is always kept, and its size too unless
/// the size was left to the link (`size_auto`); then Auto may pick a smaller one, never larger.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Wanted {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub codec: Codec,
    pub size_auto: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AutoChoice {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub grade: Grade,
    /// The link carries less than the shape is worth starting with.
    pub starved: bool,
    pub quality: LinkQuality,
}

const SIZES: [(u32, u32); 4] = [(3840, 2160), (2560, 1440), (1920, 1080), (1280, 720)];

/// Picks the bitrate the link carries for the wanted shape. When the size was left to the
/// link, it first picks the largest size the link carries among the wanted one and the smaller
/// modes the decoder and display offer (`offered`). A chosen size on a link too weak for it
/// keeps the size and is graded weak.
pub fn choose(
    quality: LinkQuality,
    wanted: Wanted,
    offered: impl Fn(u32, u32, u32) -> bool,
) -> AutoChoice {
    let usable = quality.usable_kbps();
    let full = |shape: (u32, u32, u32)| auto_bitrate(shape.0, shape.1, shape.2, wanted.codec);
    let wanted_shape = (wanted.width, wanted.height, wanted.fps);
    let shapes = SIZES
        .iter()
        .filter(|size| size.1 <= wanted.height)
        .map(|size| (size.0, size.1, wanted.fps))
        .filter(|shape| *shape == wanted_shape || wanted.size_auto)
        .filter(|shape| *shape == wanted_shape || offered(shape.0, shape.1, shape.2));

    let mut carried: Option<(u32, u32, u32)> = None;
    let mut smallest = wanted_shape;
    for shape in shapes {
        if full(shape) < full(smallest) {
            smallest = shape;
        }
        let fits = u64::from(usable) * 100 >= u64::from(full(shape)) * MINIMUM_PERCENT;
        if fits && carried.is_none_or(|best| full(shape) > full(best)) {
            carried = Some(shape);
        }
    }

    let shape = carried.unwrap_or(smallest);
    let bitrate_kbps = full(shape)
        .min(usable / STEP_KBPS * STEP_KBPS)
        .max(FLOOR_KBPS);
    let grade = if shape != wanted_shape || carried.is_none() {
        Grade::Weak
    } else if bitrate_kbps < full(shape) {
        Grade::Fair
    } else {
        Grade::Good
    };
    AutoChoice {
        width: shape.0,
        height: shape.1,
        fps: shape.2,
        bitrate_kbps,
        grade,
        starved: carried.is_none(),
        quality,
    }
}

fn write_mbps(out: &mut Note, kbps: u32) {
    let tenths = (kbps + 50) / 100;
    if tenths >= 100 || tenths % 10 == 0 {
        let _ = write!(out, "{}", (kbps + 500) / 1000);
    } else {
        let _ = write!(out, "{}.{}", tenths / 10, tenths % 10);
    }
}

/// One line: what was measured and what Auto starts with.
pub fn note(choice: &AutoChoice) -> Note {
    let mut out = Note::new();
    out.push_str(match choice.grade {
        Grade::Good => "Good link (",
        Grade::Fair => "Fair link (",
        Grade::Weak => "Weak link (",
    });
    let quality = &choice.quality;
    write_mbps(&mut out, quality.throughput_kbps);
    if quality.throughput_kbps >= CEILING_KBPS {
        out.push_str("+");
    }
    let _ = write!(out, " Mbps, {} ms", (quality.rtt_us + 500) / 1000);
    if let Some(loss) = quality.loss_permille.filter(|loss| *loss > 0) {
        let _ = write!(out, ", {}% loss", loss.div_ceil(10));
    }
    let _ = write!(out, "): {}p{} at ", choice.height, choice.fps);
    write_mbps(&mut out, choice.bitrate_kbps);
    out.push_str(" Mbps");
    if choice.starved {
        out.push_str(", may stutter");
    }
    out
}
