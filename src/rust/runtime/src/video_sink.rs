use crate::sdk;
use moonlight_nx2_app::policy::{DisplayCapabilities, DisplayEvidence, DisplayMode};
use moonlight_nx2_core::{
    codec::{Capabilities, Codec, Depth, Evidence, Mode, Size},
    decoder::{Backend, BackendError, Config, SURFACES},
    video_wire::Output,
};

const LUMA: u8 = 0x40;
const CHROMA: u8 = 0x80;
const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const FPS: u32 = 60;

/// A decoder stand-in for streaming without video decode: every access unit is accepted and
/// answered with a flat grey frame, so the media, input, audio and present paths run.
#[derive(Default)]
pub struct VideoSink {
    config: Option<Config>,
    slots: [Option<u64>; SURFACES],
    next_submit: usize,
    next_output: usize,
}

impl VideoSink {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Backend for VideoSink {
    fn open(&mut self, config: Config) -> Result<[u32; SURFACES], BackendError> {
        self.config = Some(config);
        Ok([1, 2])
    }

    fn submit(&mut self, _bytes: &[u8], pts_us: u64) -> Result<(), BackendError> {
        let slot = &mut self.slots[self.next_submit];
        if slot.is_some() {
            return Err(BackendError::Refused);
        }
        *slot = Some(pts_us);
        self.next_submit = (self.next_submit + 1) % SURFACES;
        Ok(())
    }

    fn ready(&mut self, surface: usize) -> Result<bool, BackendError> {
        Ok(self
            .slots
            .get(surface)
            .ok_or(BackendError::Invalid)?
            .is_some())
    }

    fn output(&mut self) -> Result<Output, BackendError> {
        let config = self.config.ok_or(BackendError::Invalid)?;
        let surface = self.next_output;
        let pts_us = self.slots[surface].ok_or(BackendError::Invalid)?;
        self.next_output = (self.next_output + 1) % SURFACES;
        Ok(Output {
            image: surface as u32 + 1,
            width: config.coded.width(),
            height: config.coded.height(),
            display_width: config.display.width(),
            display_height: config.display.height(),
            color: 1,
            timestamp_ns: pts_us * 1000,
            end_of_stream: false,
        })
    }

    fn readback(&mut self, _surface: usize, out: &mut [u8]) -> Result<(), BackendError> {
        let config = self.config.ok_or(BackendError::Invalid)?;
        let luma = config.coded.width() as usize * config.coded.height() as usize;
        let (top, bottom) = out.split_at_mut(luma.min(out.len()));
        top.fill(LUMA);
        bottom.fill(CHROMA);
        Ok(())
    }

    fn release(&mut self, surface: usize) -> Result<(), BackendError> {
        *self.slots.get_mut(surface).ok_or(BackendError::Invalid)? = None;
        Ok(())
    }

    fn close(&mut self) -> Result<(), BackendError> {
        self.config = None;
        self.slots = [None; SURFACES];
        Ok(())
    }

    fn now_ms(&self) -> u64 {
        (unsafe { sdk::moonlightNowNs() }) / 1_000_000
    }
}

/// The modes the sink stands in for: 1080p60 H.264 and AV1 on the verified 1080p60 display.
pub fn capabilities() -> (Capabilities, DisplayCapabilities) {
    let size = Size::new(WIDTH, HEIGHT).unwrap();
    let mut decoder = Capabilities::default();
    for codec in [Codec::H264, Codec::Av1] {
        let mode = Mode {
            codec,
            depth: Depth::Eight,
            maximum: size,
            fps: FPS,
        };
        decoder.record(mode, Evidence::PixelsAndCloseVerified);
    }
    let mut display = DisplayCapabilities::default();
    let mode = DisplayMode {
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
    };
    display.record(mode, DisplayEvidence::PresentedAndCloseVerified);
    (decoder, display)
}
