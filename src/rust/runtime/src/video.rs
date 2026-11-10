//! Stream video: decoder submission, loss recovery, presentation of decoded frames (bound in
//! place or copied) and pacing statistics.

extern crate alloc;

use crate::{
    render::{self, Renderer},
    render_platform as platform,
    stream_stats::{self, Stage},
};
use alloc::format;
use core::cell::Cell;
use moonlight_nx2_core::{
    codec::{Capabilities, Codec, Depth},
    decoder::{self, Backend, Decoder, FrameInfo, FrameToken, SURFACES},
    frame::{Frame, Layout, Matrix, Plane},
    media::Header,
    recovery::{self, Decision, Recovery},
    stats::StreamStats,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Unverified,
    Closed,
    Decoder(decoder::Error),
    Renderer(render::Error),
}

#[derive(Clone, Copy)]
pub struct Config {
    pub decoder: decoder::Config,
    pub fps: u32,
    pub matrix: Matrix,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub accepted_units: u64,
    pub accepted_bytes: u64,
    pub decoded: u64,
    pub uploaded: u64,
    pub dropped: u64,
    pub presented: u64,
    pub zero_copy: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Presentation {
    pub received_us: Option<u64>,
    pub presented_us: u64,
}

#[derive(Clone, Copy)]
struct Arrival {
    pts_us: u64,
    received_us: Option<u64>,
    submitted_ns: u64,
}

#[derive(Default)]
struct Timing {
    window_ns: u64,
    logged: u64,
    frames: u64,
    decode_us: u64,
    decode_max_us: u64,
    latency_us: u64,
    latency_max_us: u64,
    last_present_ns: u64,
    interval_max_us: u64,
    dropped_start: u64,
}

const LOG_TIMING: bool = cfg!(feature = "diagnostic-native-decode");

impl Timing {
    fn record(&mut self, pts_us: u64, submitted: u64, decoded: u64, started: u64, returned: u64) {
        let decode_us = decoded.saturating_sub(submitted) / 1000;
        let latency_us = returned.saturating_sub(submitted) / 1000;
        let interval_us = if self.last_present_ns == 0 {
            0
        } else {
            returned.saturating_sub(self.last_present_ns) / 1000
        };
        if LOG_TIMING && self.logged < 120 {
            self.logged += 1;
            platform::log(&format!(
                "video-timing: pts_us={pts_us} present_return_ns={returned} submit_to_readback_us={decode_us} present_call_us={} submit_to_present_return_us={latency_us}",
                returned.saturating_sub(started) / 1000
            ));
        }
        self.last_present_ns = returned;
        self.frames += 1;
        self.decode_us += decode_us;
        self.decode_max_us = self.decode_max_us.max(decode_us);
        self.latency_us += latency_us;
        self.latency_max_us = self.latency_max_us.max(latency_us);
        self.interval_max_us = self.interval_max_us.max(interval_us);
    }

    fn summarize(&mut self, now: u64, stats: &Stats, recovery: recovery::Counters) {
        if self.window_ns == 0 {
            self.restart(now, stats);
            return;
        }
        let elapsed = now.saturating_sub(self.window_ns);
        if elapsed < 1_000_000_000 {
            return;
        }
        let frames = self.frames.max(1);
        let (input_mean_us, input_max_us) = crate::stream_stats::take_input();
        let clamp = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);
        crate::stream_stats::publish(StreamStats {
            window_ms: clamp(elapsed / 1_000_000),
            fps_x10: clamp(self.frames * 10_000_000_000 / elapsed),
            decode_mean_us: clamp(self.decode_us / frames),
            decode_max_us: clamp(self.decode_max_us),
            latency_mean_us: clamp(self.latency_us / frames),
            latency_max_us: clamp(self.latency_max_us),
            input_mean_us,
            input_max_us,
            presented: clamp(self.frames),
            dropped: clamp(stats.dropped.saturating_sub(self.dropped_start)),
            zero_copy: stats.zero_copy != 0,
            idr_requests: clamp(recovery.idr_requests),
            frames_skipped: clamp(recovery.frames_skipped),
        });
        if !LOG_TIMING {
            self.restart(now, stats);
            return;
        }
        platform::log(&format!(
            "video-pace: window_ms={} presented={} fps_x10={} decode_mean_us={} decode_max_us={} latency_mean_us={} latency_max_us={} interval_max_us={} zero_copy_total={} dropped_total={} idr_requests={} frames_skipped={}",
            elapsed / 1_000_000,
            self.frames,
            self.frames * 10_000_000_000 / elapsed,
            self.decode_us / frames,
            self.decode_max_us,
            self.latency_us / frames,
            self.latency_max_us,
            self.interval_max_us,
            stats.zero_copy,
            stats.dropped,
            recovery.idr_requests,
            recovery.frames_skipped
        ));
        self.restart(now, stats);
    }

