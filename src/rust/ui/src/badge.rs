//! The stream badge of dev legacy/src/streamer/civ7/rate-badge.js: composed RGBA in the
//! renderer's third frame area, its rectangle in the badge words, shown for a duration or for
//! the whole stream. Port of ui/badge.c.

use alloc::vec::Vec;
use core::fmt::Write;

use crate::glyphs::{Align, Bitmap, Glyphs, TextStyle, floor};
use crate::text::Text;

pub const WORDS: usize = 0xb100;
pub const PIXELS: usize = 27_492_352;
pub const MAX_BYTES: usize = 960 * 64 * 4;
/// The renderer's badge area: the latency line takes a badge past the C port's `MAX_BYTES`.
pub const AREA_BYTES: usize = 960 * 128 * 4;
pub const STORAGE_BYTES: usize = PIXELS + AREA_BYTES;
pub const SHOW_MS: u32 = 4000;
pub const STAYS: u32 = 0;
pub const NOTE_MS: u32 = 7000;
pub const TEXT_BYTES: usize = 192;
pub const TOUCH_NOTE: &str =
    "Touch is off on this PC \u{b7} enable Native Pen/Touch Support in Sunshine";

/// Badge text: C keeps up to 191 bytes, cut at a character boundary here.
pub type Line = Text<{ TEXT_BYTES - 1 }>;

const REFERENCE_HEIGHT: f64 = 1080.0;
const PADDING_X: f64 = 14.0;
const PADDING_Y: f64 = 4.0;
const MARGIN: f64 = 24.0;
const ACCENT_WIDTH: f64 = 4.0;
const MAX_WIDTH: u32 = 960;
const MAX_HEIGHT: u32 = 96;
const LATENCY_MAX_HEIGHT: u32 = 128;
const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;

const PAINT_FAILED: &str = "Badge text could not be painted";
const ALLOCATION_FAILED: &str = "Badge allocation failed";

#[derive(Clone, Copy)]
struct Font {
    size: u32,
    weight: u32,
}

const FONTS: [Font; 4] = [
    Font {
        size: 26,
        weight: 600,
    },
    Font {
        size: 24,
        weight: 600,
    },
    Font {
        size: 22,
        weight: 600,
    },
    Font {
        size: 18,
        weight: 700,
    },
];
const BACKGROUND: [f64; 3] = [12.0, 16.0, 24.0];
const INK: [f64; 3] = [240.0, 246.0, 250.0];
const ACCENT: [f64; 3] = [64.0, 217.0, 230.0];

struct Metrics {
    font: Font,
    padding_x: u32,
    padding_y: u32,
    accent: u32,
    margin: u32,
}

fn even(value: f64) -> u32 {
    (floor(value / 2.0 + 0.5) * 2.0) as u32
}

fn metrics(frame_height: u32) -> Metrics {
    let scale = f64::from(frame_height) / REFERENCE_HEIGHT;
    let wanted = f64::from(FONTS[0].size) * scale + 0.5;
    let font = FONTS
        .into_iter()
        .find(|font| f64::from(font.size) <= wanted)
        .unwrap_or(FONTS[3]);
    Metrics {
        font,
        padding_x: even(PADDING_X * scale),
        padding_y: even(PADDING_Y * scale),
        accent: even(ACCENT_WIDTH * scale).max(2),
        margin: even(MARGIN * scale),
    }
}

fn line(glyphs: &mut Glyphs, text: &str, frame_width: u32, font: Font) -> Option<Bitmap> {
    let style = TextStyle {
        weight: font.weight,
        tracking: 0.0,
    };
    glyphs.text(text, font.size, frame_width / 2, Align::Left, Some(&style))
}

fn ink_width(strip: &Bitmap) -> u32 {
    let width = strip.width as usize;
    (1..=width)
        .rev()
        .find(|&x| strip.bytes.chunks_exact(width).any(|row| row[x - 1] != 0))
        .unwrap_or(0) as u32
}

