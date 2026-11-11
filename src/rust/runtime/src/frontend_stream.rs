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
    media::{Closed, Media, Memory, UdpMedia},
    policy::{Epoch, Observation, Telemetry},
    reply::Descriptor,
    request::Transport,
    stream::{AUDIO_CHUNK_BYTES, core_codec},
    sunshine::{
        control::{ControlSender, Delivery, SendError},
        stream::{Codec as SunshineCodec, Negotiated},
    },
};
use moonlight_nx2_core::{
    codec::{self, Capabilities, Size},
    decoder,
    frame::Matrix,
    media::MAX_OUTBOUND_BYTES,
    recovery,
};
use moonlight_nx2_io::{
    audio::{self, SLOT_BYTES, SLOTS, Slots},
    media::Channel,
    udp::{self, Receiver},
};
use moonlight_nx2_ui::store::Files;

type Decoder = crate::sdk_video::SdkVideo;
const SURFACES: usize = decoder::SURFACES;

pub(crate) fn decoder_capabilities() -> Capabilities {
    <Decoder as decoder::Backend<SURFACES>>::capabilities()
}

const MEDIA_SILENCE_MS: u64 = 10_000;

fn log_audio_offer(descriptor: &Descriptor, device: bool) {
    let Some(offer) = &descriptor.audio else {
        log("stream: audio not offered");
        return;
    };
    let queue = audio::Config::default();
    log(&format!(
        "stream: audio offered rate={} channels={} chunk_bytes={} device={} queue device_ms={} target_ms={} burst_ms={}",
        offer.rate,
        offer.channels,
        offer.chunk_bytes,
        if device {
            "free"
        } else {
            "retained, PCM unplayed"
        },
        queue.output_ms,
        queue.target_ms,
        queue.burst_ms
    ));
}

type TcpSession =
    Session<'static, Decoder, NetSocket, Audout, Channel<'static, NetSocket>, SURFACES>;
type UdpSession =
    Session<'static, Decoder, NetSocket, Audout, Receiver<'static, NetSocket, UdpSocket>, SURFACES>;

type DirectSession = Session<
    'static,
    Decoder,
    NetSocket,
    Audout,
    DirectVideo<UdpSocket, ControlEvents<Control>>,
    SURFACES,
    DirectAudio<UdpSocket, HwOpus>,
>;

enum Active {
    Tcp(Box<TcpSession>),
    Udp(Box<UdpSession>),
    Direct(Box<DirectSession>),
}

/// The Sunshine control stream the direct launch owns; video asks it for keyframes.
pub struct Control(pub Box<dyn ControlSender>);

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
}

fn direct_codec(codec: SunshineCodec) -> codec::Codec {
    match codec {
        SunshineCodec::H264 => codec::Codec::H264,
        SunshineCodec::Hevc => codec::Codec::Hevc,
        SunshineCodec::Av1 => codec::Codec::Av1,
    }
}

struct Buffers {
    video: Box<[u8]>,
    video_outbound: Box<[u8]>,
    pcm: Box<[u8]>,
    pcm_outbound: Box<[u8]>,
    frames: [Box<[u8]>; decoder::FRAMES],
}

impl Buffers {
    /// Direct media assembles frames in its own receiver and needs no `video` buffer.
    fn new(coded: Size, video_bytes: usize) -> Box<Self> {
        Box::new(Self {
            video: vec![0; video_bytes].into_boxed_slice(),
            video_outbound: vec![0; MAX_OUTBOUND_BYTES].into_boxed_slice(),
            pcm: vec![0; AUDIO_CHUNK_BYTES as usize].into_boxed_slice(),
            pcm_outbound: vec![0; MAX_OUTBOUND_BYTES].into_boxed_slice(),
            frames: core::array::from_fn(|_| vec![0; coded.nv12_bytes()].into_boxed_slice()),
        })
    }
}

