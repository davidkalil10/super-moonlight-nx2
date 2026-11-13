//! Client input recorder: the version-1 JSON input record sent with each video acknowledgement.
//! Port of dev legacy/src/streamer/input/input-record.js and touch.js; the Pad ABI never
//! reaches the socket.

use moonlight_nx2_core::input::{
    Pad, face_buttons_by_position, map_pad, map_pad_with_start_chord, stop_held,
};
use moonlight_nx2_io::media::MAX_INPUT_BYTES;
use moonlight_nx2_ui::{model::Screen, settings::ButtonLayout};

pub const VERSION: u32 = 1;
/// Records carrying more players, motion or mouse touches; a v1 host never receives them.
pub const VERSION_EXTENDED: u32 = 2;
/// Players 2 to 8, beyond the primary pad.
pub const EXTRA_PADS: usize = 7;
pub const MAX_POINTS: usize = 16;
pub const PANEL_WIDTH: f64 = 1280.0;
pub const PANEL_HEIGHT: f64 = 720.0;
pub const TOUCH_BYTES: usize = (HEADER_WORDS + MAX_POINTS * POINT_WORDS) * 4;

const HEADER_WORDS: usize = 4;
const POINT_WORDS: usize = 10;
const COUNT_WORD: usize = 2;
const ATTRIBUTES_WORD: usize = 2;
const FINGER_WORD: usize = 3;
const X_WORD: usize = 4;
const Y_WORD: usize = 5;
const ATTR_END: u32 = 0x2;
const UNIT: u16 = 10_000;

const PLUS: u64 = 1 << 10;

/// Plus quits the app outside a stream, on a fresh press only. After the screen changes every
/// button has to be let go first, so Plus still held from the stop chord does not quit.
#[derive(Default)]
pub struct ExitPress {
    screen: Option<Screen>,
    armed: bool,
    held: bool,
}

impl ExitPress {
    /// Whether `buttons` on `screen` ask to quit.
    pub fn update(&mut self, buttons: u64, screen: Screen) -> bool {
        if self.screen != Some(screen) {
            self.screen = Some(screen);
            self.armed = false;
        }
        self.armed |= buttons == 0;
        let held = buttons & PLUS != 0;
        let pressed = held && !self.held;
        self.held = held;
        pressed && self.armed && screen != Screen::Streaming
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    /// The record exceeds the 3840-byte bound; the stream must end, as the JS console did.
    TooLarge,
}

/// One frame's raw pad: NpadState buttons and sticks, already selected by the runtime.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PadState {
    pub connected: bool,
    pub buttons: u32,
    pub sticks: [i32; 4],
}

/// One motion sample: acceleration in 1/1000 m/s^2 with gravity, angular velocity in 1/1000
/// deg/s. The platform reads the Switch's axes; records carry SDL's, as Moonlight sends them.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Motion {
    pub accel: [i32; 3],
    pub gyro: [i32; 3],
}

impl Motion {
    /// The Switch has x right, y away from the player and z out of the face; SDL, like the
    /// DualShock 4, has x right, y out of the face and z toward the player.
    pub fn to_sdl_axes(self) -> Self {
        let turn = |[x, y, z]: [i32; 3]| [x, z, y.saturating_neg()];
        Self {
            accel: turn(self.accel),
            gyro: turn(self.gyro),
        }
    }
}

/// What a frame reads besides the primary pad and the touches: players 2 to 8 and one motion
/// sample per player (index 0 is the primary pad).
#[derive(Clone, Copy, Debug, Default)]
pub struct Extra {
    pub pads: [PadState; EXTRA_PADS],
    pub motion: [Option<Motion>; EXTRA_PADS + 1],
}

/// The extended part of one record.
#[derive(Default)]
struct Extended {
    pads: [Option<Pad>; EXTRA_PADS],
    motion: [Option<Motion>; EXTRA_PADS + 1],
    mouse: bool,
}

impl Extended {
    fn any_input(&self) -> bool {
        self.pads.iter().any(Option::is_some) || self.motion.iter().any(Option::is_some)
    }
}

/// One touch point, positions in 1/10000 of the panel (four decimals, as touch.js rounds).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Point {
    pub id: u32,
    pub x: u16,
    pub y: u16,
    pub ended: bool,
}

/// Points read from one frame's `nn::hid::TouchScreenState<16>` block.
#[derive(Clone, Copy, Debug, Default)]
pub struct Touches {
    points: [Point; MAX_POINTS],
    count: usize,
}

