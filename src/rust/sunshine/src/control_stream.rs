//! The stream's control channel: ENet to the control port, every message sealed with
//! AES-128-GCM under the stream key. It starts the stream, reports loss, asks for IDR frames
//! and turns the host's messages into `HostEvent`s.

use alloc::vec::Vec;

use aes_gcm::{
    Aes128Gcm, KeyInit, Nonce, Tag,
    aead::AeadInOut,
};

use crate::{
    control::{ControlSender, Delivery, HostEvent, HostEvents, SendError, channel, kind},
    enet::{self, End, Peer},
    stream::Negotiated,
};

pub const LOSS_INTERVAL_MS: u64 = 50;
const TAG_BYTES: usize = 16;
const WRAPPER_BYTES: usize = 8;
const INNER_BYTES: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Connecting,
    Streaming,
    /// The host ended it with this reason, or the channel closed (`None`).
    Ended(Option<u32>),
}

pub struct ControlStream {
    peer: Peer,
    cipher: Aes128Gcm,
    sequence: u32,
    started: bool,
    terminated: Option<u32>,
    lost: u32,
    last_good_frame: u64,
    next_loss_ms: u64,
    rejected: u32,
}

fn nonce(sequence: u32, origin: u8) -> [u8; 12] {
    let mut iv = [0; 12];
    iv[..4].copy_from_slice(&sequence.to_le_bytes());
    iv[10] = origin;
    iv[11] = b'C';
    iv
}

fn le16(bytes: &[u8], at: usize) -> u16 {
    bytes
        .get(at..at + 2)
        .map_or(0, |pair| u16::from_le_bytes([pair[0], pair[1]]))
}

/// Seals one message the way Sunshine opens it: wrapper, tag, then ciphertext.
pub fn seal(cipher: &Aes128Gcm, sequence: u32, origin: u8, message: u16, payload: &[u8]) -> Option<Vec<u8>> {
    let length = u16::try_from(4 + TAG_BYTES + INNER_BYTES + payload.len()).ok()?;
    let mut packet = Vec::with_capacity(WRAPPER_BYTES + TAG_BYTES + INNER_BYTES + payload.len());
    packet.extend_from_slice(&kind::ENCRYPTED.to_le_bytes());
    packet.extend_from_slice(&length.to_le_bytes());
    packet.extend_from_slice(&sequence.to_le_bytes());
    packet.extend_from_slice(&[0; TAG_BYTES]);
    let start = packet.len();
    packet.extend_from_slice(&message.to_le_bytes());
    packet.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    packet.extend_from_slice(payload);
    let iv = nonce(sequence, origin);
    let tag = cipher
        .encrypt_inout_detached(&Nonce::from(iv), &[], (&mut packet[start..]).into())
        .ok()?;
    packet[WRAPPER_BYTES..start].copy_from_slice(&tag);
    Some(packet)
}

/// Opens one sealed message: its type and payload.
pub fn open(cipher: &Aes128Gcm, origin: u8, packet: &[u8]) -> Option<(u16, Vec<u8>)> {
    if packet.len() < WRAPPER_BYTES + TAG_BYTES + INNER_BYTES || le16(packet, 0) != kind::ENCRYPTED {
        return None;
    }
    let length = usize::from(le16(packet, 2));
    if length + 4 != packet.len() {
        return None;
    }
    let sequence = u32::from_le_bytes(packet[4..8].try_into().ok()?);
    let tag = Tag::try_from(&packet[WRAPPER_BYTES..WRAPPER_BYTES + TAG_BYTES]).ok()?;
    let mut plain = packet[WRAPPER_BYTES + TAG_BYTES..].to_vec();
    let iv = nonce(sequence, origin);
    cipher
        .decrypt_inout_detached(&Nonce::from(iv), &[], (&mut plain[..]).into(), &tag)
        .ok()?;
    let message = le16(&plain, 0);
    let size = usize::from(le16(&plain, 2));
    let payload = plain.get(INNER_BYTES..INNER_BYTES + size)?.to_vec();
    Some((message, payload))
}

impl ControlStream {
    pub fn new(stream: &Negotiated, connect_id: u32, now_ms: u64) -> Self {
        Self {
            peer: Peer::connect(connect_id, stream.control_connect, channel::COUNT, now_ms),
            cipher: Aes128Gcm::new(&stream.key.key.into()),
            sequence: 0,
            started: false,
            terminated: None,
            lost: 0,
            last_good_frame: 0,
            next_loss_ms: 0,
            rejected: 0,
        }
    }

    pub fn state(&self) -> State {
        if let Some(reason) = self.terminated {
            return State::Ended(Some(reason));
        }
        match self.peer.state() {
            enet::State::Connecting => State::Connecting,
            enet::State::Connected => State::Streaming,
            enet::State::Closed(End::Host(_)) => State::Ended(Some(0)),
            _ => State::Ended(None),
        }
    }

    /// Whether the start messages went out, so other messages may follow them.
    pub fn started(&self) -> bool {
        self.started && self.state() == State::Streaming
    }

    pub fn rtt_ms(&self) -> u64 {
        self.peer.rtt_ms()
    }

    /// Messages that failed to decrypt or parse.
    pub fn rejected(&self) -> u32 {
        self.rejected
    }

