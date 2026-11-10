//! Decoder backend over the SDK's video decoder (`viddec.h`), through `nro/sdk_viddec.c`.
//! The service decodes into a CPU-backed image pool and each frame is copied out as linear
//! NV12. The session needs the stream's SPS and PPS, so it starts on the first access unit.

extern crate alloc;

use crate::{device::log, sdk};
use alloc::format;
use moonlight_nx2_core::{
    annexb,
    codec::{Capabilities, Codec, Depth, Evidence, Mode, Size},
    decoder::{Backend, BackendError, Backing, Config, SURFACES},
    video_wire::Output,
};

/// Enable only in a commit citing matching pixel sums and a clean close on the console.
pub const SDK_H264_VERIFIED: bool = false;
const CODEC_CONFIG_BYTES: usize = 1024;
const SUBMIT_BUSY: u32 = (3603 << 9) | 111;

#[repr(C)]
#[derive(Default)]
struct Properties {
    image: u32,
    width: u32,
    height: u32,
    crop_width: u32,
    crop_height: u32,
    end_of_stream: u32,
    timestamp_ns: i64,
}

#[repr(C)]
#[derive(Debug, Default)]
struct Layout {
    kind: u32,
    width: u32,
    height: u32,
    reserved: u32,
    pitch: [u64; 2],
}

unsafe extern "C" {
    fn moonlightSdkVideoOpen(
        width: u32,
        height: u32,
        count: u32,
        images: *mut u32,
        stage: *mut u32,
        sync_result: *mut u32,
    ) -> u32;
    fn moonlightSdkVideoStart(
        fps: u32,
        codec_config: *const u8,
        codec_config_bytes: usize,
        stage: *mut u32,
    ) -> u32;
    fn moonlightSdkVideoSubmit(data: *const u8, bytes: usize, timestamp_ns: i64) -> u32;
    fn moonlightSdkVideoReady(slot: u32, ready: *mut bool) -> u32;
    fn moonlightSdkVideoOutput(slot: u32, out: *mut Properties) -> u32;
    fn moonlightSdkVideoRead(
        slot: u32,
        luma: *mut u8,
        chroma: *mut u8,
        pitch: usize,
        layout: *mut Layout,
    ) -> u32;
    fn moonlightSdkVideoRelease(slot: u32) -> u32;
    fn moonlightSdkVideoPollResult() -> u32;
    fn moonlightSdkVideoClose(stage: *mut u32) -> u32;
}

pub struct SdkVideo {
    fps: u32,
    config: Option<Config>,
    started: bool,
    ready: Option<usize>,
    layout_reported: bool,
}

impl SdkVideo {
    pub fn new(fps: u32) -> Self {
        Self {
            fps,
            config: None,
            started: false,
            ready: None,
            layout_reported: false,
        }
    }

    fn start(&mut self, access_unit: &[u8]) -> Result<(), BackendError> {
        let mut codec_config = [0; CODEC_CONFIG_BYTES];
        let Some(bytes) = annexb::h264_parameter_sets(access_unit, &mut codec_config) else {
            log("sdk-video: first access unit has no SPS and PPS");
            return Err(BackendError::Invalid);
        };
        let mut stage = 0;
        let result =
            unsafe { moonlightSdkVideoStart(self.fps, codec_config.as_ptr(), bytes, &mut stage) };
        log(&format!(
            "sdk-video: start result=0x{result:x} stage={stage} codec_config_bytes={bytes} fps={}",
            self.fps
        ));
        if result != 0 {
            return Err(BackendError::Refused);
        }
        self.started = true;
        Ok(())
    }
}

fn check(operation: &str, result: u32) -> Result<(), BackendError> {
    if result == 0 {
        return Ok(());
    }
    log(&format!("sdk-video: {operation} result=0x{result:x}"));
    Err(BackendError::Refused)
}

impl Backend for SdkVideo {
    fn capabilities() -> Capabilities {
        let mut capabilities = Capabilities::default();
        if SDK_H264_VERIFIED {
            capabilities.record(
                Mode {
                    codec: Codec::H264,
                    depth: Depth::Eight,
                    maximum: Size::new(1920, 1080).unwrap(),
                    fps: 60,
                },
                Evidence::PixelsAndCloseVerified,
            );
        }
        capabilities
    }

