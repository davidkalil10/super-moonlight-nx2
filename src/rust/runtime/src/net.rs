//! libounce BSD sockets behind the io crate's `Socket`. C side: src/rust/nro/io_adapter.c.
//! Behaviour follows src/native/media/channel.c.

extern crate alloc;

use crate::sdk;
use moonlight_nx2_io::socket::{IoError, Socket};
use moonlight_nx2_io::udp::Datagram;

const IO_OK: u32 = 0;
const IO_WOULD_BLOCK: u32 = 1;
const IO_INTERRUPTED: u32 = 2;
const IO_REFUSED: u32 = 3;
const IO_DISCONNECTED: u32 = 4;
const IO_IN_PROGRESS: u32 = 6;
const IO_CLOSE_FAILED: u32 = 7;

#[repr(C)]
#[derive(Default)]
struct Status {
    value: i64,
    error: i32,
    kind: u32,
}

const _: () = assert!(size_of::<Status>() == 16);

unsafe extern "C" {
    fn setsockopt(
        fd: i32,
        level: i32,
        name: i32,
        value: *const core::ffi::c_void,
        length: u32,
    ) -> i32;
    fn moonlightIoSocketOpen(address: *const [u8; 4], port: u16, status: *mut Status);
    fn moonlightIoDatagramOpen(address: *const [u8; 4], port: u16, status: *mut Status);
    fn moonlightIoDatagramReceiveBuffer(
        fd: i32,
        limit: i32,
        requested: *mut i32,
        granted: *mut i32,
        error: *mut i32,
    );
    fn moonlightPlatformUdpReceiveLimit() -> u32;
    fn moonlightIoSocketPollConnect(fd: i32, status: *mut Status);
    fn moonlightIoSocketSend(fd: i32, data: *const u8, bytes: usize, status: *mut Status);
    fn moonlightIoSocketRecv(fd: i32, data: *mut u8, bytes: usize, status: *mut Status);
    fn moonlightIoSocketClose(fd: i32, status: *mut Status);
    fn moonlightIoDiscoveryOpen(status: *mut Status);
    fn moonlightIoDiscoverySend(
        fd: i32,
        address: *const [u8; 4],
        port: u16,
        data: *const u8,
        bytes: usize,
        status: *mut Status,
    );
}

fn io_error(status: &Status) -> IoError {
    match status.kind {
        IO_WOULD_BLOCK => IoError::WouldBlock,
        IO_INTERRUPTED => IoError::Interrupted,
        IO_REFUSED => IoError::Refused(status.error),
        IO_DISCONNECTED => IoError::Disconnected(status.error),
        _ => IoError::Failed,
    }
}

/// One nonblocking IPv4 TCP connection. The runtime has already called socketInitialize.
pub struct NetSocket {
    fd: i32,
    connected: bool,
}

impl NetSocket {
    /// Starts a nonblocking connect. A connect that fails at once closes the descriptor; if
    /// that close fails too, the process is retired.
    pub fn connect(address: [u8; 4], port: u16) -> Result<Self, IoError> {
        Self::open(address, port, moonlightIoSocketOpen)
    }

    fn open(
        address: [u8; 4],
        port: u16,
        open: unsafe extern "C" fn(*const [u8; 4], u16, *mut Status),
    ) -> Result<Self, IoError> {
        if sdk::process_retired() {
            return Err(IoError::Failed);
        }
        let mut status = Status::default();
        unsafe { open(&address, port, &mut status) };
        if !matches!(status.kind, IO_OK | IO_IN_PROGRESS) {
            crate::device::log(&alloc::format!(
                "net: open port={port} failed kind={} errno={}",
                status.kind,
                status.error
            ));
        }
        if status.kind == IO_CLOSE_FAILED {
            sdk::retire_process();
            return Err(IoError::Failed);
        }

        let fd = i32::try_from(status.value).unwrap_or(-1);
        let started = matches!(status.kind, IO_OK | IO_IN_PROGRESS);
        if fd >= 0 && started {
            return Ok(Self {
                fd,
                connected: status.kind == IO_OK,
            });
        }

        let error = io_error(&status);
        if fd >= 0 {
            let mut socket = Self {
                fd,
                connected: false,
            };
            if socket.close().is_err() {
                return Err(IoError::Failed);
            }
        }
        Err(error)
    }

