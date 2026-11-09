extern crate alloc;

#[cfg(any(
    not(feature = "frontend"),
    feature = "diagnostic-frontend",
    feature = "diagnostic-frontend-check"
))]
use alloc::{format, vec::Vec};
use core::{
    alloc::{GlobalAlloc, Layout},
    ffi::c_void,
    panic::PanicInfo,
};
#[cfg(any(
    not(feature = "frontend"),
    feature = "diagnostic-frontend",
    feature = "diagnostic-frontend-check"
))]
use moonlight_nx2_core::{audio, codec, control, input, media};

unsafe extern "C" {
    fn moonlightPlatformStart() -> bool;
    fn moonlightPlatformLog(message: *const u8, bytes: usize);
    fn moonlightPlatformFinish() -> bool;
    fn moonlightPlatformAbort() -> !;
    fn moonlightAllocate(bytes: usize, alignment: usize) -> *mut c_void;
    fn moonlightFree(memory: *mut c_void);
}

struct Allocator;

unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { moonlightAllocate(layout.size(), layout.align()).cast() }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, _layout: Layout) {
        unsafe { moonlightFree(pointer.cast()) };
    }
}

#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

#[panic_handler]
fn panic(_info: &PanicInfo<'_>) -> ! {
    #[cfg(feature = "native-video")]
    log("b2ar: Rust panic; process exits, cleanup unconfirmed");
    unsafe { moonlightPlatformAbort() }
}

pub(super) fn log(message: &str) {
    unsafe { moonlightPlatformLog(message.as_ptr(), message.len()) };
}

#[cfg(any(
    not(feature = "frontend"),
    feature = "diagnostic-frontend",
    feature = "diagnostic-frontend-check"
))]
fn core_check() -> bool {
    let mut storage = Vec::new();
    if storage.try_reserve_exact(control::MAX_PAYLOAD).is_err() {
        log("allocation: FAILED");
        return false;
    }
    storage.resize(control::MAX_PAYLOAD, 0);
    log("allocation: Rust Vec 65536 bytes PASS");

    let mut encoded = [0; 80];
    let length = match control::encode(control::Kind::Auth, 0, &[b'a'; 64], &mut encoded) {
        Ok(length) => length,
        Err(_) => return false,
    };
    let mut parser = control::Parser::new(&mut storage).unwrap();
    for byte in &encoded[..length] {
        if parser.feed(core::slice::from_ref(byte)) != Ok(1) {
            return false;
        }
    }
    let frame = parser.peek().unwrap().unwrap();
    if frame.header.kind != control::Kind::Auth || frame.payload != [b'a'; 64] {
        return false;
    }
    if parser.consume().is_err() || parser.end().is_err() {
        return false;
    }
    drop(parser);
    if storage.iter().any(|byte| *byte != 0) {
        return false;
    }
    log("control: fragmented auth, consume and wipe PASS");

    let header = media::Header {
        payload_bytes: 4,
        sequence: u32::MAX,
        pts_us: u64::MAX,
    };
    let mut media = media::Parser::new(&mut storage, None).unwrap();
    if media.feed(&header.encode()) != Ok(16) || media.feed(&[1, 2, 3, 4]) != Ok(4) {
        return false;
    }
    let frame = media.peek().unwrap();
    if frame.header != header || frame.payload != [1, 2, 3, 4] {
        return false;
    }
    if media.consume().is_err() || media.end().is_err() {
        return false;
    }
    log("media: frame and u64 timestamp PASS");

    let pad = input::map_pad(true, (1 << 0) | (1 << 8), [i32::MIN, i32::MAX, 0, -1]);
    if pad.buttons != 0x1000
        || pad.left_trigger != 255
        || pad.left_x != i16::MIN
        || pad.left_y != i16::MAX
    {
        return false;
    }
    log("input: mapping and clamp PASS");

    let mut audio = audio::Queue::new(audio::Policy::default());
    for item in 0..12 {
        if !audio.push(item) {
            return false;
        }
    }
    let step = audio.step(0).unwrap();
    if step.dropped().len() != 10 || step.appended() != [10, 11] {
        return false;
    }
    log("audio: bounded burst recovery PASS");

    let size = codec::Size::new(1920, 1080).unwrap();
    if codec::Capabilities::default().stream_formats(size, 60) != 0 {
        return false;
    }
    log("codec: unverified formats disabled PASS");
    log(&format!(
        "core: heap bytes={} NV12 bytes={}",
        storage.len(),
        size.nv12_bytes()
    ));
    true
}