    fn open(&mut self, config: Config) -> Result<[u32; SURFACES], BackendError> {
        if config.codec != Codec::H264 || config.backing != Backing::CpuReference {
            return Err(BackendError::Unsupported);
        }
        let mut images = [0; SURFACES];
        let mut stage = 0;
        let mut sync_result = 0;
        let result = unsafe {
            moonlightSdkVideoOpen(
                config.coded.width(),
                config.coded.height(),
                SURFACES as u32,
                images.as_mut_ptr(),
                &mut stage,
                &mut sync_result,
            )
        };
        log(&format!(
            "sdk-video: open result=0x{result:x} stage={stage} sync=0x{sync_result:x} images={images:?}"
        ));
        if result != 0 {
            return Err(BackendError::Refused);
        }
        if sync_result != 0 {
            log("sdk-video: no sync session; frames are taken when their properties arrive");
        }
        self.config = Some(config);
        Ok(images)
    }

    fn submit(&mut self, bytes: &[u8], pts_us: u64) -> Result<(), BackendError> {
        if !self.started {
            self.start(bytes)?;
        }
        let timestamp_ns = i64::try_from(pts_us * 1000).map_err(|_| BackendError::Invalid)?;
        let result = unsafe { moonlightSdkVideoSubmit(bytes.as_ptr(), bytes.len(), timestamp_ns) };
        if result == SUBMIT_BUSY {
            log("sdk-video: submit busy");
        }
        check("submit", result)
    }

    fn ready(&mut self, surface: usize) -> Result<bool, BackendError> {
        let mut ready = false;
        check("ready", unsafe {
            moonlightSdkVideoReady(surface as u32, &mut ready)
        })?;
        if ready {
            self.ready = Some(surface);
        }
        Ok(ready)
    }

    fn output(&mut self) -> Result<Output, BackendError> {
        let surface = self.ready.take().ok_or(BackendError::Invalid)?;
        let mut properties = Properties::default();
        check("output properties", unsafe {
            moonlightSdkVideoOutput(surface as u32, &mut properties)
        })?;
        Ok(Output {
            image: properties.image,
            width: properties.width,
            height: properties.height,
            display_width: properties.crop_width,
            display_height: properties.crop_height,
            color: 1,
            timestamp_ns: u64::try_from(properties.timestamp_ns)
                .map_err(|_| BackendError::Malformed)?,
            end_of_stream: properties.end_of_stream != 0,
        })
    }

    fn readback(&mut self, surface: usize, out: &mut [u8]) -> Result<(), BackendError> {
        let config = self.config.ok_or(BackendError::Invalid)?;
        let width = config.coded.width() as usize;
        let luma_bytes = width * config.coded.height() as usize;
        if out.len() < config.coded.nv12_bytes() {
            return Err(BackendError::Invalid);
        }
        let (luma, chroma) = out.split_at_mut(luma_bytes);
        let mut layout = Layout::default();
        let result = unsafe {
            moonlightSdkVideoRead(
                surface as u32,
                luma.as_mut_ptr(),
                chroma.as_mut_ptr(),
                width,
                &mut layout,
            )
        };
        if !self.layout_reported {
            self.layout_reported = true;
            log(&format!("sdk-video: first image {layout:?}"));
        }
        check("read image", result)
    }

    fn release(&mut self, surface: usize) -> Result<(), BackendError> {
        check("release image", unsafe {
            moonlightSdkVideoRelease(surface as u32)
        })
    }

    fn close(&mut self) -> Result<(), BackendError> {
        let poll_result = unsafe { moonlightSdkVideoPollResult() };
        let mut stage = 0;
        let result = unsafe { moonlightSdkVideoClose(&mut stage) };
        log(&format!(
            "sdk-video: close result=0x{result:x} stage={stage} last_poll=0x{poll_result:x}"
        ));
        self.config = None;
        self.started = false;
        self.ready = None;
        if result != 0 {
            return Err(BackendError::Uncertain);
        }
        Ok(())
    }

    fn now_ms(&self) -> u64 {
        (unsafe { sdk::moonlightNowNs() }) / 1_000_000
    }
}
