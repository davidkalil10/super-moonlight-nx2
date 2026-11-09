//! Bounded transport check against an independent fixture: one control request, the known
//! video and PCM records from src/native/media/diag/pattern.h, ordered acknowledgements and,
//! in audio mode, at most 3 s of quiet PCM. One attempt, no reconnect, 10 s overall.
//! Wire contract: moonlight-nx2-dev/src/rust/io/README.md, "Diagnostic".

use crate::audio::{self, Device, Output, Retained, Slots};
use crate::control;
use crate::media::{self, Ack};
use crate::socket::{IoError, Socket, wipe};
use core::fmt::{self, Write};
use moonlight_nx2_core::control::{AUTH_BYTES, MAX_PAYLOAD};
use moonlight_nx2_core::media::{Error as MediaError, HEADER_BYTES, Record, TOKEN_BYTES};

pub const DEADLINE_MS: u64 = 10_000;
pub const CONTROL_PROBE: &[u8] = br#"{"op":"diag","version":1}"#;
pub const CONTROL_REPLY: &[u8] = br#"{"diag":"ok"}"#;

pub const VIDEO_LENGTHS: [u32; 16] = [
    1, 16, 1460, 1461, 4096, 65536, 65537, 200_000, 1_048_576, 3000, 7, 524_288, 1_048_575, 100,
    32768, 999_999,
];
pub const VIDEO_PTS_STEP: u64 = 16_667;
pub const VIDEO_MEMORY: usize = 1 << 20;
pub const PCM_CHUNKS: u32 = 300;
pub const PCM_CHUNK_BYTES: usize = 1920;
pub const PCM_FRAMES_PER_CHUNK: u32 = 480;
pub const PCM_PTS_STEP: u64 = 10_000;
pub const PCM_PERIOD: u32 = 108;
pub const OUTBOUND_BYTES: usize = 8192;
pub const CONTROL_OUTBOUND_BYTES: usize = 4096;
const READ_BUDGET: usize = 64 * 1024;

pub fn video_byte(sequence: u32, index: u32) -> u8 {
    sequence
        .wrapping_mul(131)
        .wrapping_add(index.wrapping_mul(7))
        .wrapping_add(index >> 8) as u8
}

pub fn pcm_sample(frame: u32, channel: u32) -> i16 {
    let phase = frame % PCM_PERIOD;
    let ramp = if phase < PCM_PERIOD / 2 {
        phase as i32
    } else {
        (PCM_PERIOD - phase) as i32
    };
    let sample = (ramp - PCM_PERIOD as i32 / 4) * 3;
    if channel == 0 {
        sample as i16
    } else {
        -sample as i16
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Sockets,
    Audio,
}

/// The one-time session file: `key=value` lines. Tokens are wiped on drop and never printed.
pub struct Session {
    pub address: [u8; 4],
    pub control_port: u16,
    pub video_port: u16,
    pub audio_port: u16,
    pub control_token: [u8; AUTH_BYTES],
    pub video_token: [u8; TOKEN_BYTES],
    pub audio_token: [u8; TOKEN_BYTES],
    pub mode: Mode,
}

impl Drop for Session {
    fn drop(&mut self) {
        wipe(&mut self.control_token);
        wipe(&mut self.video_token);
        wipe(&mut self.audio_token);
    }
}

fn parse_address(value: &[u8]) -> Option<[u8; 4]> {
    let mut address = [0u8; 4];
    let mut parts = value.split(|byte| *byte == b'.');
    for octet in &mut address {
        *octet = parse_number(parts.next()?)?.try_into().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    Some(address)
}

fn parse_number(value: &[u8]) -> Option<u32> {
    if value.is_empty() || value.len() > 5 || !value.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        value
            .iter()
            .fold(0, |sum, digit| sum * 10 + u32::from(digit - b'0')),
    )
}

fn parse_port(value: &[u8]) -> Option<u16> {
    parse_number(value)?
        .try_into()
        .ok()
        .filter(|port| *port != 0)
}

fn parse_token(value: &[u8], token: &mut [u8; 64]) -> Option<()> {
    let hex = |byte: &u8| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte);
    if value.len() != token.len() || !value.iter().all(hex) {
        return None;
    }
    token.copy_from_slice(value);
    Some(())
}