#[cfg(feature = "diagnostic-renderer")]
fn renderer_check() -> bool {
    use crate::{
        render::{Config, Error, Renderer},
        sdk,
    };
    use moonlight_nx2_core::frame::{Frame, Matrix, Plane};
    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    const BARS: [[u8; 3]; 8] = [
        [235, 128, 128],
        [219, 16, 138],
        [188, 154, 16],
        [173, 42, 26],
        [78, 214, 230],
        [63, 102, 240],
        [32, 240, 118],
        [16, 128, 128],
    ];
    let mut pixels = Vec::new();
    if pixels.try_reserve_exact(WIDTH * HEIGHT * 3 / 2).is_err() {
        return false;
    }
    pixels.resize(WIDTH * HEIGHT * 3 / 2, 0);
    let (luma, chroma) = pixels.split_at_mut(WIDTH * HEIGHT);
    for row in luma.chunks_exact_mut(WIDTH) {
        for (x, pixel) in row.iter_mut().enumerate() {
            *pixel = BARS[x * 8 / WIDTH][0];
        }
    }
    for row in chroma.chunks_exact_mut(WIDTH) {
        for (x, pixel) in row.chunks_exact_mut(2).enumerate() {
            pixel.copy_from_slice(&BARS[x * 2 * 8 / WIDTH][1..]);
        }
    }
    let mut renderer = match Renderer::open(Config {
        upload_wait_ns: 12_000_000,
        frame_rates: if cfg!(feature = "diagnostic-display120") {
            Some(crate::display::FrameRates {
                at_120hz: 120,
                at_60hz: 60,
                vrr: true,
            })
        } else {
            None
        },
        ..Config::default()
    }) {
        Ok(renderer) => renderer,
        Err(error) => {
            log(&format!("renderer: open FAILED {error:?}"));
            return false;
        }
    };
    log("renderer: moving 1920x1080 BT709 bars for 20 seconds");
    #[cfg(feature = "diagnostic-display")]
    log(&format!("display: initial {:?}", renderer.display()));
    let start = unsafe { sdk::moonlightNowNs() };
    let mut second = start;
    let mut left = 0;
    let mut frames = 0;
    let mut failed = false;
    #[cfg(feature = "diagnostic-coexist")]
    let (mut coexist_done, mut coexist_passed, mut coexist_at) = (false, false, 0);
    while unsafe { sdk::appletMainLoop() }
        && unsafe { sdk::moonlightNowNs() }.saturating_sub(start) < 20_000_000_000
    {
        #[cfg(feature = "diagnostic-coexist")]
        if !coexist_done && frames >= 120 {
            if renderer.storage_mut().is_err() {
                failed = true;
                break;
            }
            log(&format!("coexist: before completed_frames={frames}"));
            coexist_at = frames;
            coexist_passed = crate::gpu_coexist::check();
            coexist_done = true;
            if sdk::process_retired() {
                failed = true;
                break;
            }
        }
        for row in 460..620 {
            for x in left..left + 160 {
                luma[row * WIDTH + x] = BARS[x * 8 / WIDTH][0];
            }
        }
        left = (left + 8) % (WIDTH - 160);
        for row in 460..620 {
            luma[row * WIDTH + left..row * WIDTH + left + 160].fill(235);
        }
        let frame = Frame {
            luma: Plane {
                bytes: luma,
                stride: WIDTH as u32,
            },
            chroma: Plane {
                bytes: chroma,
                stride: WIDTH as u32,
            },
            coded_width: WIDTH as u32,
            coded_height: HEIGHT as u32,
            crop_left: 0,
            crop_top: 0,
            display_width: WIDTH as u32,
            display_height: HEIGHT as u32,
            matrix: Matrix::Bt709,
            full_range: false,
            timestamp_ns: unsafe { sdk::moonlightNowNs() },
        };
        match renderer.upload(&frame) {
            Ok(_) | Err(Error::Busy) => {}
            Err(error) => {
                log(&format!("renderer: upload FAILED {error:?}"));
                failed = true;
                break;
            }
        }
        match renderer.present(false) {
            Ok(()) => frames += 1,
            Err(Error::Busy) => {}
            Err(error) => {
                log(&format!("renderer: present FAILED {error:?}"));
                failed = true;
                break;
            }
        }
        let now = unsafe { sdk::moonlightNowNs() };
        if now.saturating_sub(second) >= 1_000_000_000 {
            log(&format!(
                "renderer: frames={frames} elapsed_ms={}",
                now.saturating_sub(start) / 1_000_000
            ));
            #[cfg(feature = "diagnostic-display")]
            log(&format!("display: sample {:?}", renderer.display()));
            second = now;
        }
    }
    let elapsed_ms = unsafe { sdk::moonlightNowNs() }.saturating_sub(start) / 1_000_000;
    #[cfg(feature = "diagnostic-display")]
    log(&format!("display: final {:?}", renderer.display()));
    log(&format!(
        "renderer: total frames={frames} elapsed_ms={elapsed_ms}"
    ));
    let close = renderer.close();
    log(&format!("renderer: close {close:?}"));
    let passed = !failed && close.is_ok() && frames >= 1000 && elapsed_ms >= 20_000;
    #[cfg(feature = "diagnostic-coexist")]
    let passed = {
        log(&format!(
            "coexist: after presented_frames={} observed={coexist_passed}",
            frames - coexist_at
        ));
        passed && coexist_done && coexist_passed && frames - coexist_at >= 120
    };
    log(if passed {
        "renderer: result PASS"
    } else {
        "renderer: result FAIL"
    });
    passed
}

