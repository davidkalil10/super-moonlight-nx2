//! Decoder backend over the SDK's video decoder (`viddec.h`), through `nro/sdk_viddec.c`.
//! The service decodes into a CPU-backed image pool and each frame is copied out as linear
//! NV12. The session needs the stream's SPS and PPS, so it starts on the first access unit.
//! The service scales the picture to the image size, so images have the display size.

extern crate alloc;

use crate::{
    device::log,
    sdk,
    stream_stats::{self, Stage},
};
use alloc::format;
use moonlight_nx2_core::{
    annexb,
    codec::{Capabilities, Codec, Depth, Evidence, Mode, Size},
    decoder::{Backend, BackendError, Backing, Config, SURFACES, UNITS},
    video_wire::Output,
};

/// Enable only in a commit citing matching pixel sums and a clean close on the console.
pub const SDK_H264_VERIFIED: bool = true;
/// 1440p and 4K are not measured on the console yet. Only the docked-modes build offers
/// them, and only on a docked layer that presented at that size.
pub const SDK_H264_DOCKED_VERIFIED: bool = cfg!(feature = "sdk-video-docked-modes");
/// Largest size and rate per tier, and whether it is offered.
const MODES: [(u32, u32, u32, bool); 3] = [
    (1920, 1080, 60, SDK_H264_VERIFIED),
    (2560, 1440, 60, SDK_H264_DOCKED_VERIFIED),
    (3840, 2160, 60, SDK_H264_DOCKED_VERIFIED),
];
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
        rows: usize,
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
    submitted: [u64; UNITS],
    microseconds_reported: bool,
    busy_submits: u64,
}

impl SdkVideo {
    pub fn new(fps: u32) -> Self {
        Self {
            fps,
            config: None,
            started: false,
            ready: None,
            layout_reported: false,
            submitted: [0; UNITS],
            microseconds_reported: false,
            busy_submits: 0,
        }
    }

    /// Input timestamps are sent in microseconds and the header documents nanoseconds for
    /// the output. Until the console shows which one the service answers, both are taken.
    fn timestamp_ns(&mut self, reported: u64) -> u64 {
        let nanoseconds = |pts_us: &u64| pts_us.checked_mul(1000) == Some(reported);
        if self.submitted.iter().any(nanoseconds) || !self.submitted.contains(&reported) {
            return reported;
        }
        if !self.microseconds_reported {
            self.microseconds_reported = true;
            log("sdk-video: output timestamps are in microseconds");
        }
        reported * 1000
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
        for (width, height, fps, verified) in MODES {
            if verified {
                capabilities.record(
                    Mode {
                        codec: Codec::H264,
                        depth: Depth::Eight,
                        maximum: Size::new(width, height).unwrap(),
                        fps,
                    },
                    Evidence::PixelsAndCloseVerified,
                );
            }
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
                config.display.width(),
                config.display.height(),
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
        let timestamp_ns = pts_us
            .checked_mul(1000)
            .and_then(|timestamp| i64::try_from(timestamp).ok())
            .ok_or(BackendError::Invalid)?;
        #[cfg(feature = "diagnostic-sdk-decode")]
        log(&format!(
            "b2ar: before submit pts_us={pts_us} bytes={}",
            bytes.len()
        ));
        let result = unsafe { moonlightSdkVideoSubmit(bytes.as_ptr(), bytes.len(), timestamp_ns) };
        if result == SUBMIT_BUSY {
            self.busy_submits += 1;
            return Err(BackendError::Busy);
        }
        check("submit", result)?;
        self.submitted.rotate_left(1);
        self.submitted[UNITS - 1] = pts_us;
        Ok(())
    }

    fn ready(&mut self, surface: usize) -> Result<bool, BackendError> {
        let mut ready = false;
        check("ready", unsafe {
            moonlightSdkVideoReady(surface as u32, &mut ready)
        })?;
        if ready {
            #[cfg(feature = "diagnostic-sdk-decode")]
            if self.ready != Some(surface) {
                log(&format!("b2ar: ready surface={surface}"));
            }
            self.ready = Some(surface);
        }
        Ok(ready)
    }

    fn output(&mut self) -> Result<Output, BackendError> {
        let surface = self.ready.take().ok_or(BackendError::Invalid)?;
        let mut properties = Properties::default();
        #[cfg(feature = "diagnostic-sdk-decode")]
        log(&format!("b2ar: before output surface={surface}"));
        check("output properties", unsafe {
            moonlightSdkVideoOutput(surface as u32, &mut properties)
        })?;
        #[cfg(feature = "diagnostic-sdk-decode")]
        log(&format!(
            "b2ar: output image={} {}x{} crop={}x{} timestamp={} end_of_stream={}",
            properties.image,
            properties.width,
            properties.height,
            properties.crop_width,
            properties.crop_height,
            properties.timestamp_ns,
            properties.end_of_stream
        ));
        let reported =
            u64::try_from(properties.timestamp_ns).map_err(|_| BackendError::Malformed)?;
        Ok(Output {
            image: properties.image,
            width: properties.width,
            height: properties.height,
            display_width: properties.crop_width,
            display_height: properties.crop_height,
            color: 1,
            timestamp_ns: self.timestamp_ns(reported),
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
        let read_start_ns = unsafe { sdk::moonlightNowNs() };
        let result = unsafe {
            moonlightSdkVideoRead(
                surface as u32,
                luma.as_mut_ptr(),
                chroma.as_mut_ptr(),
                width,
                config.coded.height() as usize,
                &mut layout,
            )
        };
        stream_stats::stage(Stage::Readback, read_start_ns, unsafe {
            sdk::moonlightNowNs()
        });
        if !self.layout_reported || result != 0 {
            self.layout_reported = true;
            log(&format!("sdk-video: image {layout:?}"));
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
            "sdk-video: close result=0x{result:x} stage={stage} last_poll=0x{poll_result:x} busy_submits={}",
            self.busy_submits
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