/// Paints badge rows `from..to` into `rgba`, which starts at row `from`.
fn paint_rows(
    rgba: &mut [u8],
    width: u32,
    rows: core::ops::Range<u32>,
    strip: &Bitmap,
    top: u32,
    metric: &Metrics,
) {
    let from = rows.start;
    for y in rows {
        for x in 0..width {
            let text_x = i64::from(x) - i64::from(metric.accent) - i64::from(metric.padding_x);
            let text_y = i64::from(y) - i64::from(top);
            let in_strip = (0..i64::from(strip.width)).contains(&text_x)
                && (0..i64::from(strip.height)).contains(&text_y);
            let alpha = if in_strip {
                let at = text_y as usize * strip.width as usize + text_x as usize;
                f64::from(strip.bytes[at]) / 255.0
            } else {
                0.0
            };
            let under = if x < metric.accent {
                ACCENT
            } else {
                BACKGROUND
            };
            let at = ((y - from) as usize * width as usize + x as usize) * 4;
            for channel in 0..3 {
                let ink = under[channel] + (INK[channel] - under[channel]) * alpha;
                rgba[at + channel] = floor(ink + 0.5) as u8;
            }
            rgba[at + 3] = 255;
        }
    }
}

fn zeroed(length: usize) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).ok()?;
    bytes.resize(length, 0);
    Some(bytes)
}

/// A composed badge and where it sits in the frame.
pub struct Badge {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub has_counter: bool,
    pub counter_from: u32,
    pub counter_top: u32,
    /// The top of the latency line under the counter, when the badge has one.
    pub latency_top: Option<u32>,
}

impl Badge {
    fn max_bytes(&self) -> usize {
        if self.latency_top.is_some() {
            AREA_BYTES
        } else {
            MAX_BYTES
        }
    }
}

/// The text line, then the counter line when there is one. An empty text with a counter
/// shows only the counter. The width fits the widest counter, so updates never resize it.
pub fn compose(
    glyphs: &mut Glyphs,
    text: &str,
    frame_width: u32,
    frame_height: u32,
    counter: Option<&str>,
) -> Result<Badge, &'static str> {
    compose_lines(glyphs, text, frame_width, frame_height, counter, None)
}

/// `compose` with the latency line under the counter, sized for the widest one.
pub fn compose_latency(
    glyphs: &mut Glyphs,
    text: &str,
    frame_width: u32,
    frame_height: u32,
    counter: &str,
    latency: &str,
) -> Result<Badge, &'static str> {
    compose_lines(
        glyphs,
        text,
        frame_width,
        frame_height,
        Some(counter),
        Some(latency),
    )
}

fn compose_lines(
    glyphs: &mut Glyphs,
    text: &str,
    frame_width: u32,
    frame_height: u32,
    counter: Option<&str>,
    latency: Option<&str>,
) -> Result<Badge, &'static str> {
    let metric = metrics(frame_height);
    let mut lines: Vec<&str> = Vec::new();
    if counter.is_none() || !text.is_empty() {
        lines.push(text);
    }
    lines.extend(counter);
    lines.extend(latency);
    let widest = counter_text(888, 888, 888, 888);
    let widest_latency = latency_text(&Latency::WIDEST);
    let sized = lines
        .iter()
        .copied()
        .chain(counter.map(|_| widest.as_str()))
        .chain(latency.map(|_| widest_latency.as_str()));

    let mut strips = Vec::new();
    for text in sized {
        strips.push(line(glyphs, text, frame_width, metric.font).ok_or(PAINT_FAILED)?);
    }

    let widest_ink = strips.iter().map(ink_width).max().unwrap_or(0);
    let count = lines.len() as u32;
    let line_height = strips[0].height;
    let width = even(f64::from(widest_ink + metric.accent) + 2.0 * f64::from(metric.padding_x));
    let height =
        even(f64::from(line_height) * f64::from(count) + 2.0 * f64::from(metric.padding_y));
    let max_height = if latency.is_some() {
        LATENCY_MAX_HEIGHT
    } else {
        MAX_HEIGHT
    };
    let fits = width <= MAX_WIDTH && height <= max_height;
    if !fits || width > frame_width || height > frame_height {
        return Err("Badge does not fit the frame");
    }

    let mut rgba = zeroed(width as usize * height as usize * 4).ok_or(ALLOCATION_FAILED)?;
    let tops: Vec<u32> = (0..count)
        .map(|i| metric.padding_y + i * line_height)
        .collect();
    for i in 0..count as usize {
        let from = if i == 0 { 0 } else { tops[i] };
        let to = tops.get(i + 1).copied().unwrap_or(height);
        let start = from as usize * width as usize * 4;
        paint_rows(
            &mut rgba[start..],
            width,
            from..to,
            &strips[i],
            tops[i],
            &metric,
        );
    }

    let last = count as usize - 1 - usize::from(latency.is_some());
    Ok(Badge {
        x: frame_width - metric.margin - width,
        y: metric.margin,
        width,
        height,
        rgba,
        has_counter: counter.is_some(),
        counter_from: if last == 0 { 0 } else { tops[last] },
        counter_top: tops[last],
        latency_top: latency.map(|_| tops[last + 1]),
    })
}

