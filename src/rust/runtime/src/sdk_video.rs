//! Decoder backend over the SDK's video decoder (`viddec.h`), through `nro/sdk_viddec.c`.
//! The service decodes into a CPU-backed image pool and each frame is copied out as linear
//! NV12. The session is configured from the stream, so it starts on the first access unit.
//! The service scales the picture to the image size, so images have the display size.

extern crate alloc;

use crate::{
    device::log,
    sdk,
    sdk_modes::{self, verified},
    stream_stats::{self, DecoderEvent, Stage},
};
use alloc::format;
use core::sync::atomic::{AtomicBool, Ordering};
use moonlight_nx2_core::{
    annexb,
    codec::{Capabilities, Codec},
    decoder::{self, Backend, BackendError, Config, HostImage, SURFACES, UNITS},
    stats::DecoderQueue,
    viddec,
    video_wire::Output,
};

/// The SDK object's images: one shown and one waiting to be, while two more decode. With
/// the two surfaces alone a held frame kept the next unit from decoding until it was shown.
const SDK_BUFFERS: u32 = SURFACES as u32 + 2;
const SUBMIT_BUSY: u32 = (3603 << 9) | 111;
const TIMED_OUT: u32 = 0xea01;
const STAGE_POOL_CLOSE: u32 = 13;

/// A refused fps hint costs a create, so it is asked once a process for each rate.
static HINT_120_REFUSED: AtomicBool = AtomicBool::new(false);
static HINT_60_REFUSED: AtomicBool = AtomicBool::new(false);

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
    offset: [u32; 2],
}

/// A held frame in its SDK image's backing, as `moonlightSdkDecoderHost` gives it.
#[repr(C)]
struct Host {
    base: *mut u8,
    bytes: u64,
    luma_offset: u64,
    chroma_offset: u64,
    pitch: u32,
    rows: u32,
}

impl Default for Host {
    fn default() -> Self {
        Self {
            base: core::ptr::null_mut(),
            bytes: 0,
            luma_offset: 0,
            chroma_offset: 0,
            pitch: 0,
            rows: 0,
        }
    }
}

unsafe extern "C" {
    fn moonlightSdkVideoOpen(
        width: u32,
        height: u32,
        count: u32,
        slots: *const *mut u8,
        slot_bytes: usize,
        images: *mut u32,
        stage: *mut u32,
        sync_result: *mut u32,
        place_result: *mut u32,
    ) -> u32;
    fn moonlightSdkVideoWait(slot: u32, timeout_ns: u64, ready: *mut bool) -> u32;
    fn moonlightSdkDecoderOpen(
        width: u32,
        height: u32,
        count: u32,
        buffers: u32,
        images: *mut u32,
    ) -> u32;
    fn moonlightSdkDecoderStart(
        codec: u32,
        fps: u32,
        codec_config: *const u8,
        codec_config_bytes: usize,
        max_sample_bytes: u64,
    ) -> u32;
    fn moonlightSdkDecoderSubmit(data: *const u8, bytes: usize, timestamp_ns: i64) -> u32;
    fn moonlightSdkDecoderWait(slot: u32, timeout_ns: u64, ready: *mut bool) -> u32;
    fn moonlightSdkDecoderOutput(slot: u32, out: *mut Properties) -> u32;
    fn moonlightSdkDecoderRead(
        slot: u32,
        luma: *mut u8,
        chroma: *mut u8,
        pitch: usize,
        rows: usize,
        source_pitch: *mut u32,
    ) -> u32;
    fn moonlightSdkDecoderRelease(slot: u32) -> u32;
    fn moonlightSdkDecoderHost(slot: u32, out: *mut Host) -> u32;
    fn moonlightSdkVideoHost(slot: u32, out: *mut Host) -> u32;
    fn moonlightSdkDecoderClose();
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
    #[cfg(feature = "diagnostic-sdk-modes")]
    fn moonlightSdkVideoTune(
        input_format: u32,
        output_format: u32,
        pool_height: u32,
        max_input_bytes: u32,
        split_initialize: bool,
    );
}

