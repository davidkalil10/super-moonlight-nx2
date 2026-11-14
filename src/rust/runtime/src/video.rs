//! Stream video: decoder submission, loss recovery, presentation of decoded frames copied out
//! of the decoder and pacing statistics.

extern crate alloc;

use crate::{
    render::{self, Renderer},
    render_platform as platform,
    stream_stats::{self, Stage},
};
use alloc::format;
use core::cell::Cell;
use moonlight_nx2_app::media::Pump;
use moonlight_nx2_core::{
    codec::{Capabilities, Codec, Depth},
    decoder::{self, Backend, Decoder, FrameInfo, Hosted, Placed, SURFACES},
    frame::{Frame, Layout, Matrix, Plane},
    media::Header,
    recovery::{self, Decision, Recovery},
    stats::{DecoderQueue, Stages, StreamStats},
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
    /// Uploaded frames a newer one replaced before the display turned: a backlog worked off,
    /// not a loss.
    pub caught_up: u64,
    /// Turns that held a finished frame back for the next refresh, behind the one waiting to
    /// be shown, instead of replacing it.
    pub late: u64,
    /// Frames shown from the renderer's second slot, kept there to make room in the decoder.
    pub kept: u64,
    /// Units the decoder had no room for, offered again later.
    pub refused: u64,
    /// Units over the decoder's `input_max`, dropped until the next keyframe.
    pub oversize: u64,
    pub presented: u64,
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

/// A frame copied into the renderer's second slot while another waits for its present.
#[derive(Clone, Copy)]
struct Kept {
    slot: usize,
    layout: Layout,
    arrival: Option<u64>,
    timing: DecoderTiming,
}

/// What became of a frame taken from the decoder.
enum Taken {
    Dropped,
    Shown,
    Kept(usize, Layout),
}

/// When a frame's unit went to the decoder, when the decoder took it up and when its frame
/// was taken.
#[derive(Clone, Copy)]
struct DecoderTiming {
    submitted: u64,
    started: u64,
    decoded: u64,
}

#[derive(Default)]
struct Timing {
    window_ns: u64,
    frames: u64,
    decode_us: u64,
    decode_max_us: u64,
    latency_us: u64,
    latency_max_us: u64,
    stages: Stages,
    dropped_start: u64,
    presented_start: u64,
}

impl Timing {
    fn record(&mut self, received_us: Option<u64>, decoder: DecoderTiming, returned: u64) {
        let DecoderTiming {
            submitted,
            started,
            decoded,
        } = decoder;
        let received = received_us.map(|received_us| received_us.saturating_mul(1000));
        self.stages
            .record(received, submitted, started, decoded, returned);
        let decode_us = decoded.saturating_sub(submitted) / 1000;
        let latency_us = returned.saturating_sub(submitted) / 1000;
        self.frames += 1;
        self.decode_us += decode_us;
        self.decode_max_us = self.decode_max_us.max(decode_us);
        self.latency_us += latency_us;
        self.latency_max_us = self.latency_max_us.max(latency_us);
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
            fps_x10: clamp(
                stats.presented.saturating_sub(self.presented_start) * 10_000_000_000 / elapsed,
            ),
            decode_mean_us: crate::stream_stats::take_readback_mean_us()
                .unwrap_or_else(|| clamp(self.decode_us / frames)),
            decode_max_us: clamp(self.decode_max_us),
            latency_mean_us: clamp(self.latency_us / frames),
            latency_max_us: clamp(self.latency_max_us),
            input_mean_us,
            input_max_us,
            presented: clamp(self.frames),
            dropped: clamp(stats.dropped.saturating_sub(self.dropped_start)),
            idr_requests: clamp(recovery.idr_requests),
            frames_skipped: clamp(recovery.frames_skipped),
            host_mean_us: crate::stream_stats::take_host_mean_us(),
            received: self.stages.received,
            receive_mean_us: self.stages.receive_mean_us().unwrap_or(0),
            decoder_wait_mean_us: self.stages.wait_mean_us().unwrap_or(0),
            decoder_mean_us: self.stages.decode_mean_us().unwrap_or(0),
            display_mean_us: self.stages.display_mean_us().unwrap_or(0),
        });
        self.restart(now, stats);
    }

    fn restart(&mut self, now: u64, stats: &Stats) {
        *self = Self {
            window_ns: now,
            dropped_start: stats.dropped,
            presented_start: stats.presented,
            ..Self::default()
        };
    }
}

