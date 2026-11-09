//! Per-tick media driver: video records to the decoder with input-v1 acknowledgements, PCM
//! records to audio output with header acknowledgements. Socket, decoder and audio device
//! implementations belong to the runtime; this owns ordering, bounds and retention reporting.

use crate::reply::{Descriptor, MediaAck};
use crate::request::Transport;
use moonlight_nx2_core::media::{Error, HEADER_BYTES, Header, Record};
use moonlight_nx2_io::audio::{self, Device, Output, Retained, Slots};
use moonlight_nx2_io::media::{Ack, Channel, Config, MAX_INPUT_BYTES};
use moonlight_nx2_io::socket::{IoError, Socket};
use moonlight_nx2_io::udp::{self, Datagram, Receiver};

pub const PCM_RECORDS_PER_STEP: usize = 4;
pub const CONNECT_TIMEOUT_MS: u64 = 5_000;
pub const VIDEO_READ_BUDGET: usize = 256 * 1024;
pub const PCM_READ_BUDGET: usize = 8 * 1024;
pub const UDP_DATAGRAMS_PER_STEP: usize = 64;
/// Bound on draining after `begin_drain`, including a blocked write half.
pub const DRAIN_TIMEOUT_MS: u64 = 2_000;

/// Opens sockets to the control peer's address.
pub trait Connector {
    type Socket: Socket;
    fn connect(&mut self, port: u16) -> Result<Self::Socket, IoError>;
}

/// Opens a connected datagram socket to the same authenticated control peer as TCP.
pub trait UdpConnector: Connector {
    type Datagram: moonlight_nx2_io::udp::Datagram;
    fn connect_datagram(&mut self, port: u16) -> Result<Self::Datagram, IoError>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Submit {
    /// The payload was copied or decoded; the record can be released.
    Accepted,
    /// Keep the record and offer it again on a later step.
    Busy,
    Failed,
}

/// What the decoder and renderer did since the last poll.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Poll {
    Idle,
    /// A decoded frame reached the display.
    Presented,
    /// Decoding or rendering failed asynchronously; the stream must stop.
    Failed,
}

/// The video decoder boundary (Worker1). The payload is borrowed only for the call.
pub trait Decoder {
    fn submit(&mut self, header: &Header, payload: &[u8]) -> Submit;
    /// Local completion of this unit's receive, unchanged on Busy retries. None when the
    /// transport has no arrival evidence. This is never upstream PTS or PC send time.
    fn submit_timed(
        &mut self,
        header: &Header,
        payload: &[u8],
        _received_us: Option<u64>,
    ) -> Submit {
        self.submit(header, payload)
    }
    /// Called at the end of every step, with or without a new access unit, and after EOF.
    fn poll(&mut self) -> Poll;
    /// True while an accepted unit or uploaded frame still awaits presentation; video EOF is
    /// not reported as ended until this is false.
    fn pending(&mut self) -> bool {
        false
    }
}

/// Supplies the input-v1 record sent with each video acknowledgement; 0 means no change.
pub trait InputSource {
    fn take(&mut self, out: &mut [u8; MAX_INPUT_BYTES]) -> usize;
}

/// Caller-owned media storage; it stays borrowed until `close`.
pub struct Memory<'a> {
    pub video: &'a mut [u8],
    pub video_outbound: &'a mut [u8],
    pub pcm: &'a mut [u8],
    pub pcm_outbound: &'a mut [u8],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stream {
    Video,
    Pcm,
    Audio,
    Decoder,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    Invalid,
    Connect(Stream, IoError),
    Open(Stream, Error),
    OpenCleanup {
        stream: Stream,
        open: Error,
        close: IoError,
    },
    Media(Stream, Error),
    Audio(audio::Error),
    Decoder,
    /// `begin_drain`'s deadline passed before every record and acknowledgement was done.
    DrainTimeout,
    Udp(udp::Error),
}

/// Common video ownership boundary. UDP acceptance keeps its slot until feedback is queued;
/// TCP acceptance moves the original header into its bounded acknowledgement queue.
pub trait VideoChannel {
    fn pump_video(&mut self, now_ms: u64) -> Result<(), Failure>;
    fn video_record(&self) -> Option<Record<'_>>;
    fn local_arrival_us(&self) -> Option<u64> {
        None
    }
    fn accept_video(&mut self) -> Result<(), Failure>;
    fn acknowledge_video(
        &mut self,
        header: &[u8; HEADER_BYTES],
        input: &[u8],
    ) -> Result<bool, Failure>;
    fn video_drained(&self) -> bool;
    fn close_video(self) -> bool;
}