/// What a diagnostic session changes from the stream's own choices. Zero keeps the choice.
#[cfg(feature = "diagnostic-sdk-modes")]
#[derive(Clone, Copy)]
pub struct Tuning {
    pub input_format: u32,
    pub output_format: u32,
    pub pool_height: u32,
    pub max_input_bytes: u32,
    pub work_mebibytes: usize,
    /// The rate the decoder is configured with, when not the session rule's.
    pub frame_rate: u32,
    /// Initialize command by command, so the log names the one that refused.
    pub split_initialize: bool,
    /// No line per unit, for a session that is timed.
    pub quiet: bool,
}

#[cfg(feature = "diagnostic-sdk-modes")]
impl Tuning {
    pub const NONE: Self = Self {
        input_format: 0,
        output_format: 0,
        pool_height: 0,
        max_input_bytes: 0,
        work_mebibytes: 0,
        frame_rate: 0,
        split_initialize: false,
        quiet: false,
    };
}

/// A verified codec, or AV1 in the diagnostic that verifies it.
fn accepted(codec: Codec) -> bool {
    verified(codec) || (codec == Codec::Av1 && cfg!(feature = "diagnostic-sdk-decode"))
}

/// Logs the size the service reports for one image of every output format, HDR included.
/// It opens the decoder root by itself, so call it with no session open.
#[cfg(feature = "diagnostic-sdk-decode")]
pub fn note_output_formats(size: moonlight_nx2_core::codec::Size) {
    unsafe { moonlightSdkVideoNoteFormats(size.width(), size.height()) }
}

pub struct SdkVideo {
    fps: u32,
    /// The SDK's `VideoDecoder` object, which streams use. Our low-level session, frames
    /// copied out, stays for the reference replays.
    sdk_object: bool,
    #[cfg(feature = "diagnostic-sdk-modes")]
    tuning: Tuning,
    config: Option<Config>,
    started: bool,
    ready: Option<usize>,
    layout_reported: bool,
    submitted: [u64; UNITS],
    microseconds_reported: bool,
    busy_submits: u64,
    /// Submission times of the units not yet seen decoded, oldest first.
    in_flight: [u64; UNITS],
    in_flight_count: usize,
    queue: DecoderQueue,
}

impl SdkVideo {
    #[cfg(feature = "diagnostic-sdk-modes")]
    pub fn tuned(fps: u32, tuning: Tuning) -> Self {
        Self {
            tuning,
            ..Self::low_level(fps)
        }
    }

    /// Whether the diagnostic's line per unit is wanted.
    #[cfg(feature = "diagnostic-sdk-decode")]
    fn chatty(&self) -> bool {
        #[cfg(feature = "diagnostic-sdk-modes")]
        return !self.tuning.quiet;
        #[cfg(not(feature = "diagnostic-sdk-modes"))]
        true
    }

    pub fn new(fps: u32) -> Self {
        Self {
            sdk_object: true,
            ..Self::low_level(fps)
        }
    }

    pub fn low_level(fps: u32) -> Self {
        Self {
            fps,
            sdk_object: false,
            #[cfg(feature = "diagnostic-sdk-modes")]
            tuning: Tuning::NONE,
            config: None,
            started: false,
            ready: None,
            layout_reported: false,
            submitted: [0; UNITS],
            microseconds_reported: false,
            busy_submits: 0,
            in_flight: [0; UNITS],
            in_flight_count: 0,
            queue: DecoderQueue::default(),
        }
    }

    fn high_level(&self) -> bool {
        self.sdk_object
    }

    fn submitted_at(&mut self, now_ns: u64) {
        if self.in_flight_count == UNITS {
            self.in_flight.rotate_left(1);
            self.in_flight_count -= 1;
        }
        self.in_flight[self.in_flight_count] = now_ns;
        self.in_flight_count += 1;
    }

