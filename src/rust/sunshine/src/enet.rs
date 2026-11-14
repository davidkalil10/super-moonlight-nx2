//! The part of ENet 1.3 Sunshine's control stream uses, as one client peer: connect, reliable
//! and unsequenced sends per channel, acknowledgements, pings and disconnect. No checksums,
//! compression or fragments, as Sunshine sets none up. Sans-IO: datagrams in and out.

use alloc::{collections::VecDeque, vec, vec::Vec};

const ACKNOWLEDGE: u8 = 1;
const CONNECT: u8 = 2;
const VERIFY_CONNECT: u8 = 3;
const DISCONNECT: u8 = 4;
const PING: u8 = 5;
const SEND_RELIABLE: u8 = 6;
const SEND_UNRELIABLE: u8 = 7;
const SEND_FRAGMENT: u8 = 8;
const SEND_UNSEQUENCED: u8 = 9;
const BANDWIDTH_LIMIT: u8 = 10;
const THROTTLE_CONFIGURE: u8 = 11;
const SEND_UNRELIABLE_FRAGMENT: u8 = 12;
const COMMAND_MASK: u8 = 0x0f;
const FLAG_ACKNOWLEDGE: u8 = 0x80;
const FLAG_UNSEQUENCED: u8 = 0x40;
const HEADER_SENT_TIME: u16 = 0x8000;
const HEADER_COMPRESSED: u16 = 0x4000;
const HEADER_SESSION_SHIFT: u16 = 12;
const MAXIMUM_PEER_ID: u16 = 0x0fff;
const PEER_CHANNEL: u8 = 0xff;

pub const MTU: usize = 1392;
const WINDOW_SIZE: u32 = 65536;
const THROTTLE_INTERVAL_MS: u32 = 5000;
const THROTTLE_STEP: u32 = 2;
const PING_INTERVAL_MS: u64 = 500;
const TIMEOUT_MS: u64 = 10_000;
const DISCONNECT_WAIT_MS: u64 = 1000;
const MIN_RTO_MS: u64 = 100;
const MAX_RTO_MS: u64 = 2000;
const MAX_PENDING: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Connecting,
    Connected,
    Disconnecting,
    /// Ended by us, by the host (with its disconnect data), or by silence.
    Closed(End),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Local,
    Host(u32),
    TimedOut,
    Refused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Closed,
    Full,
    TooLarge,
}

struct Pending {
    channel: u8,
    sequence: u16,
    command: Vec<u8>,
    first_ms: u64,
    sent_ms: u64,
    rto_ms: u64,
}

#[derive(Clone, Copy, Default)]
struct Channel {
    outgoing_reliable: u16,
    incoming_reliable: u16,
}

pub struct Peer {
    state: State,
    connect_id: u32,
    channel_count: u8,
    outgoing_peer_id: u16,
    outgoing_session: u8,
    peer_reliable: u16,
    peer_incoming: u16,
    channels: Vec<Channel>,
    unsequenced_group: u16,
    pending: Vec<Pending>,
    acks: Vec<(u8, u16, u16)>,
    queued: VecDeque<Vec<u8>>,
    received: VecDeque<(u8, Vec<u8>)>,
    last_receive_ms: u64,
    last_send_ms: u64,
    disconnect_ms: u64,
    rtt_ms: u64,
    dropped_fragments: u32,
}

fn be16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn command_size(command: u8) -> Option<usize> {
    Some(match command {
        ACKNOWLEDGE => 8,
        CONNECT => 48,
        VERIFY_CONNECT => 44,
        DISCONNECT => 8,
        PING => 4,
        SEND_RELIABLE => 6,
        SEND_UNRELIABLE => 8,
        SEND_FRAGMENT | SEND_UNRELIABLE_FRAGMENT => 24,
        SEND_UNSEQUENCED => 8,
        BANDWIDTH_LIMIT => 12,
        THROTTLE_CONFIGURE => 16,
        _ => return None,
    })
}

/// `a` is newer than `b` in ENet's 16-bit sequence space.
fn newer(a: u16, b: u16) -> bool {
    a != b && a.wrapping_sub(b) < 0x8000
}

