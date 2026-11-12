//! Owns the active media session and its decoder, audio and transport.

extern crate alloc;

use crate::{
    audio_device::Audout,
    client::Client,
    device::log,
    frontend_media::{self, Tick},
    hid::FrameInput,
    media_session::{self, Session},
    net::{NetSocket, PeerConnector, UdpSocket},
    opus::HwOpus,
    render::Renderer,
    video::{self, Video},
};
use alloc::{boxed::Box, format, vec};
use core::cell::Cell;
use moonlight_nx2_app::{
    direct_media::{self, ControlEvents, DirectAudio, DirectVideo},
    direct_stream::Outbox,
    media::Closed,
    policy::{Epoch, Observation, Telemetry},
    sunshine::{
        control::{ControlSender, Delivery, SendError},
        stream::{Codec as SunshineCodec, Negotiated},
    },
};
use moonlight_nx2_core::{
    codec::{self, Capabilities, Size},
    decoder,
    frame::Matrix,
    recovery,
};
use moonlight_nx2_io::audio::{self, SLOT_BYTES, SLOTS, Slots};
use moonlight_nx2_ui::store::Files;

type Decoder = crate::sdk_video::SdkVideo;
const SURFACES: usize = decoder::SURFACES;

pub(crate) fn decoder_capabilities() -> Capabilities {
    <Decoder as decoder::Backend<SURFACES>>::capabilities()
}

const MEDIA_SILENCE_MS: u64 = 10_000;

type DirectSession = Session<
    'static,
    Decoder,
    NetSocket,
    Audout,
    DirectVideo<UdpSocket, ControlEvents<Control>>,
    SURFACES,
    DirectAudio<UdpSocket, HwOpus>,
>;

/// The Sunshine control stream the direct launch owns; video asks it for keyframes.
pub struct Control(pub Outbox);

impl ControlSender for Control {
    fn send(
        &mut self,
        kind: u16,
        channel: u8,
        delivery: Delivery,
        payload: &[u8],
    ) -> Result<(), SendError> {
        self.0.send(kind, channel, delivery, payload)
    }

    fn frames_lost(&mut self, first: u32, last: u32) {
        self.0.frames_lost(first, last);
    }
}

fn direct_codec(codec: SunshineCodec) -> codec::Codec {
    match codec {
        SunshineCodec::H264 => codec::Codec::H264,
        SunshineCodec::Hevc => codec::Codec::Hevc,
        SunshineCodec::Av1 => codec::Codec::Av1,
    }
}

/// The decoder's output frames; direct media assembles video in its own receiver.
struct Buffers {
    frames: [Box<[u8]>; decoder::FRAMES],
}

impl Buffers {
    fn new(coded: Size) -> Box<Self> {
        Box::new(Self {
            frames: core::array::from_fn(|_| vec![0; coded.nv12_bytes()].into_boxed_slice()),
        })
    }
}

/// One stream's channels, decoder and audio. The session borrows `buffers`, so it is closed
/// before they are freed; buffers a retained session may still touch are never freed.
struct Running {
    session: Box<DirectSession>,
    input: Outbox,
    buffers: *mut Buffers,
    epoch: Epoch,
    draining: bool,
    last_record_ms: Option<u64>,
    silent: bool,
}

impl Running {
    fn counters(&self) -> (video::Stats, recovery::Counters) {
        (self.session.video_stats(), self.session.video_recovery())
    }

    fn audio_stats(&self) -> Option<audio::Stats> {
        self.session.audio_stats()
    }

    /// What the console can measure for the bitrate and frame-rate policies: frames it lost,
    /// could not upload or skipped while waiting for a keyframe, and the keyframes it asked for.
    /// Frames replaced while working off a backlog are not counted: they say the link was late
    /// once, not that it loses frames.
    fn telemetry(&self, now_ms: u64) -> Telemetry {
        let (stats, recovery) = self.counters();
        let dropped = stats.dropped.saturating_add(recovery.frames_skipped);
        Telemetry {
            at_us: now_ms.saturating_mul(1000),
            decoded_total: Some(stats.decoded),
            dropped_total: u32::try_from(dropped).unwrap_or(u32::MAX),
            idr_requests: recovery.idr_requests,
            ..Telemetry::default()
        }
    }
}

/// Device media for the composed frontend, driven by the controller's OpenMedia and
/// CloseMedia actions.
pub struct Stream {
    running: Option<Running>,
    audio: Option<(Audout, &'static mut Slots)>,
    retired: &'static Cell<bool>,
    capabilities: Capabilities,
}

impl Stream {
    pub fn new(capabilities: Capabilities) -> Self {
        let slots = Box::leak(Box::new(Slots([[0; SLOT_BYTES]; SLOTS])));
        Self {
            running: None,
            audio: Some((Audout::new(), slots)),
            retired: Box::leak(Box::new(Cell::new(false))),
            capabilities,
        }
    }

