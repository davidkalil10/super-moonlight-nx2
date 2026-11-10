//! Reference clip replay for decoder bring-up. Embedded 1080p60 H.264 and AV1 clips
//! (`tools/refclip.py generate`) go through the stream's own `Video` path with any decoder
//! `Backend`; each decoded NV12 frame is logged as CRC-32s of its displayed luma and chroma, and
//! held on screen long enough for an HDMI capture. `tools/refclip.py compare` checks both
//! against the reference that ffmpeg decoded. A codec is enabled only once they agree.

extern crate alloc;

use crate::{
    device::log,
    render::Renderer,
    sdk,
    video::{self, Video},
};
use alloc::{format, vec};
use core::cell::Cell;
use moonlight_nx2_core::{
    codec::{Capabilities, Codec, Depth, Evidence, Mode, Size},
    decoder::{self, Backend, BackendError, Backing, Config, FrameRegistration},
    frame::Matrix,
    media::Header,
    video_wire::Output,
};

const H264: &[u8] = include_bytes!("../refclip/h264.mlrc");
#[cfg(not(feature = "diagnostic-sdk-modes-rate"))]
const AV1: &[u8] = include_bytes!("../refclip/av1.mlrc");
#[cfg(feature = "diagnostic-native-decode")]
const HEVC: &[u8] = include_bytes!("../refclip/hevc.mlrc");

#[cfg(not(any(
    feature = "diagnostic-native-decode",
    feature = "diagnostic-sdk-modes-rate"
)))]
const CLIPS: [(&str, &[u8]); 2] = [("h264", H264), ("av1", AV1)];
#[cfg(feature = "diagnostic-sdk-modes-rate")]
const CLIPS: [(&str, &[u8]); 1] = [("h264", H264)];
#[cfg(feature = "diagnostic-native-decode")]
const CLIPS: [(&str, &[u8]); 3] = [("h264", H264), ("hevc", HEVC), ("av1", AV1)];
/// One diagnostic session on the SDK decoder: a clip, the rate it is fed at, how it is fed and
/// what the session changes from a stream's own choices.
#[cfg(feature = "diagnostic-sdk-modes")]
struct Trial {
    name: &'static str,
    clip: &'static [u8],
    fps: u32,
    feed: Feed,
    tuning: Tuning,
}
#[cfg(feature = "diagnostic-sdk-modes")]
use crate::sdk_video::Tuning;

#[cfg(feature = "diagnostic-sdk-modes")]
const fn trial(name: &'static str, clip: &'static [u8], tuning: Tuning) -> Trial {
    Trial {
        name,
        clip,
        fps: CLIP_FPS,
        feed: Feed::Held,
        tuning,
    }
}