    /// Frames finish in submission order, so a newly ready one is the oldest unit's.
    fn decoded_at(&mut self, now_ns: u64) {
        if self.in_flight_count == 0 {
            return;
        }
        let submitted_ns = self.in_flight[0];
        let started_ns = self.queue.start(submitted_ns, now_ns);
        stream_stats::decoded(submitted_ns, started_ns, now_ns);
        self.in_flight.rotate_left(1);
        self.in_flight_count -= 1;
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

    /// AV1 takes nothing from the stream to start, so its decoder is created at open, before
    /// the first unit and before audio plays. H.264 waits for the parameter sets of its first.
    fn start_early(&mut self) -> Result<(), BackendError> {
        match self.config {
            Some(config) if config.codec == Codec::Av1 => self.start(&[]),
            _ => Ok(()),
        }
    }

    fn start(&mut self, access_unit: &[u8]) -> Result<(), BackendError> {
        let config = self.config.ok_or_else(|| invalid("start before open"))?;
        let session = viddec::session(config.codec, config.display, self.fps)
            .ok_or(BackendError::Unsupported)?;
        #[cfg(feature = "diagnostic-sdk-modes")]
        let session = viddec::Session {
            work_bytes: match self.tuning.work_mebibytes {
                0 => session.work_bytes,
                mebibytes => mebibytes << 20,
            },
            frame_rate: match self.tuning.frame_rate {
                0 => session.frame_rate,
                rate => rate,
            },
            ..session
        };
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
        let start_ns = unsafe { sdk::moonlightNowNs() };
        let took_ms = || (unsafe { sdk::moonlightNowNs() } - start_ns) / 1_000_000;
        if self.high_level() {
            let input_max = decoder::input_max(config.display);
            let create = |frame_rate: u32| {
                let result = unsafe {
                    moonlightSdkDecoderStart(
                        session.codec,
                        frame_rate,
                        codec_config.as_ptr(),
                        bytes,
                        input_max as u64,
                    )
                };
                log(&format!(
                    "sdk-decoder: start codec={:?} result=0x{result:x} codec_config_bytes={bytes} fps={frame_rate} stream_fps={} max_input={input_max} took_ms={}",
                    config.codec,
                    self.fps,
                    took_ms()
                ));
                result
            };
            let hint = viddec::frame_rate_hint(config.display);
            let refused = match hint {
                120 => &HINT_120_REFUSED,
                _ => &HINT_60_REFUSED,
            };
            let mut accepted = session.frame_rate;
            let mut result = u32::MAX;
            if !refused.load(Ordering::Relaxed) {
                result = create(hint);
                if result == 0 {
                    accepted = hint;
                } else {
                    refused.store(true, Ordering::Relaxed);
                }
            }
            if result != 0 {
                result = create(session.frame_rate);
            }
            log(&format!(
                "sdk-decoder: fps hint requested={hint} accepted={}",
                if result == 0 { accepted } else { 0 }
            ));
            check("start", result)?;
            self.started = true;
            return Ok(());
        }
        let mut stage = 0;
        let result = unsafe {
            moonlightSdkVideoStart(
                session.codec,
                session.frame_rate,
                session.work_bytes,
                codec_config.as_ptr(),
                bytes,
                &mut stage,
            )
        };
        log(&format!(
            "sdk-video: start codec={:?} value={} result=0x{result:x} stage={stage} codec_config_bytes={bytes} work_bytes={} fps={} stream_fps={} took_ms={}",
            config.codec,
            session.codec,
            session.work_bytes,
            session.frame_rate,
            self.fps,
            took_ms()
        ));
        if result != 0 {
            return Err(BackendError::Refused);
        }
        self.started = true;
        Ok(())
    }
}

fn invalid(reason: &str) -> BackendError {
    log(&format!("sdk-video: invalid, {reason}"));
    BackendError::Invalid
}

fn check(operation: &str, result: u32) -> Result<(), BackendError> {
    if result == 0 {
        return Ok(());
    }
    stream_stats::decoder(DecoderEvent::Error);
    log(&format!("sdk-video: {operation} result=0x{result:x}"));
    Err(BackendError::Refused)
}

impl Backend for SdkVideo {
    fn capabilities() -> Capabilities {
        sdk_modes::capabilities()
    }