impl Session {
    /// Every key exactly once; anything else is refused without echoing the input.
    pub fn parse(text: &[u8]) -> Option<Self> {
        let mut session = Session {
            address: [0; 4],
            control_port: 0,
            video_port: 0,
            audio_port: 0,
            control_token: [0; AUTH_BYTES],
            video_token: [0; TOKEN_BYTES],
            audio_token: [0; TOKEN_BYTES],
            mode: Mode::Sockets,
        };
        let mut seen = 0u8;

        for line in text.split(|byte| *byte == b'\n') {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.is_empty() {
                continue;
            }
            let split = line.iter().position(|byte| *byte == b'=')?;
            let (key, value) = (&line[..split], &line[split + 1..]);
            let bit = match key {
                b"address" => {
                    session.address = parse_address(value)?;
                    0
                }
                b"control" => {
                    session.control_port = parse_port(value)?;
                    1
                }
                b"video" => {
                    session.video_port = parse_port(value)?;
                    2
                }
                b"audio" => {
                    session.audio_port = parse_port(value)?;
                    3
                }
                b"control_token" => {
                    parse_token(value, &mut session.control_token)?;
                    4
                }
                b"video_token" => {
                    parse_token(value, &mut session.video_token)?;
                    5
                }
                b"audio_token" => {
                    parse_token(value, &mut session.audio_token)?;
                    6
                }
                b"mode" => {
                    session.mode = match value {
                        b"sockets" => Mode::Sockets,
                        b"audio" => Mode::Audio,
                        _ => return None,
                    };
                    7
                }
                _ => return None,
            };
            if seen & (1 << bit) != 0 {
                return None;
            }
            seen |= 1 << bit;
        }

        (seen == u8::MAX).then_some(session)
    }
}

/// What the runner needs from its host: a monotonic clock, a connect that starts a
/// nonblocking connection, and a short yield when a pass made no progress.
pub trait Env {
    type Socket: Socket;
    fn now_ms(&mut self) -> u64;
    fn connect(&mut self, address: [u8; 4], port: u16) -> Result<Self::Socket, IoError>;
    fn idle(&mut self);
}