/// Two-frame clips above 1080p, then 1440p at 120 units a second on a display that turns at
/// its own rate. A refused session closes and the next one runs.
#[cfg(all(
    feature = "diagnostic-sdk-modes",
    not(any(
        feature = "diagnostic-sdk-modes-4k",
        feature = "diagnostic-sdk-modes-rate"
    ))
))]
const TRIALS: [Trial; 6] = [
    trial("av1_1440p", AV1_1440P, Tuning::NONE),
    trial("h264_1440p", H264_1440P, Tuning::NONE),
    trial("av1_2160p", AV1_2160P, Tuning::NONE),
    trial("h264_2160p", H264_2160P, Tuning::NONE),
    paced("av1_1440p120", AV1_1440P120),
    paced("h264_1440p120", H264_1440P120),
];
#[cfg(all(
    feature = "diagnostic-sdk-modes",
    not(any(
        feature = "diagnostic-sdk-modes-4k",
        feature = "diagnostic-sdk-modes-rate"
    ))
))]
const fn paced(name: &'static str, clip: &'static [u8]) -> Trial {
    Trial {
        fps: 120,
        feed: Feed::Paced,
        ..trial(
            name,
            clip,
            Tuning {
                frame_rate: 120,
                quiet: true,
                ..Tuning::NONE
            },
        )
    }
}
#[cfg(all(
    feature = "diagnostic-sdk-modes",
    not(feature = "diagnostic-sdk-modes-4k")
))]
const AV1_1440P120: &[u8] = include_bytes!("../refclip/av1_1440p120.mlrc");
#[cfg(all(
    feature = "diagnostic-sdk-modes",
    not(feature = "diagnostic-sdk-modes-4k")
))]
const H264_1440P120: &[u8] = include_bytes!("../refclip/h264_1440p120.mlrc");
#[cfg(all(
    feature = "diagnostic-sdk-modes",
    not(feature = "diagnostic-sdk-modes-rate")
))]
const AV1_1440P: &[u8] = include_bytes!("../refclip/av1_1440p.mlrc");
#[cfg(all(
    feature = "diagnostic-sdk-modes",
    not(feature = "diagnostic-sdk-modes-rate")
))]
const H264_1440P: &[u8] = include_bytes!("../refclip/h264_1440p.mlrc");
#[cfg(feature = "diagnostic-sdk-modes")]
const AV1_2160P: &[u8] = include_bytes!("../refclip/av1_2160p.mlrc");
#[cfg(feature = "diagnostic-sdk-modes")]
const H264_2160P: &[u8] = include_bytes!("../refclip/h264_2160p.mlrc");

/// What the service refuses at 2160p (0x17bc6f), one difference from a stream's session at a
/// time, AV1 first: it is the codec the retail client decoded at this size. Every session
/// initializes command by command; the first two prove that path at a size that works.
#[cfg(feature = "diagnostic-sdk-modes-4k")]
const TRIALS: [Trial; 15] = [
    trial("av1_1440p_split", AV1_1440P, SPLIT),
    trial("h264_1440p_split", H264_1440P, SPLIT),
    trial("av1_2160p_split", AV1_2160P, SPLIT),
    trial("av1_2160p_in1", AV1_2160P, RETAIL_INPUT),
    trial("av1_2160p_30", AV1_2160P, at_30(SPLIT)),
    trial("av1_2160p_in1_30", AV1_2160P, at_30(RETAIL_INPUT)),
    trial(
        "av1_2160p_work308",
        AV1_2160P,
        Tuning {
            work_mebibytes: 308,
            ..SPLIT
        },
    ),
    trial(
        "av1_2160p_input4m",
        AV1_2160P,
        Tuning {
            max_input_bytes: 4 << 20,
            ..SPLIT
        },
    ),
    trial(
        "av1_2160p_pool2176",
        AV1_2160P,
        Tuning {
            pool_height: 2176,
            ..SPLIT
        },
    ),
    trial("av1_2160p_rgba", AV1_2160P, output(2)),
    trial("av1_2160p_hdr", AV1_2160P, output(4)),
    trial("av1_2160p_format5", AV1_2160P, output(5)),
    trial("h264_2160p_split", H264_2160P, SPLIT),
    trial("h264_2160p_in1", H264_2160P, RETAIL_INPUT),
    trial("h264_2160p_30", H264_2160P, at_30(SPLIT)),
];
#[cfg(feature = "diagnostic-sdk-modes-4k")]
const SPLIT: Tuning = Tuning {
    frame_rate: 60,
    split_initialize: true,
    ..Tuning::NONE
};
/// The retail client's AV1 session at 2160p sent input format 1; a stream sends 3 from 1080p up.
#[cfg(feature = "diagnostic-sdk-modes-4k")]
const RETAIL_INPUT: Tuning = Tuning {
    input_format: 1,
    ..SPLIT
};
/// An output the pipeline cannot read back: only the start result counts.
#[cfg(feature = "diagnostic-sdk-modes-4k")]
const fn output(format: u32) -> Tuning {
    Tuning {
        output_format: format,
        ..SPLIT
    }
}
#[cfg(feature = "diagnostic-sdk-modes-4k")]
const fn at_30(tuning: Tuning) -> Tuning {
    Tuning {
        frame_rate: 30,
        ..tuning
    }
}