impl Touches {
    /// Parses the block, which may end after its last reported point.
    pub fn parse(bytes: &[u8]) -> Self {
        let mut touches = Self::default();
        let present = (bytes.len() / 4).saturating_sub(HEADER_WORDS) / POINT_WORDS;
        let reported = word(bytes, COUNT_WORD) as usize;
        touches.count = reported.min(MAX_POINTS).min(present);

        for index in 0..touches.count {
            let base = HEADER_WORDS + index * POINT_WORDS;
            touches.points[index] = Point {
                id: word(bytes, base + FINGER_WORD),
                x: unit(word(bytes, base + X_WORD) as i32, PANEL_WIDTH),
                y: unit(word(bytes, base + Y_WORD) as i32, PANEL_HEIGHT),
                ended: word(bytes, base + ATTRIBUTES_WORD) & ATTR_END != 0,
            };
        }
        touches
    }

    pub fn points(&self) -> &[Point] {
        &self.points[..self.count]
    }
}

fn word(bytes: &[u8], index: usize) -> u32 {
    let at = index * 4;
    match bytes.get(at..at + 4) {
        Some(raw) => u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]),
        None => 0,
    }
}

/// `Math.round(clamp01(value / size) * 1e4)`, computed in f64 as the JS did.
fn unit(value: i32, size: f64) -> u16 {
    let ratio = f64::from(value) / size;
    let clamped = ratio.clamp(0.0, 1.0);
    let scaled = clamped * 1e4;

    let whole = scaled as u32;
    let rounded = if scaled - f64::from(whole) >= 0.5 {
        whole + 1
    } else {
        whole
    };
    rounded.min(u32::from(UNIT)) as u16
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Down,
    Move,
    Up,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TouchEvent {
    pub id: u32,
    pub action: Action,
    pub x: u16,
    pub y: u16,
}

/// Room for a full frame of new fingers while a full set of lost ones still awaits removal.
const TRACKED: usize = 2 * MAX_POINTS;

/// Active fingers in first-seen order, like the JS Map.
#[derive(Clone, Copy, Debug)]
struct Tracker {
    ids: [u32; TRACKED],
    at: [(u16, u16); TRACKED],
    count: usize,
}

impl Tracker {
    const fn new() -> Self {
        Self {
            ids: [0; TRACKED],
            at: [(0, 0); TRACKED],
            count: 0,
        }
    }

    fn find(&self, id: u32) -> Option<usize> {
        self.ids[..self.count].iter().position(|known| *known == id)
    }

    fn contains(&self, id: u32) -> bool {
        self.find(id).is_some()
    }

    fn set(&mut self, id: u32, at: (u16, u16)) {
        if let Some(index) = self.find(id) {
            self.at[index] = at;
            return;
        }
        if self.count == TRACKED {
            return;
        }
        self.ids[self.count] = id;
        self.at[self.count] = at;
        self.count += 1;
    }

    fn delete(&mut self, id: u32) {
        let Some(index) = self.find(id) else {
            return;
        };
        self.ids.copy_within(index + 1..self.count, index);
        self.at.copy_within(index + 1..self.count, index);
        self.count -= 1;
    }

    /// touch.js `step`: down, move, up on end, and up at the last position for lost fingers.
    fn step(&mut self, points: &[Point], events: &mut Events) {
        let mut seen = [0u32; MAX_POINTS];
        let mut seen_count = 0;

        for point in points {
            let previous = self.find(point.id).map(|index| self.at[index]);
            if point.ended {
                if previous.is_some() {
                    events.push(point.id, Action::Up, (point.x, point.y));
                    self.delete(point.id);
                }
                continue;
            }

            seen[seen_count] = point.id;
            seen_count += 1;
            match previous {
                None => events.push(point.id, Action::Down, (point.x, point.y)),
                Some(at) if at != (point.x, point.y) => {
                    events.push(point.id, Action::Move, (point.x, point.y))
                }
                Some(_) => {}
            }
            self.set(point.id, (point.x, point.y));
        }

        let mut index = 0;
        while index < self.count {
            let id = self.ids[index];
            if seen[..seen_count].contains(&id) {
                index += 1;
                continue;
            }
            events.push(id, Action::Up, self.at[index]);
            self.delete(id);
        }
    }

    fn flush(&mut self, events: &mut Events) {
        for index in 0..self.count {
            events.push(self.ids[index], Action::Up, self.at[index]);
        }
        self.count = 0;
    }
}

pub const MAX_TOUCH_EVENTS: usize = 2 * MAX_POINTS;

struct Events {
    list: [TouchEvent; MAX_TOUCH_EVENTS],
    count: usize,
}

impl Events {
    fn new() -> Self {
        Self {
            list: [TouchEvent {
                id: 0,
                action: Action::Up,
                x: 0,
                y: 0,
            }; MAX_TOUCH_EVENTS],
            count: 0,
        }
    }

    fn push(&mut self, id: u32, action: Action, at: (u16, u16)) {
        if self.count == MAX_TOUCH_EVENTS {
            return;
        }
        self.list[self.count] = TouchEvent {
            id,
            action,
            x: at.0,
            y: at.1,
        };
        self.count += 1;
    }

    fn as_slice(&self) -> &[TouchEvent] {
        &self.list[..self.count]
    }
}

pub struct Recorder {
    tracker: Tracker,
    forwarded: Tracker,
    last_pad: Option<Pad>,
    held_across_gate: u32,
    last_extra: [Option<Pad>; EXTRA_PADS],
    held_extra: [u32; EXTRA_PADS],
    stopped: bool,
    start_chord: u64,
    layout: ButtonLayout,
}

impl Default for Recorder {
    fn default() -> Self {
        Self::new()
    }
}

impl Recorder {
    /// The shipped Civ7 recorder: no start chord, Plus is Start (`input-record.js`
    /// `toMoonlight(state, [])`; main, 2026-11-09T08:46Z).
    pub const fn new() -> Self {
        Self::with_start_chord(0)
    }

    /// A chord-aware recorder; `DEFAULT_START_CHORD` maps LS+RS held together to Start.
    pub const fn with_start_chord(chord: u64) -> Self {
        Self {
            tracker: Tracker::new(),
            forwarded: Tracker::new(),
            last_pad: None,
            held_across_gate: 0,
            last_extra: [None; EXTRA_PADS],
            held_extra: [0; EXTRA_PADS],
            stopped: false,
            start_chord: chord,
            layout: ButtonLayout::Nintendo,
        }
    }

    /// New recorders send the labels like Civ7; the driver sets the saved layout every frame.
    pub fn set_layout(&mut self, layout: ButtonLayout) {
        self.layout = layout;
    }

    fn laid_out(&self, mut pad: Pad) -> Pad {
        if self.layout == ButtonLayout::Xbox {
            pad.buttons = face_buttons_by_position(pad.buttons);
        }
        pad
    }

    /// True after the stop chord; every later call records nothing.
    pub fn stopped(&self) -> bool {
        self.stopped
    }

    /// Records one frame. `touch` is `None` when no touch block was read; `allowed` is false while
    /// the overlay or a pause gates input. Returns the record length, 0 when nothing changed.
    pub fn record(
        &mut self,
        pad: &PadState,
        touch: Option<&Touches>,
        allowed: bool,
        out: &mut [u8; MAX_INPUT_BYTES],
    ) -> Result<usize, Error> {
        self.record_inner(pad, None, touch, false, allowed, false, out)
    }

    /// Driver gates release forwarded fingers even if this frame has no touch read. `extra`
    /// adds players 2 to 8 and motion; `touch_mouse` asks the host to drive its mouse.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn record_frame(
        &mut self,
        pad: &PadState,
        extra: Option<&Extra>,
        touch: Option<&Touches>,
        touch_mouse: bool,
        allowed: bool,
        out: &mut [u8; MAX_INPUT_BYTES],
    ) -> Result<usize, Error> {
        self.record_inner(pad, extra, touch, touch_mouse, allowed, true, out)
    }

    #[allow(clippy::too_many_arguments)]
    fn record_inner(
        &mut self,
        pad: &PadState,
        extra: Option<&Extra>,
        touch: Option<&Touches>,
        touch_mouse: bool,
        allowed: bool,
        release_without_touch: bool,
        out: &mut [u8; MAX_INPUT_BYTES],
    ) -> Result<usize, Error> {
        if self.stopped {
            return Ok(0);
        }

        let buttons = if pad.connected { pad.buttons } else { 0 };
        let extra_stop = extra.is_some_and(|extra| {
            extra
                .pads
                .iter()
                .any(|pad| pad.connected && stop_held(u64::from(pad.buttons)))
        });
        if (pad.connected && stop_held(u64::from(buttons))) || extra_stop {
            self.stopped = true;
            return self.stop_record(pad.connected, out);
        }

        self.held_across_gate = if allowed {
            self.held_across_gate & buttons
        } else {
            buttons
        };
        let mapped = if allowed {
            self.laid_out(map_pad_with_start_chord(
                pad.connected,
                u64::from(buttons & !self.held_across_gate),
                pad.sticks,
                self.start_chord,
            ))
        } else {
            map_pad(pad.connected, 0, [0; 4])
        };
        let changed = self.changed(mapped);
        let mut extended = match extra {
            Some(extra) => self.extend(extra, pad.connected, allowed),
            None => Extended::default(),
        };

        let mut events = Events::new();
        if let Some(touches) = touch {
            if allowed {
                let mut raw = Events::new();
                self.tracker.step(touches.points(), &mut raw);
                self.forward(&raw, &mut events);
            } else {
                self.tracker.step(touches.points(), &mut Events::new());
            }
        }
        if !allowed && (touch.is_some() || release_without_touch) {
            self.forwarded.flush(&mut events);
        }

        if changed.is_none() && events.count == 0 && !extended.any_input() {
            return Ok(0);
        }
        extended.mouse = touch_mouse && events.count > 0;
        write_record(false, changed.as_ref(), &extended, events.as_slice(), out)
    }

    /// Players 2 to 8 that changed, mapped like the primary pad without the start chord, and
    /// the motion of every connected player. Gated frames release the pads and send no motion.
    fn extend(&mut self, extra: &Extra, primary: bool, allowed: bool) -> Extended {
        let mut extended = Extended::default();
        for (slot, state) in extra.pads.iter().enumerate() {
            let buttons = if state.connected { state.buttons } else { 0 };
            self.held_extra[slot] = if allowed {
                self.held_extra[slot] & buttons
            } else {
                buttons
            };
            let mapped = if allowed {
                self.laid_out(map_pad(
                    state.connected,
                    u64::from(buttons & !self.held_extra[slot]),
                    state.sticks,
                ))
            } else {
                map_pad(state.connected, 0, [0; 4])
            };
            let last = &mut self.last_extra[slot];
            if *last != Some(mapped) && (state.connected || last.is_some()) {
                *last = Some(mapped);
                extended.pads[slot] = Some(mapped);
            }
        }
        if allowed {
            for (index, motion) in extra.motion.iter().enumerate() {
                let connected = match index {
                    0 => primary,
                    _ => extra.pads[index - 1].connected,
                };
                extended.motion[index] = motion.filter(|_| connected).map(Motion::to_sdl_axes);
            }
        }
        extended
    }

    fn changed(&mut self, pad: Pad) -> Option<Pad> {
        if self.last_pad == Some(pad) {
            return None;
        }
        self.last_pad = Some(pad);
        Some(pad)
    }

    /// Only a down starts forwarding a finger; a finger held across a gate waits for a new down.
    fn forward(&mut self, raw: &Events, events: &mut Events) {
        for event in raw.as_slice() {
            let known = self.forwarded.contains(event.id);
            if event.action != Action::Down && !known {
                continue;
            }
            match event.action {
                Action::Up => self.forwarded.delete(event.id),
                _ => self.forwarded.set(event.id, (event.x, event.y)),
            }
            events.push(event.id, event.action, (event.x, event.y));
        }
    }

    fn stop_record(
        &mut self,
        connected: bool,
        out: &mut [u8; MAX_INPUT_BYTES],
    ) -> Result<usize, Error> {
        let released = self.changed(map_pad(connected, 0, [0; 4]));
        let mut lifted = Events::new();
        self.forwarded.flush(&mut lifted);
        write_record(
            true,
            released.as_ref(),
            &Extended::default(),
            lifted.as_slice(),
            out,
        )
    }
}

