//! The on-screen gamepad for handheld play: touches on its controls become a pad slot routed
//! like any other controller. A finger belongs to the control it went down on for its whole
//! life; fingers that start elsewhere are left to the host.

use crate::input::{MAX_POINTS, PANEL_HEIGHT, PANEL_WIDTH, Point, Touches};

pub const A: u64 = 1 << 0;
pub const B: u64 = 1 << 1;
pub const X: u64 = 1 << 2;
pub const Y: u64 = 1 << 3;
pub const LS: u64 = 1 << 4;
pub const RS: u64 = 1 << 5;
pub const L: u64 = 1 << 6;
pub const R: u64 = 1 << 7;
pub const ZL: u64 = 1 << 8;
pub const ZR: u64 = 1 << 9;
pub const PLUS: u64 = 1 << 10;
pub const MINUS: u64 = 1 << 11;
pub const LEFT: u64 = 1 << 12;
pub const UP: u64 = 1 << 13;
pub const RIGHT: u64 = 1 << 14;
pub const DOWN: u64 = 1 << 15;

/// A pad slot: u64 buttons, i32 sticks[4], u32 attributes (bit 0 connected).
pub const SLOT_BYTES: usize = 32;

const AXIS_MAX: f32 = 32767.0;
/// Panel pixels a finger moves from where it went down for a full stick.
const STICK_TRAVEL: f32 = 70.0;
const STICK_DEADZONE: f32 = 0.12;
/// Buttons take touches a little outside what is drawn.
const HIT_SLACK: f32 = 1.4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Shape {
    Circle { x: i16, y: i16, radius: i16 },
    Rect { x: i16, y: i16, w: i16, h: i16 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Button(u64),
    Stick(usize),
    Dpad,
}

/// One drawn control, in panel pixels (1280x720).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Control {
    pub kind: Kind,
    pub shape: Shape,
}

const fn button(bit: u64, x: i16, y: i16, radius: i16) -> Control {
    Control {
        kind: Kind::Button(bit),
        shape: Shape::Circle { x, y, radius },
    }
}

const fn shoulder(bit: u64, x: i16, y: i16) -> Control {
    Control {
        kind: Kind::Button(bit),
        shape: Shape::Rect {
            x,
            y,
            w: 150,
            h: 54,
        },
    }
}

const fn round(kind: Kind, x: i16, y: i16, radius: i16) -> Control {
    Control {
        kind,
        shape: Shape::Circle { x, y, radius },
    }
}

const FACE_RADIUS: i16 = 34;
const FACE_GAP: i16 = 62;
const RIGHT_STICK_X: i16 = PANEL_WIDTH as i16 - 270;

/// Laid out as the Joy-Con are: the left stick above the D-pad, the face buttons above the
/// right stick, shoulders along the top edge.
pub const CONTROLS: [Control; 15] = [
    shoulder(ZL, 40, 40),
    shoulder(L, 40, 104),
    shoulder(ZR, PANEL_WIDTH as i16 - 190, 40),
    shoulder(R, PANEL_WIDTH as i16 - 190, 104),
    button(MINUS, 290, 72, 26),
    button(PLUS, PANEL_WIDTH as i16 - 290, 72, 26),
    button(LS, 300, 236, 28),
    button(RS, PANEL_WIDTH as i16 - 300, 236, 28),
    round(Kind::Stick(0), 150, 340, 100),
    round(Kind::Dpad, 270, 560, 96),
    round(Kind::Stick(1), RIGHT_STICK_X, 560, 100),
    button(X, 1130, 340 - FACE_GAP, FACE_RADIUS),
    button(B, 1130, 340 + FACE_GAP, FACE_RADIUS),
    button(Y, 1130 - FACE_GAP, 340, FACE_RADIUS),
    button(A, 1130 + FACE_GAP, 340, FACE_RADIUS),
];

pub const DPAD_PRESSED_SHIFT: u32 = 16;

/// The two regions the overlay draws in, in panel pixels: left and right.
pub const REGIONS: [(i16, i16, i16, i16); 2] = [(30, 30, 370, 650), (880, 30, 370, 650)];

#[derive(Clone, Copy, Debug)]
struct Finger {
    id: u32,
    control: usize,
    down: (f32, f32),
}