/// Whether the configured rate is only a declaration. The service takes 2160p configured at 30
/// and refuses it at 60, and refuses 1440p at 120: first where the 2160p limit sits, on
/// two-frame sessions that are known to close cleanly either way, then 120 at two sizes, then
/// clips fed faster than the decoder was told. Those come last: a decoder fed past its
/// configured rate has never run.
#[cfg(feature = "diagnostic-sdk-modes-rate")]
const TRIALS: [Trial; 16] = [
    trial("av1_2160p_r59", AV1_2160P, rate(59)),
    trial("av1_2160p_r50", AV1_2160P, rate(50)),
    trial("av1_2160p_r48", AV1_2160P, rate(48)),
    trial("av1_2160p_r45", AV1_2160P, rate(45)),
    trial("av1_2160p_r40", AV1_2160P, rate(40)),
    trial("h264_2160p_r30", H264_2160P, rate(30)),
    fed(120, "av1_1440p120_r120", AV1_1440P120, 120),
    fed(120, "h264_1440p120_r120", H264_1440P120, 120),
    fed(120, "av1_1080p120_r120", AV1_1080P120, 120),
    fed(120, "h264_1080p120_r120", H264_1080P120, 120),
    fed(60, "av1_2160p_r30_fed60", AV1_2160P_LONG, 30),
    fed(60, "h264_2160p_r30_fed60", H264_2160P_LONG, 30),
    fed(120, "av1_1440p120_r60_fed120", AV1_1440P120, 60),
    fed(120, "h264_1440p120_r60_fed120", H264_1440P120, 60),
    fed(120, "av1_1080p120_r60_fed120", AV1_1080P120, 60),
    fed(120, "h264_1080p120_r60_fed120", H264_1080P120, 60),
];
#[cfg(feature = "diagnostic-sdk-modes-rate")]
const fn rate(frame_rate: u32) -> Tuning {
    Tuning {
        frame_rate,
        split_initialize: true,
        ..Tuning::NONE
    }
}
/// A clip fed at `fps` units a second to a decoder configured for `frame_rate`.
#[cfg(feature = "diagnostic-sdk-modes-rate")]
const fn fed(fps: u32, name: &'static str, clip: &'static [u8], frame_rate: u32) -> Trial {
    Trial {
        fps,
        feed: Feed::Paced,
        ..trial(
            name,
            clip,
            Tuning {
                quiet: true,
                ..rate(frame_rate)
            },
        )
    }
}
#[cfg(feature = "diagnostic-sdk-modes-rate")]
const AV1_1080P120: &[u8] = include_bytes!("../refclip/av1_1080p120.mlrc");
#[cfg(feature = "diagnostic-sdk-modes-rate")]
const H264_1080P120: &[u8] = include_bytes!("../refclip/h264_1080p120.mlrc");
#[cfg(feature = "diagnostic-sdk-modes-rate")]
const AV1_2160P_LONG: &[u8] = include_bytes!("../refclip/av1_2160p_long.mlrc");
#[cfg(feature = "diagnostic-sdk-modes-rate")]
const H264_2160P_LONG: &[u8] = include_bytes!("../refclip/h264_2160p_long.mlrc");
/// Presents per decoded frame: about half a second at 60 Hz, a quarter at 120 Hz.
const HOLD_PRESENTS: u32 = 30;
/// Presents the last frame of each clip stays up, for a still HDMI capture.
const FINAL_PRESENTS: u32 = 300;
const DECODE_WAIT_NS: u64 = 2_000_000_000;
#[cfg(feature = "sdk-video")]
const CLIP_FPS: u32 = 60;