fn write_record(
    stop: bool,
    pad: Option<&Pad>,
    extended: &Extended,
    touch: &[TouchEvent],
    out: &mut [u8],
) -> Result<usize, Error> {
    let mut writer = Writer { out, used: 0 };
    writer.text("{\"v\":")?;
    writer.unsigned(if extended.any_input() || extended.mouse {
        VERSION_EXTENDED
    } else {
        VERSION
    })?;
    if stop {
        writer.text(",\"stop\":true")?;
    }

    if let Some(pad) = pad {
        writer.text(",\"pad\":")?;
        writer.pad(pad)?;
    }

    if extended.pads.iter().any(Option::is_some) {
        writer.text(",\"pads\":[")?;
        let mut first = true;
        for (slot, pad) in extended.pads.iter().enumerate() {
            let Some(pad) = pad else { continue };
            if !first {
                writer.text(",")?;
            }
            first = false;
            writer.text("{\"index\":")?;
            writer.unsigned(slot as u32 + 1)?;
            writer.text(",\"pad\":")?;
            writer.pad(pad)?;
            writer.text("}")?;
        }
        writer.text("]")?;
    }
    if extended.motion.iter().any(Option::is_some) {
        writer.text(",\"motion\":[")?;
        let mut first = true;
        for (index, motion) in extended.motion.iter().enumerate() {
            let Some(motion) = motion else { continue };
            if !first {
                writer.text(",")?;
            }
            first = false;
            writer.text("{\"index\":")?;
            writer.unsigned(index as u32)?;
            writer.text(",\"accel\":")?;
            writer.triple(motion.accel)?;
            writer.text(",\"gyro\":")?;
            writer.triple(motion.gyro)?;
            writer.text("}")?;
        }
        writer.text("]")?;
    }
    if extended.mouse {
        writer.text(",\"mouse\":true")?;
    }
    if !touch.is_empty() {
        writer.text(",\"touch\":[")?;
        for (index, event) in touch.iter().enumerate() {
            if index > 0 {
                writer.text(",")?;
            }
            writer.event(event)?;
        }
        writer.text("]")?;
    }

    writer.text("}")?;
    Ok(writer.used)
}