    fn open_video(
        &mut self,
        codec: codec::Codec,
        width: u32,
        height: u32,
        fps: u32,
        slots: Option<[*mut u8; SURFACES]>,
    ) -> Result<(Video<'static, Decoder, SURFACES>, *mut Buffers), &'static str> {
        let display = Size::new(width, height).ok_or("invalid size")?;
        let coded = Size::new(width.next_multiple_of(16), height.next_multiple_of(16))
            .ok_or("invalid coded size")?;
        let config = video::Config {
            decoder: decoder::Config {
                codec,
                coded,
                display,
                timeout_ms: 2000,
            },
            fps,
            matrix: Matrix::Bt709,
        };
        log(&crate::perf::text());
        let backend = Decoder::new(fps).with_path(
            crate::perf::path(),
            slots.map(|slots| (slots, moonlight_nx2_core::frame::FRAME_BYTES)),
        );
        let buffers = Box::into_raw(Buffers::new(coded));
        let memory = unsafe { &mut *buffers };
        let [first, second] = &mut memory.frames;
        let video = Video::open(
            backend,
            config,
            &self.capabilities,
            self.retired,
            [&mut first[..], &mut second[..]],
        );
        match video {
            Ok(video) => Ok((video, buffers)),
            Err(error) => {
                log(&format!("stream: decoder open failed {error:?}"));
                if !self.retired.get() {
                    drop(unsafe { Box::from_raw(buffers) });
                }
                Err("decoder")
            }
        }
    }

    /// Fails a media open that has no live Sunshine session to stream from.
    pub fn refuse<F: Files + Clone>(&mut self, client: &mut Client<F>) {
        log("stream: open refused: no live Sunshine session");
        match client.session_epoch() {
            Some(epoch) => {
                client.observe(epoch, Observation::Failed);
            }
            None => client.runtime(moonlight_nx2_app::service::RuntimeEvent::MediaFailed),
        }
    }

    /// Opens media straight from Sunshine once PLAY succeeded: RTP video and audio on the
    /// negotiated ports, Opus decoded on the console, keyframe requests through `control`.
    pub fn open_direct<F: Files + Clone>(
        &mut self,
        client: &mut Client<F>,
        stream: &Negotiated,
        control: Control,
        slots: Option<[*mut u8; SURFACES]>,
        now_ms: u64,
    ) -> bool {
        let Some(epoch) = client.session_epoch() else {
            client.runtime(moonlight_nx2_app::service::RuntimeEvent::MediaFailed);
            return false;
        };
        log(&format!(
            "stream: direct {}x{}@{} {:?} packet={} encryption={:#x} audio={}ch/{}ms",
            stream.width,
            stream.height,
            stream.fps,
            stream.codec,
            stream.packet_size,
            stream.encryption,
            stream.audio.channels,
            stream.audio.packet_duration_ms
        ));
        let opened = match self.running {
            None => self.start_direct(stream, control, epoch, slots, now_ms),
            Some(_) => Err("a stream is already open"),
        };
        match opened {
            Ok(running) => {
                self.running = Some(running);
                log("stream: direct media opened");
                true
            }
            Err(reason) => {
                log(&format!("stream: direct open refused: {reason}"));
                client.observe(epoch, Observation::Failed);
                false
            }
        }
    }

    fn start_direct(
        &mut self,
        stream: &Negotiated,
        control: Control,
        epoch: Epoch,
        slots: Option<[*mut u8; SURFACES]>,
        now_ms: u64,
    ) -> Result<Running, &'static str> {
        let (video, buffers) = self.open_video(
            direct_codec(stream.codec),
            u32::from(stream.width),
            u32::from(stream.height),
            u32::from(stream.fps),
            slots,
        )?;
        let decoder = match HwOpus::open(&stream.audio) {
            Ok(decoder) => Some(decoder),
            Err(result) => {
                log(&format!(
                    "stream: hwopus open failed {result:#x}; audio off"
                ));
                None
            }
        };
        let audio = self.audio.take();
        let mut connector = PeerConnector::new(stream.host);
        let input = control.0.clone();
        let events = ControlEvents::new(control);
        match direct_media::open(&mut connector, stream, events, decoder, audio, now_ms) {
            Ok(media) => Ok(Running {
                session: Box::new(Session::new(video, media)),
                input,
                buffers,
                epoch,
                draining: false,
                last_record_ms: None,
                silent: false,
            }),
            Err((failure, closed)) => {
                log(&format!("stream: direct media open failed {failure:?}"));
                if self.reclaim(closed) {
                    drop(unsafe { Box::from_raw(buffers) });
                }
                Err("media")
            }
        }
    }

    /// Takes the audio device back; false when anything stays owned by the device.
    fn reclaim(&mut self, closed: Closed<Audout>) -> bool {
        self.audio = closed.audio;
        !closed.retained
    }

    /// Drains an open stream; with nothing open, the close completes at once.
    pub fn begin_close<F: Files + Clone>(&mut self, client: &mut Client<F>, now_ms: u64) {
        let Some(running) = self.running.as_mut() else {
            if let Some(epoch) = client.session_epoch() {
                client.observe(
                    epoch,
                    Observation::Closed {
                        retained: self.retired.get() || crate::render_platform::process_retired(),
                    },
                );
            }
            return;
        };
        running.draining = true;
        running.session.begin_drain(now_ms);
    }