    fn transfer(&mut self, result: &Status, limit: usize) -> Result<usize, IoError> {
        if result.kind != IO_OK {
            return Err(io_error(result));
        }
        match usize::try_from(result.value) {
            Ok(count) if count <= limit => Ok(count),
            _ => Err(IoError::Failed),
        }
    }
}

/// One nonblocking UDP socket connected to a single configured peer. The BSD driver must
/// already be initialized; message boundaries and zero-length receives remain datagrams.
pub struct UdpSocket {
    socket: NetSocket,
}

impl UdpSocket {
    pub fn connect(address: [u8; 4], port: u16) -> Result<Self, IoError> {
        let socket = NetSocket::open(address, port, moonlightIoDatagramOpen)?;
        let limit = unsafe { moonlightPlatformUdpReceiveLimit() };
        let (mut requested, mut granted, mut error) = (0, 0, 0);
        unsafe {
            moonlightIoDatagramReceiveBuffer(
                socket.fd,
                i32::try_from(limit).unwrap_or(i32::MAX),
                &mut requested,
                &mut granted,
                &mut error,
            )
        };
        crate::device::log(&alloc::format!(
            "net: udp port={port} receive buffer asked={requested} got={granted} limit={limit} \
             errno={error}"
        ));
        Ok(Self { socket })
    }
}

impl Datagram for UdpSocket {
    fn poll_connect(&mut self) -> Result<bool, IoError> {
        self.socket.poll_connect()
    }

    fn send(&mut self, bytes: &[u8]) -> Result<(), IoError> {
        match self.socket.send(bytes)? {
            count if count == bytes.len() => Ok(()),
            _ => Err(IoError::Failed),
        }
    }

    fn recv(&mut self, bytes: &mut [u8]) -> Result<usize, IoError> {
        self.socket.recv(bytes)
    }

    fn close(&mut self) -> Result<(), IoError> {
        self.socket.close()
    }

    fn now_us(&self) -> Option<u64> {
        #[cfg(target_os = "none")]
        {
            Some(unsafe { sdk::moonlightNowNs() } / 1000)
        }
        #[cfg(not(target_os = "none"))]
        {
            None
        }
    }
}

/// One unconnected UDP socket for an mDNS query: `send` goes to the mDNS group, `recv` takes
/// unicast answers from any responder.
pub struct DiscoverySocket {
    socket: NetSocket,
}

impl DiscoverySocket {
    pub fn open() -> Result<Self, IoError> {
        if sdk::process_retired() {
            return Err(IoError::Failed);
        }
        let mut status = Status::default();
        unsafe { moonlightIoDiscoveryOpen(&mut status) };
        if status.kind == IO_CLOSE_FAILED {
            sdk::retire_process();
            return Err(IoError::Failed);
        }
        match i32::try_from(status.value) {
            Ok(fd) if fd >= 0 && status.kind == IO_OK => Ok(Self {
                socket: NetSocket {
                    fd,
                    connected: true,
                },
            }),
            _ => Err(io_error(&status)),
        }
    }

    /// Sends the Wake-on-LAN packet to each target on the discard and echo ports, as the r5-wol
    /// service did. Without SO_BROADCAST only a unicast target can go out; the report says so.
    pub fn wake(mac: [u8; 6], targets: &[[u8; 4]]) -> Result<WakeReport, IoError> {
        const SOL_SOCKET: i32 = 0xffff;
        const SO_BROADCAST: i32 = 0x20;
        const PORTS: [u16; 2] = [9, 7];
        let mut socket = Self::open()?;
        let enable: i32 = 1;
        let packet = moonlight_nx2_ui::model::Mac(mac).magic_packet();
        let mut report = WakeReport {
            broadcast: unsafe {
                setsockopt(
                    socket.socket.fd,
                    SOL_SOCKET,
                    SO_BROADCAST,
                    (&enable as *const i32).cast(),
                    4,
                )
            } == 0,
            ..WakeReport::default()
        };
        for target in targets {
            for port in PORTS {
                let mut status = Status::default();
                unsafe {
                    moonlightIoDiscoverySend(
                        socket.socket.fd,
                        target,
                        port,
                        packet.as_ptr(),
                        packet.len(),
                        &mut status,
                    );
                }
                if status.kind == IO_OK && status.value == packet.len() as i64 {
                    report.sent += 1;
                } else {
                    report.failed += 1;
                    report.error = status.error;
                }
            }
        }
        socket.close()?;
        Ok(report)
    }
}