/// Caller storage: control 64 KiB, video 1 MiB, PCM one chunk, plus outbound queues.
pub struct Memory<'a> {
    pub control: &'a mut [u8],
    pub control_outbound: &'a mut [u8],
    pub video: &'a mut [u8],
    pub video_outbound: &'a mut [u8],
    pub pcm: &'a mut [u8],
    pub pcm_outbound: &'a mut [u8],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stream {
    Control,
    Video,
    Pcm,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Field {
    Sequence,
    Pts,
    Length,
    Payload,
    Extra,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    Configuration,
    Connect(Stream, IoError),
    Control(control::Error),
    ControlReply,
    Media(Stream, MediaError),
    Mismatch(Stream, u32, Field),
    AudioOpen(audio::Error),
    Playback(audio::Error),
    Deadline,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Retention {
    #[default]
    Unused,
    Returned,
    Kept,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Report {
    pub mode: Option<Mode>,
    pub failure: Option<Failure>,
    pub control_reply: bool,
    pub video_records: u32,
    pub pcm_records: u32,
    pub control_stats: control::Stats,
    pub video_stats: media::Stats,
    pub pcm_stats: media::Stats,
    pub audio_stats: Option<audio::Stats>,
    pub control_close: Option<control::Error>,
    pub video_close: Option<MediaError>,
    pub pcm_close: Option<MediaError>,
    pub audio_close: Option<audio::Error>,
    pub retention: Retention,
    pub elapsed_ms: u64,
}

impl Report {
    pub fn passed(&self) -> bool {
        let transfers = self.control_reply
            && self.video_records == VIDEO_LENGTHS.len() as u32
            && self.pcm_records == PCM_CHUNKS;
        let closes = self.control_close.is_none()
            && self.video_close.is_none()
            && self.pcm_close.is_none()
            && self.audio_close.is_none();
        let audio_ok = match self.mode {
            Some(Mode::Audio) => self.retention == Retention::Returned,
            _ => self.retention == Retention::Unused,
        };
        self.failure.is_none() && transfers && closes && audio_ok
    }

    /// `key=value` lines for the runtime log. Contains no token or payload byte.
    pub fn write(&self, out: &mut impl Write) -> fmt::Result {
        let verdict = if self.passed() { "pass" } else { "fail" };
        writeln!(out, "diag.verdict={verdict}")?;
        writeln!(out, "diag.mode={:?}", self.mode)?;
        writeln!(out, "diag.failure={:?}", self.failure)?;
        writeln!(out, "diag.elapsed_ms={}", self.elapsed_ms)?;
        writeln!(out, "diag.control_reply={}", self.control_reply)?;
        writeln!(out, "diag.video_records={}", self.video_records)?;
        writeln!(out, "diag.pcm_records={}", self.pcm_records)?;
        writeln!(out, "diag.control={:?}", self.control_stats)?;
        writeln!(out, "diag.video={:?}", self.video_stats)?;
        writeln!(out, "diag.pcm={:?}", self.pcm_stats)?;
        writeln!(out, "diag.audio={:?}", self.audio_stats)?;
        writeln!(
            out,
            "diag.close control={:?} video={:?} pcm={:?} audio={:?} retention={:?}",
            self.control_close, self.video_close, self.pcm_close, self.audio_close, self.retention
        )
    }
}

fn check_video(record: &Record<'_>, sequence: u32) -> Result<(), Field> {
    let Some(&length) = VIDEO_LENGTHS.get(sequence as usize) else {
        return Err(Field::Extra);
    };
    if record.header.sequence != sequence {
        return Err(Field::Sequence);
    }
    if record.header.pts_us != u64::from(sequence) * VIDEO_PTS_STEP {
        return Err(Field::Pts);
    }
    if record.payload.len() != length as usize {
        return Err(Field::Length);
    }
    let exact = record
        .payload
        .iter()
        .enumerate()
        .all(|(index, byte)| *byte == video_byte(sequence, index as u32));
    if exact { Ok(()) } else { Err(Field::Payload) }
}

fn check_pcm(record: &Record<'_>, sequence: u32) -> Result<(), Field> {
    if sequence >= PCM_CHUNKS {
        return Err(Field::Extra);
    }
    if record.header.sequence != sequence {
        return Err(Field::Sequence);
    }
    if record.header.pts_us != u64::from(sequence) * PCM_PTS_STEP {
        return Err(Field::Pts);
    }
    if record.payload.len() != PCM_CHUNK_BYTES {
        return Err(Field::Length);
    }
    let first = sequence * PCM_FRAMES_PER_CHUNK;
    let (samples, _) = record.payload.as_chunks::<2>();
    let exact = samples.iter().enumerate().all(|(index, bytes)| {
        let frame = first + index as u32 / 2;
        *bytes == pcm_sample(frame, index as u32 % 2).to_le_bytes()
    });
    if exact { Ok(()) } else { Err(Field::Payload) }
}

struct Run<'a, S: Socket, D: Device> {
    control: Option<control::Channel<'a, S>>,
    video: Option<media::Channel<'a, S>>,
    pcm: Option<media::Channel<'a, S>>,
    output: Option<Output<D>>,
    requested: bool,
    video_held: Option<[u8; HEADER_BYTES]>,
    pcm_held: Option<[u8; HEADER_BYTES]>,
    report: Report,
}

impl<'a, S: Socket, D: Device> Run<'a, S, D> {
    fn step_control(&mut self) -> Result<bool, Failure> {
        let Some(channel) = self.control.as_mut() else {
            return Ok(false);
        };
        let mut progress = false;
        if !self.requested && channel.state() == control::State::Ready {
            match channel.request(CONTROL_PROBE) {
                Ok(_) => {
                    self.requested = true;
                    progress = true;
                }
                Err(control::Error::Again) => {}
                Err(error) => return Err(Failure::Control(error)),
            }
        }

        if let Some(frame) = channel.peek() {
            let reply = frame.header.request_id == 1 && frame.payload == CONTROL_REPLY;
            if !reply || self.report.control_reply {
                return Err(Failure::ControlReply);
            }
            channel.consume().map_err(Failure::Control)?;
            self.report.control_reply = true;
            progress = true;
        }
        Ok(progress)
    }

    fn step_video(&mut self) -> Result<bool, Failure> {
        let Some(channel) = self.video.as_mut() else {
            return Ok(false);
        };
        if let Some(header) = self.video_held {
            match channel.acknowledge(&header, &[]) {
                Ok(()) => self.video_held = None,
                Err(MediaError::Again) => return Ok(false),
                Err(error) => return Err(Failure::Media(Stream::Video, error)),
            }
        }

        let sequence = self.report.video_records;
        let Some(record) = channel.peek() else {
            return Ok(false);
        };
        check_video(&record, sequence)
            .map_err(|f| Failure::Mismatch(Stream::Video, sequence, f))?;
        let header = record.raw_header;
        channel
            .consume()
            .map_err(|error| Failure::Media(Stream::Video, error))?;
        self.report.video_records += 1;
        match channel.acknowledge(&header, &[]) {
            Ok(()) => {}
            Err(MediaError::Again) => self.video_held = Some(header),
            Err(error) => return Err(Failure::Media(Stream::Video, error)),
        }
        Ok(true)
    }

    fn acknowledge_pcm(&mut self) -> Result<bool, Failure> {
        let Some(channel) = self.pcm.as_mut() else {
            return Ok(false);
        };
        let mut progress = false;
        loop {
            let header = match self.pcm_held.take() {
                Some(header) => header,
                None => match self.output.as_mut().and_then(Output::take_acknowledgement) {
                    Some(header) => header,
                    None => return Ok(progress),
                },
            };
            match channel.acknowledge(&header, &[]) {
                Ok(()) => progress = true,
                Err(MediaError::Again) => {
                    self.pcm_held = Some(header);
                    return Ok(progress);
                }
                Err(error) => return Err(Failure::Media(Stream::Pcm, error)),
            }
        }
    }

    fn step_pcm(&mut self, now_ms: u64) -> Result<bool, Failure> {
        let mut progress = self.acknowledge_pcm()?;
        if self.pcm_held.is_some() {
            return Ok(progress);
        }
        let Some(channel) = self.pcm.as_mut() else {
            return Ok(progress);
        };

        let sequence = self.report.pcm_records;
        if let Some(record) = channel.peek() {
            check_pcm(&record, sequence)
                .map_err(|f| Failure::Mismatch(Stream::Pcm, sequence, f))?;
            let header = record.raw_header;
            let queued = match self.output.as_mut() {
                Some(output) => match output.push(&header, record.payload) {
                    Ok(()) => true,
                    Err(audio::Error::Again) => false,
                    Err(error) => return Err(Failure::Playback(error)),
                },
                None => {
                    self.pcm_held = Some(header);
                    true
                }
            };
            if queued {
                channel
                    .consume()
                    .map_err(|error| Failure::Media(Stream::Pcm, error))?;
                self.report.pcm_records += 1;
                progress = true;
            }
        }

        if let Some(output) = self.output.as_mut() {
            output.pump(now_ms).map_err(Failure::Playback)?;
        }
        Ok(self.acknowledge_pcm()? || progress)
    }

    fn pump(&mut self, now_ms: u64) -> Result<bool, Failure> {
        if let Some(channel) = self.control.as_mut() {
            channel.pump(now_ms).map_err(Failure::Control)?;
        }
        if let Some(channel) = self.video.as_mut() {
            channel
                .pump(now_ms)
                .map_err(|error| Failure::Media(Stream::Video, error))?;
        }
        if let Some(channel) = self.pcm.as_mut() {
            channel
                .pump(now_ms)
                .map_err(|error| Failure::Media(Stream::Pcm, error))?;
        }

        let control = self.step_control()?;
        let video = self.step_video()?;
        let pcm = self.step_pcm(now_ms)?;
        Ok(control || video || pcm)
    }

    fn finished(&self) -> bool {
        let drained = |channel: &Option<media::Channel<'a, S>>| {
            channel.as_ref().is_some_and(|channel| {
                let stats = channel.stats();
                stats.pending_acks == 0 && stats.outbound_bytes == 0
            })
        };
        let records = self.report.control_reply
            && self.report.video_records == VIDEO_LENGTHS.len() as u32
            && self.report.pcm_records == PCM_CHUNKS;
        records && drained(&self.video) && drained(&self.pcm)
    }

    fn teardown(mut self) -> (Report, Option<Retained<D>>) {
        if let Some(channel) = self.control.take() {
            let result = channel.close();
            self.report.control_stats = result.unwrap_or_else(|(_, stats)| stats);
            self.report.control_close = result.err().map(|(error, _)| error);
        }
        (self.report.video_stats, self.report.video_close) = close_media(self.video.take());
        (self.report.pcm_stats, self.report.pcm_close) = close_media(self.pcm.take());

        let retained = self.output.take().map(|output| {
            self.report.audio_stats = Some(output.stats());
            let (result, retained) = output.close();
            self.report.audio_close = result.err();
            self.report.retention = retention(&retained);
            retained
        });
        (self.report, retained)
    }
}

