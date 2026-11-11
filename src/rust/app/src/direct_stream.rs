//! A direct stream once its control channel is up: the encrypted control stream, the input
//! session and their socket, shared between the direct link and the media path through
//! `Outbox` so keyframe requests, loss and input records go out the moment they happen.

extern crate alloc;

use alloc::{boxed::Box, collections::VecDeque, format, rc::Rc, string::String, vec::Vec};
use core::cell::RefCell;

use moonlight_nx2_core::control::Kind;
use moonlight_nx2_io::{
    socket::IoError,
    udp::{Datagram, MAX_DATAGRAM},
};
use moonlight_nx2_sunshine::{
    control::{ControlSender, Delivery, HostEvent, SendError},
    control_stream::{self, ControlStream},
    stream::Negotiated,
};

use crate::{
    direct_input::{self, DirectInput},
    pointer::{KeyboardSample, MouseSample},
    reply::Rumble,
};

pub type Reply = (Kind, u32, Vec<u8>);

struct Channel {
    control: ControlStream,
    input: DirectInput,
    socket: Box<dyn Datagram>,
    now_ms: u64,
    failed: bool,
}

impl Channel {
    fn flush_input(&mut self) -> Result<(), direct_input::Error> {
        if !self.control.started() {
            return Ok(());
        }
        self.input.flush(&mut control_stream::Sender {
            stream: &mut self.control,
            now_ms: self.now_ms,
        })
    }

    fn send_out(&mut self) {
        while let Some(datagram) = self.control.output(self.now_ms) {
            match self.socket.send(&datagram) {
                Ok(()) | Err(IoError::WouldBlock) => {}
                Err(_) => {
                    self.failed = true;
                    return;
                }
            }
        }
    }
}

/// A stream whose control channel is up.
pub struct Live {
    pub app: u32,
    pub negotiated: Negotiated,
    channel: Rc<RefCell<Channel>>,
}

impl Live {
    pub fn new(
        app: u32,
        negotiated: Negotiated,
        control: ControlStream,
        mut input: DirectInput,
        socket: Box<dyn Datagram>,
        now_ms: u64,
    ) -> Self {
        input.connect();
        let channel = Channel {
            control,
            input,
            socket,
            now_ms,
            failed: false,
        };
        Self {
            app,
            negotiated,
            channel: Rc::new(RefCell::new(channel)),
        }
    }

    pub fn state(&self) -> control_stream::State {
        self.channel.borrow().control.state()
    }

    /// Moves datagrams both ways; false once the channel ended.
    pub fn pump(
        &mut self,
        now_ms: u64,
        events: &mut VecDeque<HostEvent>,
        replies: &mut VecDeque<Reply>,
    ) -> bool {
        let mut channel = self.channel.borrow_mut();
        let channel = &mut *channel;
        channel.now_ms = now_ms;
        let mut buffer = [0u8; MAX_DATAGRAM + 1];
        loop {
            match channel.socket.recv(&mut buffer) {
                Ok(length) if length <= MAX_DATAGRAM => {
                    let input = &mut channel.input;
                    channel
                        .control
                        .input(&buffer[..length], now_ms, &mut |event| {
                            if let Some(rumble) = input.host_event(event) {
                                replies.push_back((
                                    Kind::Event,
                                    0,
                                    rumble_event(rumble).into_bytes(),
                                ));
                            }
                            events.push_back(event);
                        });
                }
                Ok(_) => {}
                Err(IoError::WouldBlock | IoError::Interrupted) => break,
                Err(_) => return false,
            }
        }
        channel.send_out();
        if channel.flush_input().is_ok() {
            channel.send_out();
        }
        !channel.failed && !matches!(channel.control.state(), control_stream::State::Ended(_))
    }

    pub fn request_idr(&mut self, now_ms: u64) -> Result<(), SendError> {
        self.channel.borrow_mut().control.request_idr(now_ms)
    }

    /// Takes the USB mouse and keyboard; flushed with the next pump.
    pub fn pointer(&mut self, mouse: Option<&MouseSample>, keyboard: Option<&KeyboardSample>) {
        let mut channel = self.channel.borrow_mut();
        if let Some(mouse) = mouse {
            channel.input.mouse(mouse);
        }
        channel.input.keyboard(keyboard);
    }

    /// Types `text` on the PC; false when it holds characters Sunshine cannot type.
    pub fn text(&mut self, text: &str) -> bool {
        self.channel.borrow_mut().input.text(text)
    }

    /// The handle the media path sends keyframe requests, loss and input records through.
    pub fn outbox(&self) -> Outbox {
        Outbox(self.channel.clone())
    }

    /// Says goodbye on the control channel without waiting for the host.
    pub fn end(self, now_ms: u64) {
        let mut channel = self.channel.borrow_mut();
        channel.now_ms = now_ms;
        channel.input.release();
        channel.input.disconnect();
        let _ = channel.flush_input();
        channel.control.disconnect(now_ms);
        channel.send_out();
        let _ = channel.socket.close();
    }
}

/// The live channel as the media path holds it; it stays valid after the stream ended, and
/// sends then fail as closed.
#[derive(Clone)]
pub struct Outbox(Rc<RefCell<Channel>>);

impl Outbox {
    fn apply(&self, record: &[u8]) -> Result<bool, direct_input::Error> {
        let mut channel = self
            .0
            .try_borrow_mut()
            .map_err(|_| direct_input::Error::Link)?;
        let now_us = channel.now_ms.saturating_mul(1000);
        let changed = channel.input.apply(record, now_us)?;
        channel.flush_input()?;
        channel.send_out();
        Ok(changed)
    }
}

impl crate::direct_media::InputSink for Outbox {
    fn input(&mut self, record: &[u8]) {
        let _ = self.apply(record);
    }
}

impl ControlSender for Outbox {
    fn send(
        &mut self,
        kind: u16,
        channel: u8,
        delivery: Delivery,
        payload: &[u8],
    ) -> Result<(), SendError> {
        let mut shared = self.0.try_borrow_mut().map_err(|_| SendError::Full)?;
        let now_ms = shared.now_ms;
        control_stream::Sender {
            stream: &mut shared.control,
            now_ms,
        }
        .send(kind, channel, delivery, payload)?;
        shared.send_out();
        Ok(())
    }

    fn frames_lost(&mut self, first: u32, last: u32) {
        if let Ok(mut channel) = self.0.try_borrow_mut() {
            let lost = last.wrapping_sub(first).saturating_add(1);
            channel
                .control
                .report_loss(lost, u64::from(first.wrapping_sub(1)));
        }
    }
}

fn rumble_event(rumble: Rumble) -> String {
    format!(
        "{{\"event\":\"rumble\",\"controller\":{},\"low\":{},\"high\":{}}}",
        rumble.player, rumble.low, rumble.high
    )
}
