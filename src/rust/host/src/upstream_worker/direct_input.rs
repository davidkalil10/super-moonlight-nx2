use super::native;
use serde::Deserialize;

const MAX_LINE: usize = 3840;
const MAX_TOUCHES: usize = 32;
const PADS: u8 = 8;
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
/// when they first connect and leave the active mask when they disconnect.
pub struct DirectInput {
    touch_supported: Option<bool>,
    active: u16,
    announced: u16,
    motion_supported: bool,
    mouse_finger: Option<u32>,
}

impl Default for DirectInput {
    fn default() -> Self {
        Self {
            touch_supported: None,
            active: 1,
            announced: 1,
            motion_supported: true,
            mouse_finger: None,
        }
    }
}

impl DirectInput {
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
                if index >= PADS {
                    return Err(Error::Invalid);
                }
                let bit = 1u16 << index;
                if index != 0 {
                    if connected {
                        self.active |= bit;
                        if self.announced & bit == 0 {
                            self.announced |= bit;
                            announce(index, self.active);
                        }
                    } else {
                        self.active &= !bit;
                    }
                }
                let result = unsafe {
                    native::LiSendMultiControllerEvent(
                        i16::from(index),
                        self.active as i16,
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
                if index >= PADS
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

    /// Motion is best effort: a host without motion support stops it for the session.
    fn motion(&mut self, index: u8, accel: [f32; 3], gyro: [f32; 3]) {
        if !self.motion_supported {
            return;
        }
        for (kind, [x, y, z]) in [
            (native::LI_MOTION_TYPE_ACCEL, accel),
            (native::LI_MOTION_TYPE_GYRO, gyro),
        ] {
            let result = unsafe { native::LiSendControllerMotionEvent(index, kind as u8, x, y, z) };
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

/// Announces another player like the primary pad, with motion sensors.
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
    let capabilities =
        native::LI_CCAP_ANALOG_TRIGGERS | native::LI_CCAP_ACCEL | native::LI_CCAP_GYRO;
    unsafe {
        native::LiSendControllerArrivalEvent(
            index,
            active,
            native::LI_CTYPE_XBOX as u8,
            buttons,
            capabilities as u16,
        )
    };
}
