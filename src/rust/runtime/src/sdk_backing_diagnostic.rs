use crate::{
    device::log,
    render::{Config, Error, Renderer},
    sdk, sdk_backing,
};
use alloc::{format, vec};
use moonlight_nx2_core::frame::{Frame, Matrix, Plane};

pub fn check() -> bool {
    const WIDTH: usize = 1920;
    const HEIGHT: usize = 1080;
    let mut pixels = vec![128; WIDTH * HEIGHT * 3 / 2];
    bars(&mut pixels, false);
    let start = unsafe { sdk::moonlightNowNs() };
    let mut renderer = match Renderer::open(Config::default()) {
        Ok(renderer) => renderer,
        Err(error) => {
            log(&format!("sdk-backing: renderer open FAIL {error:?}"));
            return false;
        }
    };
    log("sdk-backing: metadata only; no consumer, decoder or additional GPU/VM");
    let mut frames = 0;
    let result = (|| {
        renderer.upload(&frame(&pixels))?;
        render_phase(&mut renderer, 120, start, &mut frames)?;
        log(&format!("sdk-backing: before frames={frames} bars=normal"));
        let probe =
            renderer.probe_backing(&mut |allocation| sdk_backing::query(allocation.memory))?;
        log(&format!("sdk-backing: allocation {:?}", probe.allocation));
        log(&format!("sdk-backing: report {:?}", probe.report));
        log(&format!(
            "sdk-backing: comparison {:?} query_ns={:?}",
            probe.comparison, probe.query_ns
        ));
        log("sdk-backing: owned allocation unmap/free completed; public Vulkan void operations");
        let before = frames;
        bars(&mut pixels, true);
        renderer.upload(&frame(&pixels))?;
        render_phase(&mut renderer, 120, start, &mut frames)?;
        log(&format!(
            "sdk-backing: after frames={} continued={} bars=reversed",
            frames,
            frames - before
        ));
        Ok::<_, Error>(
            probe.comparison.is_ok() && probe.query_ns.is_some_and(|ns| ns <= 250_000_000),
        )
    })();
    let closed = renderer.close();
    log(&format!("sdk-backing: renderer close {closed:?}"));
    let elapsed_ns = unsafe { sdk::moonlightNowNs() }.saturating_sub(start);
    let passed =
        result == Ok(true) && closed.is_ok() && frames == 240 && elapsed_ns < 10_000_000_000;
    log(&format!(
        "sdk-backing: frames={frames} elapsed_ns={elapsed_ns} retired={}",
        sdk::process_retired()
    ));
    log(if passed {
        "sdk-backing: result PASS"
    } else {
        "sdk-backing: result FAIL"
    });
    passed
}

fn frame(pixels: &[u8]) -> Frame<'_> {
    Frame {
        luma: Plane {
            bytes: &pixels[..1920 * 1080],
            stride: 1920,
        },
        chroma: Plane {
            bytes: &pixels[1920 * 1080..],
            stride: 1920,
        },
        coded_width: 1920,
        coded_height: 1080,
        crop_left: 0,
        crop_top: 0,
        display_width: 1920,
        display_height: 1080,
        matrix: Matrix::Bt709,
        full_range: false,
        timestamp_ns: 0,
    }
}

fn bars(pixels: &mut [u8], reversed: bool) {
    let colors = [
        [235, 128, 128],
        [219, 16, 138],
        [188, 154, 16],
        [173, 42, 26],
        [78, 214, 230],
        [63, 102, 240],
        [32, 240, 118],
        [16, 128, 128],
    ];
    let color = |x: usize| {
        colors[if reversed {
            7 - x * 8 / 1920
        } else {
            x * 8 / 1920
        }]
    };
    for row in pixels[..1920 * 1080].chunks_exact_mut(1920) {
        for (x, value) in row.iter_mut().enumerate() {
            *value = color(x)[0];
        }
    }
    for row in pixels[1920 * 1080..].chunks_exact_mut(1920) {
        for (x, value) in row.chunks_exact_mut(2).enumerate() {
            value.copy_from_slice(&color(x * 2)[1..]);
        }
    }
}

fn render_phase(
    renderer: &mut Renderer,
    count: usize,
    start: u64,
    frames: &mut usize,
) -> Result<(), Error> {
    for _ in 0..count {
        if unsafe { sdk::moonlightNowNs() }.saturating_sub(start) >= 10_000_000_000 {
            return Err(Error::Busy);
        }
        renderer.present(false)?;
        *frames += 1;
    }
    Ok(())
}
