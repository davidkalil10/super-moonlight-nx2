//! Socket options for the TCP connections to the console.

use std::{io, net::TcpStream, os::fd::AsRawFd, time::Duration};

/// A console that stops answering is given up after this long, a little past the console's
/// own media watchdog.
pub const PEER_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE_IDLE_SECONDS: libc::c_int = 5;
const KEEPALIVE_INTERVAL_SECONDS: libc::c_int = 2;
const KEEPALIVE_PROBES: libc::c_int = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Class {
    Control,
    Video,
    Audio,
}

impl Class {
    /// DSCP in the TOS byte: CS4 for video, EF for audio, so a WMM access point can queue them
    /// ahead of bulk traffic.
    fn tos(self) -> Option<libc::c_int> {
        match self {
            Self::Control => None,
            Self::Video => Some(0x80),
            Self::Audio => Some(0xb8),
        }
    }
}

fn set(
    socket: &TcpStream,
    level: libc::c_int,
    name: libc::c_int,
    value: libc::c_int,
) -> io::Result<()> {
    let result = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            level,
            name,
            (&value as *const libc::c_int).cast(),
            size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// No Nagle delay on records and acknowledgements, and a bounded wait for a dead peer.
pub fn apply(socket: &TcpStream, class: Class) -> io::Result<()> {
    socket.set_nodelay(true)?;
    set(socket, libc::SOL_SOCKET, libc::SO_KEEPALIVE, 1)?;
    set(
        socket,
        libc::IPPROTO_TCP,
        libc::TCP_KEEPIDLE,
        KEEPALIVE_IDLE_SECONDS,
    )?;
    set(
        socket,
        libc::IPPROTO_TCP,
        libc::TCP_KEEPINTVL,
        KEEPALIVE_INTERVAL_SECONDS,
    )?;
    set(
        socket,
        libc::IPPROTO_TCP,
        libc::TCP_KEEPCNT,
        KEEPALIVE_PROBES,
    )?;
    set(
        socket,
        libc::IPPROTO_TCP,
        libc::TCP_USER_TIMEOUT,
        PEER_TIMEOUT.as_millis() as libc::c_int,
    )?;
    if let Some(tos) = class.tos() {
        let _ = set(socket, libc::IPPROTO_IP, libc::IP_TOS, tos);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn get(socket: &TcpStream, level: libc::c_int, name: libc::c_int) -> libc::c_int {
        let mut value: libc::c_int = 0;
        let mut length = size_of::<libc::c_int>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                socket.as_raw_fd(),
                level,
                name,
                (&mut value as *mut libc::c_int).cast(),
                &mut length,
            )
        };
        assert_eq!(result, 0);
        value
    }

    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        (listener.accept().unwrap().0, client)
    }

    #[test]
    fn media_sockets_send_at_once_and_give_up_on_a_dead_peer() {
        let (socket, _peer) = pair();
        apply(&socket, Class::Video).unwrap();
        assert!(socket.nodelay().unwrap());
        assert_eq!(get(&socket, libc::SOL_SOCKET, libc::SO_KEEPALIVE), 1);
        assert_eq!(get(&socket, libc::IPPROTO_TCP, libc::TCP_KEEPIDLE), 5);
        assert_eq!(
            get(&socket, libc::IPPROTO_TCP, libc::TCP_USER_TIMEOUT),
            15_000
        );
        assert_eq!(get(&socket, libc::IPPROTO_IP, libc::IP_TOS), 0x80);
    }

    #[test]
    fn audio_is_marked_ahead_of_video_and_control_is_unmarked() {
        let (audio, control) = pair();
        apply(&audio, Class::Audio).unwrap();
        apply(&control, Class::Control).unwrap();
        assert_eq!(get(&audio, libc::IPPROTO_IP, libc::IP_TOS), 0xb8);
        assert_eq!(get(&control, libc::IPPROTO_IP, libc::IP_TOS), 0);
        assert!(control.nodelay().unwrap());
    }
}