impl Peer {
    /// Starts connecting with `data` (Sunshine's `X-SS-Connect-Data`) on `channels` channels.
    pub fn connect(connect_id: u32, data: u32, channels: u8, now_ms: u64) -> Self {
        let mut peer = Self {
            state: State::Connecting,
            connect_id,
            channel_count: channels,
            outgoing_peer_id: MAXIMUM_PEER_ID,
            outgoing_session: 0xff,
            peer_reliable: 0,
            peer_incoming: 0,
            channels: vec![Channel::default(); usize::from(channels)],
            unsequenced_group: 0,
            pending: Vec::new(),
            acks: Vec::new(),
            queued: VecDeque::new(),
            received: VecDeque::new(),
            last_receive_ms: now_ms,
            last_send_ms: now_ms,
            disconnect_ms: 0,
            rtt_ms: 500,
            dropped_fragments: 0,
        };
        let mut command = Vec::with_capacity(48);
        command.extend_from_slice(&0u16.to_be_bytes());
        command.extend_from_slice(&[0xff, 0xff]);
        for value in [
            MTU as u32,
            WINDOW_SIZE,
            u32::from(channels),
            0,
            0,
            THROTTLE_INTERVAL_MS,
            THROTTLE_STEP,
            THROTTLE_STEP,
            connect_id,
            data,
        ] {
            command.extend_from_slice(&value.to_be_bytes());
        }
        peer.queue_reliable(PEER_CHANNEL, CONNECT, &command, now_ms);
        peer
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn rtt_ms(&self) -> u64 {
        self.rtt_ms
    }

    pub fn dropped_fragments(&self) -> u32 {
        self.dropped_fragments
    }

    pub fn send_reliable(&mut self, channel: u8, data: &[u8], now_ms: u64) -> Result<(), Error> {
        self.check_send(channel, data)?;
        if self.pending.len() >= MAX_PENDING {
            return Err(Error::Full);
        }
        let mut body = Vec::with_capacity(2 + data.len());
        body.extend_from_slice(&(data.len() as u16).to_be_bytes());
        body.extend_from_slice(data);
        self.queue_reliable(channel, SEND_RELIABLE, &body, now_ms);
        Ok(())
    }

    pub fn send_unsequenced(&mut self, channel: u8, data: &[u8]) -> Result<(), Error> {
        self.check_send(channel, data)?;
        self.unsequenced_group = self.unsequenced_group.wrapping_add(1);
        let mut command = Vec::with_capacity(8 + data.len());
        command.extend_from_slice(&[SEND_UNSEQUENCED | FLAG_UNSEQUENCED, channel]);
        command.extend_from_slice(&0u16.to_be_bytes());
        command.extend_from_slice(&self.unsequenced_group.to_be_bytes());
        command.extend_from_slice(&(data.len() as u16).to_be_bytes());
        command.extend_from_slice(data);
        self.queued.push_back(command);
        Ok(())
    }

    fn check_send(&self, channel: u8, data: &[u8]) -> Result<(), Error> {
        if self.state != State::Connected {
            return Err(Error::Closed);
        }
        if channel >= self.channel_count || data.len() + 32 > MTU {
            return Err(Error::TooLarge);
        }
        Ok(())
    }

    fn queue_reliable(&mut self, channel: u8, command: u8, body: &[u8], now_ms: u64) {
        let sequence = if channel == PEER_CHANNEL {
            self.peer_reliable = self.peer_reliable.wrapping_add(1);
            self.peer_reliable
        } else {
            let state = &mut self.channels[usize::from(channel)];
            state.outgoing_reliable = state.outgoing_reliable.wrapping_add(1);
            state.outgoing_reliable
        };
        let mut bytes = Vec::with_capacity(4 + body.len());
        bytes.extend_from_slice(&[command | FLAG_ACKNOWLEDGE, channel]);
        bytes.extend_from_slice(&sequence.to_be_bytes());
        bytes.extend_from_slice(body);
        self.pending.push(Pending {
            channel,
            sequence,
            command: bytes,
            first_ms: now_ms,
            sent_ms: 0,
            rto_ms: 0,
        });
    }

    /// Starts a clean disconnect; the peer closes once the host acknowledges it.
    pub fn disconnect(&mut self, now_ms: u64) {
        match self.state {
            State::Connected => {
                self.state = State::Disconnecting;
                self.disconnect_ms = now_ms;
                self.queue_reliable(PEER_CHANNEL, DISCONNECT, &0u32.to_be_bytes(), now_ms);
            }
            State::Connecting => self.state = State::Closed(End::Local),
            _ => {}
        }
    }

    /// The next message the host sent, with its channel.
    pub fn receive(&mut self) -> Option<(u8, Vec<u8>)> {
        self.received.pop_front()
    }

    /// Takes one datagram from the host.
    pub fn input(&mut self, datagram: &[u8], now_ms: u64) {
        if matches!(self.state, State::Closed(_)) {
            return;
        }
        let Some(peer_id) = be16(datagram, 0) else {
            return;
        };
        if peer_id & HEADER_COMPRESSED != 0 {
            return;
        }
        let (sent_time, mut at) = if peer_id & HEADER_SENT_TIME != 0 {
            match be16(datagram, 2) {
                Some(time) => (time, 4),
                None => return,
            }
        } else {
            (0, 2)
        };
        self.last_receive_ms = now_ms;

        while at + 4 <= datagram.len() {
            let command = datagram[at] & COMMAND_MASK;
            let flags = datagram[at] & !COMMAND_MASK;
            let channel = datagram[at + 1];
            let sequence = be16(datagram, at + 2).unwrap_or(0);
            let Some(size) = command_size(command) else {
                return;
            };
            if at + size > datagram.len() {
                return;
            }
            let data_length = match command {
                SEND_RELIABLE => usize::from(be16(datagram, at + 4).unwrap_or(0)),
                SEND_UNRELIABLE | SEND_UNSEQUENCED => {
                    usize::from(be16(datagram, at + 6).unwrap_or(0))
                }
                SEND_FRAGMENT | SEND_UNRELIABLE_FRAGMENT => {
                    usize::from(be16(datagram, at + 6).unwrap_or(0))
                }
                _ => 0,
            };
            let end = at + size + data_length;
            if end > datagram.len() {
                return;
            }
            let body = &datagram[at..at + size];
            let data = &datagram[at + size..end];
            let accepted = self.handle(command, channel, sequence, body, data, now_ms);
            if flags & FLAG_ACKNOWLEDGE != 0 && accepted {
                self.acks.push((channel, sequence, sent_time));
            }
            at = end;
        }
    }

    /// Whether to acknowledge the command: reliable ones ahead of the next expected are left
    /// unacknowledged so the host sends them again in order.
    fn handle(
        &mut self,
        command: u8,
        channel: u8,
        sequence: u16,
        body: &[u8],
        data: &[u8],
        now_ms: u64,
    ) -> bool {
        match command {
            ACKNOWLEDGE => {
                let acked = be16(body, 4).unwrap_or(0);
                let sent = be16(body, 6).unwrap_or(0);
                if let Some(index) = self.pending.iter().position(|pending| {
                    pending.channel == channel && pending.sequence == acked && pending.sent_ms != 0
                }) {
                    let pending = self.pending.remove(index);
                    let rtt = u64::from((now_ms as u16).wrapping_sub(sent)).max(1);
                    self.rtt_ms = (self.rtt_ms * 7 + rtt) / 8;
                    let disconnect = pending.command[0] & COMMAND_MASK == DISCONNECT;
                    if disconnect && self.state == State::Disconnecting {
                        self.state = State::Closed(End::Local);
                    }
                }
                true
            }
            VERIFY_CONNECT => {
                if self.state != State::Connecting {
                    return true;
                }
                let connect_id = be32(body, 40);
                if connect_id != Some(self.connect_id) {
                    self.state = State::Closed(End::Refused);
                    return false;
                }
                self.outgoing_peer_id = be16(body, 4).unwrap_or(MAXIMUM_PEER_ID);
                self.outgoing_session = body[7];
                let channels = be32(body, 16).unwrap_or(0);
                if channels > 0 && channels < u32::from(self.channel_count) {
                    self.channel_count = channels as u8;
                    self.channels.truncate(usize::from(self.channel_count));
                }
                self.pending
                    .retain(|pending| pending.command[0] & COMMAND_MASK != CONNECT);
                self.peer_incoming = sequence;
                self.state = State::Connected;
                true
            }
            DISCONNECT => {
                self.state = State::Closed(End::Host(be32(body, 4).unwrap_or(0)));
                self.pending.clear();
                true
            }
            PING | BANDWIDTH_LIMIT | THROTTLE_CONFIGURE => true,
            SEND_RELIABLE => {
                let Some(state) = self.channels.get_mut(usize::from(channel)) else {
                    return false;
                };
                let expected = state.incoming_reliable.wrapping_add(1);
                if sequence == expected {
                    state.incoming_reliable = expected;
                    self.received.push_back((channel, data.to_vec()));
                    true
                } else {
                    !newer(sequence, expected)
                }
            }
            SEND_UNRELIABLE | SEND_UNSEQUENCED => {
                if usize::from(channel) < self.channels.len() {
                    self.received.push_back((channel, data.to_vec()));
                }
                true
            }
            _ => {
                self.dropped_fragments += 1;
                true
            }
        }
    }

    /// The next datagram to send, if any; call until none.
    pub fn output(&mut self, now_ms: u64) -> Option<Vec<u8>> {
        self.check_timers(now_ms);
        if matches!(self.state, State::Closed(_)) {
            return None;
        }
        let mut header_id = self.outgoing_peer_id | HEADER_SENT_TIME;
        if self.outgoing_session != 0xff {
            header_id |= u16::from(self.outgoing_session & 3) << HEADER_SESSION_SHIFT;
        }
        let mut datagram = Vec::with_capacity(MTU);
        datagram.extend_from_slice(&header_id.to_be_bytes());
        datagram.extend_from_slice(&(now_ms as u16).to_be_bytes());
        let empty = datagram.len();

        while let Some(&(channel, sequence, sent_time)) = self.acks.first() {
            if datagram.len() + 8 > MTU {
                break;
            }
            self.acks.remove(0);
            datagram.extend_from_slice(&[ACKNOWLEDGE, channel]);
            datagram.extend_from_slice(&0u16.to_be_bytes());
            datagram.extend_from_slice(&sequence.to_be_bytes());
            datagram.extend_from_slice(&sent_time.to_be_bytes());
        }
        let rto_floor = (self.rtt_ms * 2).clamp(MIN_RTO_MS, MAX_RTO_MS);
        for pending in &mut self.pending {
            let due = pending.sent_ms == 0 || now_ms >= pending.sent_ms + pending.rto_ms;
            if !due || datagram.len() + pending.command.len() > MTU {
                continue;
            }
            pending.rto_ms = if pending.sent_ms == 0 {
                rto_floor
            } else {
                (pending.rto_ms * 2).min(MAX_RTO_MS)
            };
            pending.sent_ms = now_ms.max(1);
            datagram.extend_from_slice(&pending.command);
        }
        while let Some(command) = self.queued.front() {
            if datagram.len() + command.len() > MTU {
                break;
            }
            let command = self.queued.pop_front().expect("queued");
            datagram.extend_from_slice(&command);
        }
        if datagram.len() == empty {
            return None;
        }
        self.last_send_ms = now_ms;
        Some(datagram)
    }

    fn check_timers(&mut self, now_ms: u64) {
        match self.state {
            State::Closed(_) => return,
            State::Disconnecting if now_ms >= self.disconnect_ms + DISCONNECT_WAIT_MS => {
                self.state = State::Closed(End::Local);
                return;
            }
            _ => {}
        }
        let stale = self
            .pending
            .iter()
            .any(|pending| now_ms >= pending.first_ms + TIMEOUT_MS);
        if stale || now_ms >= self.last_receive_ms + TIMEOUT_MS {
            self.state = State::Closed(End::TimedOut);
            return;
        }
        let idle = self.pending.is_empty() && now_ms >= self.last_send_ms + PING_INTERVAL_MS;
        if self.state == State::Connected && idle {
            self.queue_reliable(PEER_CHANNEL, PING, &[], now_ms);
        }
    }
}