/// The backend under test. The sink answers grey frames, so its sums never match; it proves
/// the plumbing. A real decoder gates these two behind its feature (`diagnostic-native-decode`)
/// and adds its own constructor and `BACKING` next to them.
#[cfg(not(any(feature = "diagnostic-native-decode", feature = "sdk-video")))]
fn backend(_: &mut Renderer) -> Option<crate::video_sink::VideoSink> {
    Some(crate::video_sink::VideoSink::new())
}
#[cfg(feature = "sdk-video")]
fn backend(_: &mut Renderer) -> Option<crate::sdk_video::SdkVideo> {
    Some(crate::sdk_video::SdkVideo::new(CLIP_FPS))
}
#[cfg(not(feature = "diagnostic-native-decode"))]
const BACKING: Backing = Backing::CpuReference;
#[cfg(feature = "diagnostic-native-decode")]
fn backend(renderer: &mut Renderer) -> Option<crate::native_video::NativeVideo> {
    renderer.native_decoder().ok()
}
#[cfg(feature = "diagnostic-native-decode")]
const BACKING: Backing = Backing::NativeGpu;

/// One session: true when the clip decoded, uploaded and closed cleanly.
fn session<B: Backend<N>, const N: usize>(
    renderer: &mut Renderer,
    name: &'static str,
    bytes: &[u8],
    backend: Option<B>,
    feed: Feed,
) -> bool {
    log(&format!("b2ar: codec={name} begin"));
    let Some(clip) = Clip::parse(bytes) else {
        log(&format!("ref: {name} clip malformed"));
        return false;
    };
    let Some(backend) = backend else {
        log(&format!("ref: {name} backend unavailable"));
        return false;
    };
    let result = replay(renderer, backend, BACKING, name, &clip, feed);
    log(&format!("b2ar: codec={name} replay={result}"));
    log(&format!(
        "ref: {name} session {}",
        if result { "PASS" } else { "FAIL" }
    ));
    result
}

fn stopped() -> bool {
    sdk::process_retired() || !unsafe { sdk::appletMainLoop() }
}

/// Replays every embedded clip; true when each session passed.
pub fn run(renderer: &mut Renderer) -> bool {
    let mut passed = true;
    for (name, bytes) in CLIPS {
        let backend = backend(renderer);
        passed &= session(renderer, name, bytes, backend, Feed::Held);
        if stopped() {
            return false;
        }
    }
    #[cfg(feature = "diagnostic-sdk-modes")]
    for trial in TRIALS {
        let backend = crate::sdk_video::SdkVideo::tuned(trial.fps, trial.tuning);
        passed &= session(renderer, trial.name, trial.clip, Some(backend), trial.feed);
        if stopped() {
            return false;
        }
    }
    #[cfg(feature = "diagnostic-sdk-decode")]
    if let Some(size) = Size::new(1920, 1088) {
        crate::sdk_video::note_output_formats(size);
    }
    log(&format!("ref: replay done passed={passed}"));
    passed
}

/// How a clip's units reach the decoder.
#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Feed {
    /// One unit at a time, each frame summed and held on screen.
    Held,
    /// Units at the clip's own rate with one present a refresh, timed and not summed.
    #[cfg_attr(
        any(
            not(feature = "diagnostic-sdk-modes"),
            feature = "diagnostic-sdk-modes-4k"
        ),
        allow(dead_code)
    )]
    Paced,
}

