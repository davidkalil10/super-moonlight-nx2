//! The console's input towards Sunshine without the helper: reads the version 1 and 2 input
//! records the recorder writes, as the helper's forwarder does, and drives a `sunshine::session`
//! session from them. Host rumble comes back as the replies the console already drives its
//! motors with.

extern crate alloc;

use crate::json::{self, Kind, Value};
use crate::pointer::{KeyboardSample, MouseSample, Pointer};
use crate::reply::{RUMBLE_PLAYERS, Rumble};
use alloc::vec::Vec;
use moonlight_nx2_sunshine::control::{ControlSender, HostEvent};
use moonlight_nx2_sunshine::input::PadValues;
use moonlight_nx2_sunshine::session::{self, Feedback, PADS, Session, Touch, TouchAction};

const LIMIT: usize = 3840;
const MAX_TOUCH: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    TooManyTouches,
    Stopped,
    Link,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pad {
    connected: bool,
    values: PadValues,
}

struct Sample {
    index: u8,
    accel: [f32; 3],
    gyro: [f32; 3],
}

#[derive(Default)]
struct Record {
    pad: Option<Pad>,
    pads: Vec<(u8, Pad)>,
    motion: Vec<Sample>,
    touch: Vec<Touch>,
    touch_given: bool,
    mouse: Option<bool>,
    stop: Option<bool>,
}

pub struct DirectInput {
    session: Session,
    pointer: Pointer,
    last_pad: [Option<Pad>; PADS],
    fingers: Vec<Touch>,
    stopped: bool,
}

impl DirectInput {
    /// `features` are the host's Sunshine feature flags.
    pub fn new(features: u32) -> Self {
        Self {
            session: Session::new(features),
            pointer: Pointer::default(),
            last_pad: [None; PADS],
            fingers: Vec::new(),
            stopped: false,
        }
    }

    pub fn connect(&mut self) {
        self.session.connect();
    }

    /// Turns one record into packets; true after the record that stops the session.
    pub fn apply(&mut self, bytes: &[u8], now_us: u64) -> Result<bool, Error> {
        if self.stopped {
            return Err(Error::Stopped);
        }
        if bytes.is_empty() || bytes.len() > LIMIT {
            return Err(Error::Invalid);
        }
        let record = parse(bytes)?;
        let mut fingers = self.fingers.clone();
        let mut touches = Vec::new();
        for touch in record.touch {
            let known = fingers.iter().position(|finger| finger.id == touch.id);
            match (touch.action, known) {
                (TouchAction::Down | TouchAction::Move, Some(at)) => fingers[at] = touch,
                (TouchAction::Down, None) => {
                    if fingers.len() == MAX_TOUCH {
                        return Err(Error::TooManyTouches);
                    }
                    fingers.push(touch);
                }
                (TouchAction::Up, Some(at)) => {
                    fingers.remove(at);
                }
                (TouchAction::Move | TouchAction::Up, None) => continue,
            }
            touches.push(touch);
        }
        let pads = record
            .pad
            .map(|pad| (0, pad))
            .into_iter()
            .chain(record.pads);
        for (index, pad) in pads {
            if self.last_pad[usize::from(index)] != Some(pad) {
                self.session
                    .pad(index, pad.connected, &pad.values)
                    .map_err(|_| Error::Invalid)?;
                self.last_pad[usize::from(index)] = Some(pad);
            }
        }
        for sample in record.motion {
            self.session
                .motion(sample.index, sample.accel, sample.gyro, now_us)
                .map_err(|_| Error::Invalid)?;
        }
        if !touches.is_empty() {
            self.session
                .touch(record.mouse == Some(true), &touches)
                .map_err(|_| Error::Invalid)?;
        }
        self.fingers = fingers;
        self.stopped = record.stop == Some(true);
        Ok(self.stopped)
    }

    /// Releases the primary pad, every other pad still connected and all fingers.
    pub fn release(&mut self) {
        for index in 0..PADS {
            let connected = self.last_pad[index].is_some_and(|pad| pad.connected);
            if index == 0 || connected {
                let _ = self.session.pad(index as u8, false, &PadValues::default());
                self.last_pad[index] = None;
            }
        }
        let lifted: Vec<Touch> = self
            .fingers
            .drain(..)
            .map(|finger| Touch {
                action: TouchAction::Up,
                pressure: 0.0,
                ..finger
            })
            .collect();
        if !lifted.is_empty() {
            let _ = self.session.touch(false, &lifted);
        }
        self.pointer.release(&mut self.session);
        self.stopped = true;
    }

    /// The USB mouse since the last sample; changes only.
    pub fn mouse(&mut self, sample: &MouseSample) {
        self.pointer.mouse(sample, &mut self.session);
    }

    /// The USB keyboard now; `None` when none is attached.
    pub fn keyboard(&mut self, sample: Option<&KeyboardSample>) {
        self.pointer.keyboard(sample, &mut self.session);
    }

    /// Removes every pad on the host while the connection still runs.
    pub fn disconnect(&mut self) {
        self.session.disconnect();
    }