    fn open(&mut self, config: Config) -> Result<[u32; SURFACES], BackendError> {
        if !accepted(config.codec) {
            return Err(BackendError::Unsupported);
        }
        #[cfg(feature = "diagnostic-sdk-modes")]
        unsafe {
            let tuning = self.tuning;
            moonlightSdkVideoTune(
                tuning.input_format,
                tuning.output_format,
                tuning.pool_height,
                tuning.max_input_bytes,
                tuning.split_initialize,
            );
        }
        let mut images = [0; SURFACES];
        stream_stats::decoder_path(self.sdk_object);
        self.in_flight_count = 0;
        if self.high_level() {
            let result = unsafe {
                moonlightSdkDecoderOpen(
                    config.display.width(),
                    config.display.height(),
                    SURFACES as u32,
                    SDK_BUFFERS,
                    images.as_mut_ptr(),
                )
            };
            log(&format!(
                "sdk-decoder: open result=0x{result:x} buffers={SDK_BUFFERS} units={}",
                self.units()
            ));
            check("open", result)?;
            self.config = Some(config);
            self.start_early()?;
            return Ok(images);
        }
        let mut stage = 0;
        let mut sync_result = 0;
        let mut place_result = 0;
        let result = unsafe {
            moonlightSdkVideoOpen(
                config.display.width(),
                config.display.height(),
                SURFACES as u32,
                core::ptr::null(),
                0,
                images.as_mut_ptr(),
                &mut stage,
                &mut sync_result,
                &mut place_result,
            )
        };
        log(&format!(
            "sdk-video: open result=0x{result:x} stage={stage} sync=0x{sync_result:x} place=0x{place_result:x} images={images:?}"
        ));
        if result != 0 {
            return Err(if stage == STAGE_POOL_CLOSE {
                BackendError::Uncertain
            } else {
                BackendError::Refused
            });
        }
        if sync_result != 0 {
            log("sdk-video: no sync session; frames are taken when their properties arrive");
        }
        self.config = Some(config);
        self.start_early()?;
        Ok(images)
    }

    fn submit(&mut self, bytes: &[u8], pts_us: u64) -> Result<(), BackendError> {
        if !self.started {
            self.start(bytes)?;
        }
        let timestamp_ns = pts_us
            .checked_mul(1000)
            .and_then(|timestamp| i64::try_from(timestamp).ok())
            .ok_or_else(|| invalid("submit timestamp range"))?;
        #[cfg(feature = "diagnostic-sdk-decode")]
        if self.chatty() {
            log(&format!(
                "b2ar: before submit pts_us={pts_us} bytes={}",
                bytes.len()
            ));
        }
        let result = unsafe {
            if self.high_level() {
                moonlightSdkDecoderSubmit(bytes.as_ptr(), bytes.len(), timestamp_ns)
            } else {
                moonlightSdkVideoSubmit(bytes.as_ptr(), bytes.len(), timestamp_ns)
            }
        };
        if result == SUBMIT_BUSY || (self.high_level() && result & 0x3f_ffff == TIMED_OUT) {
            self.busy_submits += 1;
            stream_stats::decoder(DecoderEvent::Busy);
            return Err(BackendError::Busy);
        }
        check("submit", result)?;
        stream_stats::decoder(DecoderEvent::Submit);
        self.submitted_at(unsafe { sdk::moonlightNowNs() });
        self.submitted.rotate_left(1);
        self.submitted[UNITS - 1] = pts_us;
        Ok(())
    }

    fn ready(&mut self, surface: usize) -> Result<bool, BackendError> {
        self.wait(surface, 0)
    }

