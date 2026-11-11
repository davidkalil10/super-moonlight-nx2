use super::native;
use moonlight_nx2_host::gamepads::{Gamepads, MotionGate, MotionKind, MotionRates, PADS};
use serde::Deserialize;
use std::time::Instant;

const MAX_LINE: usize = 3840;
const MAX_TOUCHES: usize = 32;
/// Touch positions reach the mouse on this virtual grid.
const MOUSE_GRID: f64 = 10_000.0;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Message {
    #[serde(rename_all = "camelCase")]
    Controller {
        #[serde(default)]
        index: u8,
        connected: bool,
        button_flags: u16,
        left_trigger: u8,
        right_trigger: u8,
        left_stick_x: i16,
        left_stick_y: i16,
        right_stick_x: i16,
        right_stick_y: i16,
    },
    Touch {
        #[serde(default)]
        mouse: bool,
        events: Vec<Touch>,
    },
    Motion {
        index: u8,
        accel: [f32; 3],
        gyro: [f32; 3],
    },
    RequestIdr {},
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Touch {
    id: u32,
    action: Action,
    x: f64,
    y: f64,
    pressure: f64,
}

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Action {
    Down,
    Move,
    Up,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Backend,
}

/// The primary pad (index 0) is announced by the stream worker; other players are announced here
/// when they connect and leave the active mask when they disconnect.
pub struct DirectInput {
    touch_supported: Option<bool>,
    gamepads: Gamepads,
    motion_supported: bool,
    motion: MotionGate,
    motion_rates: MotionRates,
    started: Instant,
    live: bool,
    mouse_finger: Option<u32>,
}

impl Default for DirectInput {
    fn default() -> Self {
        Self {
            touch_supported: None,
            gamepads: Gamepads::default(),
            motion_supported: true,
            motion: MotionGate::default(),
            motion_rates: [[0; 2]; PADS],
            started: Instant::now(),
            live: false,
            mouse_finger: None,
        }
    }
}

impl DirectInput {
    /// Frees every pad an earlier session may have left on the host, so the primary arrives
    /// fresh with this session's type and sensors, then announces it.
    pub fn connect(&mut self) {
        for index in 0..PADS as u8 {
            send_empty(index, 0);
        }
        eprintln!("{{\"event\":\"controller\",\"action\":\"reset\",\"mask\":0}}");
        self.gamepads = Gamepads::default();
        announce(0, self.gamepads.mask());
        self.live = true;
    }

    /// Removes every pad while the connection still runs, so the host frees them.
    pub fn disconnect(&mut self) {
        if !std::mem::take(&mut self.live) {
            return;
        }
        for update in self.gamepads.remove_all() {
            send_empty(update.index, update.mask);
            log_controller("removal", update.index, update.mask);
        }
    }

    pub fn handle(&mut self, line: &[u8]) -> Result<Vec<bool>, Error> {
        if line.is_empty() || line.len() > MAX_LINE {
            return Err(Error::Invalid);
        }
        let message: Message = serde_json::from_slice(line).map_err(|_| Error::Invalid)?;
        match message {
            Message::Controller {
                index,
                connected,
                button_flags,
                left_trigger,
                right_trigger,
                left_stick_x,
                left_stick_y,
                right_stick_x,
                right_stick_y,
            } => {
                if usize::from(index) >= PADS {
                    return Err(Error::Invalid);
                }
                let was = self.gamepads.mask();
                let update = self.gamepads.update(index, connected);
                if update.arrived {
                    announce(index, update.mask);
                } else if update.mask != was {
                    log_controller("removal", index, update.mask);
                }
                let result = unsafe {
                    native::LiSendMultiControllerEvent(
                        i16::from(index),
                        update.mask as i16,
                        i32::from(button_flags),
                        left_trigger,
                        right_trigger,
                        left_stick_x,
                        left_stick_y,
                        right_stick_x,
                        right_stick_y,
                    )
                };
                if result != 0 {
                    return Err(Error::Backend);
                }
                Ok(Vec::new())
            }
            Message::RequestIdr {} => {
                unsafe { native::LiRequestIdrFrame() };
                Ok(Vec::new())
            }
            Message::Touch { mouse, events } => self.touch(mouse, events),
            Message::Motion { index, accel, gyro } => {
                if usize::from(index) >= PADS
                    || ![accel, gyro]
                        .iter()
                        .flatten()
                        .all(|value| value.is_finite())
                {
                    return Err(Error::Invalid);
                }
                self.motion(index, accel, gyro);
                Ok(Vec::new())
            }
        }
    }

    /// The report rates the host asked for, read from the listener before each batch of input.
    pub fn set_motion_rates(&mut self, rates: MotionRates) {
        for (index, (old, new)) in self.motion_rates.iter().zip(&rates).enumerate() {
            if old != new {
                eprintln!(
                    "{{\"event\":\"motion-request\",\"controller\":{index},\"accel\":{},\"gyro\":{}}}",
                    new[0], new[1]
                );
            }
        }
        self.motion_rates = rates;
        self.motion.set_rates(&rates);
    }

    /// Motion goes out only as the host asked for it. It is best effort: a host without motion
    /// support stops it for the session.
    fn motion(&mut self, index: u8, accel: [f32; 3], gyro: [f32; 3]) {
        if !self.motion_supported {
            return;
        }
        let now_us = self.started.elapsed().as_micros() as u64;
        for (kind, wire, [x, y, z]) in [
            (MotionKind::Accel, native::LI_MOTION_TYPE_ACCEL, accel),
            (MotionKind::Gyro, native::LI_MOTION_TYPE_GYRO, gyro),
        ] {
            if !self.motion.due(index, kind, now_us) {
                continue;
            }
            let result = unsafe { native::LiSendControllerMotionEvent(index, wire as u8, x, y, z) };
            if result == native::LI_ERR_UNSUPPORTED {
                self.motion_supported = false;
                eprintln!("{{\"event\":\"motion\",\"supported\":false}}");
                return;
            }
        }
    }

    /// The first finger down drives the mouse: position follows it, the left button is held
    /// while it touches. Later fingers are ignored until it lifts.
    fn mouse(&mut self, events: &[Touch]) -> Result<(), Error> {
        let mut failed = false;
        for event in events {
            match (event.action, self.mouse_finger) {
                (Action::Down, None) => self.mouse_finger = Some(event.id),
                (_, Some(finger)) if finger == event.id => {}
                _ => continue,
            }
            let position = unsafe {
                native::LiSendMousePositionEvent(
                    (event.x * MOUSE_GRID) as i16,
                    (event.y * MOUSE_GRID) as i16,
                    MOUSE_GRID as i16,
                    MOUSE_GRID as i16,
                )
            };
            failed |= position != 0;
            let action = match event.action {
                Action::Down => native::BUTTON_ACTION_PRESS,
                Action::Up => native::BUTTON_ACTION_RELEASE,
                Action::Move => continue,
            };
            if event.action == Action::Up {
                self.mouse_finger = None;
            }
            let button =
                unsafe { native::LiSendMouseButtonEvent(action as _, native::BUTTON_LEFT as i32) };
            failed |= button != 0;
        }
        if failed { Err(Error::Backend) } else { Ok(()) }
    }

    fn touch(&mut self, mouse: bool, events: Vec<Touch>) -> Result<Vec<bool>, Error> {
        if events.is_empty()
            || events.len() > MAX_TOUCHES
            || events.iter().any(|event| {
                ![event.x, event.y, event.pressure]
                    .iter()
                    .all(|number| (0.0..=1.0).contains(number))
            })
        {
            return Err(Error::Invalid);
        }
        // A finger already driving the mouse keeps doing so until it lifts.
        let following = self
            .mouse_finger
            .is_some_and(|finger| events.iter().any(|event| event.id == finger));
        if mouse || following {
            self.mouse(&events)?;
            return Ok(Vec::new());
        }
        let mut changes = Vec::new();
        let supported = *self.touch_supported.get_or_insert_with(|| {
            let supported =
                unsafe { native::LiGetHostFeatureFlags() } & native::LI_FF_PEN_TOUCH_EVENTS != 0;
            changes.push(supported);
            supported
        });
        if !supported {
            // Without host touch support the fingers fall back to the mouse.
            self.mouse(&events)?;
            return Ok(changes);
        }
        let mut failed = false;
        for event in &events {
            let action = match event.action {
                Action::Down => native::LI_TOUCH_EVENT_DOWN,
                Action::Move => native::LI_TOUCH_EVENT_MOVE,
                Action::Up => native::LI_TOUCH_EVENT_UP,
            };
            let result = unsafe {
                native::LiSendTouchEvent(
                    action as u8,
                    event.id.min(i32::MAX as u32),
                    event.x as f32,
                    event.y as f32,
                    event.pressure as f32,
                    0.0,
                    0.0,
                    native::LI_ROT_UNKNOWN as u16,
                )
            };
            if result == native::LI_ERR_UNSUPPORTED {
                self.touch_supported = Some(false);
                changes.push(false);
                self.mouse(&events)?;
                return Ok(changes);
            }
            failed |= result != 0;
        }
        if failed {
            Err(Error::Backend)
        } else {
            Ok(changes)
        }
    }
}

/// Announces a pad by its buttons and sensors but no type, so Sunshine picks a DualShock 4 or
/// DualSense for its motion unless the PC sets a gamepad type.
fn announce(index: u8, active: u16) {
    let buttons = native::A_FLAG
        | native::B_FLAG
        | native::X_FLAG
        | native::Y_FLAG
        | native::UP_FLAG
        | native::DOWN_FLAG
        | native::LEFT_FLAG
        | native::RIGHT_FLAG
        | native::LB_FLAG
        | native::RB_FLAG
        | native::PLAY_FLAG
        | native::BACK_FLAG
        | native::LS_CLK_FLAG
        | native::RS_CLK_FLAG
        | native::SPECIAL_FLAG;
    let capabilities = native::LI_CCAP_ANALOG_TRIGGERS
        | native::LI_CCAP_RUMBLE
        | native::LI_CCAP_TRIGGER_RUMBLE
        | native::LI_CCAP_ACCEL
        | native::LI_CCAP_GYRO;
    let result = unsafe {
        native::LiSendControllerArrivalEvent(
            index,
            active,
            native::LI_CTYPE_UNKNOWN as u8,
            buttons,
            capabilities as u16,
        )
    };
    eprintln!(
        "{{\"event\":\"controller\",\"action\":\"arrival\",\"controller\":{index},\"type\":\"unknown\",\"caps\":\"{capabilities:#x}\",\"mask\":\"{active:#x}\",\"result\":{result}}}"
    );
}

fn send_empty(index: u8, active: u16) {
    unsafe {
        native::LiSendMultiControllerEvent(i16::from(index), active as i16, 0, 0, 0, 0, 0, 0, 0)
    };
}

fn log_controller(action: &str, index: u8, active: u16) {
    eprintln!(
        "{{\"event\":\"controller\",\"action\":\"{action}\",\"controller\":{index},\"mask\":\"{active:#x}\"}}"
    );
}
