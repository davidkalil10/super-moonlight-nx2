use super::native;
use serde::Deserialize;

const MAX_LINE: usize = 3840;
const MAX_TOUCHES: usize = 32;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Message {
    #[serde(rename_all = "camelCase")]
    Controller {
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
        events: Vec<Touch>,
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

#[derive(Deserialize)]
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

#[derive(Default)]
pub struct DirectInput {
    touch_supported: Option<bool>,
}

impl DirectInput {
    pub fn handle(&mut self, line: &[u8]) -> Result<Vec<bool>, Error> {
        if line.is_empty() || line.len() > MAX_LINE {
            return Err(Error::Invalid);
        }
        let message: Message = serde_json::from_slice(line).map_err(|_| Error::Invalid)?;
        match message {
            Message::Controller {
                connected: _,
                button_flags,
                left_trigger,
                right_trigger,
                left_stick_x,
                left_stick_y,
                right_stick_x,
                right_stick_y,
            } => {
                let result = unsafe {
                    native::LiSendMultiControllerEvent(
                        0,
                        1,
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
            Message::Touch { events } => self.touch(events),
        }
    }

    fn touch(&mut self, events: Vec<Touch>) -> Result<Vec<bool>, Error> {
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
        let mut changes = Vec::new();
        let supported = *self.touch_supported.get_or_insert_with(|| {
            let supported =
                unsafe { native::LiGetHostFeatureFlags() } & native::LI_FF_PEN_TOUCH_EVENTS != 0;
            changes.push(supported);
            supported
        });
        if !supported {
            return Ok(changes);
        }
        let mut failed = false;
        for event in events {
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