    pub fn pump<F: Files + Clone>(
        &mut self,
        client: &mut Client<F>,
        renderer: &mut Renderer,
        now_ms: u64,
    ) {
        let Some(running) = self.running.as_mut() else {
            return;
        };
        let result =
            frontend_media::pump_network(&mut running.session, client, running.epoch, now_ms);
        if result == Err(frontend_media::Error::Stale) {
            self.close(client, renderer);
        }
    }

    /// Steps the open stream. True when the step presented, so the caller's frame is already
    /// on its way to the display and must not be presented again.
    pub fn step<F: Files + Clone>(
        &mut self,
        client: &mut Client<F>,
        renderer: &mut Renderer,
        input: &FrameInput,
        now_ms: u64,
        interactive: bool,
    ) -> bool {
        let Some(running) = self.running.as_mut() else {
            return false;
        };
        let tick = Tick {
            epoch: running.epoch,
            now_ms,
            interactive,
        };
        frontend_media::send_input(&running.input, client, input, running.epoch);
        let result = frontend_media::step(&mut running.session, client, renderer, tick);
        let presented = result.is_ok();
        if let Ok(step) = &result
            && step.progress.video_records + step.progress.pcm_records > 0
        {
            running.last_record_ms = Some(now_ms);
        }
        if result.is_ok() {
            client.observe(
                running.epoch,
                Observation::Telemetry(running.telemetry(now_ms)),
            );
        }
        let quiet = running
            .last_record_ms
            .is_some_and(|last| now_ms.saturating_sub(last) > MEDIA_SILENCE_MS);
        if quiet && !running.draining && !running.silent {
            running.silent = true;
            log(&format!(
                "stream: no media for {MEDIA_SILENCE_MS} ms; failing"
            ));
            client.observe(running.epoch, Observation::Failed);
        }
        let finished = match result {
            Ok(step) => running.draining && step.progress.drained,
            Err(frontend_media::Error::Media(media_session::Error::Media(_))) => running.draining,
            Err(error) => {
                log(&format!("stream: step failed {error:?}"));
                true
            }
        };
        if finished {
            self.close(client, renderer);
        }
        presented
    }

    pub fn report(&self) {
        let Some(running) = self.running.as_ref() else {
            return;
        };
        let (stats, recovery) = running.counters();
        log(&format!(
            "stream: video units={} bytes={} presented={} dropped={} caught_up={} skipped={} idr_requests={}",
            stats.accepted_units,
            stats.accepted_bytes,
            stats.presented,
            stats.dropped,
            stats.caught_up,
            recovery.frames_skipped,
            recovery.idr_requests
        ));
        log(&format!(
            "stream: {}",
            crate::stream_stats::take_stages_text()
        ));
        if let Some(wake) = crate::stream_stats::take_wake_text() {
            log(&format!("stream: {wake}"));
        }
        if let Some(decoder) = crate::stream_stats::take_decoder_text() {
            log(&format!("stream: {decoder}"));
        }
        if let Some(overruns) = crate::stream_stats::take_overruns_text() {
            log(&format!("stream: {overruns}"));
        }
        let Some(audio) = running.audio_stats() else {
            return;
        };
        log(&format!(
            "stream: audio received={} queued={} played={} dropped={} overflow={} cuts={} underruns={} gap_ms={} longest_empty_ms={} empties={} empty_ms={} empties<2/<5/<10/more_ms={}/{}/{}/{} depth_ms={}..{} pump_gap_ms={}",
            audio.received,
            audio.appended,
            audio.released,
            audio.dropped,
            audio.overflow_drops,
            audio.cuts,
            audio.audible_gaps,
            audio.audible_gap_ms,
            audio.longest_empty_ms,
            audio.polled_starvations,
            audio.starved_ms_at_least,
            audio.empty_spells[0],
            audio.empty_spells[1],
            audio.empty_spells[2],
            audio.empty_spells[3],
            audio.second_low_depth_ms,
            audio.second_high_depth_ms,
            audio.longest_pump_gap_ms
        ));
    }

    /// Closes the stream. The renderer lets go of the decoder's memory first, since closing
    /// the decoder frees it.
    pub fn close<F: Files + Clone>(&mut self, client: &mut Client<F>, renderer: &mut Renderer) {
        self.report();
        let Some(mut running) = self.running.take() else {
            return;
        };
        if let Err(error) = renderer.forget_imports() {
            log(&format!("stream: renderer kept its imports {error:?}"));
        }
        let closed = frontend_media::close(&mut running.session, client, running.epoch);
        drop(running.session);
        let freed = closed.is_some_and(|closed| {
            if let Err(error) = closed.decoder {
                log(&format!("stream: decoder close {error:?}"));
            }
            self.reclaim(closed.media)
        });
        if freed && !self.retired.get() {
            drop(unsafe { Box::from_raw(running.buffers) });
        } else {
            log("stream: media memory retained until process exit");
        }
    }
}
