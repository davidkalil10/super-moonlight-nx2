//! The control stream's messages, and the interfaces input and media talk to it through.

/// Message types for hosts at 7.1.431 and later (encrypted control).
pub mod kind {
    pub const PERIODIC_PING: u16 = 0x0200;
    pub const LOSS_STATS: u16 = 0x0201;
    pub const FRAME_STATS: u16 = 0x0204;
    pub const INPUT: u16 = 0x0206;
    pub const INVALIDATE_REFERENCES: u16 = 0x0301;
    pub const REQUEST_IDR: u16 = 0x0302;
    pub const START_B: u16 = 0x0307;
    pub const TERMINATION: u16 = 0x0109;
    pub const RUMBLE: u16 = 0x010b;
    pub const HDR_MODE: u16 = 0x010e;
    pub const RUMBLE_TRIGGERS: u16 = 0x5500;
    pub const SET_MOTION_EVENT: u16 = 0x5501;
    pub const SET_RGB_LED: u16 = 0x5502;
    /// The wrapper every message travels in once control is encrypted.
    pub const ENCRYPTED: u16 = 0x0001;
}

/// ENet channels, as moonlight-common-c numbers them.
pub mod channel {
    pub const GENERIC: u8 = 0x00;
    pub const URGENT: u8 = 0x01;
    pub const KEYBOARD: u8 = 0x02;
    pub const MOUSE: u8 = 0x03;
    pub const PEN: u8 = 0x04;
    pub const TOUCH: u8 = 0x05;
    pub const UTF8: u8 = 0x06;
    pub const GAMEPAD_BASE: u8 = 0x10;
    pub const SENSOR_BASE: u8 = 0x20;
    pub const COUNT: u8 = 0x30;

    pub fn gamepad(player: u8) -> u8 {
        GAMEPAD_BASE + (player & 0x0f)
    }

    pub fn sensor(player: u8) -> u8 {
        SENSOR_BASE + (player & 0x0f)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    Reliable,
    /// Sent once; motion and other samples a newer one replaces.
    Unreliable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendError {
    /// Not connected yet, or the stream ended.
    Closed,
    /// The outgoing window is full; drop or retry next frame.
    Full,
    TooLarge,
}

/// Sends one control message; the channel encrypts it with the stream key.
pub trait ControlSender {
    fn send(
        &mut self,
        kind: u16,
        channel: u8,
        delivery: Delivery,
        payload: &[u8],
    ) -> Result<(), SendError>;

    /// Frames `first..=last` never decoded; reported to the host with the loss stats.
    fn frames_lost(&mut self, _first: u32, _last: u32) {}
}

/// What the host asks of the console during a stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostEvent {
    Rumble {
        controller: u16,
        low: u16,
        high: u16,
    },
    TriggerRumble {
        controller: u16,
        left: u16,
        right: u16,
    },
    /// `kind`: 1 accelerometer, 2 gyroscope. A rate of 0 stops the reports.
    Motion {
        controller: u16,
        rate_hz: u16,
        kind: u8,
    },
    Led {
        controller: u16,
        red: u8,
        green: u8,
        blue: u8,
    },
    Hdr(bool),
    /// The host ended the stream; `reason` as sent, 0 for a clean end.
    Terminated {
        reason: u32,
    },
}

/// Receives host events as the control channel decodes them.
pub trait HostEvents {
    fn event(&mut self, event: HostEvent);
}

impl<F: FnMut(HostEvent)> HostEvents for F {
    fn event(&mut self, event: HostEvent) {
        self(event)
    }
}
