use crate::udp_video::{self, Counters, Sender, Timing, Unit};
use std::collections::VecDeque;
use std::io;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::atomic::{Ordering, compiler_fence};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RECEIVE_BUDGET: usize = 32;
const SEND_BUDGET: usize = 256;
const RECEIVE_BYTES: usize = 8192;
#[cfg(unix)]
const SEND_BUFFER_BYTES: libc::c_int = 4 * 1024 * 1024;

#[cfg(unix)]
fn tune_send_buffer(socket: &UdpSocket) {
    use std::os::fd::AsRawFd;
    let _ = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_SNDBUF,
            (&SEND_BUFFER_BYTES as *const libc::c_int).cast(),
            std::mem::size_of_val(&SEND_BUFFER_BYTES) as libc::socklen_t,
        )
    };
}

#[cfg(not(unix))]
fn tune_send_buffer(_: &UdpSocket) {}

#[derive(Debug)]
pub enum Error {
    InvalidConfig,
    InvalidToken,
    Timeout,
    NotConnected,
    Ended,
    Closed,
    Backpressure,
    Sender(udp_video::Error),
    Io(io::Error),
}

struct End {
    next: Instant,
    sent: u32,
    settled: bool,
}

pub struct Endpoint {
    socket: UdpSocket,
    allowed_peer: IpAddr,
    token: [u8; 64],
    peer: Option<SocketAddr>,
    hello_deadline: Instant,
    origin: Instant,
    origin_epoch_ms: f64,
    sender: Sender,
    outgoing: VecDeque<Vec<u8>>,
    outgoing_bytes: usize,
    stats: Vec<u32>,
    end: Option<End>,
    failed: bool,
}

