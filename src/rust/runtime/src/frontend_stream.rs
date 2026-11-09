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
    render::Renderer,
    video::{self, Video},
};
use alloc::{boxed::Box, format, vec};
use core::cell::Cell;
use moonlight_nx2_app::{
    media::{Closed, Media, Memory, UdpMedia},
    policy::{Epoch, Observation},
    reply::Descriptor,
    request::Transport,
    stream::{AUDIO_CHUNK_BYTES, core_codec},
};
use moonlight_nx2_core::{
    codec::{Capabilities, Size},
    decoder::{self, Backing, FrameRegistration},
    frame::Matrix,
    media::MAX_OUTBOUND_BYTES,
};
use moonlight_nx2_io::{
    audio::{SLOT_BYTES, SLOTS, Slots},
    media::Channel,
    udp::{self, Receiver},
};
use moonlight_nx2_ui::store::Files;

#[cfg(not(any(feature = "diagnostic-frontend", feature = "native-video")))]
type Decoder = crate::gsv::GsvBackend;
#[cfg(all(feature = "diagnostic-frontend", not(feature = "native-video")))]
type Decoder = crate::video_sink::VideoSink;
#[cfg(feature = "native-video")]
type Decoder = crate::native_video::NativeVideo;
#[cfg(feature = "native-video")]
const SURFACES: usize = decoder::RING;
#[cfg(not(feature = "native-video"))]
const SURFACES: usize = decoder::SURFACES;

#[cfg(any(feature = "diagnostic-frontend", feature = "native-video"))]
pub(crate) fn decoder_capabilities() -> Capabilities {
    <Decoder as decoder::Backend<SURFACES>>::capabilities()
}

const MEDIA_SILENCE_MS: u64 = 10_000;

type TcpSession =
    Session<'static, Decoder, NetSocket, Audout, Channel<'static, NetSocket>, SURFACES>;
type UdpSession =
    Session<'static, Decoder, NetSocket, Audout, Receiver<'static, NetSocket, UdpSocket>, SURFACES>;

enum Active {
    Tcp(Box<TcpSession>),
    Udp(Box<UdpSession>),
}

struct Buffers {
    video: Box<[u8]>,
    video_outbound: Box<[u8]>,
    pcm: Box<[u8]>,
    pcm_outbound: Box<[u8]>,
    frames: [Box<[u8]>; decoder::FRAMES],
}

impl Buffers {
    fn new(coded: Size) -> Box<Self> {
        Box::new(Self {
            video: vec![0; udp::UNIT_SLOTS * udp::MAX_PAYLOAD].into_boxed_slice(),
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
        #[cfg(feature = "native-video")] renderer: &mut Renderer,
    ) -> bool {
        let Some(epoch) = client.session_epoch() else {
            descriptor.wipe();
            client.runtime(moonlight_nx2_app::service::RuntimeEvent::MediaFailed);
            return false;
        };
        let opened = match peer {
            Some(peer) if self.running.is_none() => self.start(
                &descriptor,
                peer,
                epoch,
                now_ms,
                #[cfg(feature = "native-video")]
                renderer,
            ),
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
        #[cfg(feature = "native-video")] renderer: &mut Renderer,
    ) -> Result<Running, &'static str> {
        let display = Size::new(descriptor.width, descriptor.height).ok_or("invalid size")?;
        let coded = Size::new(
            descriptor.width.next_multiple_of(16),
            descriptor.height.next_multiple_of(16),
        )
        .ok_or("invalid coded size")?;
        let config = video::Config {
            decoder: decoder::Config {
                codec: core_codec(descriptor.codec),
                coded,
                display,
                timeout_ms: if cfg!(feature = "native-video") {
                    2000
                } else {
                    0
                },
                frame_registration: FrameRegistration::Register,
                backing: if cfg!(feature = "native-video") {
                    Backing::NativeGpu
                } else {
                    Backing::CpuReference
                },
            },
            fps: descriptor.fps,
            matrix: Matrix::Bt709,
        };
        #[cfg(feature = "native-video")]
        let backend = renderer
            .native_decoder()
            .map_err(|_| "native renderer owner")?;
        #[cfg(not(feature = "native-video"))]
        let backend = Decoder::new();
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
        let video = match video {
            Ok(video) => video,
            Err(error) => {
                log(&format!("stream: decoder open failed {error:?}"));
                if !self.retired.get() {
                    drop(unsafe { Box::from_raw(buffers) });
                }
                return Err("decoder");
            }
        };
        let media = Memory {
            video: &mut memory.video,
            video_outbound: &mut memory.video_outbound,
            pcm: &mut memory.pcm,
            pcm_outbound: &mut memory.pcm_outbound,
        };
        let audio = self.audio.take();
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
                if self.reclaim(closed) && (!cfg!(feature = "native-video") || !self.retired.get())
                {
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
        };
        if result == Err(frontend_media::Error::Stale) {
            self.close(client);
        }
    }

    pub fn step<F: Files + Clone>(
        &mut self,
        client: &mut Client<F>,
        renderer: &mut Renderer,
        input: &FrameInput,
        now_ms: u64,
        interactive: bool,
    ) {
        let Some(running) = self.running.as_mut() else {
            return;
        };
        let tick = Tick {
            epoch: running.epoch,
            now_ms,
            interactive,
        };
        let result = match &mut running.session {
            Active::Tcp(session) => frontend_media::step(session, client, renderer, input, tick),
            Active::Udp(session) => frontend_media::step(session, client, renderer, input, tick),
        };
        if let Ok(step) = &result
            && step.progress.video_records + step.progress.pcm_records > 0
        {
            running.last_record_ms = Some(now_ms);
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
    }

    pub fn report(&self) {
        let Some(running) = self.running.as_ref() else {
            return;
        };
        let stats = match &running.session {
            Active::Tcp(session) => session.video_stats(),
            Active::Udp(session) => session.video_stats(),
        };
        log(&format!(
            "stream: video units={} bytes={} presented={} dropped={}",
            stats.accepted_units, stats.accepted_bytes, stats.presented, stats.dropped
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