    fn restart(&mut self, now: u64, stats: &Stats) {
        *self = Self {
            window_ns: now,
            logged: self.logged,
            last_present_ns: self.last_present_ns,
            dropped_start: stats.dropped,
            ..Self::default()
        };
    }
}

pub struct Video<'a, B: Backend<N>, const N: usize = SURFACES> {
    decoder: Decoder<'a, B, N>,
    codec: Codec,
    recovery: Recovery,
    matrix: Matrix,
    failure: Option<Error>,
    pending: bool,
    closed: bool,
    stats: Stats,
    arrivals: [Option<Arrival>; decoder::UNITS],
    bound: [Option<FrameToken>; N],
    pending_arrival: Option<u64>,
    pending_timing: Option<(u64, u64, u64)>,
    timing: Timing,
    presentation: Option<Presentation>,
}

impl<'a, B: Backend<N>, const N: usize> Video<'a, B, N> {
    pub fn open(
        backend: B,
        config: Config,
        capabilities: &Capabilities,
        retired: &'a Cell<bool>,
        frames: [&'a mut [u8]; decoder::FRAMES],
    ) -> Result<Self, Error> {
        if !capabilities.supports(
            config.decoder.codec,
            Depth::Eight,
            config.decoder.display,
            config.fps,
        ) {
            return Err(Error::Unverified);
        }
        if platform::process_retired() {
            retired.set(true);
            return Err(Error::Decoder(decoder::Error::Retired));
        }
        let mut decoder = match Decoder::open(backend, config.decoder, retired, frames) {
            Ok(decoder) => decoder,
            Err(error) => {
                if retired.get() {
                    platform::retire_process();
                }
                return Err(Error::Decoder(error));
            }
        };
        decoder.set_zero_copy(
            cfg!(all(target_os = "none", feature = "native-video"))
                && config.decoder.backing == decoder::Backing::NativeGpu,
        );
        Ok(Self {
            decoder,
            codec: config.decoder.codec,
            recovery: Recovery::default(),
            matrix: config.matrix,
            failure: None,
            pending: false,
            closed: false,
            stats: Stats::default(),
            arrivals: [None; decoder::UNITS],
            bound: [None; N],
            pending_arrival: None,
            pending_timing: None,
            timing: Timing::default(),
            presentation: None,
        })
    }

    pub fn set_zero_copy(&mut self, enabled: bool) {
        self.decoder.set_zero_copy(enabled);
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }
    pub fn failure(&self) -> Option<Error> {
        self.failure
    }

    pub fn take_presentation(&mut self) -> Option<Presentation> {
        self.presentation.take()
    }

    pub fn pending(&self) -> bool {
        !self.closed && (self.pending || self.decoder.pending_units() != 0)
    }

    fn fail(&mut self, error: Error) -> Error {
        if matches!(
            error,
            Error::Decoder(decoder::Error::Uncertain | decoder::Error::Retired)
                | Error::Renderer(render::Error::Retained)
        ) {
            self.decoder.retire();
            platform::retire_process();
        }
        self.failure = Some(error);
        error
    }

    fn active(&mut self) -> Result<(), Error> {
        if self.closed {
            return Err(Error::Closed);
        }
        if platform::process_retired() {
            return Err(self.fail(Error::Renderer(render::Error::Retained)));
        }
        self.failure.map_or(Ok(()), Err)
    }

    pub fn submit(&mut self, header: &Header, bytes: &[u8]) -> Result<(), Error> {
        self.submit_timed(header, bytes, None)
    }

    pub fn submit_timed(
        &mut self,
        header: &Header,
        bytes: &[u8],
        received_us: Option<u64>,
    ) -> Result<(), Error> {
        self.active()?;
        if header.payload_bytes as usize != bytes.len() {
            return Err(self.fail(Error::Decoder(decoder::Error::Invalid)));
        }
        let submitted_ns = platform::now_ns();
        let keyframe = recovery::keyframe(self.codec, bytes);
        let decision = self.recovery.unit(
            header.sequence,
            keyframe,
            header.pts_us,
            submitted_ns / 1_000_000,
        );
        self.forward_idr_request();
        if decision == Decision::Skip {
            return Ok(());
        }
        let submitted = self.decoder.submit(bytes, header.pts_us);
        stream_stats::stage(Stage::Submit, submitted_ns, platform::now_ns());
        match submitted {
            Ok(()) => {
                let Some(index) = self.arrivals.iter().position(Option::is_none) else {
                    return Err(self.fail(Error::Decoder(decoder::Error::Uncertain)));
                };
                self.arrivals[index] = Some(Arrival {
                    pts_us: header.pts_us,
                    received_us,
                    submitted_ns,
                });
                self.stats.accepted_units += 1;
                self.stats.accepted_bytes += bytes.len() as u64;
                Ok(())
            }
            Err(decoder::Error::Again) => Err(Error::Decoder(decoder::Error::Again)),
            Err(error) => Err(self.fail(Error::Decoder(error))),
        }
    }

    fn forward_idr_request(&mut self) {
        if self.recovery.take_request() {
            crate::stream_stats::request_idr();
            platform::log(&format!(
                "video-recovery: idr request {:?}",
                self.recovery.counters()
            ));
        }
    }

    pub fn recovery(&self) -> recovery::Counters {
        self.recovery.counters()
    }

    fn release_bound(&mut self, renderer: &mut Renderer) -> Result<(), Error> {
        for surface in 0..N {
            let Some(token) = self.bound[surface] else {
                continue;
            };
            if native_busy(renderer, surface).map_err(|error| self.fail(Error::Renderer(error)))? {
                continue;
            }
            self.bound[surface] = None;
            self.decoder
                .release(token)
                .map_err(|error| self.fail(Error::Decoder(error)))?;
        }
        Ok(())
    }

    fn upload(&mut self, renderer: &mut Renderer, info: &FrameInfo) -> Result<bool, Error> {
        if let (Some(image), Some(surface)) = (info.bound, info.token.surface()) {
            let uploaded = native_upload(renderer, surface, image, info, self.matrix);
            return match uploaded {
                Ok(()) => {
                    self.bound[surface] = Some(info.token);
                    self.stats.zero_copy += 1;
                    Ok(true)
                }
                Err(render::Error::Busy) => {
                    self.decoder
                        .release(info.token)
                        .map_err(|error| self.fail(Error::Decoder(error)))?;
                    Ok(false)
                }
                Err(error) => {
                    let _ = self.decoder.release(info.token);
                    Err(self.fail(Error::Renderer(error)))
                }
            };
        }

        let bytes = match self.decoder.frame(info.token) {
            Ok(bytes) => bytes,
            Err(error) => return Err(self.fail(Error::Decoder(error))),
        };
        let luma_bytes = info.coded.width() as usize * info.coded.height() as usize;
        let (luma, chroma) = bytes.split_at(luma_bytes);
        let frame = Frame {
            luma: Plane {
                bytes: luma,
                stride: info.coded.width(),
            },
            chroma: Plane {
                bytes: chroma,
                stride: info.coded.width(),
            },
            coded_width: info.coded.width(),
            coded_height: info.coded.height(),
            crop_left: 0,
            crop_top: 0,
            display_width: info.display.width(),
            display_height: info.display.height(),
            matrix: self.matrix,
            full_range: false,
            timestamp_ns: info.timestamp_ns,
        };
        let uploaded = renderer.upload(&frame);
        self.decoder
            .release(info.token)
            .map_err(|error| self.fail(Error::Decoder(error)))?;
        match uploaded {
            Ok(_) => Ok(true),
            Err(render::Error::Busy) => Ok(false),
            Err(error) => Err(self.fail(Error::Renderer(error))),
        }
    }

    /// Shows a frame the decoder read straight into the renderer's upload slot.
    fn publish_staged(
        &mut self,
        renderer: &mut Renderer,
        slot: usize,
        info: &FrameInfo,
    ) -> Result<bool, Error> {
        let published = Layout::coded(
            info.coded.width(),
            info.coded.height(),
            info.display.width(),
            info.display.height(),
            self.matrix,
        )
        .map_err(render::Error::from)
        .and_then(|layout| renderer.publish(slot, layout));
        self.decoder
            .release(info.token)
            .map_err(|error| self.fail(Error::Decoder(error)))?;
        match published {
            Ok(_) => Ok(true),
            Err(render::Error::Busy) => Ok(false),
            Err(error) => Err(self.fail(Error::Renderer(error))),
        }
    }

    pub fn poll_upload(&mut self, renderer: &mut Renderer) -> Result<bool, Error> {
        self.active()?;
        self.release_bound(renderer)?;
        self.recovery.tick(platform::now_ns() / 1_000_000);
        self.forward_idr_request();
        let poll_start_ns = platform::now_ns();
        let (staged_slot, frame) = match renderer.staging() {
            Ok(Some((slot, staging))) => (Some(slot), self.decoder.poll_into(Some(staging))),
            Ok(None) => (None, self.decoder.poll()),
            Err(error) => return Err(self.fail(Error::Renderer(error))),
        };
        stream_stats::stage(Stage::Poll, poll_start_ns, platform::now_ns());
        let frame = frame.map_err(|error| self.fail(Error::Decoder(error)))?;
        let Some(info) = frame else {
            return Ok(false);
        };

        self.stats.decoded += 1;
        let Some(index) = self
            .arrivals
            .iter()
            .position(|entry| entry.is_some_and(|arrival| arrival.pts_us == info.pts_us))
        else {
            if info.bound.is_some() {
                let _ = self.decoder.release(info.token);
            }
            return Err(self.fail(Error::Decoder(decoder::Error::Invalid)));
        };
        let arrival = self.arrivals[index].unwrap().received_us;
        let submitted_ns = self.arrivals[index].unwrap().submitted_ns;
        let decoded_ns = platform::now_ns();
        stream_stats::stage(Stage::Output, submitted_ns, poll_start_ns);
        self.stats.dropped += index as u64;
        if index != 0 {
            self.recovery.lose(decoded_ns / 1_000_000);
            self.forward_idr_request();
        }
        self.arrivals.rotate_left(index + 1);
        for entry in self.arrivals.iter_mut().skip(decoder::UNITS - index - 1) {
            *entry = None;
        }

        if !self.recovery.presentable(info.pts_us) {
            self.decoder
                .release(info.token)
                .map_err(|error| self.fail(Error::Decoder(error)))?;
            return Ok(false);
        }
        let uploaded = match staged_slot.filter(|_| info.staged) {
            Some(slot) => self.publish_staged(renderer, slot, &info),
            None => self.upload(renderer, &info),
        };
        stream_stats::stage(Stage::Upload, decoded_ns, platform::now_ns());
        if !uploaded? {
            self.stats.dropped += 1;
            return Ok(false);
        }
        self.stats.uploaded += 1;
        if self.pending {
            self.stats.dropped += 1;
        }
        self.pending = true;
        self.pending_arrival = arrival;
        self.pending_timing = Some((info.pts_us, submitted_ns, decoded_ns));
        Ok(true)
    }

    pub fn present_pending(
        &mut self,
        renderer: &mut Renderer,
        interactive: bool,
    ) -> Result<bool, Error> {
        self.active()?;
        let present_start_ns = platform::now_ns();
        let shown = renderer.present(interactive);
        stream_stats::stage(Stage::Present, present_start_ns, platform::now_ns());
        match shown {
            Ok(()) => {
                let presented = self.pending;
                self.pending = false;
                self.stats.presented += u64::from(presented);
                if presented {
                    if let Some((pts, submitted, decoded)) = self.pending_timing.take() {
                        let returned = platform::now_ns();
                        self.timing
                            .record(pts, submitted, decoded, present_start_ns, returned);
                    }
                    self.presentation = Some(Presentation {
                        received_us: self.pending_arrival.take(),
                        presented_us: platform::now_ns() / 1000,
                    });
                }
                self.timing
                    .summarize(platform::now_ns(), &self.stats, self.recovery.counters());
                Ok(presented)
            }
            Err(render::Error::Busy) => Ok(false),
            Err(error) => Err(self.fail(Error::Renderer(error))),
        }
    }

    /// Takes every frame the decoder finished since the last call and shows the newest, so a
    /// step that submitted two units to work off a backlog does not leave one waiting.
    pub fn present(&mut self, renderer: &mut Renderer, interactive: bool) -> Result<bool, Error> {
        for _ in 0..decoder::UNITS {
            if !self.poll_upload(renderer)? {
                break;
            }
        }
        self.present_pending(renderer, interactive)
    }

    pub fn close(&mut self) -> Result<(), Error> {
        if self.closed {
            return Ok(());
        }
        if platform::process_retired() {
            self.decoder.retire();
        }
        for token in self.bound.iter_mut().filter_map(Option::take) {
            if let Err(error) = self.decoder.release(token) {
                self.decoder.retire();
                platform::retire_process();
                return Err(self.fail(Error::Decoder(error)));
            }
        }
        if let Err(error) = self.decoder.close() {
            self.decoder.retire();
            platform::retire_process();
            return Err(self.fail(Error::Decoder(error)));
        }
        self.closed = true;
        self.arrivals.fill(None);
        self.bound.fill(None);
        self.pending_arrival = None;
        self.pending_timing = None;
        crate::stream_stats::clear();
        Ok(())
    }

    pub fn tick<'t>(
        &'t mut self,
        renderer: &'t mut Renderer,
        interactive: bool,
    ) -> Tick<'t, 'a, B, N> {
        Tick {
            video: self,
            renderer,
            interactive,
            present: true,
        }
    }