fn close_media<S: Socket>(
    channel: Option<media::Channel<'_, S>>,
) -> (media::Stats, Option<MediaError>) {
    match channel.map(media::Channel::close) {
        None => (media::Stats::default(), None),
        Some(Ok(stats)) => (stats, None),
        Some(Err((error, stats))) => (stats, Some(error)),
    }
}

fn retention<D>(retained: &Retained<D>) -> Retention {
    match retained {
        Retained::Returned(..) => Retention::Returned,
        Retained::Kept => Retention::Kept,
    }
}

fn media_config<'a>(
    token: [u8; TOKEN_BYTES],
    memory: &'a mut [u8],
    outbound: &'a mut [u8],
    pcm: bool,
    timeout_ms: u64,
) -> media::Config<'a> {
    media::Config {
        token,
        memory,
        outbound,
        exact_bytes: pcm.then_some(PCM_CHUNK_BYTES),
        ack: if pcm { Ack::Header } else { Ack::Input },
        read_budget: READ_BUDGET,
        connect_timeout_ms: timeout_ms,
    }
}

/// Runs once and always tears down. `audio` is required in audio mode and must be absent in
/// sockets mode. A `Retained::Kept` result means the process must exit without reusing the
/// slots or opening audio again.
pub fn run<E: Env, D: Device>(
    env: &mut E,
    session: Session,
    memory: Memory<'_>,
    audio: Option<(D, &'static mut Slots)>,
) -> (Report, Option<Retained<D>>) {
    let start = env.now_ms();
    let mut run = Run {
        control: None,
        video: None,
        pcm: None,
        output: None,
        requested: false,
        video_held: None,
        pcm_held: None,
        report: Report {
            mode: Some(session.mode),
            ..Report::default()
        },
    };

    let opened = open(env, &session, memory, audio, start, &mut run);
    drop(session);
    let returned = match opened {
        Ok(()) => {
            run.report.failure = drive(env, start, &mut run).err();
            None
        }
        Err((failure, returned)) => {
            run.report.failure = Some(failure);
            returned
        }
    };

    let (mut report, retained) = run.teardown();
    report.elapsed_ms = env.now_ms().saturating_sub(start);
    match returned {
        Some(returned) => {
            report.retention = retention(&returned);
            (report, Some(returned))
        }
        None => (report, retained),
    }
}

type Opened<D> = Result<(), (Failure, Option<Retained<D>>)>;

fn open<'a, E: Env, D: Device>(
    env: &mut E,
    session: &Session,
    memory: Memory<'a>,
    audio: Option<(D, &'static mut Slots)>,
    start: u64,
    run: &mut Run<'a, E::Socket, D>,
) -> Opened<D> {
    let audio_ok = matches!(
        (session.mode, &audio),
        (Mode::Audio, Some(_)) | (Mode::Sockets, None)
    );
    let sizes_ok = memory.control.len() >= MAX_PAYLOAD
        && memory.control_outbound.len() >= CONTROL_OUTBOUND_BYTES
        && memory.video.len() >= VIDEO_MEMORY
        && memory.pcm.len() >= PCM_CHUNK_BYTES;
    if !audio_ok || !sizes_ok {
        let returned = audio.map(|(device, slots)| Retained::Returned(device, slots));
        return Err((Failure::Configuration, returned));
    }

    if let Some((device, slots)) = audio {
        match Output::open(audio::Config::default(), device, slots) {
            Ok(output) => run.output = Some(output),
            Err((error, retained)) => return Err((Failure::AudioOpen(error), Some(retained))),
        }
    }

    let timeout = DEADLINE_MS;
    let connect = |env: &mut E, port, stream| {
        env.connect(session.address, port)
            .map_err(|error| Failure::Connect(stream, error))
    };

    let socket = connect(env, session.control_port, Stream::Control).map_err(|f| (f, None))?;
    let config = control::Config {
        token: session.control_token,
        memory: memory.control,
        outbound: memory.control_outbound,
        read_budget: READ_BUDGET,
        connect_timeout_ms: timeout,
    };
    run.control = Some(control::Channel::open(config, socket, start).map_err(
        |(error, mut socket)| {
            let _ = socket.close();
            (Failure::Control(error), None)
        },
    )?);

    let streams = [
        (
            Stream::Video,
            session.video_port,
            session.video_token,
            memory.video,
            memory.video_outbound,
        ),
        (
            Stream::Pcm,
            session.audio_port,
            session.audio_token,
            memory.pcm,
            memory.pcm_outbound,
        ),
    ];
    for (stream, port, token, data, outbound) in streams {
        let socket = connect(env, port, stream).map_err(|f| (f, None))?;
        let config = media_config(token, data, outbound, stream == Stream::Pcm, timeout);
        let channel =
            media::Channel::open(config, socket, start).map_err(|(error, mut socket)| {
                let _ = socket.close();
                (Failure::Media(stream, error), None)
            })?;
        match stream {
            Stream::Video => run.video = Some(channel),
            _ => run.pcm = Some(channel),
        }
    }
    Ok(())
}

fn drive<E: Env, D: Device>(
    env: &mut E,
    start: u64,
    run: &mut Run<'_, E::Socket, D>,
) -> Result<(), Failure> {
    loop {
        let now = env.now_ms();
        if now.saturating_sub(start) >= DEADLINE_MS {
            return Err(Failure::Deadline);
        }
        let progress = run.pump(now)?;
        if run.finished() {
            return Ok(());
        }
        if !progress {
            env.idle();
        }
    }
}