impl<S: Socket> VideoChannel for Channel<'_, S> {
    fn pump_video(&mut self, now_ms: u64) -> Result<(), Failure> {
        match self.pump(now_ms) {
            Ok(()) | Err(Error::Again | Error::Ended) => Ok(()),
            Err(error) => Err(Failure::Media(Stream::Video, error)),
        }
    }

    fn video_record(&self) -> Option<Record<'_>> {
        self.peek()
    }

    fn accept_video(&mut self) -> Result<(), Failure> {
        self.consume()
            .map_err(|error| Failure::Media(Stream::Video, error))
    }

    fn acknowledge_video(
        &mut self,
        header: &[u8; HEADER_BYTES],
        input: &[u8],
    ) -> Result<bool, Failure> {
        match self.acknowledge(header, input) {
            Ok(()) => Ok(true),
            Err(Error::Again) => Ok(false),
            Err(error) => Err(Failure::Media(Stream::Video, error)),
        }
    }

    fn video_drained(&self) -> bool {
        self.drained()
    }
    fn close_video(self) -> bool {
        self.close().is_err()
    }
}

impl<S: Socket, U: Datagram> VideoChannel for Receiver<'_, S, U> {
    fn pump_video(&mut self, now_ms: u64) -> Result<(), Failure> {
        let now_us = now_ms
            .checked_mul(1000)
            .ok_or(Failure::Udp(udp::Error::Clock))?;
        match self.pump(now_us) {
            Ok(()) | Err(udp::Error::Again | udp::Error::Ended) => Ok(()),
            Err(error) => Err(Failure::Udp(error)),
        }
    }

    fn video_record(&self) -> Option<Record<'_>> {
        self.peek().map(|unit| Record {
            header: unit.header,
            raw_header: unit.header.encode(),
            payload: unit.payload,
        })
    }

    fn local_arrival_us(&self) -> Option<u64> {
        self.peek().map(|unit| unit.completed_at_us)
    }

    fn accept_video(&mut self) -> Result<(), Failure> {
        Ok(())
    }

    fn acknowledge_video(
        &mut self,
        header: &[u8; HEADER_BYTES],
        input: &[u8],
    ) -> Result<bool, Failure> {
        if !self
            .peek()
            .is_some_and(|unit| unit.header.encode() == *header)
        {
            return Err(Failure::Udp(udp::Error::Invalid));
        }
        match self.acknowledge(input) {
            Ok(()) => Ok(true),
            Err(udp::Error::Again) => Ok(false),
            Err(error) => Err(Failure::Udp(error)),
        }
    }

    fn video_drained(&self) -> bool {
        self.drained()
    }
    fn close_video(self) -> bool {
        self.close().0.is_err()
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Progress {
    pub video_records: u32,
    pub pcm_records: u32,
    pub presented: bool,
    /// Video only: drained (clean EOF, every record consumed and its acknowledgement sent), no
    /// acknowledgement held, nothing awaiting presentation. PCM may still have work; see `drained`.
    pub ended: bool,
    /// PCM is drained and no release acknowledgement is held (false when there is no PCM).
    pub pcm_ended: bool,
    /// Whole-media completion: video ended and, when PCM exists, PCM ended too.
    pub drained: bool,
}

/// Result of `close`: whether every local resource was released.
pub struct Closed<D> {
    pub retained: bool,
    pub audio: Option<(D, &'static mut Slots)>,
    pub outcome: Outcome,
}

/// How media ended: everything drained, or closed early with work left undone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Drained,
    Aborted,
}

struct HeldAck {
    header: [u8; HEADER_BYTES],
    length: usize,
}

impl<D> core::fmt::Debug for Closed<D> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Closed")
            .field("retained", &self.retained)
            .field("audio_returned", &self.audio.is_some())
            .finish()
    }
}