/// Feeds one clip's access units in order and logs the decoder's output sums or its timing.
pub fn replay<B: Backend<N>, const N: usize>(
    renderer: &mut Renderer,
    backend: B,
    backing: Backing,
    name: &'static str,
    clip: &Clip<'_>,
    feed: Feed,
) -> bool {
    let (Some(display), Some(coded)) = (
        Size::new(clip.width, clip.height),
        Size::new(
            clip.width.next_multiple_of(16),
            clip.height.next_multiple_of(16),
        ),
    ) else {
        log(&format!(
            "ref: {name} size {}x{} unsupported",
            clip.width, clip.height
        ));
        return false;
    };
    let config = video::Config {
        decoder: Config {
            codec: clip.codec,
            coded,
            display,
            timeout_ms: DECODE_WAIT_NS / 1_000_000,
            frame_registration: FrameRegistration::Register,
            backing,
        },
        fps: clip.fps,
        matrix: Matrix::Bt709,
    };
    // The replay is how decode evidence is earned, so it admits exactly the clip's mode.
    let mut capabilities = Capabilities::default();
    capabilities.record(
        Mode {
            codec: clip.codec,
            depth: Depth::Eight,
            maximum: display,
            fps: clip.fps,
        },
        Evidence::PixelsAndCloseVerified,
    );
    let mut first = vec![0; coded.nv12_bytes()];
    let mut second = vec![0; coded.nv12_bytes()];
    let retired = Cell::new(false);
    let checked = Checksummed::new(backend, name, feed == Feed::Held);
    let mut video = match Video::open(
        checked,
        config,
        &capabilities,
        &retired,
        [&mut first[..], &mut second[..]],
    ) {
        Ok(video) => video,
        Err(error) => {
            log(&format!("ref: {name} open failed {error:?}"));
            return false;
        }
    };
    log(&format!(
        "ref: {name} {}x{}@{} units={} backing={backing:?}",
        clip.width, clip.height, clip.fps, clip.units
    ));
    let result = match feed {
        Feed::Held => feed_held(renderer, &mut video, clip),
        Feed::Paced => feed_paced(renderer, &mut video, name, clip),
    };
    let stats = video.stats();
    let closed = video.close();
    log(&format!(
        "ref: {name} result={result:?} decoded={} uploaded={} presented={} close={closed:?}",
        stats.decoded, stats.uploaded, stats.presented
    ));
    result.is_ok() && closed.is_ok() && stats.decoded == u64::from(clip.units)
}

/// Submits each unit when its timestamp is due, as a stream at the clip's rate would, and
/// presents once a turn. Logs how the decoder kept up.
fn feed_paced<B: Backend<N>, const N: usize>(
    renderer: &mut Renderer,
    video: &mut Video<'_, B, N>,
    name: &str,
    clip: &Clip<'_>,
) -> Result<(), video::Error> {
    let now = || unsafe { sdk::moonlightNowNs() };
    let _ = crate::stream_stats::take_stages();
    let start_ns = now();
    let mut units = clip.iter().enumerate().peekable();
    let mut turns = 0u32;
    let mut busy = 0u32;
    let mut end_ns = None;
    loop {
        while let Some(&(index, (pts_us, unit))) = units.peek() {
            if now() < start_ns + pts_us * 1000 {
                break;
            }
            let header = Header {
                payload_bytes: unit.len() as u32,
                sequence: index as u32,
                pts_us,
            };
            match video.submit_draining(renderer, &header, unit, None) {
                Ok(()) => units.next(),
                Err(video::Error::Decoder(decoder::Error::Again)) => {
                    busy += 1;
                    break;
                }
                Err(error) => return Err(error),
            };
        }
        step(renderer, video)?;
        turns += 1;
        if units.peek().is_none() {
            let deadline = *end_ns.get_or_insert_with(|| now() + DECODE_WAIT_NS);
            if !video.pending() || now() >= deadline {
                break;
            }
        }
    }
    let elapsed_ms = (now() - start_ns) / 1_000_000;
    let stats = video.stats();
    let [submit, poll, output, readback, upload, present] = crate::stream_stats::take_stages();
    let time = |stage: crate::stream_stats::StageTime| {
        format!("{}x{}/{}", stage.count, stage.mean_us, stage.max_us)
    };
    log(&format!(
        "ref: {name} paced {}@{} in {elapsed_ms} ms turns={turns} busy_turns={busy} decoded={} presented={} caught_up={} dropped={}",
        clip.units, clip.fps, stats.decoded, stats.presented, stats.caught_up, stats.dropped
    ));
    log(&format!(
        "ref: {name} stages count x mean/max us submit={} poll={} output={} readback={} upload={} present={}",
        time(submit),
        time(poll),
        time(output),
        time(readback),
        time(upload),
        time(present)
    ));
    Ok(())
}