/// One stream's channels, decoder and audio. The session borrows `buffers`, so it is closed
/// before they are freed; buffers a retained session may still touch are never freed.
struct Running {
    session: Active,
    buffers: *mut Buffers,
    epoch: Epoch,
    draining: bool,
    last_record_ms: Option<u64>,
    silent: bool,
}

impl Running {
    fn counters(&self) -> (video::Stats, recovery::Counters) {
        match &self.session {
            Active::Tcp(session) => (session.video_stats(), session.video_recovery()),
            Active::Udp(session) => (session.video_stats(), session.video_recovery()),
            Active::Direct(session) => (session.video_stats(), session.video_recovery()),
        }
    }

    fn audio_stats(&self) -> Option<audio::Stats> {
        match &self.session {
            Active::Tcp(session) => session.audio_stats(),
            Active::Udp(session) => session.audio_stats(),
            Active::Direct(session) => session.audio_stats(),
        }
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

    pub fn open<F: Files + Clone>(
        &mut self,
        client: &mut Client<F>,
        mut descriptor: Descriptor,
        peer: Option<[u8; 4]>,
        now_ms: u64,
    ) -> bool {
        let Some(epoch) = client.session_epoch() else {
            descriptor.wipe();
            client.runtime(moonlight_nx2_app::service::RuntimeEvent::MediaFailed);
            return false;
        };
        let requested = client.requested_options().map_or_else(
            || format!("nothing"),
            |options| {
                format!(
                    "{}x{}@{} {} {} kbps",
                    options.width,
                    options.height,
                    options.fps,
                    options.codec.name(),
                    options.bitrate_kbps
                )
            },
        );
        log(&format!(
            "stream: requested {requested}; negotiated {}x{}@{} {}",
            descriptor.width,
            descriptor.height,
            descriptor.fps,
            descriptor.codec.name()
        ));
        let opened = match peer {
            Some(peer) if self.running.is_none() => self.start(&descriptor, peer, epoch, now_ms),
            _ => Err("no peer or a stream is already open"),
        };
        descriptor.wipe();
        match opened {
            Ok(running) => {
                self.running = Some(running);
                log("stream: media opened");
                true
            }
            Err(reason) => {
                log(&format!("stream: open refused: {reason}"));
                client.observe(epoch, Observation::Failed);
                false
            }
        }
    }

    fn start(
        &mut self,
        descriptor: &Descriptor,
        peer: [u8; 4],
        epoch: Epoch,
        now_ms: u64,
    ) -> Result<Running, &'static str> {
        let (video, buffers) = self.open_video(
            core_codec(descriptor.codec),
            descriptor.width,
            descriptor.height,
            descriptor.fps,
            udp::UNIT_SLOTS * udp::MAX_PAYLOAD,
        )?;
        let memory = unsafe { &mut *buffers };
        let media = Memory {
            video: &mut memory.video,
            video_outbound: &mut memory.video_outbound,
            pcm: &mut memory.pcm,
            pcm_outbound: &mut memory.pcm_outbound,
        };
        let audio = self.audio.take();
        log_audio_offer(descriptor, audio.is_some());
        let mut connector = PeerConnector::new(peer);
        let session = if descriptor.video.transport == Transport::UdpV1 {
            UdpMedia::open_udp(&mut connector, descriptor, media, audio, now_ms)
                .map(|media| Active::Udp(Box::new(Session::new(video, media))))
        } else {
            Media::open(&mut connector, descriptor, media, audio, now_ms)
                .map(|media| Active::Tcp(Box::new(Session::new(video, media))))
        };
        match session {
            Ok(session) => Ok(Running {
                session,
                buffers,
                epoch,
                draining: false,
                last_record_ms: None,
                silent: false,
            }),
            Err((failure, closed)) => {
                log(&format!("stream: media open failed {failure:?}"));
                if self.reclaim(closed) {
                    drop(unsafe { Box::from_raw(buffers) });
                }
                Err("media")
            }
        }
    }