    pub fn consume_tick<'t>(&'t mut self, renderer: &'t mut Renderer) -> Tick<'t, 'a, B, N> {
        Tick {
            video: self,
            renderer,
            interactive: false,
            present: false,
        }
    }
}

impl<B: Backend<N>, const N: usize> Drop for Video<'_, B, N> {
    fn drop(&mut self) {
        if !self.closed && self.close().is_err() {
            platform::log("video: teardown retained; exit process");
        }
    }
}

pub struct Tick<'t, 'a, B: Backend<N>, const N: usize = SURFACES> {
    video: &'t mut Video<'a, B, N>,
    renderer: &'t mut Renderer,
    interactive: bool,
    present: bool,
}

impl<B: Backend<N>, const N: usize> Tick<'_, '_, B, N> {
    pub fn submit(&mut self, header: &Header, bytes: &[u8]) -> moonlight_nx2_app::media::Submit {
        self.submit_timed(header, bytes, None)
    }

    pub fn submit_timed(
        &mut self,
        header: &Header,
        bytes: &[u8],
        received_us: Option<u64>,
    ) -> moonlight_nx2_app::media::Submit {
        match self.video.submit_timed(header, bytes, received_us) {
            Ok(()) => moonlight_nx2_app::media::Submit::Accepted,
            Err(Error::Decoder(decoder::Error::Again)) => moonlight_nx2_app::media::Submit::Busy,
            Err(_) => moonlight_nx2_app::media::Submit::Failed,
        }
    }

