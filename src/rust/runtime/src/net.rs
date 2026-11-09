//! libounce BSD sockets behind the io crate's `Socket`. C side: src/rust/nro/io_adapter.c.
//! Behaviour follows src/native/media/channel.c.

use crate::sdk;
use moonlight_nx2_io::control;
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
        NetSocket::open(address, port, moonlightIoDatagramOpen).map(|socket| Self { socket })
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

    /// Send one Wake-on-LAN packet. The SDK uses BSD SOL_SOCKET/SO_BROADCAST values.
    pub fn wake(mac: [u8; 6]) -> Result<(), IoError> {
        let mut socket = Self::open()?;
        let enable: i32 = 1;
        let packet = moonlight_nx2_ui::model::Mac(mac).magic_packet();
        let configured = unsafe {
            setsockopt(
                socket.socket.fd,
                0xffff,
                0x20,
                (&enable as *const i32).cast(),
                4,
            )
        } == 0;
        let result = if configured {
            let mut status = Status::default();
            unsafe {
                moonlightIoDiscoverySend(
                    socket.socket.fd,
                    &[255; 4],
                    9,
                    packet.as_ptr(),
                    packet.len(),
                    &mut status,
                );
            }
            match socket.socket.transfer(&status, packet.len()) {
                Ok(count) if count == packet.len() => Ok(()),
                _ => Err(IoError::Failed),
            }
        } else {
            Err(IoError::Failed)
        };
        socket.close()?;
        result
    }
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

/// Keeps control and media connections on the same configured IPv4 peer.
pub struct PeerConnector {
    address: [u8; 4],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlOpenError {
    Socket(IoError),
    Channel(control::Error),
    Close {
        channel: control::Error,
        socket: IoError,
    },
}

impl PeerConnector {
    /// The runtime initializes BSD sockets before opening this peer's channels.
    pub const fn new(address: [u8; 4]) -> Self {
        Self { address }
    }

    pub fn open_datagram(&mut self, port: u16) -> Result<UdpSocket, IoError> {
        UdpSocket::connect(self.address, port)
    }

    /// Starts control authentication. The caller pumps the channel until `Link::ready`;
    /// successful construction alone does not authenticate the peer.
    pub fn open_control<'a>(
        &mut self,
        port: u16,
        mut config: control::Config<'a>,
        now_ms: u64,
    ) -> Result<control::Channel<'a, NetSocket>, ControlOpenError> {
        let socket = match NetSocket::connect(self.address, port) {
            Ok(socket) => socket,
            Err(error) => {
                for byte in &mut config.token {
                    unsafe { core::ptr::write_volatile(byte, 0) };
                }
                return Err(ControlOpenError::Socket(error));
            }
        };
        match control::Channel::open(config, socket, now_ms) {
            Ok(channel) => Ok(channel),
            Err((error, mut socket)) => match socket.close() {
                Ok(()) => Err(ControlOpenError::Channel(error)),
                Err(close) => Err(ControlOpenError::Close {
                    channel: error,
                    socket: close,
                }),
            },
        }
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
