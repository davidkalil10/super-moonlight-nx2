use serde::{Deserialize, Deserializer, Serialize};

const LIMIT: usize = 3840;
const MAX_TOUCH: usize = 32;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pad {
    connected: bool,
    button_flags: u16,
    left_trigger: u8,
    right_trigger: u8,
    left_stick_x: i16,
    left_stick_y: i16,
    right_stick_x: i16,
    right_stick_y: i16,
}
impl Pad {
    fn released() -> Self {
        Self {
            connected: false,
            button_flags: 0,
            left_trigger: 0,
            right_trigger: 0,
            left_stick_x: 0,
            left_stick_y: 0,
            right_stick_x: 0,
            right_stick_y: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Action {
    Down,
    Move,
    Up,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Touch {
    id: u32,
    action: Action,
    x: f64,
    y: f64,
    pressure: f64,
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    v: u8,
    #[serde(default, deserialize_with = "present")]
    pad: Option<Pad>,
    #[serde(default, deserialize_with = "present")]
    touch: Option<Vec<Touch>>,
    #[serde(default, deserialize_with = "present")]
    stop: Option<bool>,
}

#[derive(Serialize)]
struct Controller<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(flatten)]
    pad: &'a Pad,
}
#[derive(Serialize)]
struct Touches<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    events: &'a [Touch],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    TooManyTouches,
    Stopped,
}

pub struct Output {
    pub lines: Vec<Vec<u8>>,
    pub stop: bool,
}

#[derive(Default)]
pub struct Forwarder {
    last_pad: Option<Pad>,
    active: Vec<Touch>,
    stopped: bool,
}

impl Forwarder {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn apply(&mut self, bytes: &[u8]) -> Result<Output, Error> {
        if self.stopped {
            return Err(Error::Stopped);
        }
        if bytes.is_empty() || bytes.len() > LIMIT {
            return Err(Error::Invalid);
        }
        let record: Record = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        if record.v != 1
            || record.stop == Some(false)
            || (record.pad.is_none() && record.touch.is_none() && record.stop.is_none())
        {
            return Err(Error::Invalid);
        }
        if let Some(touches) = &record.touch
            && (touches.is_empty()
                || touches.len() > MAX_TOUCH
                || touches.iter().any(|event| {
                    ![event.x, event.y, event.pressure]
                        .iter()
                        .all(|v| (0.0..=1.0).contains(v))
                }))
        {
            return Err(Error::Invalid);
        }
        let mut active = self.active.clone();
        let mut touches_out = Vec::new();
        for touch in record.touch.unwrap_or_default() {
            let index = active.iter().position(|item| item.id == touch.id);
            match (touch.action, index) {
                (Action::Down, Some(i)) | (Action::Move, Some(i)) => active[i] = touch.clone(),
                (Action::Down, None) => {
                    if active.len() == MAX_TOUCH {
                        return Err(Error::TooManyTouches);
                    }
                    active.push(touch.clone());
                }
                (Action::Up, Some(i)) => {
                    active.remove(i);
                }
                (Action::Move | Action::Up, None) => continue,
            }
            touches_out.push(touch);
        }
        let mut lines = Vec::new();
        if let Some(pad) = &record.pad
            && self.last_pad.as_ref() != Some(pad)
        {
            lines.push(
                serde_json::to_vec(&Controller {
                    kind: "controller",
                    pad,
                })
                .map_err(|_| Error::Invalid)?,
            );
        }
        if !touches_out.is_empty() {
            lines.push(
                serde_json::to_vec(&Touches {
                    kind: "touch",
                    events: &touches_out,
                })
                .map_err(|_| Error::Invalid)?,
            );
        }
        self.active = active;
        if let Some(pad) = record.pad {
            self.last_pad = Some(pad);
        }
        let stop = record.stop == Some(true);
        self.stopped = stop;
        Ok(Output { lines, stop })
    }
    pub fn release(&mut self) -> Output {
        let pad = Pad::released();
        let mut lines = vec![
            serde_json::to_vec(&Controller {
                kind: "controller",
                pad: &pad,
            })
            .expect("controller encoding"),
        ];
        let touches: Vec<_> = self
            .active
            .drain(..)
            .map(|mut touch| {
                touch.action = Action::Up;
                touch.pressure = 0.0;
                touch
            })
            .collect();
        if !touches.is_empty() {
            lines.push(
                serde_json::to_vec(&Touches {
                    kind: "touch",
                    events: &touches,
                })
                .expect("touch encoding"),
            );
        }
        self.last_pad = Some(pad);
        self.stopped = true;
        Output { lines, stop: true }
    }
}