impl Endpoint {
    pub fn bind(
        address: SocketAddr,
        peer: IpAddr,
        token: [u8; 64],
        fps: u32,
        max_unit: usize,
        now: Instant,
        deadline: Instant,
    ) -> Result<Self, Error> {
        if !address.is_ipv4() || !peer.is_ipv4() || deadline <= now {
            return Err(Error::InvalidConfig);
        }
        if !token
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return Err(Error::InvalidToken);
        }
        let mut sender = Sender::new(fps, max_unit).map_err(Error::Sender)?;
        sender.use_profile_timing();
        let origin_epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::InvalidConfig)?
            .as_secs_f64()
            * 1000.0;
        let socket = UdpSocket::bind(address).map_err(Error::Io)?;
        tune_send_buffer(&socket);
        socket.set_nonblocking(true).map_err(Error::Io)?;
        Ok(Self {
            socket,
            allowed_peer: peer,
            token,
            peer: None,
            hello_deadline: deadline,
            origin: now,
            origin_epoch_ms,
            sender,
            outgoing: VecDeque::new(),
            outgoing_bytes: 0,
            stats: Vec::new(),
            end: None,
            failed: false,
        })
    }

    pub fn local_addr(&self) -> Result<SocketAddr, Error> {
        self.socket.local_addr().map_err(Error::Io)
    }
    pub fn peer(&self) -> Option<SocketAddr> {
        self.peer
    }
    pub fn timing(&self) -> Timing {
        self.sender.timing()
    }
    pub fn counters(&self) -> Counters {
        self.sender.counters()
    }
    pub fn console_stats(&self) -> &[u32] {
        &self.stats
    }

    fn millis(&self, now: Instant) -> Result<f64, Error> {
        Ok(self.origin_epoch_ms
            + now
                .checked_duration_since(self.origin)
                .ok_or(Error::InvalidConfig)?
                .as_secs_f64()
                * 1000.0)
    }

    fn queue(&mut self, packets: Vec<Vec<u8>>) -> Result<(), Error> {
        let bytes = packets
            .iter()
            .try_fold(0usize, |total, packet| total.checked_add(packet.len()))
            .ok_or(Error::Backpressure)?;
        if packets.len() > udp_video::MAX_BUFFERED_DATAGRAMS - self.outgoing.len()
            || bytes > udp_video::MAX_BUFFERED_DATAGRAM_BYTES - self.outgoing_bytes
        {
            self.failed = true;
            return Err(Error::Backpressure);
        }
        self.outgoing_bytes += bytes;
        self.outgoing.extend(packets);
        Ok(())
    }

    pub fn send(&mut self, unit: Unit<'_>, now: Instant) -> Result<u32, Error> {
        if self.failed {
            return Err(Error::Closed);
        }
        if self.peer.is_none() {
            return Err(Error::NotConnected);
        }
        if self.end.is_some() {
            return Err(Error::Ended);
        }
        let ms = self.millis(now)?;
        let frame = self.sender.enqueue(unit, ms).map_err(Error::Sender)?;
        let (_, packets) = self.sender.flush(ms).map_err(Error::Sender)?;
        self.queue(packets)?;
        Ok(frame)
    }

    pub fn begin_end(&mut self, now: Instant, settled: bool) -> Result<(), Error> {
        if self.failed {
            return Err(Error::Closed);
        }
        if self.peer.is_none() {
            return Err(Error::NotConnected);
        }
        if self.end.is_some() {
            return Err(Error::Ended);
        }
        self.end = Some(End {
            next: now,
            sent: 0,
            settled,
        });
        Ok(())
    }

    pub fn settle_end(&mut self) {
        if let Some(end) = &mut self.end {
            end.settled = true;
        }
    }

    pub fn ended(&self, now: Instant) -> bool {
        self.end
            .as_ref()
            .is_some_and(|end| end.sent >= 3 && end.settled && now >= end.next)
            && self.outgoing.is_empty()
    }

    pub fn poll(&mut self, now: Instant, outstanding: bool) -> Result<(), Error> {
        if self.failed {
            return Err(Error::Closed);
        }
        let result = self.poll_inner(now, outstanding);
        if result.is_err() {
            self.failed = true;
        }
        result
    }

    fn poll_inner(&mut self, now: Instant, outstanding: bool) -> Result<(), Error> {
        let ms = self.millis(now)?;
        if self.peer.is_none() && now >= self.hello_deadline {
            return Err(Error::Timeout);
        }
        for _ in 0..RECEIVE_BUDGET {
            let mut bytes = [0u8; RECEIVE_BYTES];
            let (size, from) = match self.socket.recv_from(&mut bytes) {
                Ok(value) => value,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    break;
                }
                Err(error) => return Err(Error::Io(error)),
            };
            let message = &bytes[..size];
            if self.peer.is_none() {
                if from.ip() == self.allowed_peer && udp_video::is_hello(message, &self.token) {
                    self.peer = Some(from);
                    self.clear_token();
                }
                continue;
            }
            if self.peer != Some(from) {
                continue;
            }
            if let Some(ranges) = udp_video::read_nack(message) {
                let packets = self.sender.nack(&ranges, ms).map_err(Error::Sender)?;
                self.queue(packets)?;
            } else if let Some(stats) = udp_video::read_stats(message) {
                self.stats = stats;
            }
        }
        if self.peer.is_none() {
            return Ok(());
        }
        let (_, packets) = self.sender.flush(ms).map_err(Error::Sender)?;
        self.queue(packets)?;
        if outstanding {
            let (_, packet) = self.sender.probe(ms).map_err(Error::Sender)?;
            if let Some(packet) = packet {
                self.queue(vec![packet])?;
            }
        }
        let send_end = self.end.as_ref().is_some_and(|end| {
            now >= end.next
                && (end.sent < 3 || !end.settled)
                && self.sender.pending() == 0
                && self.outgoing.is_empty()
        });
        if send_end {
            self.queue(vec![self.sender.end().to_vec()])?;
            let end = self.end.as_mut().expect("end state");
            end.sent += 1;
            end.next = now
                + if end.sent <= 3 {
                    Duration::from_millis(5)
                } else {
                    Duration::from_millis(100)
                };
        }
        let peer = self.peer.expect("connected peer");
        for _ in 0..SEND_BUDGET {
            let Some(packet) = self.outgoing.front() else {
                break;
            };
            match self.socket.send_to(packet, peer) {
                Ok(count) if count == packet.len() => {}
                Ok(_) => {
                    return Err(Error::Io(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "partial UDP datagram",
                    )));
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) =>
                {
                    break;
                }
                Err(error) => return Err(Error::Io(error)),
            }
            let packet = self.outgoing.pop_front().expect("queued packet");
            self.outgoing_bytes -= packet.len();
        }
        Ok(())
    }

    fn clear_token(&mut self) {
        for byte in &mut self.token {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        compiler_fence(Ordering::SeqCst);
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.clear_token();
    }
}
