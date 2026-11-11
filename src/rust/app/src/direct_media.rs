//! Direct Sunshine media behind the helper's media boundaries: `DirectVideo` is a
//! `VideoChannel` over `sunshine::video`, `DirectAudio` a `PcmChannel` that decodes
//! `sunshine::audio`'s Opus packets on the console into the same PCM chunks the helper sends.
//! Both ride connected UDP sockets and keep Sunshine's ping going. Buffers are allocated once.

extern crate alloc;

use alloc::{vec, vec::Vec};

use moonlight_nx2_core::media::{HEADER_BYTES, Header, Record};
use moonlight_nx2_io::audio::{Device, Slots};
use moonlight_nx2_io::socket::{IoError, Socket};
use moonlight_nx2_io::udp::{self, Datagram};
use moonlight_nx2_sunshine::{
    audio,
    control::{ControlSender, Delivery, channel, kind},
    media::{self as session, Ping},
    stream::Negotiated,
    video,
};

use crate::media::{Closed, Failure, Media, PcmChannel, Stream, UdpConnector, VideoChannel};
use crate::stream::AUDIO_CHUNK_BYTES;

pub const VIDEO_DATAGRAMS_PER_PUMP: usize = 512;
pub const AUDIO_DATAGRAMS_PER_PUMP: usize = 64;
/// Ring for complete access units; a frame larger than this is dropped.
pub const FRAME_BYTES: usize = 8 << 20;
/// Sunshine starts video right after the first ping; nothing by then fails the stream.
pub const FIRST_VIDEO_TIMEOUT_MS: u64 = 10_000;
const MAX_OPUS_SAMPLES: usize = 5760;

pub type DirectMedia<'a, S, D, U, E, O> = Media<'a, S, D, DirectVideo<U, E>, DirectAudio<U, O>>;
pub type Opened<'a, S, D, U, E, O> = Result<DirectMedia<'a, S, D, U, E, O>, (Failure, Closed<D>)>;

/// Decodes one Opus packet into interleaved 16-bit PCM; samples per channel, None on failure.
pub trait OpusDecoder {
    fn decode(&mut self, packet: &[u8], pcm: &mut [i16]) -> Option<usize>;
}

/// Video events onto the control stream: a keyframe request is REQUEST_IDR on the urgent
/// channel, as moonlight-common-c sends it to hosts that support it.
pub struct ControlEvents<C: ControlSender> {
    pub control: C,
    pub unsent: u64,
}

impl<C: ControlSender> ControlEvents<C> {
    pub fn new(control: C) -> Self {
        Self { control, unsent: 0 }
    }
}

impl<C: ControlSender> video::Events for ControlEvents<C> {
    fn request_idr(&mut self) {
        let sent = self.control.send(
            kind::REQUEST_IDR,
            channel::URGENT,
            Delivery::Reliable,
            &[0, 0],
        );
        self.unsent += u64::from(sent.is_err());
    }
}

fn send_ping<U: Datagram>(socket: &mut U, ping: &mut Ping, now_us: u64) -> Result<(), IoError> {
    let mut datagram = [0; 20];
    let Some(length) = ping.poll(now_us, &mut datagram) else {
        return Ok(());
    };
    match socket.send(&datagram[..length]) {
        Err(error) if !error.is_retry() => Err(error),
        _ => Ok(()),
    }
}

fn connected<U: Datagram>(
    socket: &mut U,
    done: &mut bool,
    stream: Stream,
) -> Result<bool, Failure> {
    if !*done {
        *done = socket
            .poll_connect()
            .map_err(|error| Failure::Connect(stream, error))?;
    }
    Ok(*done)
}

pub struct DirectVideo<U: Datagram, E: video::Events> {
    socket: U,
    receiver: video::Receiver,
    ping: Ping,
    events: E,
    connected: bool,
    opened_ms: u64,
    draining: bool,
}

impl<U: Datagram, E: video::Events> DirectVideo<U, E> {
    pub fn new(
        socket: U,
        stream: &Negotiated,
        events: E,
        now_ms: u64,
    ) -> Result<Self, (Failure, U)> {
        match video::Receiver::new(session::video_config(stream, FRAME_BYTES)) {
            Ok(receiver) => Ok(Self {
                socket,
                receiver,
                ping: Ping::new(stream.video_ping),
                events,
                connected: false,
                opened_ms: now_ms,
                draining: false,
            }),
            Err(_) => Err((Failure::Invalid, socket)),
        }
    }

    pub fn stats(&self) -> video::Stats {
        self.receiver.stats()
    }

    pub fn events(&mut self) -> &mut E {
        &mut self.events
    }