/// How long a finished frame waits for an upload slot. The slot of the frame before last is
/// still read by the GPU for a moment after its present.
const STAGING_WAIT_NS: u64 = 2_000_000;
/// The frame whose picture is measured once a stream, a second in at 120 frames a second.
#[cfg(feature = "frame-detail")]
const DETAIL_FRAME: u64 = 120;
/// The share of a turn, in percent, a turn may spend waiting for its unit's frame. The rest
/// is left for the upload, the present and input.
const WAKE_SHARE: u64 = 55;
const TURN_MIN_NS: u64 = 4_000_000;
const TURN_MAX_NS: u64 = 34_000_000;
/// The longest a wait for the decoder goes without pumping audio.
const SLICE_NS: u64 = 1_000_000;
/// Refreshes in a row a full decoder may hold a frame back before one is replaced: a burst
/// of two frames costs a refresh of latency, a backlog that stays is worked off.
const CATCH_UP_TURNS: u32 = 2;
/// With VRR, how long a turn without a finished frame waits for one before the loop goes
/// round again.
const ARRIVAL_WAIT_NS: u64 = 2_000_000;
/// With VRR, the longest the picture goes without a present while no frame comes.
const HOLD_NS: u64 = 34_000_000;

/// Copies a frame into a free slot: shown on the next present, or held there when `keep`.
fn copy_in(renderer: &mut Renderer, frame: &Frame<'_>, keep: bool) -> Result<Taken, render::Error> {
    match keep {
        true => renderer
            .stage(frame)
            .map(|(slot, layout)| Taken::Kept(slot, layout)),
        false => renderer.upload(frame).map(|_| Taken::Shown),
    }
}

fn pump(audio: &mut dyn Pump) {
    audio.pump(platform::now_ns() / 1_000_000);
}

/// When the current turn started and how long turns last, for the wait in `wake`.
#[derive(Default)]
struct Turns {
    started_ns: u64,
    period_ns: u64,
    waited: bool,
}

impl Turns {
    fn start(&mut self, now_ns: u64) {
        let elapsed = now_ns.saturating_sub(self.started_ns);
        if self.started_ns != 0 && (TURN_MIN_NS..=TURN_MAX_NS).contains(&elapsed) {
            self.period_ns = match self.period_ns {
                0 => elapsed,
                period => (period * 7 + elapsed) / 8,
            };
        }
        self.started_ns = now_ns;
        self.waited = false;
    }