    /// Takes a datagram from the control port and reports what the host asked for.
    pub fn input(&mut self, datagram: &[u8], now_ms: u64, events: &mut impl HostEvents) {
        self.peer.input(datagram, now_ms);
        while let Some((_, packet)) = self.peer.receive() {
            match open(&self.cipher, b'H', &packet) {
                Some((message, payload)) => self.host_message(message, &payload, events),
                None => self.rejected += 1,
            }
        }
    }

    fn host_message(&mut self, message: u16, payload: &[u8], events: &mut impl HostEvents) {
        let at = |offset| le16(payload, offset);
        let event = match message {
            kind::TERMINATION => {
                let reason = match payload.len() {
                    4.. => u32::from_be_bytes([payload[0], payload[1], payload[2], payload[3]]),
                    2 => u32::from(at(0)),
                    _ => 0,
                };
                self.terminated = Some(reason);
                HostEvent::Terminated { reason }
            }
            kind::RUMBLE if payload.len() >= 10 => HostEvent::Rumble {
                controller: at(4),
                low: at(6),
                high: at(8),
            },
            kind::RUMBLE_TRIGGERS if payload.len() >= 6 => HostEvent::TriggerRumble {
                controller: at(0),
                left: at(2),
                right: at(4),
            },
            kind::SET_MOTION_EVENT if payload.len() >= 5 => HostEvent::Motion {
                controller: at(0),
                rate_hz: at(2),
                kind: payload[4],
            },
            kind::SET_RGB_LED if payload.len() >= 5 => HostEvent::Led {
                controller: at(0),
                red: payload[2],
                green: payload[3],
                blue: payload[4],
            },
            kind::HDR_MODE if !payload.is_empty() => HostEvent::Hdr(payload[0] != 0),
            _ => return,
        };
        events.event(event);
    }

    /// Counts frames lost since the last report and the newest whole frame.
    pub fn report_loss(&mut self, lost: u32, last_good_frame: u64) {
        self.lost = self.lost.saturating_add(lost);
        self.last_good_frame = self.last_good_frame.max(last_good_frame);
    }

    pub fn request_idr(&mut self, now_ms: u64) -> Result<(), SendError> {
        self.send_at(kind::REQUEST_IDR, channel::URGENT, Delivery::Reliable, &[0, 0], now_ms)
    }

    pub fn disconnect(&mut self, now_ms: u64) {
        self.peer.disconnect(now_ms);
    }

    /// The next datagram for the control port; call until none.
    pub fn output(&mut self, now_ms: u64) -> Option<Vec<u8>> {
        if self.peer.state() == enet::State::Connected && self.terminated.is_none() {
            if !self.started {
                self.started = true;
                let _ = self.send_at(kind::REQUEST_IDR, channel::GENERIC, Delivery::Reliable, &[0, 0], now_ms);
                let _ = self.send_at(kind::START_B, channel::GENERIC, Delivery::Reliable, &[0], now_ms);
                self.next_loss_ms = now_ms + LOSS_INTERVAL_MS;
            } else if now_ms >= self.next_loss_ms {
                self.next_loss_ms = now_ms + LOSS_INTERVAL_MS;
                let stats = self.loss_payload();
                if self.send_at(kind::LOSS_STATS, channel::GENERIC, Delivery::Unreliable, &stats, now_ms).is_ok() {
                    self.lost = 0;
                }
            }
        }
        self.peer.output(now_ms)
    }

    fn loss_payload(&self) -> [u8; 32] {
        let mut payload = [0; 32];
        payload[0..4].copy_from_slice(&self.lost.to_le_bytes());
        payload[4..8].copy_from_slice(&(LOSS_INTERVAL_MS as u32).to_le_bytes());
        payload[8..12].copy_from_slice(&1000u32.to_le_bytes());
        payload[12..20].copy_from_slice(&self.last_good_frame.to_le_bytes());
        payload[28..32].copy_from_slice(&0x14u32.to_le_bytes());
        payload
    }

    fn send_at(
        &mut self,
        message: u16,
        channel: u8,
        delivery: Delivery,
        payload: &[u8],
        now_ms: u64,
    ) -> Result<(), SendError> {
        if self.terminated.is_some() {
            return Err(SendError::Closed);
        }
        let packet = seal(&self.cipher, self.sequence, b'C', message, payload).ok_or(SendError::TooLarge)?;
        let sent = match delivery {
            Delivery::Reliable => self.peer.send_reliable(channel, &packet, now_ms),
            Delivery::Unreliable => self.peer.send_unsequenced(channel, &packet),
        };
        sent.map_err(|error| match error {
            enet::Error::Closed => SendError::Closed,
            enet::Error::Full => SendError::Full,
            enet::Error::TooLarge => SendError::TooLarge,
        })?;
        self.sequence = self.sequence.wrapping_add(1);
        Ok(())
    }
}

/// Input sends through the channel with the clock of its last `output` call.
pub struct Sender<'a> {
    pub stream: &'a mut ControlStream,
    pub now_ms: u64,
}

impl ControlSender for Sender<'_> {
    fn send(&mut self, message: u16, channel: u8, delivery: Delivery, payload: &[u8]) -> Result<(), SendError> {
        self.stream.send_at(message, channel, delivery, payload, self.now_ms)
    }
}