pub struct Media<'a, S: Socket, D: Device, V: VideoChannel = Channel<'a, S>> {
    video: V,
    pcm: Option<Channel<'a, S>>,
    audio: Option<Output<D>>,
    held_video: Option<HeldAck>,
    held_pcm: Option<[u8; HEADER_BYTES]>,
    spare_audio: Option<(D, &'static mut Slots)>,
    input: [u8; MAX_INPUT_BYTES],
    retained: bool,
    drain_deadline_ms: Option<u64>,
    drained: bool,
}

impl<'a, S: Socket, D: Device> Media<'a, S, D> {
    /// Connects the descriptor's channels. PCM connects whenever the descriptor offers it; without
    /// a device it is acknowledged unplayed. A refused device is returned, an uncertain one is
    /// reported retained.
    pub fn open<C: Connector<Socket = S>>(
        connector: &mut C,
        descriptor: &Descriptor,
        memory: Memory<'a>,
        audio: Option<(D, &'static mut Slots)>,
        now_ms: u64,
    ) -> Result<Self, (Failure, Closed<D>)> {
        let Memory {
            video,
            video_outbound,
            pcm,
            pcm_outbound,
        } = memory;
        let video_fits =
            usize::try_from(descriptor.video.max_payload).is_ok_and(|max| max <= video.len());
        if !video_fits
            || descriptor.video.ack != MediaAck::InputV1
            || descriptor.video.transport != Transport::TcpV1
            || descriptor.video.udp.is_some()
        {
            return Err((
                Failure::Invalid,
                Closed {
                    retained: false,
                    audio,
                    outcome: Outcome::Aborted,
                },
            ));
        }

        let video_config = Config {
            token: descriptor.video.token,
            memory: video,
            outbound: video_outbound,
            exact_bytes: None,
            ack: Ack::Input,
            read_budget: VIDEO_READ_BUDGET,
            connect_timeout_ms: CONNECT_TIMEOUT_MS,
        };
        let video = match open_channel(
            connector,
            descriptor.video.port,
            video_config,
            Stream::Video,
            now_ms,
        ) {
            Ok(channel) => channel,
            Err(failure) => {
                return Err((
                    failure,
                    Closed {
                        retained: matches!(failure, Failure::OpenCleanup { .. }),
                        audio,
                        outcome: Outcome::Aborted,
                    },
                ));
            }
        };

        Self::with_video(
            connector,
            descriptor,
            video,
            (pcm, pcm_outbound),
            audio,
            now_ms,
        )
    }
}

pub type UdpMedia<'a, S, D, U> = Media<'a, S, D, Receiver<'a, S, U>>;

impl<'a, S: Socket, D: Device, U: Datagram> UdpMedia<'a, S, D, U> {
    /// Opens UDP video and its TCP feedback, plus optional TCP PCM. No TCP video fallback.
    /// `memory.video` holds eight max_payload slots and `video_outbound` holds TCP feedback.
    pub fn open_udp<C: UdpConnector<Socket = S, Datagram = U>>(
        connector: &mut C,
        descriptor: &Descriptor,
        memory: Memory<'a>,
        audio: Option<(D, &'static mut Slots)>,
        now_ms: u64,
    ) -> Result<Self, (Failure, Closed<D>)> {
        let video = &descriptor.video;
        let profile = video
            .udp
            .filter(|_| video.transport == Transport::UdpV1 && video.ack == MediaAck::InputV1);
        let Some(profile) = profile else {
            return Err((
                Failure::Invalid,
                Closed {
                    retained: false,
                    audio,
                    outcome: Outcome::Aborted,
                },
            ));
        };
        if !profile.is_valid()
            || profile.token == video.token
            || video.port == 0
            || descriptor
                .audio
                .is_some_and(|audio| audio.token == profile.token)
        {
            return Err((
                Failure::Invalid,
                Closed {
                    retained: false,
                    audio,
                    outcome: Outcome::Aborted,
                },
            ));
        }
        let Some(now_us) = now_ms.checked_mul(1000) else {
            return Err((
                Failure::Udp(udp::Error::Clock),
                Closed {
                    retained: false,
                    audio,
                    outcome: Outcome::Aborted,
                },
            ));
        };
        let room = (video.max_payload as usize).checked_mul(udp::UNIT_SLOTS);
        if video.max_payload == 0
            || video.max_payload > crate::stream::MAX_VIDEO_PAYLOAD
            || !room.is_some_and(|room| memory.video.len() >= room)
        {
            return Err((
                Failure::Invalid,
                Closed {
                    retained: false,
                    audio,
                    outcome: Outcome::Aborted,
                },
            ));
        }
        let config = udp::Config {
            feedback_token: video.token,
            udp_token: profile.token,
            max_payload: video.max_payload as usize,
            deadline_us: u64::from(profile.deadline_us),
            spread_us: u64::from(profile.spread_us),
            pace_bytes_per_ms: profile.pace_bytes_per_ms,
            hello_ms: profile.hello_ms,
            connect_timeout_us: CONNECT_TIMEOUT_MS * 1000,
            datagram_budget: UDP_DATAGRAMS_PER_STEP,
        };
        let mut feedback = match connector.connect(video.port) {
            Ok(socket) => socket,
            Err(error) => {
                return Err((
                    Failure::Connect(Stream::Video, error),
                    Closed {
                        retained: false,
                        audio,
                        outcome: Outcome::Aborted,
                    },
                ));
            }
        };
        let datagram = match connector.connect_datagram(profile.port) {
            Ok(socket) => socket,
            Err(error) => {
                let retained = feedback.close().is_err();
                return Err((
                    Failure::Connect(Stream::Video, error),
                    Closed {
                        retained,
                        audio,
                        outcome: Outcome::Aborted,
                    },
                ));
            }
        };
        let receiver = match Receiver::open(
            config,
            udp::Memory {
                units: memory.video,
                feedback: memory.video_outbound,
            },
            feedback,
            datagram,
            now_us,
        ) {
            Ok(receiver) => receiver,
            Err((error, mut feedback, mut datagram)) => {
                let feedback_failed = feedback.close().is_err();
                let datagram_failed = datagram.close().is_err();
                return Err((
                    Failure::Udp(error),
                    Closed {
                        retained: feedback_failed || datagram_failed,
                        audio,
                        outcome: Outcome::Aborted,
                    },
                ));
            }
        };
        Self::with_video(
            connector,
            descriptor,
            receiver,
            (memory.pcm, memory.pcm_outbound),
            audio,
            now_ms,
        )
    }

    pub fn udp_stats(&self) -> udp::Stats {
        self.video.stats()
    }
}

impl<'a, S: Socket, D: Device, VC: VideoChannel> Media<'a, S, D, VC> {
    fn with_video<C: Connector<Socket = S>>(
        connector: &mut C,
        descriptor: &Descriptor,
        video: VC,
        pcm_memory: (&'a mut [u8], &'a mut [u8]),
        audio: Option<(D, &'static mut Slots)>,
        now_ms: u64,
    ) -> Result<Self, (Failure, Closed<D>)> {
        let (pcm, pcm_outbound) = pcm_memory;
        let mut media = Self {
            video,
            pcm: None,
            audio: None,
            held_video: None,
            held_pcm: None,
            spare_audio: None,
            input: [0; MAX_INPUT_BYTES],
            retained: false,
            drain_deadline_ms: None,
            drained: false,
        };

        let Some(offer) = descriptor.audio else {
            media.spare_audio = audio;
            return Ok(media);
        };
        let pcm_config = Config {
            token: offer.token,
            memory: pcm,
            outbound: pcm_outbound,
            exact_bytes: Some(offer.chunk_bytes as usize),
            ack: Ack::Header,
            read_budget: PCM_READ_BUDGET,
            connect_timeout_ms: CONNECT_TIMEOUT_MS,
        };
        match open_channel(connector, offer.port, pcm_config, Stream::Pcm, now_ms) {
            Ok(channel) => media.pcm = Some(channel),
            Err(failure) => {
                media.retained |= matches!(failure, Failure::OpenCleanup { .. });
                let closed = media.close_with(audio);
                return Err((failure, closed));
            }
        }

        let Some((device, slots)) = audio else {
            return Ok(media);
        };

        let config = audio::Config {
            chunk_bytes: offer.chunk_bytes as usize,
            ..audio::Config::default()
        };
        match Output::open(config, device, slots) {
            Ok(output) => media.audio = Some(output),
            Err((error, retained)) => {
                let returned = match retained {
                    Retained::Returned(device, slots) => Some((device, slots)),
                    Retained::Kept => None,
                };
                let mut closed = media.close_with(returned);
                closed.retained |= closed.audio.is_none();
                return Err((Failure::Audio(error), closed));
            }
        }

        Ok(media)
    }

    /// One transport quantum and retries of already held ACKs, without consumer/device work.
    /// Only `step` can consume new records or establish whole-media completion.
    pub fn pump_network(&mut self, now_ms: u64) -> Result<(), Failure> {
        let expired = self
            .drain_deadline_ms
            .is_some_and(|deadline| now_ms >= deadline);
        if expired && !self.drained {
            return Err(Failure::DrainTimeout);
        }

        self.video.pump_video(now_ms)?;
        self.flush_video_ack()?;

        if let Some(pcm) = &mut self.pcm {
            match pcm.pump(now_ms) {
                Ok(()) | Err(Error::Again | Error::Ended) => {}
                Err(error) => return Err(Failure::Media(Stream::Pcm, error)),
            }
            retry_pcm_ack(pcm, &mut self.held_pcm)?;
        }
        Ok(())
    }

    /// One bounded step: at most one video record and `PCM_RECORDS_PER_STEP` PCM records, then a
    /// decoder poll, so a unit submitted this step can present in the same frame. The poll runs on
    /// every step that reaches it, with or without a new unit and after EOF.
    pub fn step<V: Decoder, I: InputSource>(
        &mut self,
        decoder: &mut V,
        input: &mut I,
        now_ms: u64,
    ) -> Result<Progress, Failure> {
        let mut progress = Progress::default();

        self.step_video(decoder, input, now_ms, &mut progress)?;
        self.step_pcm(now_ms, &mut progress)?;

        match decoder.poll() {
            Poll::Idle => {}
            Poll::Presented => progress.presented = true,
            Poll::Failed => return Err(Failure::Decoder),
        }
        progress.ended =
            self.video.video_drained() && self.held_video.is_none() && !decoder.pending();
        progress.pcm_ended =
            self.pcm.as_ref().is_some_and(|pcm| pcm.drained()) && self.held_pcm.is_none();
        progress.drained = progress.ended && (self.pcm.is_none() || progress.pcm_ended);
        self.drained = progress.drained;

        let expired = self
            .drain_deadline_ms
            .is_some_and(|deadline| now_ms >= deadline);
        if expired && !progress.drained {
            return Err(Failure::DrainTimeout);
        }
        Ok(progress)
    }

    /// Starts the bounded drain after the stop: keep stepping until `Progress.drained`, then
    /// `close` reports `Outcome::Drained`; past `DRAIN_TIMEOUT_MS` the step fails with
    /// `DrainTimeout` and `close` reports `Outcome::Aborted`.
    pub fn begin_drain(&mut self, now_ms: u64) {
        if self.drain_deadline_ms.is_none() {
            self.drain_deadline_ms = Some(now_ms.saturating_add(DRAIN_TIMEOUT_MS));
        }
    }

    fn step_video<V: Decoder, I: InputSource>(
        &mut self,
        decoder: &mut V,
        input: &mut I,
        now_ms: u64,
        progress: &mut Progress,
    ) -> Result<(), Failure> {
        self.video.pump_video(now_ms)?;

        if !self.flush_video_ack()? {
            return Ok(());
        }

        let received_us = self.video.local_arrival_us();
        let Some(record) = self.video.video_record() else {
            return Ok(());
        };
        let header = record.raw_header;
        match decoder.submit_timed(&record.header, record.payload, received_us) {
            Submit::Accepted => {}
            Submit::Busy => return Ok(()),
            Submit::Failed => return Err(Failure::Decoder),
        }

        self.video.accept_video()?;
        progress.video_records += 1;

        let length = input.take(&mut self.input).min(MAX_INPUT_BYTES);
        self.held_video = Some(HeldAck { header, length });
        self.flush_video_ack()?;
        Ok(())
    }

    /// Sends a held acknowledgement with its original input record. False while still held.
    fn flush_video_ack(&mut self) -> Result<bool, Failure> {
        let Some(held) = &self.held_video else {
            return Ok(true);
        };

        match self
            .video
            .acknowledge_video(&held.header, &self.input[..held.length])?
        {
            true => {
                self.input[..held.length].fill(0);
                self.held_video = None;
                Ok(true)
            }
            false => Ok(false),
        }
    }

    fn step_pcm(&mut self, now_ms: u64, progress: &mut Progress) -> Result<(), Failure> {
        let Some(pcm) = self.pcm.as_mut() else {
            return Ok(());
        };

        match pcm.pump(now_ms) {
            Ok(()) | Err(Error::Again) | Err(Error::Ended) => {}
            Err(error) => return Err(Failure::Media(Stream::Pcm, error)),
        }

        let Some(output) = self.audio.as_mut() else {
            return drain_pcm(pcm, &mut self.held_pcm, progress);
        };

        for _ in 0..PCM_RECORDS_PER_STEP {
            let Some(record) = pcm.peek() else {
                break;
            };
            match output.push(&record.raw_header, record.payload) {
                Ok(()) => {}
                Err(audio::Error::Again) => break,
                Err(error) => return Err(Failure::Audio(error)),
            }
            pcm.consume()
                .map_err(|error| Failure::Media(Stream::Pcm, error))?;
            progress.pcm_records += 1;
        }

        output.pump(now_ms).map_err(Failure::Audio)?;
        acknowledge_pcm(pcm, output, &mut self.held_pcm)
    }

    /// Closes every channel and the audio output. Never hides an uncertain release.
    pub fn close(self) -> Closed<D> {
        self.close_with(None)
    }

    fn close_with(mut self, unopened_audio: Option<(D, &'static mut Slots)>) -> Closed<D> {
        self.input.fill(0);
        let video_retained = self.video.close_video();
        let mut retained = self.retained || video_retained;
        if let Some(pcm) = self.pcm.take() {
            retained |= pcm.close().is_err();
        }
        let audio = match self.audio.take() {
            Some(output) => match output.close() {
                (_, Retained::Returned(device, slots)) => Some((device, slots)),
                (_, Retained::Kept) => {
                    retained = true;
                    None
                }
            },
            None => unopened_audio.or(self.spare_audio.take()),
        };

        let outcome = if self.drained {
            Outcome::Drained
        } else {
            Outcome::Aborted
        };
        Closed {
            retained,
            audio,
            outcome,
        }
    }
}

/// Without an audio device, PCM is read and acknowledged unplayed so the PC never waits on it.
fn drain_pcm<S: Socket>(
    pcm: &mut Channel<'_, S>,
    held: &mut Option<[u8; HEADER_BYTES]>,
    progress: &mut Progress,
) -> Result<(), Failure> {
    if !retry_pcm_ack(pcm, held)? {
        return Ok(());
    }

    for _ in 0..PCM_RECORDS_PER_STEP {
        let Some(record) = pcm.peek() else {
            break;
        };
        let header = record.raw_header;
        pcm.consume()
            .map_err(|error| Failure::Media(Stream::Pcm, error))?;
        progress.pcm_records += 1;

        match pcm.acknowledge(&header, &[]) {
            Ok(()) => {}
            Err(Error::Again) => {
                *held = Some(header);
                break;
            }
            Err(error) => return Err(Failure::Media(Stream::Pcm, error)),
        }
    }
    Ok(())
}

fn acknowledge_pcm<S: Socket, D: Device>(
    pcm: &mut Channel<'_, S>,
    output: &mut Output<D>,
    held: &mut Option<[u8; HEADER_BYTES]>,
) -> Result<(), Failure> {
    loop {
        if held.is_none() {
            *held = output.take_acknowledgement();
            if held.is_none() {
                return Ok(());
            }
        }
        if !retry_pcm_ack(pcm, held)? {
            return Ok(());
        }
    }
}

fn retry_pcm_ack<S: Socket>(
    pcm: &mut Channel<'_, S>,
    held: &mut Option<[u8; HEADER_BYTES]>,
) -> Result<bool, Failure> {
    let Some(header) = held.take() else {
        return Ok(true);
    };
    match pcm.acknowledge(&header, &[]) {
        Ok(()) => Ok(true),
        Err(Error::Again) => {
            *held = Some(header);
            Ok(false)
        }
        Err(error) => Err(Failure::Media(Stream::Pcm, error)),
    }
}

fn open_channel<'a, C: Connector>(
    connector: &mut C,
    port: u16,
    config: Config<'a>,
    stream: Stream,
    now_ms: u64,
) -> Result<Channel<'a, C::Socket>, Failure> {
    let socket = connector
        .connect(port)
        .map_err(|error| Failure::Connect(stream, error))?;
    match Channel::open(config, socket, now_ms) {
        Ok(channel) => Ok(channel),
        Err((error, mut socket)) => match socket.close() {
            Ok(()) => Err(Failure::Open(stream, error)),
            Err(close) => Err(Failure::OpenCleanup {
                stream,
                open: error,
                close,
            }),
        },
    }
}
