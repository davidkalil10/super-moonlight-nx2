//! The console's input session towards Sunshine: pad arrival and removal in an order that does
//! not lean on any send queue, motion only as the host asked for it, touch with the mouse as
//! fallback, and the host's rumble and motion requests folded into what the console drives.
//! It mirrors the helper worker's `direct_input` so both paths give the host the same pads.

use crate::control::{ControlSender, Delivery, HostEvent, SendError, kind};
use crate::input::{
    self, ARRIVAL_BUTTONS, ARRIVAL_CAPS, FEATURE_CONTROLLER_TOUCH, FEATURE_PEN_TOUCH, MOTION_ACCEL,
    MOTION_GYRO, Packet, PadValues, TYPE_UNKNOWN,
};
use alloc::vec::Vec;

/// Pads the console routes; Sunshine takes up to 16.
pub const PADS: usize = 8;
const MOUSE_GRID: f32 = 10_000.0;
const MAX_QUEUED: usize = 150;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// A pad index or touch value out of range.
    Invalid,
    /// The control channel refused a message; the session is over.
    Sink,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionKind {
    Accel = 0,
    Gyro = 1,
}

impl MotionKind {
    pub fn from_wire(kind: u8) -> Option<Self> {
        match kind {
            MOTION_ACCEL => Some(Self::Accel),
            MOTION_GYRO => Some(Self::Gyro),
            _ => None,
        }
    }

    fn wire(self) -> u8 {
        match self {
            Self::Accel => MOTION_ACCEL,
            Self::Gyro => MOTION_GYRO,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchAction {
    Down,
    Move,
    Up,
}

/// One finger, positions and pressure in 0 to 1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Touch {
    pub id: u32,
    pub action: TouchAction,
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
}

/// What the host asked for, for the console's motors and sensors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Feedback {
    /// Pad motors with the trigger motors folded in, as Switch pads have none.
    Rumble { player: u8, low: u16, high: u16 },
    MotionRate {
        player: u8,
        kind: MotionKind,
        rate_hz: u16,
    },
}

/// Report rate per pad and sensor in Hz; 0 means the host wants none.
type Rates = [[u16; 2]; PADS];

/// Samples arrive in bursts with the input records, so a burst sends at most one per quarter
/// period of the rate the host asked for.
#[derive(Default)]
struct MotionGate {
    next_us: [[u64; 2]; PADS],
}

impl MotionGate {
    fn due(&mut self, rates: &Rates, pad: usize, kind: MotionKind, now_us: u64) -> bool {
        let rate = rates[pad][kind as usize];
        if rate == 0 {
            return false;
        }
        let next = &mut self.next_us[pad][kind as usize];
        if now_us < *next {
            return false;
        }
        let period = 1_000_000 / u64::from(rate);
        *next = (*next + period).max(now_us + period / 4);
        true
    }
}

#[derive(Clone, Copy, Default)]
struct Motors {
    low: u16,
    high: u16,
    left: u16,
    right: u16,
}

pub struct Session {
    features: u32,
    active: u16,
    live: bool,
    queue: Vec<Packet>,
    rates: Rates,
    gate: MotionGate,
    motors: [Motors; PADS],
    mouse_finger: Option<u32>,
}

impl Session {
    /// `features` are the host's Sunshine feature flags from its RTSP answer.
    pub fn new(features: u32) -> Self {
        Self {
            features,
            active: 1,
            live: false,
            queue: Vec::new(),
            rates: [[0; 2]; PADS],
            gate: MotionGate::default(),
            motors: [Motors::default(); PADS],
            mouse_finger: None,
        }
    }

    /// Enables haptics, frees every pad an earlier session may have left on the host, and then
    /// announces the primary. Each pad has its own reliable ordered channel, so the removals
    /// reach the host before the arrival without a pause.
    pub fn connect(&mut self) {
        self.active = 1;
        self.live = true;
        self.queue.push(input::enable_haptics());
        for index in 0..PADS as u8 {
            self.queue
                .push(input::multi_controller(index, 0, &PadValues::default()));
        }
        self.arrive(0);
    }