/// The counter rows of `badge` repainted with `counter`: (byte offset into its RGBA, bytes).
pub fn compose_counter(
    glyphs: &mut Glyphs,
    badge: &Badge,
    counter: &str,
    frame_width: u32,
    frame_height: u32,
) -> Result<(usize, Vec<u8>), &'static str> {
    compose_counter_lines(glyphs, badge, counter, None, frame_width, frame_height)
}

/// The counter and latency rows of `badge` repainted, as `compose_counter`.
pub fn compose_counter_latency(
    glyphs: &mut Glyphs,
    badge: &Badge,
    counter: &str,
    latency: &str,
    frame_width: u32,
    frame_height: u32,
) -> Result<(usize, Vec<u8>), &'static str> {
    compose_counter_lines(
        glyphs,
        badge,
        counter,
        Some(latency),
        frame_width,
        frame_height,
    )
}

fn compose_counter_lines(
    glyphs: &mut Glyphs,
    badge: &Badge,
    counter: &str,
    latency: Option<&str>,
    frame_width: u32,
    frame_height: u32,
) -> Result<(usize, Vec<u8>), &'static str> {
    if !badge.has_counter {
        return Err("The badge has no counter line");
    }
    if latency.is_some() != badge.latency_top.is_some() {
        return Err("The badge's latency line does not match");
    }

    let metric = metrics(frame_height);
    let strip = line(glyphs, counter, frame_width, metric.font).ok_or(PAINT_FAILED)?;
    let rows = badge.height - badge.counter_from;
    let row_bytes = badge.width as usize * 4;
    let offset = badge.counter_from as usize * row_bytes;
    let mut rgba = zeroed(rows as usize * row_bytes).ok_or(ALLOCATION_FAILED)?;
    let counter_to = badge.latency_top.unwrap_or(badge.height);
    paint_rows(
        &mut rgba,
        badge.width,
        badge.counter_from..counter_to,
        &strip,
        badge.counter_top,
        &metric,
    );
    if let (Some(latency), Some(top)) = (latency, badge.latency_top) {
        let strip = line(glyphs, latency, frame_width, metric.font).ok_or(PAINT_FAILED)?;
        let start = (top - badge.counter_from) as usize * row_bytes;
        paint_rows(
            &mut rgba[start..],
            badge.width,
            top..badge.height,
            &strip,
            top,
            &metric,
        );
    }
    Ok((offset, rgba))
}

struct Count(i64);

impl core::fmt::Display for Count {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        if self.0 < 0 {
            f.write_str("-")
        } else {
            write!(f, "{}", self.0)
        }
    }
}

/// Negative values show as a dash.
pub fn counter_text(presented: i64, caught_up: i64, dropped: i64, console_ms: i64) -> Line {
    let mut out = Line::new();
    let _ = write!(
        out,
        "{} fps \u{b7} {} skipped \u{b7} {} dropped \u{b7} console {} ms",
        Count(presented),
        Count(caught_up),
        Count(dropped),
        Count(console_ms)
    );
    out
}

/// The latency stages of the full badge in microseconds, each None when it was not measured.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Latency {
    /// Host processing the PC reported for its frames.
    pub host_us: Option<u32>,
    /// The network round trip.
    pub rtt_us: Option<u32>,
    /// From a frame's last packet being read until its unit went to the decoder.
    pub queue_us: Option<u32>,
    /// From a unit's submission until the decoder handed its frame back.
    pub decode_us: Option<u32>,
    /// From a decoded frame until its present returned.
    pub present_us: Option<u32>,
}