struct Writer<'a> {
    out: &'a mut [u8],
    used: usize,
}

impl Writer<'_> {
    fn bytes(&mut self, bytes: &[u8]) -> Result<(), Error> {
        let end = self.used + bytes.len();
        self.out
            .get_mut(self.used..end)
            .ok_or(Error::TooLarge)?
            .copy_from_slice(bytes);
        self.used = end;
        Ok(())
    }

    fn text(&mut self, text: &str) -> Result<(), Error> {
        self.bytes(text.as_bytes())
    }

    fn unsigned(&mut self, value: u32) -> Result<(), Error> {
        let mut digits = [0u8; 10];
        let mut start = digits.len();
        let mut rest = value;
        loop {
            start -= 1;
            digits[start] = b'0' + (rest % 10) as u8;
            rest /= 10;
            if rest == 0 {
                break;
            }
        }
        self.bytes(&digits[start..])
    }

    fn signed(&mut self, value: i32) -> Result<(), Error> {
        if value < 0 {
            self.text("-")?;
        }
        self.unsigned(value.unsigned_abs())
    }

    /// A 0..=10000 position as JSON.stringify prints n / 1e4: `0`, `1`, `0.5`, `0.1234`.
    fn unit(&mut self, value: u16) -> Result<(), Error> {
        if value == 0 || value >= UNIT {
            return self.text(if value == 0 { "0" } else { "1" });
        }

        let mut digits = [b'0'; 4];
        let mut rest = value;
        for slot in digits.iter_mut().rev() {
            *slot = b'0' + (rest % 10) as u8;
            rest /= 10;
        }
        let mut length = digits.len();
        while digits[length - 1] == b'0' {
            length -= 1;
        }

        self.text("0.")?;
        self.bytes(&digits[..length])
    }

    fn triple(&mut self, values: [i32; 3]) -> Result<(), Error> {
        self.text("[")?;
        self.signed(values[0])?;
        self.text(",")?;
        self.signed(values[1])?;
        self.text(",")?;
        self.signed(values[2])?;
        self.text("]")
    }

    fn pad(&mut self, pad: &Pad) -> Result<(), Error> {
        self.text("{\"connected\":")?;
        self.text(if pad.connected { "true" } else { "false" })?;
        self.text(",\"buttonFlags\":")?;
        self.unsigned(u32::from(pad.buttons))?;
        self.text(",\"leftTrigger\":")?;
        self.unsigned(u32::from(pad.left_trigger))?;
        self.text(",\"rightTrigger\":")?;
        self.unsigned(u32::from(pad.right_trigger))?;
        self.text(",\"leftStickX\":")?;
        self.signed(i32::from(pad.left_x))?;
        self.text(",\"leftStickY\":")?;
        self.signed(i32::from(pad.left_y))?;
        self.text(",\"rightStickX\":")?;
        self.signed(i32::from(pad.right_x))?;
        self.text(",\"rightStickY\":")?;
        self.signed(i32::from(pad.right_y))?;
        self.text("}")
    }

    fn event(&mut self, event: &TouchEvent) -> Result<(), Error> {
        let action = match event.action {
            Action::Down => "down",
            Action::Move => "move",
            Action::Up => "up",
        };

        self.text("{\"id\":")?;
        self.unsigned(event.id)?;
        self.text(",\"action\":\"")?;
        self.text(action)?;
        self.text("\",\"x\":")?;
        self.unit(event.x)?;
        self.text(",\"y\":")?;
        self.unit(event.y)?;
        self.text(",\"pressure\":0}")
    }
}