fn feed_held<B: Backend<N>, const N: usize>(
    renderer: &mut Renderer,
    video: &mut Video<'_, B, N>,
    clip: &Clip<'_>,
) -> Result<(), video::Error> {
    for (index, (pts_us, unit)) in clip.iter().enumerate() {
        let header = Header {
            payload_bytes: unit.len() as u32,
            sequence: index as u32,
            pts_us,
        };
        loop {
            match video.submit(&header, unit) {
                Ok(()) => break,
                Err(video::Error::Decoder(decoder::Error::Again)) => step(renderer, video)?,
                Err(error) => return Err(error),
            }
        }
        let deadline = unsafe { sdk::moonlightNowNs() } + DECODE_WAIT_NS;
        while video.stats().decoded <= index as u64 && unsafe { sdk::moonlightNowNs() } < deadline {
            step(renderer, video)?;
        }
        for _ in 0..HOLD_PRESENTS {
            step(renderer, video)?;
        }
    }
    let deadline = unsafe { sdk::moonlightNowNs() } + DECODE_WAIT_NS;
    while video.pending() && unsafe { sdk::moonlightNowNs() } < deadline {
        step(renderer, video)?;
    }
    for _ in 0..FINAL_PRESENTS {
        step(renderer, video)?;
    }
    Ok(())
}

fn step<B: Backend<N>, const N: usize>(
    renderer: &mut Renderer,
    video: &mut Video<'_, B, N>,
) -> Result<(), video::Error> {
    if sdk::process_retired() || !unsafe { sdk::appletMainLoop() } {
        return Err(video::Error::Closed);
    }
    video.present(renderer, false).map(|_| ())
}

/// One embedded clip: the `.mlrc` header and its access units (see tools/refclip.py).
pub struct Clip<'a> {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub units: u32,
    bytes: &'a [u8],
}

impl<'a> Clip<'a> {
    const HEADER: usize = 28;

    pub fn parse(bytes: &'a [u8]) -> Option<Self> {
        let word = |at: usize| Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?));
        if bytes.get(..4)? != b"MLRC" || word(4)? != 1 {
            return None;
        }
        let codec = match word(8)? {
            0 => Codec::H264,
            1 => Codec::Av1,
            2 => Codec::Hevc,
            _ => return None,
        };
        let clip = Self {
            codec,
            width: word(12)?,
            height: word(16)?,
            fps: word(20)?,
            units: word(24)?,
            bytes: &bytes[Self::HEADER..],
        };
        let mut count = 0;
        let mut rest = clip.bytes;
        while !rest.is_empty() {
            let size = u32::from_le_bytes(rest.get(..4)?.try_into().ok()?) as usize;
            if size == 0 || size > decoder::INPUT_MAX {
                return None;
            }
            rest = rest.get(12 + size..)?;
            count += 1;
        }
        (count == clip.units && (1..=120).contains(&clip.fps)).then_some(clip)
    }

    /// `(pts_us, access unit)` in decode order; `parse` already checked every bound.
    pub fn iter(&self) -> impl Iterator<Item = (u64, &'a [u8])> {
        let mut rest = self.bytes;
        core::iter::from_fn(move || {
            if rest.is_empty() {
                return None;
            }
            let size = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
            let pts_us = u64::from_le_bytes(rest[4..12].try_into().unwrap());
            let unit = &rest[12..12 + size];
            rest = &rest[12 + size..];
            Some((pts_us, unit))
        })
    }
}