impl Latency {
    /// The line the badge is sized for, so updates never resize it.
    pub const WIDEST: Self = Self {
        host_us: Some(88_800),
        rtt_us: Some(88_800),
        queue_us: Some(88_800),
        decode_us: Some(88_800),
        present_us: Some(88_800),
    };
}

/// "host 2.1 · rtt 3.0 · queue 0.4 · decode 5.2 · present 8.0 ms", in tenths of a ms rounded
/// to the nearest; stages not measured are left out.
pub fn latency_text(latency: &Latency) -> Line {
    let stages = [
        ("host", latency.host_us),
        ("rtt", latency.rtt_us),
        ("queue", latency.queue_us),
        ("decode", latency.decode_us),
        ("present", latency.present_us),
    ];
    let mut out = Line::new();
    for (name, us) in stages {
        let Some(us) = us else {
            continue;
        };
        if !out.is_empty() {
            out.push_str(" \u{b7} ");
        }
        let tenths = us.saturating_add(50) / 100;
        let _ = write!(out, "{name} {}.{}", tenths / 10, tenths % 10);
    }
    if out.is_empty() {
        out.push_str("latency -");
    }
    out.push_str(" ms");
    out
}

pub fn rate_text(from_height: u32, from_fps: u32, to_height: u32, to_fps: u32) -> Line {
    let mut out = Line::new();
    let _ = if from_fps == to_fps && from_height != to_height {
        write!(out, "{from_height}p \u{25b8} {to_height}p")
    } else {
        write!(
            out,
            "{from_height}p{from_fps} \u{25b8} {to_height}p{to_fps}"
        )
    };
    out
}

/// The badge over a stream. Each call takes the renderer storage the badge words and pixels
/// live in; the controller keeps only what it composed.
pub struct Controller {
    text: Line,
    duration_ms: u32,
    counter: bool,
    failure: Option<&'static str>,
    shown: Option<Badge>,
    counted: Line,
    latency: Option<Line>,
    latency_stale: bool,
    dropped: i64,
    console_ms: i64,
    armed: bool,
    armed_ms: u32,
    until_ns: u64,
    restore_ns: u64,
}

fn put_word(storage: &mut [u8; STORAGE_BYTES], offset: usize, value: u32) {
    storage[offset..offset + 4].copy_from_slice(&value.to_ne_bytes());
}

impl Controller {
    /// `duration_ms` 0 (`STAYS`) keeps the badge for the whole stream.
    pub fn start(text: &str, duration_ms: u32, counter: bool) -> Self {
        Self {
            text: Line::of(text),
            duration_ms,
            counter,
            failure: None,
            shown: None,
            counted: counter_text(-1, -1, -1, -1),
            latency: None,
            latency_stale: false,
            dropped: 0,
            console_ms: -1,
            armed: false,
            armed_ms: 0,
            until_ns: 0,
            restore_ns: 0,
        }
    }

    /// Adds the latency line under the counter of a badge that has one.
    pub fn with_latency(mut self) -> Self {
        if self.counter {
            self.latency = Some(latency_text(&Latency::default()));
        }
        self
    }

    /// The stages the latency line shows from the next counter update on.
    pub fn set_latency(&mut self, latency: &Latency) {
        let line = latency_text(latency);
        if let Some(shown) = &mut self.latency
            && shown.as_str() != line.as_str()
        {
            *shown = line;
            self.latency_stale = true;
        }
    }