    /// Removes every pad, in player order, while the connection still runs so the host frees
    /// them, and lets go of the mouse button a finger may hold.
    pub fn disconnect(&mut self) {
        if !core::mem::take(&mut self.live) {
            return;
        }
        for index in 0..PADS as u8 {
            let bit = 1 << index;
            if self.active & bit != 0 {
                self.active &= !bit;
                self.queue.push(input::multi_controller(
                    index,
                    self.active,
                    &PadValues::default(),
                ));
            }
        }
        if self.mouse_finger.take().is_some() {
            self.queue
                .push(input::mouse_button(input::MOUSE_RELEASE, input::MOUSE_LEFT));
        }
        self.motors = [Motors::default(); PADS];
    }

    pub fn active_mask(&self) -> u16 {
        self.active
    }

    fn arrive(&mut self, index: u8) {
        self.queue.push(input::controller_arrival(
            index,
            TYPE_UNKNOWN,
            ARRIVAL_CAPS,
            ARRIVAL_BUTTONS,
        ));
        self.queue.push(input::multi_controller(
            index,
            self.active,
            &PadValues::default(),
        ));
    }

    /// One pad's state. A pad that connects is announced first; one that leaves is removed with
    /// all values released, so the host never keeps a held button of a vanished pad. The
    /// primary stays present.
    pub fn pad(&mut self, index: u8, connected: bool, values: &PadValues) -> Result<(), Error> {
        if usize::from(index) >= PADS {
            return Err(Error::Invalid);
        }
        let bit = 1 << index;
        let was = self.active;
        if index != 0 {
            if connected {
                self.active |= bit;
            } else {
                self.active &= !bit;
            }
        }
        if index != 0 && connected && was & bit == 0 {
            self.arrive(index);
        }
        let released = PadValues::default();
        let values = if connected { values } else { &released };
        self.queue
            .push(input::multi_controller(index, self.active, values));
        Ok(())
    }

    /// Motion in m/s^2 and deg/s. It goes out only for sensors the host asked for, no faster
    /// than the rate it gave, and only if the host supports it.
    pub fn motion(
        &mut self,
        index: u8,
        accel: [f32; 3],
        gyro: [f32; 3],
        now_us: u64,
    ) -> Result<(), Error> {
        let pad = usize::from(index);
        if pad >= PADS
            || ![accel, gyro]
                .iter()
                .flatten()
                .all(|value| value.is_finite())
        {
            return Err(Error::Invalid);
        }
        if self.features & FEATURE_CONTROLLER_TOUCH == 0 {
            return Ok(());
        }
        for (kind, sample) in [(MotionKind::Accel, accel), (MotionKind::Gyro, gyro)] {
            if self.gate.due(&self.rates, pad, kind, now_us) {
                self.queue
                    .push(input::controller_motion(index, kind.wire(), sample));
            }
        }
        Ok(())
    }

    /// The first finger down drives the mouse when `mouse` asks for it or the host has no touch:
    /// position follows it and the left button is held while it touches.
    pub fn touch(&mut self, mouse: bool, events: &[Touch]) -> Result<(), Error> {
        let in_range = |value: f32| (0.0..=1.0).contains(&value);
        if events.is_empty()
            || events
                .iter()
                .any(|event| !(in_range(event.x) && in_range(event.y) && in_range(event.pressure)))
        {
            return Err(Error::Invalid);
        }
        let following = self
            .mouse_finger
            .is_some_and(|finger| events.iter().any(|event| event.id == finger));
        if mouse || following || self.features & FEATURE_PEN_TOUCH == 0 {
            self.mouse(events);
            return Ok(());
        }
        for event in events {
            let action = match event.action {
                TouchAction::Down => input::TOUCH_DOWN,
                TouchAction::Move => input::TOUCH_MOVE,
                TouchAction::Up => input::TOUCH_UP,
            };
            self.queue.push(input::touch(
                action,
                event.id.min(i32::MAX as u32),
                event.x,
                event.y,
                event.pressure,
                [0.0, 0.0],
                input::ROTATION_UNKNOWN,
            ));
        }
        Ok(())
    }