    fn open_video(
        &mut self,
        codec: codec::Codec,
        width: u32,
        height: u32,
        fps: u32,
        video_bytes: usize,
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
        let backend = Decoder::new(fps);
        let buffers = Box::into_raw(Buffers::new(coded, video_bytes));
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

    /// Opens media straight from Sunshine once PLAY succeeded: RTP video and audio on the
    /// negotiated ports, Opus decoded on the console, keyframe requests through `control`.
    #[expect(dead_code, reason = "the direct launch calls this once it hands over a stream")]
    pub fn open_direct<F: Files + Clone>(
        &mut self,
        client: &mut Client<F>,
        stream: &Negotiated,
        control: Control,
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
            None => self.start_direct(stream, control, epoch, now_ms),
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
        now_ms: u64,
    ) -> Result<Running, &'static str> {
        let (video, buffers) = self.open_video(
            direct_codec(stream.codec),
            u32::from(stream.width),
            u32::from(stream.height),
            u32::from(stream.fps),
            0,
        )?;
        let decoder = match HwOpus::open(&stream.audio) {
            Ok(decoder) => Some(decoder),
            Err(result) => {
                log(&format!("stream: hwopus open failed {result:#x}; audio off"));
                None
            }
        };
        let audio = self.audio.take();
        let mut connector = PeerConnector::new(stream.host);
        let events = ControlEvents::new(control);
        match direct_media::open(&mut connector, stream, events, decoder, audio, now_ms) {
            Ok(media) => Ok(Running {
                session: Active::Direct(Box::new(Session::new(video, media))),
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
        match &mut running.session {
            Active::Tcp(session) => session.begin_drain(now_ms),
            Active::Udp(session) => session.begin_drain(now_ms),
            Active::Direct(session) => session.begin_drain(now_ms),
        }
    }

    pub fn pump<F: Files + Clone>(&mut self, client: &mut Client<F>, now_ms: u64) {
        let Some(running) = self.running.as_mut() else {
            return;
        };
        let result = match &mut running.session {
            Active::Tcp(session) => {
                frontend_media::pump_network(session, client, running.epoch, now_ms)
            }
            Active::Udp(session) => {
                frontend_media::pump_network(session, client, running.epoch, now_ms)
            }
            Active::Direct(session) => {
                frontend_media::pump_network(session, client, running.epoch, now_ms)
            }
        };
        if result == Err(frontend_media::Error::Stale) {
            self.close(client);
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
        let result = match &mut running.session {
            Active::Tcp(session) => frontend_media::step(session, client, renderer, input, tick),
            Active::Udp(session) => frontend_media::step(session, client, renderer, input, tick),
            Active::Direct(session) => {
                frontend_media::step(session, client, renderer, input, tick)
            }
        };
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
            Err(_) => true,
        };
        if finished {
            self.close(client);
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
        let Some(audio) = running.audio_stats() else {
            return;
        };
        log(&format!(
            "stream: audio received={} queued={} played={} dropped={} overflow={} cuts={} underruns={} starved_ms={} depth_ms={}..{} pump_gap_ms={}",
            audio.received,
            audio.appended,
            audio.released,
            audio.dropped,
            audio.overflow_drops,
            audio.cuts,
            audio.polled_starvations,
            audio.starved_ms_at_most,
            audio.second_low_depth_ms,
            audio.second_high_depth_ms,
            audio.longest_pump_gap_ms
        ));
    }

    pub fn close<F: Files + Clone>(&mut self, client: &mut Client<F>) {
        self.report();
        let Some(mut running) = self.running.take() else {
            return;
        };
        let closed = match &mut running.session {
            Active::Tcp(session) => frontend_media::close(session, client, running.epoch),
            Active::Udp(session) => frontend_media::close(session, client, running.epoch),
            Active::Direct(session) => frontend_media::close(session, client, running.epoch),
        };
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