/// What one Wake-on-LAN send did, for the log.
#[derive(Clone, Copy, Debug, Default)]
pub struct WakeReport {
    pub broadcast: bool,
    pub sent: u32,
    pub failed: u32,
    /// errno of the last packet that did not go out.
    pub error: i32,
}

impl Datagram for DiscoverySocket {
    fn poll_connect(&mut self) -> Result<bool, IoError> {
        Ok(true)
    }

    fn send(&mut self, bytes: &[u8]) -> Result<(), IoError> {
        use moonlight_nx2_ui::discover::{MDNS_ADDRESS, MDNS_PORT};
        if self.socket.fd < 0 {
            return Err(IoError::Failed);
        }
        let mut status = Status::default();
        unsafe {
            moonlightIoDiscoverySend(
                self.socket.fd,
                &MDNS_ADDRESS,
                MDNS_PORT,
                bytes.as_ptr(),
                bytes.len(),
                &mut status,
            )
        };
        match self.socket.transfer(&status, bytes.len())? {
            count if count == bytes.len() => Ok(()),
            _ => Err(IoError::Failed),
        }
    }

    fn recv(&mut self, bytes: &mut [u8]) -> Result<usize, IoError> {
        self.socket.recv(bytes)
    }

    fn close(&mut self) -> Result<(), IoError> {
        self.socket.close()
    }
}

/// Keeps the media connections on the PC's IPv4 address.
pub struct PeerConnector {
    address: [u8; 4],
}

impl PeerConnector {
    /// The runtime initializes BSD sockets before opening this peer's channels.
    pub const fn new(address: [u8; 4]) -> Self {
        Self { address }
    }

    pub fn open_datagram(&mut self, port: u16) -> Result<UdpSocket, IoError> {
        UdpSocket::connect(self.address, port)
    }
}

impl moonlight_nx2_app::media::Connector for PeerConnector {
    type Socket = NetSocket;

    fn connect(&mut self, port: u16) -> Result<Self::Socket, IoError> {
        NetSocket::connect(self.address, port)
    }
}

impl moonlight_nx2_app::media::UdpConnector for PeerConnector {
    type Datagram = UdpSocket;

    fn connect_datagram(&mut self, port: u16) -> Result<Self::Datagram, IoError> {
        self.open_datagram(port)
    }
}

impl Socket for NetSocket {
    fn poll_connect(&mut self) -> Result<bool, IoError> {
        if self.fd < 0 {
            return Err(IoError::Failed);
        }
        if self.connected {
            return Ok(true);
        }

        let mut status = Status::default();
        unsafe { moonlightIoSocketPollConnect(self.fd, &mut status) };
        if status.kind != IO_OK {
            return Err(io_error(&status));
        }
        self.connected = status.value == 1;
        Ok(self.connected)
    }

    fn send(&mut self, bytes: &[u8]) -> Result<usize, IoError> {
        if self.fd < 0 {
            return Err(IoError::Failed);
        }
        let mut status = Status::default();
        unsafe { moonlightIoSocketSend(self.fd, bytes.as_ptr(), bytes.len(), &mut status) };
        self.transfer(&status, bytes.len())
    }

    fn recv(&mut self, bytes: &mut [u8]) -> Result<usize, IoError> {
        if self.fd < 0 {
            return Err(IoError::Failed);
        }
        let mut status = Status::default();
        unsafe { moonlightIoSocketRecv(self.fd, bytes.as_mut_ptr(), bytes.len(), &mut status) };
        self.transfer(&status, bytes.len())
    }

    /// The descriptor is given up even when close fails and is never closed twice. A failed
    /// close leaves its state unknown, so the process is retired.
    fn close(&mut self) -> Result<(), IoError> {
        if self.fd < 0 {
            return Err(IoError::Failed);
        }
        let fd = core::mem::replace(&mut self.fd, -1);
        let mut status = Status::default();
        unsafe { moonlightIoSocketClose(fd, &mut status) };
        if status.kind != IO_OK {
            sdk::retire_process();
            return Err(IoError::Failed);
        }
        Ok(())
    }
}

impl Drop for NetSocket {
    fn drop(&mut self) {
        if self.fd >= 0 {
            let _ = self.close();
        }
    }
}