    fn mouse(&mut self, events: &[Touch]) {
        for event in events {
            match (event.action, self.mouse_finger) {
                (TouchAction::Down, None) => self.mouse_finger = Some(event.id),
                (_, Some(finger)) if finger == event.id => {}
                _ => continue,
            }
            self.queue.push(input::mouse_position(
                (event.x * MOUSE_GRID) as i16,
                (event.y * MOUSE_GRID) as i16,
                MOUSE_GRID as i16,
                MOUSE_GRID as i16,
            ));
            let action = match event.action {
                TouchAction::Down => input::MOUSE_PRESS,
                TouchAction::Up => input::MOUSE_RELEASE,
                TouchAction::Move => continue,
            };
            if event.action == TouchAction::Up {
                self.mouse_finger = None;
            }
            self.queue
                .push(input::mouse_button(action, input::MOUSE_LEFT));
        }
    }

    pub fn key(&mut self, key: i16, down: bool, modifiers: u8) {
        self.queue.push(input::keyboard(key, down, modifiers, 0));
    }

    pub fn mouse_move(&mut self, dx: i16, dy: i16) {
        self.queue.push(input::mouse_move(dx, dy));
    }

    pub fn mouse_button(&mut self, pressed: bool, button: u8) {
        let action = if pressed {
            input::MOUSE_PRESS
        } else {
            input::MOUSE_RELEASE
        };
        self.queue.push(input::mouse_button(action, button));
    }

    pub fn scroll(&mut self, amount: i16) {
        self.queue.push(input::scroll(amount));
    }

    pub fn text(&mut self, text: &str) {
        self.queue.extend(input::utf8_text(text));
    }

    /// The packets waiting, oldest first.
    pub fn pending(&self) -> &[Packet] {
        &self.queue
    }

    /// Sends what the control channel takes. A full window leaves the rest queued for the next
    /// call, after dropping the moves and motion that no longer matter; state changes are
    /// never dropped.
    pub fn flush(&mut self, sender: &mut impl ControlSender) -> Result<(), Error> {
        let mut excess = self.queue.len().saturating_sub(MAX_QUEUED);
        self.queue.retain(|packet| {
            let drop = excess > 0 && !packet.reliable;
            excess -= usize::from(drop);
            !drop
        });
        let mut sent = 0;
        let mut result = Ok(());
        for packet in &self.queue {
            let delivery = if packet.reliable {
                Delivery::Reliable
            } else {
                Delivery::Unreliable
            };
            match sender.send(kind::INPUT, packet.channel, delivery, &packet.data) {
                Ok(()) => sent += 1,
                Err(SendError::Full) => break,
                Err(_) => {
                    result = Err(Error::Sink);
                    break;
                }
            }
        }
        self.queue.drain(..sent);
        result
    }

    /// Applies one host request. Pads above the console's routing and requests that do not
    /// move a pad are ignored.
    pub fn host(&mut self, event: HostEvent) -> Option<Feedback> {
        match event {
            HostEvent::Rumble {
                controller,
                low,
                high,
            } => {
                let motors = self.motors.get_mut(usize::from(controller))?;
                (motors.low, motors.high) = (low, high);
                Some(folded(controller as u8, motors))
            }
            HostEvent::TriggerRumble {
                controller,
                left,
                right,
            } => {
                let motors = self.motors.get_mut(usize::from(controller))?;
                (motors.left, motors.right) = (left, right);
                Some(folded(controller as u8, motors))
            }
            HostEvent::Motion {
                controller,
                rate_hz,
                kind,
            } => {
                let kind = MotionKind::from_wire(kind)?;
                let pad = usize::from(controller);
                let rates = self.rates.get_mut(pad)?;
                if rates[kind as usize] != rate_hz {
                    rates[kind as usize] = rate_hz;
                    self.gate.next_us[pad][kind as usize] = 0;
                }
                Some(Feedback::MotionRate {
                    player: controller as u8,
                    kind,
                    rate_hz,
                })
            }
            _ => None,
        }
    }
}

fn folded(player: u8, motors: &Motors) -> Feedback {
    Feedback::Rumble {
        player,
        low: motors.low.max(motors.left),
        high: motors.high.max(motors.right),
    }
}