/// Per-frame state of the on-screen pad.
#[derive(Clone, Copy, Debug)]
pub struct VirtualPad {
    fingers: [Option<Finger>; MAX_POINTS],
    owned: [Option<u32>; MAX_POINTS],
    seen: [Option<u32>; MAX_POINTS],
    buttons: u64,
    sticks: [i32; 4],
    pressed: u32,
    revision: u32,
    presses: u32,
}

impl Default for VirtualPad {
    fn default() -> Self {
        Self::new()
    }
}

fn panel(point: &Point) -> (f32, f32) {
    (
        f32::from(point.x) * PANEL_WIDTH as f32 / 10_000.0,
        f32::from(point.y) * PANEL_HEIGHT as f32 / 10_000.0,
    )
}

fn distance(a: (f32, f32), b: (f32, f32)) -> f32 {
    let (dx, dy) = (a.0 - b.0, a.1 - b.1);
    crate::bitrate::sqrt(f64::from(dx * dx + dy * dy)) as f32
}

fn center(shape: &Shape) -> (f32, f32) {
    match *shape {
        Shape::Circle { x, y, .. } => (f32::from(x), f32::from(y)),
        Shape::Rect { x, y, w, h } => (f32::from(x + w / 2), f32::from(y + h / 2)),
    }
}

/// How far `at` is inside the control's forgiving area: 0 at its centre, 1 on its edge.
fn reach(control: &Control, at: (f32, f32)) -> Option<f32> {
    let reach = match control.shape {
        Shape::Circle { radius, .. } => {
            let slack = match control.kind {
                Kind::Button(_) => HIT_SLACK,
                Kind::Stick(_) | Kind::Dpad => 1.25,
            };
            distance(at, center(&control.shape)) / (f32::from(radius) * slack)
        }
        Shape::Rect { w, h, .. } => {
            let (cx, cy) = center(&control.shape);
            let half_w = f32::from(w) / 2.0 + 20.0;
            let half_h = f32::from(h) / 2.0 + 6.0;
            ((at.0 - cx).abs() / half_w).max((at.1 - cy).abs() / half_h)
        }
    };
    (reach <= 1.0).then_some(reach)
}