    /// The first error; the badge stays dark after it.
    pub fn failure(&self) -> Option<&'static str> {
        self.failure
    }

    fn set_visible(storage: &mut [u8; STORAGE_BYTES], visible: bool) {
        put_word(storage, WORDS, u32::from(visible));
    }

    fn hide(&mut self, storage: &mut [u8; STORAGE_BYTES]) {
        if self.armed {
            Self::set_visible(storage, false);
        }
        self.armed = false;
    }

    fn put(
        &mut self,
        storage: &mut [u8; STORAGE_BYTES],
        composed: &Badge,
        duration_ms: u32,
    ) -> bool {
        let bytes = composed.width as usize * composed.height as usize * 4;
        if bytes > composed.max_bytes() {
            self.failure = Some("Badge exceeds its pixel area");
            return false;
        }

        self.hide(storage);
        storage[PIXELS..PIXELS + bytes].copy_from_slice(&composed.rgba[..bytes]);
        let words = [0, composed.x, composed.y, composed.width, composed.height];
        for (index, word) in words.into_iter().enumerate() {
            put_word(storage, WORDS + index * 4, word);
        }
        self.armed_ms = duration_ms;
        self.until_ns = 0;
        self.armed = true;
        Self::set_visible(storage, true);
        true
    }

    pub fn show(&mut self, glyphs: &mut Glyphs, storage: &mut [u8; STORAGE_BYTES]) {
        if self.failure.is_some() {
            return;
        }

        let text = self.text.as_str();
        let composed = match (self.counter, &self.latency) {
            (true, Some(latency)) => compose_latency(
                glyphs,
                text,
                WIDTH,
                HEIGHT,
                self.counted.as_str(),
                latency.as_str(),
            ),
            (counter, _) => compose(
                glyphs,
                text,
                WIDTH,
                HEIGHT,
                counter.then_some(self.counted.as_str()),
            ),
        };
        let composed = match composed {
            Ok(composed) => composed,
            Err(error) => {
                self.failure = Some(error);
                return;
            }
        };
        if self.put(storage, &composed, self.duration_ms) {
            self.latency_stale = false;
            self.shown = Some(composed);
        }
    }

    /// A one-line note; a badge that stays comes back after it.
    pub fn note(
        &mut self,
        glyphs: &mut Glyphs,
        storage: &mut [u8; STORAGE_BYTES],
        line: &str,
        now_ns: u64,
    ) {
        if self.failure.is_some() {
            return;
        }

        let back = self.duration_ms == STAYS && self.shown.is_some();
        self.shown = None;
        let composed = match compose(glyphs, line, WIDTH, HEIGHT, None) {
            Ok(composed) => composed,
            Err(error) => {
                self.failure = Some(error);
                return;
            }
        };
        let duration = if back { STAYS } else { NOTE_MS };
        if self.put(storage, &composed, duration) && back {
            self.restore_ns = now_ns + u64::from(NOTE_MS) * 1_000_000;
        }
    }

    /// Counter update; `dropped_total` is cumulative, the badge shows drops since the last call.
    pub fn stats(
        &mut self,
        glyphs: &mut Glyphs,
        storage: &mut [u8; STORAGE_BYTES],
        presented: i64,
        caught_up: i64,
        dropped_total: i64,
        console_mean_ms: Option<i64>,
    ) {
        if !self.counter {
            return;
        }

        if let Some(console_ms) = console_mean_ms {
            self.console_ms = console_ms;
        }
        let dropped = dropped_total.saturating_sub(self.dropped).max(0);
        let line = counter_text(presented, caught_up, dropped, self.console_ms);
        self.dropped = dropped_total;
        if line.as_str() == self.counted.as_str() && !self.latency_stale {
            return;
        }

        self.counted = line;
        if self.failure.is_some() {
            return;
        }
        let Some(shown) = &self.shown else {
            return;
        };
        let repainted = match (&self.latency, shown.latency_top) {
            (Some(latency), Some(_)) => compose_counter_latency(
                glyphs,
                shown,
                line.as_str(),
                latency.as_str(),
                WIDTH,
                HEIGHT,
            ),
            _ => compose_counter(glyphs, shown, line.as_str(), WIDTH, HEIGHT),
        };
        match repainted {
            Ok((offset, rgba)) => {
                let at = PIXELS + offset;
                storage[at..at + rgba.len()].copy_from_slice(&rgba);
                self.latency_stale = false;
            }
            Err(error) => self.failure = Some(error),
        }
    }

    pub fn frame(&mut self, glyphs: &mut Glyphs, storage: &mut [u8; STORAGE_BYTES], now_ns: u64) {
        if self.restore_ns != 0 && now_ns >= self.restore_ns {
            self.restore_ns = 0;
            self.show(glyphs, storage);
        }
        if !self.armed || self.armed_ms == STAYS {
            return;
        }

        if self.until_ns == 0 {
            self.until_ns = now_ns + u64::from(self.armed_ms) * 1_000_000;
        } else if now_ns >= self.until_ns {
            self.hide(storage);
        }
    }

    pub fn stop(&mut self, storage: &mut [u8; STORAGE_BYTES]) {
        self.hide(storage);
        self.restore_ns = 0;
        self.shown = None;
    }
}