/// Forwards to any backend and logs CRC-32s of the displayed area of each NV12 readback.
pub struct Checksummed<B, const N: usize> {
    inner: B,
    name: &'static str,
    config: Option<Config>,
    images: [u32; N],
    stamps: [u64; N],
    frames: u32,
    sums: bool,
}

impl<B: Backend<N>, const N: usize> Checksummed<B, N> {
    pub fn new(inner: B, name: &'static str, sums: bool) -> Self {
        Self {
            inner,
            name,
            config: None,
            images: [0; N],
            stamps: [0; N],
            frames: 0,
            sums,
        }
    }
}

impl<B: Backend<N>, const N: usize> Backend<N> for Checksummed<B, N> {
    fn open(&mut self, config: Config) -> Result<[u32; N], BackendError> {
        let images = self.inner.open(config)?;
        self.config = Some(config);
        self.images = images;
        Ok(images)
    }

    fn submit(&mut self, bytes: &[u8], pts_us: u64) -> Result<(), BackendError> {
        self.inner.submit(bytes, pts_us)
    }

    fn ready(&mut self, surface: usize) -> Result<bool, BackendError> {
        self.inner.ready(surface)
    }

    fn output(&mut self) -> Result<Output, BackendError> {
        let output = self.inner.output()?;
        if let Some(index) = self.images.iter().position(|image| *image == output.image) {
            self.stamps[index] = output.timestamp_ns;
        }
        Ok(output)
    }

    fn readback(&mut self, surface: usize, out: &mut [u8]) -> Result<(), BackendError> {
        self.inner.readback(surface, out)?;
        if !self.sums {
            return Ok(());
        }
        let config = self.config.ok_or(BackendError::Invalid)?;
        let stride = config.coded.width() as usize;
        let (width, height) = (
            config.display.width() as usize,
            config.display.height() as usize,
        );
        let chroma = stride * config.coded.height() as usize;
        log(&format!("b2ar: CRC frame {} begin", self.frames));
        let chroma_bytes = out.get(chroma..).ok_or(BackendError::Invalid)?;
        let luma = crc32(out, stride, width, height);
        let chroma = crc32(chroma_bytes, stride, width, height / 2);
        log(&format!(
            "ref: {} frame {} pts_us={} y={luma:08x} uv={chroma:08x}",
            self.name,
            self.frames,
            self.stamps.get(surface).copied().unwrap_or(0) / 1000
        ));
        if self.frames == 0 {
            let last_row = &out[(height - 1) * stride..];
            log(&format!(
                "ref: {} first frame top={:08x} bottom={:08x} luma={:02x?} chroma={:02x?}",
                self.name,
                crc32(out, stride, width, 1),
                crc32(last_row, stride, width, 1),
                &out[..8],
                &chroma_bytes[..8]
            ));
        }
        self.frames += 1;
        Ok(())
    }

    fn release(&mut self, surface: usize) -> Result<(), BackendError> {
        self.inner.release(surface)
    }

    fn close(&mut self) -> Result<(), BackendError> {
        self.inner.close()
    }

    fn now_ms(&self) -> u64 {
        self.inner.now_ms()
    }
}

const CRC_TABLE: [u32; 256] = {
    let mut table = [0; 256];
    let mut index = 0;
    while index < 256 {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = if value & 1 != 0 {
                0xedb8_8320 ^ (value >> 1)
            } else {
                value >> 1
            };
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
};

/// zlib-compatible CRC-32 over `rows` rows of `width` bytes, `stride` apart.
fn crc32(bytes: &[u8], stride: usize, width: usize, rows: usize) -> u32 {
    let mut crc = !0u32;
    for row in 0..rows {
        let start = row * stride;
        let Some(line) = bytes.get(start..start + width) else {
            return 0;
        };
        for byte in line {
            crc = CRC_TABLE[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
        }
    }
    !crc
}