/// The control a finger going down at `at` takes: the one it is most inside.
pub fn hit(at: (f32, f32)) -> Option<usize> {
    CONTROLS
        .iter()
        .enumerate()
        .filter_map(|(index, control)| reach(control, at).map(|reach| (index, reach)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(index, _)| index)
}

fn dpad(control: &Control, at: (f32, f32)) -> u64 {
    let (cx, cy) = center(&control.shape);
    let (dx, dy) = (at.0 - cx, at.1 - cy);
    if distance(at, (cx, cy)) < 18.0 {
        return 0;
    }
    const TAN_22_5: f32 = 0.414_213_57;
    let horizontal = if dx > 0.0 { RIGHT } else { LEFT };
    let vertical = if dy > 0.0 { DOWN } else { UP };
    if dy.abs() < dx.abs() * TAN_22_5 {
        horizontal
    } else if dx.abs() < dy.abs() * TAN_22_5 {
        vertical
    } else {
        horizontal | vertical
    }
}

fn stick(down: (f32, f32), at: (f32, f32)) -> [i32; 2] {
    let (dx, dy) = (
        (at.0 - down.0) / STICK_TRAVEL,
        (down.1 - at.1) / STICK_TRAVEL,
    );
    let length = distance((0.0, 0.0), (dx, dy));
    if length < STICK_DEADZONE {
        return [0, 0];
    }
    let scale = length.min(1.0) / length;
    let axis = |value: f32| {
        let scaled = (value * scale * AXIS_MAX).clamp(-AXIS_MAX, AXIS_MAX);
        (scaled + scaled.signum() * 0.5) as i32
    };
    [axis(dx), axis(dy)]
}

impl VirtualPad {
    pub const fn new() -> Self {
        Self {
            fingers: [None; MAX_POINTS],
            owned: [None; MAX_POINTS],
            seen: [None; MAX_POINTS],
            buttons: 0,
            sticks: [0; 4],
            pressed: 0,
            revision: 0,
            presses: 0,
        }
    }

    /// Takes this frame's touches. Fingers that just went down on a control are claimed;
    /// claimed fingers that lifted let go.
    pub fn update(&mut self, touches: &Touches) {
        let points = touches.points();
        let mut owned = [None; MAX_POINTS];
        for (out, point) in owned.iter_mut().zip(points) {
            if self
                .fingers
                .iter()
                .flatten()
                .any(|finger| finger.id == point.id)
            {
                *out = Some(point.id);
            }
        }
        for slot in &mut self.fingers {
            if slot.is_some_and(|finger| {
                !points
                    .iter()
                    .any(|point| point.id == finger.id && !point.ended)
            }) {
                *slot = None;
            }
        }
        for point in points.iter().filter(|point| !point.ended) {
            if self.seen.contains(&Some(point.id)) {
                continue;
            }
            let at = panel(point);
            let Some(control) = hit(at) else {
                continue;
            };
            if let Some(slot) = self.fingers.iter_mut().find(|slot| slot.is_none()) {
                *slot = Some(Finger {
                    id: point.id,
                    control,
                    down: at,
                });
                if let Some(out) = owned.iter_mut().find(|out| out.is_none()) {
                    *out = Some(point.id);
                }
            }
        }

        let mut buttons = 0;
        let mut sticks = [0; 4];
        let mut pressed = 0;
        for finger in self.fingers.iter().flatten() {
            let Some(point) = points.iter().find(|point| point.id == finger.id) else {
                continue;
            };
            let at = panel(point);
            let control = &CONTROLS[finger.control];
            match control.kind {
                Kind::Button(bit) if reach(control, at).is_some() => {
                    buttons |= bit;
                    pressed |= 1 << finger.control;
                }
                Kind::Button(_) => {}
                Kind::Dpad => {
                    let held = dpad(control, at);
                    buttons |= held;
                    pressed |= (((held >> 12) & 0xf) as u32) << DPAD_PRESSED_SHIFT;
                }
                Kind::Stick(index) => {
                    let [x, y] = stick(finger.down, at);
                    sticks[index * 2] = x;
                    sticks[index * 2 + 1] = y;
                    pressed |= 1 << finger.control;
                }
            }
        }
        self.presses += (buttons & !self.buttons).count_ones();
        if pressed != self.pressed {
            self.revision = self.revision.wrapping_add(1);
        }
        self.buttons = buttons;
        self.sticks = sticks;
        self.pressed = pressed;
        self.owned = owned;
        self.seen = [None; MAX_POINTS];
        let down = points.iter().filter(|point| !point.ended);
        for (seen, point) in self.seen.iter_mut().zip(down) {
            *seen = Some(point.id);
        }
    }

    /// True for a finger of this frame that belongs to a control, the one lifting included.
    pub fn owns(&self, id: u32) -> bool {
        self.owned.contains(&Some(id))
    }

    /// Lets go of everything: the pad reads neutral until fingers go down again.
    pub fn release(&mut self) {
        if self.pressed != 0 {
            self.revision = self.revision.wrapping_add(1);
        }
        *self = Self {
            revision: self.revision,
            presses: self.presses,
            seen: self.seen,
            ..Self::new()
        };
    }

    pub fn buttons(&self) -> u64 {
        self.buttons
    }

    pub fn sticks(&self) -> [i32; 4] {
        self.sticks
    }

    /// One bit per entry of `CONTROLS` that is held; the D-pad's directions instead take the bits
    /// from `DPAD_PRESSED_SHIFT` on, Left, Up, Right and Down in that order.
    pub fn pressed(&self) -> u32 {
        self.pressed
    }

    /// Changes whenever `pressed` does, so a drawing can be kept until then.
    pub fn revision(&self) -> u32 {
        self.revision
    }

    /// Button presses since the last call.
    pub fn take_presses(&mut self) -> u32 {
        core::mem::take(&mut self.presses)
    }

    /// The pad as a connected controller source.
    pub fn slot(&self) -> [u8; SLOT_BYTES] {
        let mut slot = [0; SLOT_BYTES];
        slot[..8].copy_from_slice(&self.buttons.to_le_bytes());
        for (axis, value) in self.sticks.iter().enumerate() {
            slot[8 + axis * 4..12 + axis * 4].copy_from_slice(&value.to_le_bytes());
        }
        slot[24] = 1;
        slot
    }
}

/// Drops the claimed fingers from a raw `TouchScreenState` block so only the host's fingers
/// are read from it.
pub fn retain_touches(block: &mut [u8], pad: &VirtualPad) {
    crate::input::retain_touch_block(block, |id| !pad.owns(id));
}