    fn now_us(&self, now_ms: u64) -> u64 {
        self.socket.now_us().unwrap_or(now_ms.saturating_mul(1000))
    }
}

impl<U: Datagram, E: video::Events> VideoChannel for DirectVideo<U, E> {
    fn pump_video(&mut self, now_ms: u64) -> Result<(), Failure> {
        if !connected(&mut self.socket, &mut self.connected, Stream::Video)? {
            return Ok(());
        }
        let now_us = self.now_us(now_ms);
        send_ping(&mut self.socket, &mut self.ping, now_us)
            .map_err(|e| Failure::Udp(udp::Error::Io(e)))?;
        for _ in 0..VIDEO_DATAGRAMS_PER_PUMP {
            match self.socket.recv(self.receiver.buffer()) {
                Ok(length) => self.receiver.commit(length, now_us, &mut self.events),
                Err(error) if error.is_retry() => break,
                Err(error) => return Err(Failure::Udp(udp::Error::Io(error))),
            }
        }
        let silent = self.receiver.stats().packets == 0;
        if silent && now_ms.saturating_sub(self.opened_ms) >= FIRST_VIDEO_TIMEOUT_MS {
            return Err(Failure::Udp(udp::Error::ConnectTimeout));
        }
        Ok(())
    }

    fn video_record(&self) -> Option<Record<'_>> {
        self.receiver.peek().map(|frame| {
            let header = Header {
                payload_bytes: frame.data.len() as u32,
                sequence: frame.number,
                pts_us: frame.pts_us,
            };
            Record {
                header,
                raw_header: header.encode(),
                payload: frame.data,
            }
        })
    }

    fn local_arrival_us(&self) -> Option<u64> {
        self.receiver.peek().map(|frame| frame.received_us)
    }

    fn accept_video(&mut self) -> Result<(), Failure> {
        self.receiver.release();
        Ok(())
    }

    fn acknowledge_video(
        &mut self,
        _header: &[u8; HEADER_BYTES],
        _input: &[u8],
    ) -> Result<bool, Failure> {
        Ok(true)
    }

    fn video_drained(&self) -> bool {
        self.draining && self.receiver.ready() == 0
    }

    fn close_video(mut self) -> bool {
        self.socket.close().is_err()
    }

    fn begin_video_drain(&mut self) {
        self.draining = true;
    }
}

pub struct DirectAudio<U: Datagram, O: OpusDecoder> {
    socket: U,
    receiver: audio::Receiver,
    ping: Ping,
    decoder: O,
    channels: usize,
    frame_samples: usize,
    packet: Vec<u8>,
    decoded: Vec<i16>,
    decoded_at: usize,
    decoded_len: usize,
    chunk: Vec<u8>,
    filled: usize,
    ready: bool,
    sequence: u32,
    timestamp_ms: u32,
    connected: bool,
    draining: bool,
    decode_failures: u64,
}

impl<U: Datagram, O: OpusDecoder> DirectAudio<U, O> {
    /// Stereo only, the audio device's layout; other layouts return the socket.
    pub fn new(socket: U, stream: &Negotiated, decoder: O) -> Result<Self, (Failure, U)> {
        let receiver = match audio::Receiver::new(session::audio_config(stream)) {
            Ok(receiver) if stream.audio.channels == 2 => receiver,
            _ => return Err((Failure::Invalid, socket)),
        };
        let channels = usize::from(stream.audio.channels);
        Ok(Self {
            socket,
            receiver,
            ping: Ping::new(stream.audio_ping),
            decoder,
            channels,
            frame_samples: session::audio_frame_samples(stream),
            packet: vec![0; audio::MAX_PAYLOAD],
            decoded: vec![0; MAX_OPUS_SAMPLES * channels],
            decoded_at: 0,
            decoded_len: 0,
            chunk: vec![0; AUDIO_CHUNK_BYTES as usize],
            filled: 0,
            ready: false,
            sequence: 0,
            timestamp_ms: 0,
            connected: false,
            draining: false,
            decode_failures: 0,
        })
    }

    pub fn stats(&self) -> audio::Stats {
        self.receiver.stats()
    }

    pub fn decode_failures(&self) -> u64 {
        self.decode_failures
    }