    pub fn presented(&mut self) -> Result<bool, Error> {
        self.video.present(self.renderer, self.interactive)
    }
}

impl<B: Backend<N>, const N: usize> moonlight_nx2_app::media::Decoder for Tick<'_, '_, B, N> {
    fn pending(&mut self) -> bool {
        self.video.pending()
    }

    fn submit(&mut self, header: &Header, payload: &[u8]) -> moonlight_nx2_app::media::Submit {
        Tick::submit(self, header, payload)
    }

    fn submit_timed(
        &mut self,
        header: &Header,
        payload: &[u8],
        received_us: Option<u64>,
    ) -> moonlight_nx2_app::media::Submit {
        Tick::submit_timed(self, header, payload, received_us)
    }

    fn poll(&mut self) -> moonlight_nx2_app::media::Poll {
        if !self.present {
            return match self.video.poll_upload(self.renderer) {
                Ok(_) => moonlight_nx2_app::media::Poll::Idle,
                Err(_) => moonlight_nx2_app::media::Poll::Failed,
            };
        }
        match self.presented() {
            Ok(true) => moonlight_nx2_app::media::Poll::Presented,
            Ok(false) => moonlight_nx2_app::media::Poll::Idle,
            Err(_) => moonlight_nx2_app::media::Poll::Failed,
        }
    }
}

#[cfg(all(target_os = "none", feature = "native-video"))]
fn native_busy(renderer: &mut Renderer, surface: usize) -> Result<bool, render::Error> {
    renderer.native_busy(surface)
}

#[cfg(not(all(target_os = "none", feature = "native-video")))]
fn native_busy(_renderer: &mut Renderer, _surface: usize) -> Result<bool, render::Error> {
    Ok(false)
}

#[cfg(all(target_os = "none", feature = "native-video"))]
fn native_upload(
    renderer: &mut Renderer,
    surface: usize,
    image: moonlight_nx2_core::untile::Image,
    info: &FrameInfo,
    matrix: Matrix,
) -> Result<(), render::Error> {
    renderer.upload_native(surface, image, info.display, matrix)
}

#[cfg(not(all(target_os = "none", feature = "native-video")))]
fn native_upload(
    _renderer: &mut Renderer,
    _surface: usize,
    _image: moonlight_nx2_core::untile::Image,
    _info: &FrameInfo,
    _matrix: Matrix,
) -> Result<(), render::Error> {
    Err(render::Error::Unsupported)
}
