//! Authenticates and bounds the PC helper control connection.

extern crate alloc;

use alloc::{boxed::Box, vec::Vec};
use core::ptr::NonNull;
use moonlight_nx2_app::link::{Link, LinkError};
use moonlight_nx2_core::control::Frame;
use moonlight_nx2_io::{
    control::{self, Channel},
    socket::Socket,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Access {
    User,
    Streaming,
    SingleList,
}

#[derive(Clone, Copy, Debug)]
pub struct OpenError {
    pub channel: Option<control::Error>,
    pub retained: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Closed {
    pub error: Option<control::Error>,
    pub stats: control::Stats,
    pub retained: bool,
}

pub struct Control<S: Socket + 'static> {
    channel: Option<Channel<'static, S>>,
    memory: Option<NonNull<[u8]>>,
    outbound: Option<NonNull<[u8]>>,
    access: Access,
    listed: bool,
    rejected: bool,
}

fn buffer(length: usize) -> Option<Box<[u8]>> {
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(length).ok()?;
    bytes.resize(length, 0);
    Some(bytes.into_boxed_slice())
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
}

impl<S: Socket + 'static> Control<S> {
    pub fn open(
        mut socket: S,
        mut token: [u8; 64],
        access: Access,
        now_ms: u64,
    ) -> Result<Self, OpenError> {
        let allocated = buffer(65_536).zip(buffer(4_096));
        let Some((memory, outbound)) = allocated else {
            wipe(&mut token);
            let retained = socket.close().is_err();
            if retained {
                crate::render_platform::retire_process();
            }
            return Err(OpenError {
                channel: None,
                retained,
            });
        };
        let memory_pointer = NonNull::new(Box::into_raw(memory)).unwrap();
        let outbound_pointer = NonNull::new(Box::into_raw(outbound)).unwrap();
        let memory = unsafe { &mut *memory_pointer.as_ptr() };
        let outbound = unsafe { &mut *outbound_pointer.as_ptr() };
        let config = control::Config {
            token: core::mem::replace(&mut token, [0; 64]),
            memory,
            outbound,
            read_budget: 65_536,
            connect_timeout_ms: 5_000,
        };
        wipe(&mut token);
        let mut result = Self {
            channel: None,
            memory: Some(memory_pointer),
            outbound: Some(outbound_pointer),
            access,
            listed: false,
            rejected: false,
        };
        match Channel::open(config, socket, now_ms) {
            Ok(channel) => {
                result.channel = Some(channel);
                Ok(result)
            }
            Err((error, mut socket)) => {
                let retained = socket.close().is_err();
                if retained {
                    crate::render_platform::retire_process();
                } else {
                    result.release_buffers();
                }
                Err(OpenError {
                    channel: Some(error),
                    retained,
                })
            }
        }
    }

    fn release_buffers(&mut self) {
        for pointer in [self.memory.take(), self.outbound.take()]
            .into_iter()
            .flatten()
        {
            unsafe {
                drop(Box::from_raw(pointer.as_ptr()));
            }
        }
    }

    pub fn pump(&mut self, now_ms: u64) -> Result<(), control::Error> {
        self.channel
            .as_mut()
            .ok_or(control::Error::Ended)?
            .pump(now_ms)
    }

    pub fn rejected(&self) -> bool {
        self.rejected
    }
    pub fn listed(&self) -> bool {
        self.listed
    }

    pub fn stats(&self) -> Option<control::Stats> {
        self.channel.as_ref().map(Channel::stats)
    }

    pub fn close(&mut self) -> Option<Closed> {
        let channel = self.channel.take()?;
        match channel.close() {
            Ok(stats) => {
                self.release_buffers();
                Some(Closed {
                    error: None,
                    stats,
                    retained: false,
                })
            }
            Err((error, stats)) => {
                crate::render_platform::retire_process();
                Some(Closed {
                    error: Some(error),
                    stats,
                    retained: true,
                })
            }
        }
    }
}

impl<S: Socket + 'static> Link for Control<S> {
    fn ready(&self) -> bool {
        !self.rejected && self.channel.as_ref().is_some_and(Link::ready)
    }
    fn failed(&self) -> bool {
        self.rejected || self.channel.as_ref().is_none_or(Link::failed)
    }
    fn request(&mut self, payload: &[u8]) -> Result<u32, LinkError> {
        let parsed = moonlight_nx2_app::json::parse(payload).ok();
        let op = parsed.and_then(|value| value.member("op"));
        let list = op.is_some_and(|op| op.string_is("list"));
        let allowed = op.is_some_and(|op| {
            ["list", "pair", "unpair", "quit", "stop", "cover", "probe"]
                .iter()
                .any(|name| op.string_is(name))
                || (self.access == Access::Streaming
                    && (op.string_is("start") || op.string_is("idr")))
        });
        if !allowed
            || self.rejected
            || (self.access == Access::SingleList && (!list || self.listed))
        {
            self.rejected = true;
            return Err(LinkError::Closed);
        }
        let id = Link::request(self.channel.as_mut().ok_or(LinkError::Closed)?, payload)?;
        self.listed |= list;
        Ok(id)
    }
    fn peek(&self) -> Option<Frame<'_>> {
        self.channel.as_ref()?.peek()
    }
    fn consume(&mut self) -> Result<(), LinkError> {
        Link::consume(self.channel.as_mut().ok_or(LinkError::Closed)?)
    }
}

impl<S: Socket + 'static> Drop for Control<S> {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlight_nx2_io::socket::IoError;

    struct SocketStub;
    impl Socket for SocketStub {
        fn poll_connect(&mut self) -> Result<bool, IoError> {
            Ok(true)
        }
        fn send(&mut self, _: &[u8]) -> Result<usize, IoError> {
            panic!("no network send expected")
        }
        fn recv(&mut self, _: &mut [u8]) -> Result<usize, IoError> {
            Err(IoError::WouldBlock)
        }
        fn close(&mut self) -> Result<(), IoError> {
            Ok(())
        }
    }

    #[test]
    fn start_requires_streaming_access_before_any_network_io() {
        let mut refused = Control::open(SocketStub, [b'0'; 64], Access::User, 0).unwrap();
        assert_eq!(
            refused.request(br#"{"op":"start"}"#),
            Err(LinkError::Closed)
        );
        assert!(refused.rejected());
        let mut permitted = Control::open(SocketStub, [b'0'; 64], Access::Streaming, 0).unwrap();
        assert_eq!(
            permitted.request(br#"{"op":"start"}"#),
            Err(LinkError::Again)
        );
        assert!(!permitted.rejected());
    }

    #[test]
    fn idr_requests_pass_only_with_streaming_access() {
        let mut refused = Control::open(SocketStub, [b'0'; 64], Access::User, 0).unwrap();
        assert_eq!(refused.request(br#"{"op":"idr"}"#), Err(LinkError::Closed));
        assert!(refused.rejected());
        let mut permitted = Control::open(SocketStub, [b'0'; 64], Access::Streaming, 0).unwrap();
        assert_eq!(permitted.request(br#"{"op":"idr"}"#), Err(LinkError::Again));
        assert!(!permitted.rejected());
    }
}
