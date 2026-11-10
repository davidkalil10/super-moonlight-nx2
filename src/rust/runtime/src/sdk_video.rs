//! Decoder backend over the SDK's video decoder (`viddec.h`), through `nro/sdk_viddec.c`.
//! The service decodes into a CPU-backed image pool and each frame is copied out as linear
//! NV12. The session is configured from the stream, so it starts on the first access unit.
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
    viddec,
    video_wire::Output,
};

/// Enable only in a commit citing matching pixel sums and a clean close on the console.
pub const SDK_H264_VERIFIED: bool = true;
/// AV1 stays out of the stream offer until the diagnostic shows matching sums on the console.
pub const SDK_AV1_VERIFIED: bool = true;
/// The service refuses 2160p at initialize (0x17bc6f) for both codecs. Only the docked-modes
/// build still offers it, for the runs that look for what the service wants.
pub const SDK_DOCKED_MODES: bool = cfg!(feature = "sdk-video-docked-modes");
/// 120 fps is not measured on the console yet. Only the 120 Hz build offers it, up to 1440p,
/// and only on a display that presented at 120 Hz.
pub const SDK_120HZ: bool = cfg!(feature = "sdk-video-120hz");
const FAST_FPS: u32 = if SDK_120HZ { 120 } else { 60 };
/// Largest size and rate per tier, and whether it is offered.
const MODES: [(u32, u32, u32, bool); 3] = [
    (1920, 1080, FAST_FPS, true),
    (2560, 1440, FAST_FPS, true),
    (3840, 2160, 60, SDK_DOCKED_MODES),
];
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
        codec: u32,
        fps: u32,
        work_bytes: usize,
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
    #[cfg(feature = "diagnostic-sdk-decode")]
    fn moonlightSdkVideoNoteFormats(width: u32, height: u32);
}

fn verified(codec: Codec) -> bool {
    match codec {
        Codec::H264 => SDK_H264_VERIFIED,
        Codec::Av1 => SDK_AV1_VERIFIED,
        Codec::Hevc | Codec::Vp9 => false,
    }
}

/// A verified codec, or AV1 in the diagnostic that verifies it.
fn accepted(codec: Codec) -> bool {
    verified(codec) || (codec == Codec::Av1 && cfg!(feature = "diagnostic-sdk-decode"))
}

/// Logs the size the service reports for one image of every output format, HDR included.
/// It opens the decoder root by itself, so call it with no session open.
#[cfg(feature = "diagnostic-sdk-decode")]
pub fn note_output_formats(size: Size) {
    unsafe { moonlightSdkVideoNoteFormats(size.width(), size.height()) }
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
        let config = self.config.ok_or(BackendError::Invalid)?;
        let session =
            viddec::session(config.codec, config.display).ok_or(BackendError::Unsupported)?;
        let mut codec_config = [0; viddec::CODEC_CONFIG_MAX];
        let Some(bytes) = viddec::codec_config(config.codec, access_unit, &mut codec_config) else {
            log(&format!(
                "sdk-video: first {:?} access unit has no codec configuration",
                config.codec
            ));
            return Err(BackendError::Invalid);
        };
        if let Some((width, height)) =
            annexb::h264_coded_size(access_unit).filter(|_| config.codec == Codec::H264)
        {
            log(&format!(
                "sdk-video: SPS codes {width}x{height}; opened for {}x{}",
                config.display.width(),
                config.display.height()
            ));
        }
        let mut stage = 0;
        let result = unsafe {
            moonlightSdkVideoStart(
                session.codec,
                self.fps,
                session.work_bytes,
                codec_config.as_ptr(),
                bytes,
                &mut stage,
            )
        };
        log(&format!(
            "sdk-video: start codec={:?} value={} result=0x{result:x} stage={stage} codec_config_bytes={bytes} work_bytes={} fps={}",
            config.codec, session.codec, session.work_bytes, self.fps
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
        for codec in [Codec::H264, Codec::Av1] {
            for (width, height, fps, offered) in MODES {
                if verified(codec) && offered {
                    capabilities.record(
                        Mode {
                            codec,
                            depth: Depth::Eight,
                            maximum: Size::new(width, height).unwrap(),
                            fps,
                        },
                        Evidence::PixelsAndCloseVerified,
                    );
                }
            }
        }
        capabilities
    }

    fn open(&mut self, config: Config) -> Result<[u32; SURFACES], BackendError> {
        if !accepted(config.codec) || config.backing != Backing::CpuReference {
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