#[unsafe(export_name = "moonlightRustMain")]
pub extern "C" fn main() -> i32 {
    if !unsafe { moonlightPlatformStart() } {
        return 1;
    }
    log(if cfg!(feature = "native-video") {
        "Moonlight NX2 Rust frontend; native video behind verified capabilities"
    } else if cfg!(feature = "frontend") {
        "Moonlight NX2 Rust frontend; native codecs disabled"
    } else {
        "Moonlight NX2 Rust runtime diagnostic; streaming not implemented"
    });
    #[cfg(any(
        not(feature = "frontend"),
        feature = "diagnostic-frontend",
        feature = "diagnostic-frontend-check"
    ))]
    let passed = core_check();
    #[cfg(not(any(
        not(feature = "frontend"),
        feature = "diagnostic-frontend",
        feature = "diagnostic-frontend-check"
    )))]
    let passed = true;
    #[cfg(feature = "frontend")]
    let passed = passed && crate::native_frontend::run();
    #[cfg(feature = "diagnostic-renderer")]
    let passed = passed && renderer_check();
    #[cfg(feature = "diagnostic-io")]
    let passed = passed && crate::io_diagnostic::io_check();
    #[cfg(feature = "diagnostic-audio-cue")]
    let passed = passed && crate::audio_cue_diagnostic::check();
    #[cfg(feature = "diagnostic-udp")]
    let passed = passed && crate::udp_diagnostic::check();
    #[cfg(feature = "diagnostic-nvdec")]
    let passed = passed && crate::nvdec_access::nvdec_check();
    #[cfg(feature = "diagnostic-sdk-backing")]
    let passed = passed && crate::sdk_backing_diagnostic::check();
    #[cfg(feature = "diagnostic-ui")]
    let passed = passed && crate::ui_diagnostic::check();
    #[cfg(feature = "diagnostic-control")]
    let passed = passed && crate::control_diagnostic::check();
    log(if passed {
        "runtime: result PASS"
    } else {
        "runtime: result FAIL"
    });
    let retired = crate::sdk::process_retired();
    if retired {
        log("runtime: retained resources; exit process, restart before another GPU test");
    }
    let closed = unsafe { moonlightPlatformFinish() };
    if retired {
        unsafe { crate::sdk::svcExitProcess() }
    }
    i32::from(!passed || !closed)
}