    /// What is left of this turn's wait, None when the turn already waited or its length is
    /// not known yet.
    fn budget_ns(&mut self, now_ns: u64) -> Option<u64> {
        if self.waited || self.period_ns == 0 {
            return None;
        }
        self.waited = true;
        let deadline = self.started_ns + self.period_ns * WAKE_SHARE / 100;
        Some(deadline.saturating_sub(now_ns)).filter(|budget| *budget != 0)
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
    pending_arrival: Option<u64>,
    pending_timing: Option<DecoderTiming>,
    kept: Option<Kept>,
    queue: DecoderQueue,
    /// Presents in a row that found a frame waiting and the decoder full.
    late_turns: u32,
    last_present_ns: u64,
    timing: Timing,
    presentation: Option<Presentation>,
    turns: Turns,
    /// The renderer's import each surface held in the backend's memory is copied from.
    imports: [Option<usize>; N],
    /// Whether frames in the backend's memory are imported, once the first one shows it.
    host_import: Option<bool>,
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
        let decoder = match Decoder::open(backend, config.decoder, retired, frames) {
            Ok(decoder) => decoder,
            Err(error) => {
                if retired.get() {
                    platform::retire_process();
                }
                return Err(Error::Decoder(error));
            }
        };
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
            pending_arrival: None,
            pending_timing: None,
            kept: None,
            queue: DecoderQueue::default(),
            late_turns: 0,
            last_present_ns: 0,
            timing: Timing::default(),
            presentation: None,
            turns: Turns::default(),
            imports: [None; N],
            host_import: None,
        })
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
        !self.closed && (self.pending || self.kept.is_some() || self.decoder.pending_units() != 0)
    }

    fn fail(&mut self, error: Error) -> Error {
        if self.failure.is_none() {
            match self.decoder.rejected() {
                Some(rejected) => platform::log(&format!(
                    "video: failed {error:?} on {} of {:?}",
                    rejected.reason, rejected.output
                )),
                None => match (error, self.decoder.invalid_reason()) {
                    (Error::Decoder(decoder::Error::Invalid), Some(reason)) => {
                        platform::log(&format!("video: failed {error:?}, {reason}"))
                    }
                    _ => platform::log(&format!("video: failed {error:?}")),
                },
            }
        }
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
            platform::log(&format!(
                "video: unit {} declares {} bytes and carries {}",
                header.sequence,
                header.payload_bytes,
                bytes.len()
            ));
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
        let input_max = self.decoder.input_max();
        if bytes.len() > input_max {
            self.stats.oversize += 1;
            platform::log(&format!(
                "video: dropped unit {} of {} bytes over the decoder's {}",
                header.sequence,
                bytes.len(),
                input_max
            ));
            self.recovery.lose(submitted_ns / 1_000_000);
            self.forward_idr_request();
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
                stream_stats::in_flight(self.decoder.pending_units());
                Ok(())
            }
            Err(decoder::Error::Again) => {
                self.stats.refused += 1;
                Err(Error::Decoder(decoder::Error::Again))
            }
            Err(error) => {
                platform::log(&format!(
                    "video: submit failed {error:?} sequence={} pts_us={} bytes={}",
                    header.sequence,
                    header.pts_us,
                    bytes.len()
                ));
                Err(self.fail(Error::Decoder(error)))
            }
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

    fn upload(
        &mut self,
        renderer: &mut Renderer,
        info: &FrameInfo,
        keep: bool,
    ) -> Result<Taken, Error> {
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
        let uploaded = copy_in(renderer, &frame, keep);
        self.decoder
            .release(info.token)
            .map_err(|error| self.fail(Error::Decoder(error)))?;
        self.taken(uploaded)
    }

    /// Shows a frame the decoder read straight into the renderer's upload slot, or holds the
    /// slot when `keep`.
    fn publish_staged(
        &mut self,
        renderer: &mut Renderer,
        slot: usize,
        info: &FrameInfo,
        keep: bool,
    ) -> Result<Taken, Error> {
        let published = Layout::coded(
            info.coded.width(),
            info.coded.height(),
            info.display.width(),
            info.display.height(),
            self.matrix,
        )
        .map_err(render::Error::from)
        .and_then(|layout| match keep {
            true => renderer.hold(slot).map(|()| Taken::Kept(slot, layout)),
            false => renderer.publish(slot, layout).map(|_| Taken::Shown),
        });
        self.decoder
            .release(info.token)
            .map_err(|error| self.fail(Error::Decoder(error)))?;
        self.taken(published)
    }

    fn taken(&mut self, result: Result<Taken, render::Error>) -> Result<Taken, Error> {
        match result {
            Ok(taken) => Ok(taken),
            Err(render::Error::Busy) => Ok(Taken::Dropped),
            Err(error) => Err(self.fail(Error::Renderer(error))),
        }
    }

    /// Shows a frame the decoder wrote into the renderer's slot of its surface. The surface
    /// goes back to the decoder once the slot is no longer read, in `reclaim`.
    fn publish_placed(
        &mut self,
        renderer: &mut Renderer,
        info: &FrameInfo,
        placed: Placed,
    ) -> Result<Taken, Error> {
        let published = Layout::coded(
            placed.placement.stride,
            placed.placement.slice_height,
            info.display.width(),
            info.display.height(),
            self.matrix,
        )
        .map_err(render::Error::from)
        .and_then(|layout| renderer.publish(placed.surface, layout));
        match published {
            Ok(_) => Ok(Taken::Shown),
            Err(render::Error::Busy) => {
                self.drop_frame(info)?;
                Ok(Taken::Dropped)
            }
            Err(error) => Err(self.fail(Error::Renderer(error))),
        }
    }

    /// Shows a frame left in the backend's memory: copied by the GPU from its import, or by
    /// the CPU into a slot when the renderer cannot import it. Only a copied frame is kept.
    fn publish_hosted(
        &mut self,
        renderer: &mut Renderer,
        info: &FrameInfo,
        hosted: Hosted,
        keep: bool,
    ) -> Result<Taken, Error> {
        let image = hosted.image;
        if self.stats.decoded == 1 {
            platform::log(&format!(
                "video: host frame pitch={} rows={} luma_offset={} chroma_offset={} bytes={}",
                image.pitch, image.rows, image.luma_offset, image.chroma_offset, image.bytes
            ));
        }
        let layout = Layout::coded(
            image.pitch,
            image.rows,
            info.display.width(),
            info.display.height(),
            self.matrix,
        )
        .map_err(render::Error::from);
        if self.host_import.is_none() && !renderer.host_import() {
            platform::log("sdk-decoder: output=readback, no VK_EXT_external_memory_host");
            self.host_import = Some(false);
        }
        if self.host_import != Some(false) {
            let imported = layout.and_then(|layout| {
                let import = renderer.import_host(image.base, image.bytes)?;
                let host = render::HostFrame {
                    luma_offset: image.luma_offset,
                    chroma_offset: image.chroma_offset,
                    pitch: image.pitch,
                    rows: image.rows,
                };
                renderer
                    .publish_import(import, host, layout)
                    .map(|_| import)
            });
            match imported {
                Ok(import) => {
                    if self.host_import.is_none() {
                        platform::log("sdk-decoder: output=host-import");
                    }
                    self.host_import = Some(true);
                    self.imports[hosted.surface] = Some(import);
                    return Ok(Taken::Shown);
                }
                Err(render::Error::Busy) => {
                    self.drop_frame(info)?;
                    return Ok(Taken::Dropped);
                }
                Err(error) => {
                    platform::log(&format!("sdk-decoder: output=readback import {error:?}"));
                    self.host_import = Some(false);
                }
            }
        }
        let luma_bytes = image.pitch as usize * image.rows as usize;
        let (luma, chroma) = unsafe {
            (
                core::slice::from_raw_parts(image.base.add(image.luma_offset), luma_bytes),
                core::slice::from_raw_parts(image.base.add(image.chroma_offset), luma_bytes / 2),
            )
        };
        let frame = Frame {
            luma: Plane {
                bytes: luma,
                stride: image.pitch,
            },
            chroma: Plane {
                bytes: chroma,
                stride: image.pitch,
            },
            coded_width: info.display.width(),
            coded_height: image.rows,
            crop_left: 0,
            crop_top: 0,
            display_width: info.display.width(),
            display_height: info.display.height(),
            matrix: self.matrix,
            full_range: false,
            timestamp_ns: info.timestamp_ns,
        };
        let read_start_ns = platform::now_ns();
        let uploaded = copy_in(renderer, &frame, keep);
        stream_stats::stage(Stage::Readback, read_start_ns, platform::now_ns());
        self.decoder
            .release_surface(hosted.surface)
            .map_err(|error| self.fail(Error::Decoder(error)))?;
        self.taken(uploaded)
    }

    fn drop_frame(&mut self, info: &FrameInfo) -> Result<(), Error> {
        let released = match (info.placed, info.hosted) {
            (Some(Placed { surface, .. }), _) | (None, Some(Hosted { surface, .. })) => {
                self.decoder.release_surface(surface)
            }
            (None, None) => self.decoder.release(info.token),
        };
        released.map_err(|error| self.fail(Error::Decoder(error)))
    }

    /// Hands surfaces back to the decoder once nothing reads them: a surface decoded in place
    /// when its slot is neither shown nor read, one in the backend's memory when the GPU copy
    /// from it has run.
    fn reclaim(&mut self, renderer: &mut Renderer) -> Result<(), Error> {
        for surface in 0..N {
            if !self.decoder.holds_surface(surface) {
                continue;
            }
            let free = match self.imports[surface] {
                Some(import) => renderer.import_busy(import).map(|busy| !busy),
                None => renderer.slot_free(surface),
            };
            match free {
                Ok(true) => {
                    self.imports[surface] = None;
                    self.decoder
                        .release_surface(surface)
                        .map_err(|error| self.fail(Error::Decoder(error)))?
                }
                Ok(false) => {}
                Err(error) => return Err(self.fail(Error::Renderer(error))),
            }
        }
        Ok(())
    }

    /// Waits up to the turn's share for the oldest unit's frame, so it is shown on this turn
    /// rather than the next. Audio is pumped between slices of the wait.
    fn wake(&mut self, audio: &mut dyn Pump) -> Result<(), Error> {
        if stream_stats::vrr() || self.decoder.pending_units() == 0 {
            return Ok(());
        }
        let start_ns = platform::now_ns();
        let Some(budget_ns) = self.turns.budget_ns(start_ns) else {
            return Ok(());
        };
        let deadline_ns = start_ns + budget_ns;
        let ready = loop {
            let left_ns = deadline_ns.saturating_sub(platform::now_ns());
            let ready = self
                .decoder
                .wait(left_ns.clamp(1, SLICE_NS))
                .map_err(|error| self.fail(Error::Decoder(error)))?;
            if ready || left_ns <= SLICE_NS {
                break ready;
            }
            pump(audio);
        };
        stream_stats::wake(platform::now_ns() - start_ns, budget_ns, ready);
        Ok(())
    }

    /// Submits a unit. When the decoder has no room for it, a finished frame is taken first and
    /// the unit is offered once more, so it goes in on the turn it arrived. Left waiting, it
    /// would go in next turn together with that turn's unit, their two frames would finish
    /// together, fill the decoder again and keep every later turn in the same step of two.
    /// With a frame already waiting, the finished one is kept in the renderer's second slot
    /// instead, when the frames are copied into slots, so it is still shown on the next
    /// refresh. Only when both wait, or frames cannot be kept, does a frame taken here replace
    /// one not shown yet: that is the catch-up when units arrive faster than the display turns.
    pub fn submit_draining(
        &mut self,
        renderer: &mut Renderer,
        header: &Header,
        bytes: &[u8],
        received_us: Option<u64>,
        audio: &mut dyn Pump,
    ) -> Result<(), Error> {
        if self.decoder.holds_frames() {
            self.active()?;
            self.reclaim(renderer)?;
        }
        match self.submit_timed(header, bytes, received_us) {
            Err(Error::Decoder(decoder::Error::Again)) if self.pending && self.can_keep() => {
                self.take(renderer, audio, true)?;
                self.submit_timed(header, bytes, received_us)
            }
            Err(Error::Decoder(decoder::Error::Again)) if self.pending && !self.catching_up() => {
                Err(Error::Decoder(decoder::Error::Again))
            }
            Err(Error::Decoder(decoder::Error::Again)) => {
                self.replace(renderer, audio)?;
                self.submit_timed(header, bytes, received_us)
            }
            result => result,
        }
    }

    fn catching_up(&self) -> bool {
        self.late_turns >= CATCH_UP_TURNS
    }

    /// Whether a second finished frame can wait, in the renderer's other slot: frames are
    /// copied into slots, and none is kept yet.
    fn can_keep(&self) -> bool {
        self.kept.is_none()
            && !self.decoder.in_place()
            && (!self.decoder.holds_frames() || self.host_import == Some(false))
    }

    /// Replaces the frame waiting to be shown with the next one, keeping the one after it
    /// when the next one was kept.
    fn replace(&mut self, renderer: &mut Renderer, audio: &mut dyn Pump) -> Result<(), Error> {
        let kept = self.kept.is_some();
        self.take(renderer, audio, false)?;
        if kept && self.can_keep() {
            self.take(renderer, audio, true)?;
        }
        Ok(())
    }

    pub fn poll_upload(&mut self, renderer: &mut Renderer) -> Result<bool, Error> {
        self.poll_upload_pumping(renderer, &mut ())
    }

    fn poll_upload_pumping(
        &mut self,
        renderer: &mut Renderer,
        audio: &mut dyn Pump,
    ) -> Result<bool, Error> {
        self.take(renderer, audio, false)
    }

    /// Shows the kept frame, replacing one still waiting.
    fn show_kept(&mut self, renderer: &mut Renderer) -> Result<bool, Error> {
        let Some(kept) = self.kept.take() else {
            return Ok(false);
        };
        match renderer.publish(kept.slot, kept.layout) {
            Ok(_) => {}
            Err(render::Error::Busy) => {
                renderer.release_held();
                self.stats.dropped += 1;
                return Ok(false);
            }
            Err(error) => return Err(self.fail(Error::Renderer(error))),
        }
        self.stats.kept += 1;
        self.waiting(kept.arrival, kept.timing);
        Ok(true)
    }

    fn waiting(&mut self, arrival: Option<u64>, timing: DecoderTiming) {
        if self.pending {
            self.stats.caught_up += 1;
            stream_stats::discarded();
        }
        self.pending = true;
        self.pending_arrival = arrival;
        self.pending_timing = Some(timing);
    }

    /// Takes the oldest frame not shown yet so the next present shows it: the kept one, or a
    /// finished one from the decoder. With `keep`, a frame the decoder already finished is
    /// held in the renderer's other slot instead, behind the one waiting.
    fn take(
        &mut self,
        renderer: &mut Renderer,
        audio: &mut dyn Pump,
        keep: bool,
    ) -> Result<bool, Error> {
        self.active()?;
        if !keep && self.kept.is_some() {
            return self.show_kept(renderer);
        }
        self.recovery.tick(platform::now_ns() / 1_000_000);
        self.forward_idr_request();
        let (slot, frame, poll_start_ns) = if self.decoder.holds_frames() {
            self.reclaim(renderer)?;
            if !keep {
                self.wake(audio)?;
            }
            let poll_start_ns = platform::now_ns();
            (None, self.decoder.poll_into(None), poll_start_ns)
        } else {
            match renderer.staging(STAGING_WAIT_NS) {
                Ok(Some((slot, staging))) => {
                    if !keep {
                        self.wake(audio)?;
                    }
                    let poll_start_ns = platform::now_ns();
                    (
                        Some(slot),
                        self.decoder.poll_into(Some(staging)),
                        poll_start_ns,
                    )
                }
                // A frame with no slot to go to would be read back and thrown away.
                Ok(None) => return Ok(false),
                Err(error) => return Err(self.fail(Error::Renderer(error))),
            }
        };
        stream_stats::stage(Stage::Poll, poll_start_ns, platform::now_ns());
        let frame = frame.map_err(|error| self.fail(Error::Decoder(error)))?;
        let Some(info) = frame else {
            return Ok(false);
        };

        self.stats.decoded += 1;
        stream_stats::frame_ready(platform::now_ns());
        let Some(index) = self
            .arrivals
            .iter()
            .position(|entry| entry.is_some_and(|arrival| arrival.pts_us == info.pts_us))
        else {
            platform::log(&format!(
                "video: frame pts_us={} has no arrival",
                info.pts_us
            ));
            return Err(self.fail(Error::Decoder(decoder::Error::Invalid)));
        };
        let arrival = self.arrivals[index].unwrap().received_us;
        let submitted_ns = self.arrivals[index].unwrap().submitted_ns;
        let decoded_ns = platform::now_ns();
        let started_ns = self.queue.start(submitted_ns, decoded_ns);
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
            self.drop_frame(&info)?;
            return Ok(false);
        }
        #[cfg(feature = "frame-detail")]
        let source = match (info.placed, info.hosted, slot) {
            (Some(_), _, _) => "placed",
            (None, Some(_), _) => "hosted",
            (None, None, Some(_)) if info.staged => "staged",
            _ => "copied",
        };
        let taken = match (info.placed, info.hosted, slot) {
            (Some(placed), _, _) => self.publish_placed(renderer, &info, placed),
            (None, Some(hosted), _) => self.publish_hosted(renderer, &info, hosted, keep),
            (None, None, Some(slot)) if info.staged => {
                self.publish_staged(renderer, slot, &info, keep)
            }
            _ => self.upload(renderer, &info, keep),
        };
        stream_stats::stage(Stage::Upload, decoded_ns, platform::now_ns());
        pump(audio);
        let timing = DecoderTiming {
            submitted: submitted_ns,
            started: started_ns,
            decoded: decoded_ns,
        };
        match taken? {
            Taken::Dropped => {
                self.stats.dropped += 1;
                return Ok(false);
            }
            Taken::Kept(slot, layout) => {
                self.stats.uploaded += 1;
                self.kept = Some(Kept {
                    slot,
                    layout,
                    arrival,
                    timing,
                });
                return Ok(true);
            }
            Taken::Shown => {}
        }
        self.stats.uploaded += 1;
        #[cfg(feature = "frame-detail")]
        if self.stats.uploaded == DETAIL_FRAME
            && self.host_import != Some(true)
            && let Some((layout, detail)) = renderer.shown_detail()
        {
            platform::log(&format!("video: shown {source} {layout:?} {detail:?}"));
        }
        self.waiting(arrival, timing);
        Ok(true)
    }

    pub fn present_pending(
        &mut self,
        renderer: &mut Renderer,
        interactive: bool,
    ) -> Result<bool, Error> {
        self.present_pumping(renderer, interactive, &mut ())
    }

    /// Presents what is pending, pumping audio before the present and while it waits.
    fn present_pumping(
        &mut self,
        renderer: &mut Renderer,
        interactive: bool,
        audio: &mut dyn Pump,
    ) -> Result<bool, Error> {
        self.active()?;
        pump(audio);
        let present_start_ns = platform::now_ns();
        let shown = renderer.present_pumping(interactive, audio);
        stream_stats::stage(Stage::Present, present_start_ns, platform::now_ns());
        match shown {
            Ok(()) => {
                self.last_present_ns = platform::now_ns();
                let presented = self.pending;
                self.pending = false;
                self.stats.presented += u64::from(presented);
                if presented {
                    let received_us = self.pending_arrival.take();
                    if let Some(decoder) = self.pending_timing.take() {
                        self.timing.record(received_us, decoder, platform::now_ns());
                    }
                    self.presentation = Some(Presentation {
                        received_us,
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

    /// Takes one frame, unless the step already took one to make room for a unit, and
    /// presents once, so a turn lasts one display refresh and frames are shown in order.
    /// Every frame is shown: one waiting with the decoder full holds the next a refresh late,
    /// kept in the renderer's second slot when frames are copied into slots, which makes room
    /// in the decoder for the unit after it, or else in the decoder, holding that unit in the
    /// network. Only when the decoder stays full for `CATCH_UP_TURNS` refreshes has latency
    /// built up: `submit_draining` then replaces the waiting frame, and so does one taken here.
    /// With VRR the display refreshes on a present, so a frame is presented once it is ready
    /// and a turn without one presents nothing, up to `HOLD_NS`: a late frame then delays one
    /// refresh instead of repeating the previous picture for a whole one.
    pub fn present(
        &mut self,
        renderer: &mut Renderer,
        interactive: bool,
        audio: &mut dyn Pump,
    ) -> Result<bool, Error> {
        let vrr = stream_stats::vrr();
        let full = self.decoder.pending_units() >= self.decoder.units();
        let waiting = self.pending;
        if !self.pending {
            if vrr && self.kept.is_none() {
                self.await_frame(audio)?;
            }
            self.take(renderer, audio, false)?;
        }
        if waiting && full {
            self.late_turns += 1;
        } else {
            self.late_turns = 0;
        }
        if waiting && full {
            if self.catching_up() {
                self.replace(renderer, audio)?;
            } else {
                self.stats.late += 1;
                stream_stats::shown_late(platform::now_ns());
                if self.can_keep() {
                    self.take(renderer, audio, true)?;
                }
            }
        }
        if vrr && !self.pending && !self.hold_ended(interactive) {
            return Ok(false);
        }
        self.present_pumping(renderer, interactive, audio)
    }

    /// Whether a present without a new frame is due: the UI redraws at most once a refresh,
    /// the picture at least every `HOLD_NS`.
    fn hold_ended(&self, interactive: bool) -> bool {
        let since = platform::now_ns().saturating_sub(self.last_present_ns);
        let refresh = stream_stats::frame_ns().unwrap_or(HOLD_NS);
        since >= HOLD_NS || (interactive && since >= refresh)
    }

    /// Waits up to `ARRIVAL_WAIT_NS` for the decoder to finish a frame, pumping audio, or
    /// sleeps that long in slices while it holds no unit.
    fn await_frame(&mut self, audio: &mut dyn Pump) -> Result<(), Error> {
        let deadline_ns = platform::now_ns() + ARRIVAL_WAIT_NS;
        loop {
            let left_ns = deadline_ns.saturating_sub(platform::now_ns());
            let slice_ns = left_ns.clamp(1, SLICE_NS);
            let ready = if self.decoder.pending_units() == 0 {
                platform::sleep_ns(slice_ns);
                false
            } else {
                self.decoder
                    .wait(slice_ns)
                    .map_err(|error| self.fail(Error::Decoder(error)))?
            };
            if ready || left_ns <= SLICE_NS {
                return Ok(());
            }
            pump(audio);
        }
    }

    pub fn close(&mut self) -> Result<(), Error> {
        if self.closed {
            return Ok(());
        }
        if platform::process_retired() {
            self.decoder.retire();
        }
        if let Err(error) = self.decoder.close() {
            self.decoder.retire();
            platform::retire_process();
            return Err(self.fail(Error::Decoder(error)));
        }
        self.closed = true;
        self.arrivals.fill(None);
        self.kept = None;
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
        self.turns.start(platform::now_ns());
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
        self.submit_pumping(header, bytes, received_us, &mut ())
    }

    fn submit_pumping(
        &mut self,
        header: &Header,
        bytes: &[u8],
        received_us: Option<u64>,
        audio: &mut dyn Pump,
    ) -> moonlight_nx2_app::media::Submit {
        match self
            .video
            .submit_draining(self.renderer, header, bytes, received_us, audio)
        {
            Ok(()) => moonlight_nx2_app::media::Submit::Accepted,
            Err(Error::Decoder(decoder::Error::Again)) => moonlight_nx2_app::media::Submit::Busy,
            Err(_) => moonlight_nx2_app::media::Submit::Failed,
        }
    }

    pub fn presented(&mut self) -> Result<bool, Error> {
        self.video.present(self.renderer, self.interactive, &mut ())
    }

    fn poll_pumping(&mut self, audio: &mut dyn Pump) -> moonlight_nx2_app::media::Poll {
        let polled = match self.present {
            false => self.video.poll_upload_pumping(self.renderer, audio),
            true => self.video.present(self.renderer, self.interactive, audio),
        };
        match (polled, self.present) {
            (Ok(true), true) => moonlight_nx2_app::media::Poll::Presented,
            (Ok(_), _) => moonlight_nx2_app::media::Poll::Idle,
            (Err(_), _) => moonlight_nx2_app::media::Poll::Failed,
        }
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

    fn submit_pumping(
        &mut self,
        header: &Header,
        payload: &[u8],
        received_us: Option<u64>,
        audio: &mut dyn Pump,
    ) -> moonlight_nx2_app::media::Submit {
        Tick::submit_pumping(self, header, payload, received_us, audio)
    }

    fn host_processing(&mut self, host_us: u32) {
        stream_stats::host_processing(host_us);
    }

    fn poll(&mut self) -> moonlight_nx2_app::media::Poll {
        Tick::poll_pumping(self, &mut ())
    }

    fn poll_pumping(&mut self, audio: &mut dyn Pump) -> moonlight_nx2_app::media::Poll {
        Tick::poll_pumping(self, audio)
    }
}
