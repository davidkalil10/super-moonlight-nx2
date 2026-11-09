use serde::{Deserialize, Deserializer, Serialize};

const LIMIT: usize = 3840;
const MAX_TOUCH: usize = 32;
/// Host gamepads: the primary pad is 0, version-2 records add players 1 to 7.
const PADS: usize = 8;

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

/// A version-2 player beyond the primary pad.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexedPad {
    index: usize,
    pad: Pad,
}

/// A version-2 motion sample: 1/1000 m/s^2 and 1/1000 deg/s.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Motion {
    index: usize,
    accel: [i32; 3],
    gyro: [i32; 3],
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
    #[serde(default, deserialize_with = "present")]
    pads: Option<Vec<IndexedPad>>,
    #[serde(default, deserialize_with = "present")]
    motion: Option<Vec<Motion>>,
    #[serde(default, deserialize_with = "present")]
    mouse: Option<bool>,
}

impl Record {
    fn valid(&self) -> bool {
        let extended = self.pads.is_some() || self.motion.is_some() || self.mouse.is_some();
        let any = self.pad.is_some()
            || self.touch.is_some()
            || self.stop.is_some()
            || self.pads.is_some()
            || self.motion.is_some();
        let pads = self.pads.as_ref().is_none_or(|pads| {
            !pads.is_empty()
                && distinct(pads.iter().map(|pad| pad.index))
                && pads.iter().all(|pad| (1..PADS).contains(&pad.index))
        });
        let motion = self.motion.as_ref().is_none_or(|samples| {
            !samples.is_empty()
                && distinct(samples.iter().map(|sample| sample.index))
                && samples.iter().all(|sample| sample.index < PADS)
        });
        match self.v {
            1 => !extended && any,
            2 => {
                any && pads
                    && motion
                    && self.mouse != Some(false)
                    && (self.mouse.is_none() || self.touch.is_some())
            }
            _ => false,
        }
    }
}

fn distinct(indexes: impl Iterator<Item = usize>) -> bool {
    let mut seen = 0u32;
    indexes.into_iter().all(|index| {
        let bit = 1u32 << index.min(31);
        let new = seen & bit == 0;
        seen |= bit;
        new
    })
}

#[derive(Serialize)]
struct Controller<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    /// Omitted for the primary pad, so its line stays what the C helper reads.
    #[serde(skip_serializing_if = "is_primary")]
    index: usize,
    #[serde(flatten)]
    pad: &'a Pad,
}
#[derive(Serialize)]
struct Touches<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "core::ops::Not::not")]
    mouse: bool,
    events: &'a [Touch],
}
/// Motion in the units moonlight-common-c takes: m/s^2 and deg/s.
#[derive(Serialize)]
struct MotionLine {
    #[serde(rename = "type")]
    kind: &'static str,
    index: usize,
    accel: [f32; 3],
    gyro: [f32; 3],
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
    last_pad: [Option<Pad>; PADS],
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
        if !record.valid() || record.stop == Some(false) {
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
        let mut pads: Vec<(usize, Pad)> = record.pad.into_iter().map(|pad| (0, pad)).collect();
        pads.extend(
            record
                .pads
                .unwrap_or_default()
                .into_iter()
                .map(|indexed| (indexed.index, indexed.pad)),
        );
        let mut lines = Vec::new();
        for (index, pad) in &pads {
            if self.last_pad[*index].as_ref() != Some(pad) {
                lines.push(controller_line(*index, pad));
            }
        }
        for sample in record.motion.unwrap_or_default() {
            lines.push(
                serde_json::to_vec(&MotionLine {
                    kind: "motion",
                    index: sample.index,
                    accel: sample.accel.map(|value| value as f32 / 1000.0),
                    gyro: sample.gyro.map(|value| value as f32 / 1000.0),
                })
                .map_err(|_| Error::Invalid)?,
            );
        }
        if !touches_out.is_empty() {
            lines.push(
                serde_json::to_vec(&Touches {
                    kind: "touch",
                    mouse: record.mouse == Some(true),
                    events: &touches_out,
                })
                .map_err(|_| Error::Invalid)?,
            );
        }
        self.active = active;
        for (index, pad) in pads {
            self.last_pad[index] = Some(pad);
        }
        let stop = record.stop == Some(true);
        self.stopped = stop;
        Ok(Output { lines, stop })
    }
    /// Releases the primary pad, every other player still connected and all fingers.
    pub fn release(&mut self) -> Output {
        let pad = Pad::released();
        let mut lines = Vec::new();
        for (index, last) in self.last_pad.iter_mut().enumerate() {
            if index == 0 || last.as_ref().is_some_and(|last| last.connected) {
                lines.push(controller_line(index, &pad));
                *last = Some(pad.clone());
            }
        }
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
                    mouse: false,
                    events: &touches,
                })
                .expect("touch encoding"),
            );
        }
        self.stopped = true;
        Output { lines, stop: true }
    }
}

fn is_primary(index: &usize) -> bool {
    *index == 0
}

fn controller_line(index: usize, pad: &Pad) -> Vec<u8> {
    serde_json::to_vec(&Controller {
        kind: "controller",
        index,
        pad,
    })
    .expect("controller encoding")
}