    fn fill(&mut self, now_us: u64) {
        while !self.ready {
            if self.decoded_at < self.decoded_len {
                let space = (self.chunk.len() - self.filled) / 2;
                let take = space.min(self.decoded_len - self.decoded_at);
                let samples = &self.decoded[self.decoded_at..self.decoded_at + take];
                let out = &mut self.chunk[self.filled..self.filled + take * 2];
                for (bytes, sample) in out.as_chunks_mut::<2>().0.iter_mut().zip(samples) {
                    *bytes = sample.to_le_bytes();
                }
                self.decoded_at += take;
                self.filled += take * 2;
                self.ready = self.filled == self.chunk.len();
                continue;
            }
            let silence = self.frame_samples * self.channels;
            let samples = match self.receiver.next(now_us, &mut self.packet) {
                None => return,
                Some(audio::Packet::Opus {
                    length, timestamp, ..
                }) => {
                    if self.filled == 0 {
                        self.timestamp_ms = timestamp;
                    }
                    match self
                        .decoder
                        .decode(&self.packet[..length], &mut self.decoded)
                    {
                        Some(per_channel) => (per_channel * self.channels).min(self.decoded.len()),
                        None => {
                            self.decode_failures += 1;
                            self.decoded[..silence].fill(0);
                            silence
                        }
                    }
                }
                Some(audio::Packet::Lost { .. }) => {
                    self.decoded[..silence].fill(0);
                    silence
                }
            };
            self.decoded_at = 0;
            self.decoded_len = samples;
        }
    }
}

impl<U: Datagram, O: OpusDecoder> PcmChannel for DirectAudio<U, O> {
    fn pump_pcm(&mut self, now_ms: u64) -> Result<(), Failure> {
        if !connected(&mut self.socket, &mut self.connected, Stream::Audio)? {
            return Ok(());
        }
        let now_us = self.socket.now_us().unwrap_or(now_ms.saturating_mul(1000));
        send_ping(&mut self.socket, &mut self.ping, now_us)
            .map_err(|e| Failure::Udp(udp::Error::Io(e)))?;
        for _ in 0..AUDIO_DATAGRAMS_PER_PUMP {
            match self.socket.recv(self.receiver.buffer()) {
                Ok(length) => self.receiver.commit(length, now_us),
                Err(error) if error.is_retry() => break,
                Err(error) => return Err(Failure::Udp(udp::Error::Io(error))),
            }
        }
        self.fill(now_us);
        Ok(())
    }

    fn pcm_record(&self) -> Option<Record<'_>> {
        self.ready.then(|| {
            let header = Header {
                payload_bytes: self.chunk.len() as u32,
                sequence: self.sequence,
                pts_us: u64::from(self.timestamp_ms) * 1000,
            };
            Record {
                header,
                raw_header: header.encode(),
                payload: &self.chunk,
            }
        })
    }

    fn consume_pcm(&mut self) -> Result<(), Failure> {
        self.ready = false;
        self.filled = 0;
        self.sequence = self.sequence.wrapping_add(1);
        Ok(())
    }

    fn acknowledge_pcm(&mut self, _header: &[u8; HEADER_BYTES]) -> Result<bool, Failure> {
        Ok(true)
    }

    fn pcm_drained(&self) -> bool {
        self.draining && !self.ready
    }

    fn close_pcm(mut self) -> bool {
        self.socket.close().is_err()
    }

    fn begin_pcm_drain(&mut self) {
        self.draining = true;
    }
}

/// Opens video and, when a decoder and device are given, audio. Audio that cannot open
/// leaves the stream silent rather than failing it.
pub fn open<'a, C, D, E, O>(
    connector: &mut C,
    stream: &Negotiated,
    events: E,
    decoder: Option<O>,
    audio: Option<(D, &'static mut Slots)>,
    now_ms: u64,
) -> Opened<'a, C::Socket, D, C::Datagram, E, O>
where
    C: UdpConnector,
    C::Socket: Socket + 'a,
    D: Device,
    E: video::Events,
    O: OpusDecoder,
{
    let closed = |audio| Closed {
        retained: false,
        audio,
        outcome: crate::media::Outcome::Aborted,
    };
    let socket = match connector.connect_datagram(stream.video_port) {
        Ok(socket) => socket,
        Err(error) => return Err((Failure::Connect(Stream::Video, error), closed(audio))),
    };
    let video = match DirectVideo::new(socket, stream, events, now_ms) {
        Ok(video) => video,
        Err((failure, mut socket)) => {
            let retained = socket.close().is_err();
            let mut closed = closed(audio);
            closed.retained = retained;
            return Err((failure, closed));
        }
    };
    let pcm = match (decoder, audio.is_some()) {
        (Some(decoder), true) => {
            connector
                .connect_datagram(stream.audio_port)
                .ok()
                .and_then(|socket| match DirectAudio::new(socket, stream, decoder) {
                    Ok(pcm) => Some(pcm),
                    Err((_, mut socket)) => {
                        let _ = socket.close();
                        None
                    }
                })
        }
        _ => None,
    };
    Media::with_channels(video, pcm, audio, AUDIO_CHUNK_BYTES as usize)
}
