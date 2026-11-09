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
    decoder::{self, Backend, BackendError, Backing, Config, FrameRegistration, SURFACES},
    frame::Matrix,
    media::Header,
    video_wire::Output,
};

const CLIPS: [(&str, &[u8]); 2] = [
    ("h264", include_bytes!("../refclip/h264.mlrc")),
    ("av1", include_bytes!("../refclip/av1.mlrc")),
];
/// Presents per decoded frame: about half a second at 60 Hz, a quarter at 120 Hz.
const HOLD_PRESENTS: u32 = 30;
/// Presents the last frame of each clip stays up, for a still HDMI capture.
const FINAL_PRESENTS: u32 = 300;
const DECODE_WAIT_NS: u64 = 2_000_000_000;

/// The backend under test. The sink answers grey frames, so its sums never match; it proves
/// the plumbing. A real decoder gates these two behind its feature (`diagnostic-native-decode`)
/// and adds its own constructor and `BACKING` next to them.
fn backend(_: &mut Renderer) -> Option<crate::video_sink::VideoSink> {
    Some(crate::video_sink::VideoSink::new())
}
const BACKING: Backing = Backing::CpuReference;

/// Replays every embedded clip; true when each one decoded, uploaded and closed cleanly.
pub fn run(renderer: &mut Renderer) -> bool {
    let mut passed = true;
    for (name, bytes) in CLIPS {
        let Some(clip) = Clip::parse(bytes) else {
            log(&format!("ref: {name} clip malformed"));
            passed = false;
            continue;
        };
        let Some(backend) = backend(renderer) else {
            log(&format!("ref: {name} backend unavailable"));
            passed = false;
            continue;
        };
        passed &= replay(renderer, backend, BACKING, name, &clip);
        if sdk::process_retired() || !unsafe { sdk::appletMainLoop() } {
            return false;
        }
    }
    log(&format!("ref: replay done passed={passed}"));
    passed
}

/// Feeds one clip's access units in order and logs the decoder's output sums.
pub fn replay<B: Backend>(
    renderer: &mut Renderer,
    backend: B,
    backing: Backing,
    name: &'static str,
    clip: &Clip<'_>,
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
            timeout_ms: 0,
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
    let checked = Checksummed::new(backend, name);
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
    let result = feed(renderer, &mut video, clip);
    let stats = video.stats();
    let closed = video.close();
    log(&format!(
        "ref: {name} result={result:?} decoded={} uploaded={} presented={} close={closed:?}",
        stats.decoded, stats.uploaded, stats.presented
    ));
    result.is_ok() && closed.is_ok() && stats.decoded == u64::from(clip.units)
}

fn feed<B: Backend>(
    renderer: &mut Renderer,
    video: &mut Video<'_, B>,
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

fn step<B: Backend>(renderer: &mut Renderer, video: &mut Video<'_, B>) -> Result<(), video::Error> {
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
pub struct Checksummed<B> {
    inner: B,
    name: &'static str,
    config: Option<Config>,
    images: [u32; SURFACES],
    stamps: [u64; SURFACES],
    frames: u32,
}

impl<B: Backend> Checksummed<B> {
    pub fn new(inner: B, name: &'static str) -> Self {
        Self {
            inner,
            name,
            config: None,
            images: [0; SURFACES],
            stamps: [0; SURFACES],
            frames: 0,
        }
    }
}

impl<B: Backend> Backend for Checksummed<B> {
    fn open(&mut self, config: Config) -> Result<[u32; SURFACES], BackendError> {
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
        let config = self.config.ok_or(BackendError::Invalid)?;
        let stride = config.coded.width() as usize;
        let (width, height) = (
            config.display.width() as usize,
            config.display.height() as usize,
        );
        let chroma = stride * config.coded.height() as usize;
        let luma = crc32(out, stride, width, height);
        let chroma = crc32(&out[chroma..], stride, width, height / 2);
        log(&format!(
            "ref: {} frame {} pts_us={} y={luma:08x} uv={chroma:08x}",
            self.name,
            self.frames,
            self.stamps.get(surface).copied().unwrap_or(0) / 1000
        ));
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