    pub fn flush(&mut self, sender: &mut impl ControlSender) -> Result<(), Error> {
        self.session
            .flush(sender)
            .map_err(|_: session::Error| Error::Link)
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    /// The motor command a host event asks for, if it is one; motion requests set the report
    /// rates for later records.
    pub fn host_event(&mut self, event: HostEvent) -> Option<Rumble> {
        match self.session.host(event)? {
            Feedback::Rumble { player, low, high } if player < RUMBLE_PLAYERS => {
                Some(Rumble { player, low, high })
            }
            _ => None,
        }
    }
}

fn parse(bytes: &[u8]) -> Result<Record, Error> {
    let root = json::parse(bytes).map_err(|_| Error::Invalid)?;
    if root.kind() != Kind::Object {
        return Err(Error::Invalid);
    }
    let mut record = Record::default();
    let mut version = 0;
    for (key, value) in root.members() {
        if key.string_is("v") {
            version = value.as_u64().ok_or(Error::Invalid)?;
        } else if key.string_is("pad") {
            record.pad = Some(pad(value)?);
        } else if key.string_is("pads") {
            record.pads = list(value, |item| {
                let index = item.member("index").and_then(|index| index.as_u64());
                let index =
                    u8::try_from(index.ok_or(Error::Invalid)?).map_err(|_| Error::Invalid)?;
                let inner = item.member("pad").ok_or(Error::Invalid)?;
                Ok((index, pad(inner)?))
            })?;
        } else if key.string_is("motion") {
            record.motion = list(value, sample)?;
        } else if key.string_is("touch") {
            record.touch_given = true;
            record.touch = list(value, touch)?;
        } else if key.string_is("mouse") {
            record.mouse = Some(value.as_bool().ok_or(Error::Invalid)?);
        } else if key.string_is("stop") {
            record.stop = Some(value.as_bool().ok_or(Error::Invalid)?);
        } else {
            return Err(Error::Invalid);
        }
    }
    check(&record, version)?;
    Ok(record)
}

fn check(record: &Record, version: u64) -> Result<(), Error> {
    let extended = !record.pads.is_empty() || !record.motion.is_empty() || record.mouse.is_some();
    let any = record.pad.is_some()
        || record.touch_given
        || record.stop.is_some()
        || !record.pads.is_empty()
        || !record.motion.is_empty();
    let pads = record
        .pads
        .iter()
        .all(|(index, _)| (1..PADS as u8).contains(index))
        && distinct(record.pads.iter().map(|(index, _)| *index));
    let motion = record
        .motion
        .iter()
        .all(|sample| usize::from(sample.index) < PADS)
        && distinct(record.motion.iter().map(|sample| sample.index));
    let touches =
        record.touch.len() <= MAX_TOUCH && (!record.touch_given || !record.touch.is_empty());
    let valid = match version {
        1 => !extended && any,
        2 => {
            any && pads
                && motion
                && record.mouse != Some(false)
                && (record.mouse.is_none() || record.touch_given)
        }
        _ => false,
    };
    if valid && touches && record.stop != Some(false) {
        Ok(())
    } else {
        Err(Error::Invalid)
    }
}

fn distinct(indexes: impl Iterator<Item = u8>) -> bool {
    let mut seen = 0u32;
    indexes.into_iter().all(|index| {
        let bit = 1u32 << index.min(31);
        let new = seen & bit == 0;
        seen |= bit;
        new
    })
}

fn list<T>(
    value: Value<'_>,
    mut item: impl FnMut(Value<'_>) -> Result<T, Error>,
) -> Result<Vec<T>, Error> {
    if value.kind() != Kind::Array {
        return Err(Error::Invalid);
    }
    value.elements().map(&mut item).collect()
}

fn integer<T: TryFrom<i64>>(value: Value<'_>, key: &str) -> Result<T, Error> {
    let number = value.member(key).and_then(|number| number.as_i64());
    T::try_from(number.ok_or(Error::Invalid)?).map_err(|_| Error::Invalid)
}

fn pad(value: Value<'_>) -> Result<Pad, Error> {
    let connected = value
        .member("connected")
        .and_then(|flag| flag.as_bool())
        .ok_or(Error::Invalid)?;
    Ok(Pad {
        connected,
        values: PadValues {
            buttons: integer::<u16>(value, "buttonFlags")?.into(),
            left_trigger: integer(value, "leftTrigger")?,
            right_trigger: integer(value, "rightTrigger")?,
            left_x: integer(value, "leftStickX")?,
            left_y: integer(value, "leftStickY")?,
            right_x: integer(value, "rightStickX")?,
            right_y: integer(value, "rightStickY")?,
        },
    })
}

fn triple(value: Value<'_>, key: &str) -> Result<[f32; 3], Error> {
    let array = value.member(key).ok_or(Error::Invalid)?;
    let mut out = [0.0; 3];
    let mut count = 0;
    for element in list(array, |element| element.as_i64().ok_or(Error::Invalid))? {
        *out.get_mut(count).ok_or(Error::Invalid)? = element as f32 / 1000.0;
        count += 1;
    }
    if count == 3 {
        Ok(out)
    } else {
        Err(Error::Invalid)
    }
}

fn sample(value: Value<'_>) -> Result<Sample, Error> {
    Ok(Sample {
        index: integer(value, "index")?,
        accel: triple(value, "accel")?,
        gyro: triple(value, "gyro")?,
    })
}

fn decimal(value: Value<'_>, key: &str) -> Result<f32, Error> {
    let member = value.member(key).ok_or(Error::Invalid)?;
    let text = core::str::from_utf8(member.raw()).map_err(|_| Error::Invalid)?;
    text.parse().map_err(|_| Error::Invalid)
}

fn touch(value: Value<'_>) -> Result<Touch, Error> {
    let action = value.member("action").ok_or(Error::Invalid)?;
    let action = if action.string_is("down") {
        TouchAction::Down
    } else if action.string_is("move") {
        TouchAction::Move
    } else if action.string_is("up") {
        TouchAction::Up
    } else {
        return Err(Error::Invalid);
    };
    Ok(Touch {
        id: integer(value, "id")?,
        action,
        x: decimal(value, "x")?,
        y: decimal(value, "y")?,
        pressure: decimal(value, "pressure")?,
    })
}