    fn wait(&mut self, surface: usize, timeout_ns: u64) -> Result<bool, BackendError> {
        let mut ready = false;
        check("ready", unsafe {
            match (self.high_level(), timeout_ns) {
                (true, _) => moonlightSdkDecoderWait(surface as u32, timeout_ns, &mut ready),
                (false, 0) => moonlightSdkVideoReady(surface as u32, &mut ready),
                (false, _) => moonlightSdkVideoWait(surface as u32, timeout_ns, &mut ready),
            }
        })?;
        if ready {
            if self.ready != Some(surface) {
                #[cfg(feature = "diagnostic-sdk-decode")]
                if self.chatty() {
                    log(&format!("b2ar: ready surface={surface}"));
                }
                self.decoded_at(unsafe { sdk::moonlightNowNs() });
            }
            self.ready = Some(surface);
        }
        Ok(ready)
    }

    fn output(&mut self) -> Result<Output, BackendError> {
        let surface = self
            .ready
            .take()
            .ok_or_else(|| invalid("output before ready"))?;
        let mut properties = Properties::default();
        #[cfg(feature = "diagnostic-sdk-decode")]
        if self.chatty() {
            log(&format!("b2ar: before output surface={surface}"));
        }
        check("output properties", unsafe {
            if self.high_level() {
                moonlightSdkDecoderOutput(surface as u32, &mut properties)
            } else {
                moonlightSdkVideoOutput(surface as u32, &mut properties)
            }
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
        let config = self.config.ok_or_else(|| invalid("readback before open"))?;
        let width = config.coded.width() as usize;
        let luma_bytes = width * config.coded.height() as usize;
        if out.len() < config.coded.nv12_bytes() {
            return Err(invalid("readback target too small"));
        }
        let (luma, chroma) = out.split_at_mut(luma_bytes);
        let mut layout = Layout::default();
        let read_start_ns = unsafe { sdk::moonlightNowNs() };
        let result = unsafe {
            if self.high_level() {
                let mut pitch = 0;
                let result = moonlightSdkDecoderRead(
                    surface as u32,
                    luma.as_mut_ptr(),
                    chroma.as_mut_ptr(),
                    width,
                    config.coded.height() as usize,
                    &mut pitch,
                );
                layout.pitch = [u64::from(pitch); 2];
                result
            } else {
                moonlightSdkVideoRead(
                    surface as u32,
                    luma.as_mut_ptr(),
                    chroma.as_mut_ptr(),
                    width,
                    config.coded.height() as usize,
                    &mut layout,
                )
            }
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
            if self.high_level() {
                moonlightSdkDecoderRelease(surface as u32)
            } else {
                moonlightSdkVideoRelease(surface as u32)
            }
        })
    }

    fn units(&self) -> usize {
        if self.high_level() { UNITS } else { 2 }
    }

    fn closes_after_malformed(&self) -> bool {
        self.high_level()
    }

    fn host_images(&self) -> bool {
        self.high_level()
    }

    fn host_image(&self, surface: usize) -> Option<HostImage> {
        if !self.host_images() {
            return None;
        }
        let mut host = Host::default();
        let result = unsafe {
            if self.high_level() {
                moonlightSdkDecoderHost(surface as u32, &mut host)
            } else {
                moonlightSdkVideoHost(surface as u32, &mut host)
            }
        };
        if result != 0 {
            return None;
        }
        Some(HostImage {
            base: host.base,
            bytes: usize::try_from(host.bytes).ok()?,
            luma_offset: usize::try_from(host.luma_offset).ok()?,
            chroma_offset: usize::try_from(host.chroma_offset).ok()?,
            pitch: host.pitch,
            rows: host.rows,
        })
    }

    fn close(&mut self) -> Result<(), BackendError> {
        if self.high_level() {
            unsafe { moonlightSdkDecoderClose() };
            log(&format!(
                "sdk-decoder: closed busy_submits={}",
                self.busy_submits
            ));
            self.config = None;
            self.started = false;
            self.ready = None;
            return Ok(());
        }
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
