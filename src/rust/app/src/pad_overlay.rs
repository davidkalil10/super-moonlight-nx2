//! Draws the on-screen gamepad into two RGBA areas the renderer shows over the stream. A
//! control is drawn again only when its pressed state or its knob changes, so a held button or
//! a stick at rest costs nothing per frame.

extern crate alloc;

use crate::virtual_pad::{
    A, B, CONTROLS, Control, DPAD_PRESSED_SHIFT, KNOB_RADIUS, Kind, REGIONS, Shape, X, Y,
};
use alloc::vec::Vec;
use core::ops::Range;
use moonlight_nx2_ui::glyphs::{Align, Bitmap, Glyphs};

/// Panel pixels (1280x720) to display pixels (1920x1080).
const SCALE: f32 = 1.5;
const fn scaled(value: i16) -> u32 {
    (value as u32 * 3) / 2
}

/// Each area in display pixels: x, y, width, height.
pub const AREAS: [(u32, u32, u32, u32); 2] = [
    (
        scaled(REGIONS[0].0),
        scaled(REGIONS[0].1),
        scaled(REGIONS[0].2),
        scaled(REGIONS[0].3),
    ),
    (
        scaled(REGIONS[1].0),
        scaled(REGIONS[1].1),
        scaled(REGIONS[1].2),
        scaled(REGIONS[1].3),
    ),
];
pub const AREA_BYTES: usize = (AREAS[0].2 * AREAS[0].3 * 4) as usize;
pub const BYTES: usize = 2 * AREA_BYTES;

/// The D-pad's cross in panel pixels: how far each arm reaches, its width and its corners.
const DPAD_REACH: f32 = 90.0;
const DPAD_WIDTH: f32 = 58.0;
const DPAD_CORNER: f32 = 12.0;
const ARROW: f32 = 9.0;
const OUTLINE: f32 = 2.5;

/// Shares of the opacity setting every control uses alike.
const FILL: f32 = 0.55;
const HELD_FILL: f32 = 0.95;
const EDGE: f32 = 0.9;
const INK: f32 = 1.0;

const LIGHT: [f32; 3] = [0.95, 0.96, 0.98];
const DARK: [f32; 3] = [0.09, 0.10, 0.12];
const GREEN: [f32; 3] = [0.20, 0.66, 0.26];
const RED: [f32; 3] = [0.86, 0.22, 0.22];
const BLUE: [f32; 3] = [0.18, 0.47, 0.90];
const YELLOW: [f32; 3] = [0.96, 0.74, 0.12];

type Knobs = [(i16, i16); 2];

#[derive(Clone, Copy, PartialEq, Eq)]
struct Look {
    opacity: u32,
    nintendo: bool,
}

#[derive(Default)]
pub struct Overlay {
    drawn: Option<(Look, u32, Knobs)>,
    labels: Vec<Option<Bitmap>>,
    faces: Vec<Option<[f32; 3]>>,
}

fn label(control: &Control, nintendo: bool) -> Option<&'static str> {
    let Kind::Button(bit) = control.kind else {
        return None;
    };
    let face = |switch, xbox| Some(if nintendo { switch } else { xbox });
    match bit {
        A => face("A", "B"),
        B => face("B", "A"),
        X => face("X", "Y"),
        Y => face("Y", "X"),
        crate::virtual_pad::L => Some("L"),
        crate::virtual_pad::R => Some("R"),
        crate::virtual_pad::ZL => Some("ZL"),
        crate::virtual_pad::ZR => Some("ZR"),
        crate::virtual_pad::PLUS => Some("+"),
        crate::virtual_pad::MINUS => Some("\u{2212}"),
        crate::virtual_pad::LS => Some("LS"),
        crate::virtual_pad::RS => Some("RS"),
        _ => None,
    }
}

/// The Xbox colour of a face button, by the letter it shows.
fn face(text: Option<&str>) -> Option<[f32; 3]> {
    match text? {
        "A" => Some(GREEN),
        "B" => Some(RED),
        "X" => Some(BLUE),
        "Y" => Some(YELLOW),
        _ => None,
    }
}

/// The area a control sits in and its box there, in display pixels: x, y, width, height.
fn bounds(control: &Control) -> (usize, (u32, u32, u32, u32)) {
    let (left, top, right, bottom) = match control.shape {
        Shape::Circle { x, y, radius } => (x - radius, y - radius, x + radius, y + radius),
        Shape::Rect { x, y, w, h } => (x, y, x + w, y + h),
    };
    let side = usize::from(left >= REGIONS[1].0);
    let (ax, ay, aw, ah) = AREAS[side];
    let x0 = (scaled(left) - 3).saturating_sub(ax);
    let y0 = (scaled(top) - 3).saturating_sub(ay);
    let x1 = (scaled(right) + 3 - ax).min(aw);
    let y1 = (scaled(bottom) + 3 - ay).min(ah);
    (side, (x0, y0, x1 - x0, y1 - y0))
}

/// Coverage of a disc of `radius` at squared distance `d2`, smoothed over about a pixel.
fn disc(d2: f32, radius: f32) -> f32 {
    ((radius * radius - d2) / (2.0 * radius) + 0.5).clamp(0.0, 1.0)
}

fn ring(d2: f32, radius: f32) -> f32 {
    (disc(d2, radius) - disc(d2, radius - OUTLINE)).max(0.0)
}

/// Coverage of a box with rounded corners, `inset` pixels in from its edge.
fn rounded(px: f32, py: f32, (x, y, w, h): (f32, f32, f32, f32), corner: f32, inset: f32) -> f32 {
    let corner = (corner - inset).max(0.5);
    let (left, top) = (x + inset + corner, y + inset + corner);
    let (right, bottom) = (x + w - inset - corner, y + h - inset - corner);
    if right < left || bottom < top {
        return 0.0;
    }
    let (qx, qy) = (px.clamp(left, right), py.clamp(top, bottom));
    disc((px - qx) * (px - qx) + (py - qy) * (py - qy), corner)
}

/// Coverage of an arrow of half-size `size` at `at`, pointing along the unit `towards`.
fn arrow(px: f32, py: f32, at: (f32, f32), towards: (f32, f32), size: f32) -> f32 {
    const HALF_SQRT_2: f32 = core::f32::consts::FRAC_1_SQRT_2;
    let (rx, ry) = (px - at.0, py - at.1);
    let along = rx * towards.0 + ry * towards.1;
    let across = (ry * towards.0 - rx * towards.1).abs();
    let slant = (size - along - across) * HALF_SQRT_2;
    let back = along + size;
    (slant.min(back) + 0.5).clamp(0.0, 1.0)
}

/// A colour lit from above: a little brighter at the top of its shape, darker at the bottom.
fn shade(rgb: [f32; 3], top: f32, height: f32, py: f32) -> [f32; 3] {
    let t = ((py - top) / height.max(1.0)).clamp(0.0, 1.0);
    let light = 1.1 - 0.2 * t;
    rgb.map(|channel| (channel * light).min(1.0))
}

fn mix(a: [f32; 3], b: [f32; 3], share: f32) -> [f32; 3] {
    [0, 1, 2].map(|index| a[index] + (b[index] - a[index]) * share)
}

fn over(below: [f32; 4], rgb: [f32; 3], alpha: f32, cover: f32) -> [f32; 4] {
    let a = alpha * cover;
    if a <= 0.0 {
        return below;
    }
    let out = a + below[3] * (1.0 - a);
    let blend = |index: usize| (rgb[index] * a + below[index] * below[3] * (1.0 - a)) / out;
    [blend(0), blend(1), blend(2), out]
}

/// What one pixel of a control is painted with.
struct Brush {
    strength: f32,
    held: bool,
    face: Option<[f32; 3]>,
}

impl Brush {
    fn fill(&self) -> ([f32; 3], f32) {
        match (self.face, self.held) {
            (Some(face), false) => (face, FILL),
            (Some(face), true) => (mix(face, LIGHT, 0.45), HELD_FILL),
            (None, false) => (DARK, FILL),
            (None, true) => (LIGHT, HELD_FILL),
        }
    }

    fn edge(&self) -> [f32; 3] {
        self.face.map_or(LIGHT, |face| mix(face, LIGHT, 0.5))
    }

    fn ink(&self) -> [f32; 3] {
        if self.held && self.face.is_none() {
            DARK
        } else {
            LIGHT
        }
    }

    /// A disc of `radius` at squared distance `d2`, shaded over `top..top + 2 * radius`.
    fn disc(&self, color: [f32; 4], d2: f32, radius: f32, top: f32, py: f32) -> [f32; 4] {
        let (rgb, alpha) = self.fill();
        let rgb = shade(rgb, top, 2.0 * radius, py);
        let color = over(color, rgb, alpha * self.strength, disc(d2, radius));
        over(color, self.edge(), EDGE * self.strength, ring(d2, radius))
    }
}

impl Overlay {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forgets what was drawn, as after the areas were cleared or reused.
    pub fn reset(&mut self) {
        self.drawn = None;
    }

    /// Brings `area` (both areas, left then right) up to `pressed` with the sticks' `knobs`.
    /// Returns the bytes written, or None when nothing changed.
    pub fn draw(
        &mut self,
        glyphs: &mut Glyphs,
        area: &mut [u8],
        pressed: u32,
        knobs: Knobs,
        opacity: u32,
        nintendo: bool,
    ) -> Option<Range<usize>> {
        if area.len() < BYTES {
            return None;
        }
        let look = Look { opacity, nintendo };
        let changed = match self.drawn {
            Some((drawn, was, moved)) if drawn == look => {
                let mut changed = was ^ pressed;
                for (index, control) in CONTROLS.iter().enumerate() {
                    if let Kind::Stick(stick) = control.kind
                        && moved[stick] != knobs[stick]
                    {
                        changed |= 1 << index;
                    }
                }
                changed
            }
            _ => {
                self.labels = CONTROLS
                    .iter()
                    .map(|control| {
                        glyphs.text(label(control, nintendo)?, 32, 120, Align::Center, None)
                    })
                    .collect();
                self.faces = CONTROLS
                    .iter()
                    .map(|control| face(label(control, nintendo)))
                    .collect();
                area[..BYTES].fill(0);
                u32::MAX
            }
        };
        self.drawn = Some((look, pressed, knobs));
        if changed == 0 {
            return None;
        }
        let mut touched: Option<Range<usize>> = None;
        for (index, control) in CONTROLS.iter().enumerate() {
            let bits = match control.kind {
                Kind::Dpad => 0xf << DPAD_PRESSED_SHIFT,
                _ => 1 << index,
            };
            if changed & bits == 0 {
                continue;
            }
            let range = self.draw_control(area, index, pressed, knobs, opacity);
            touched = Some(match touched {
                Some(was) => was.start.min(range.start)..was.end.max(range.end),
                None => range,
            });
        }
        touched
    }

    fn draw_control(
        &self,
        area: &mut [u8],
        index: usize,
        pressed: u32,
        knobs: Knobs,
        opacity: u32,
    ) -> Range<usize> {
        let control = &CONTROLS[index];
        let (side, (bx, by, bw, bh)) = bounds(control);
        let (ax, ay, aw, _) = AREAS[side];
        let brush = Brush {
            strength: opacity as f32 / 100.0,
            held: pressed & (1 << index) != 0,
            face: self.faces.get(index).copied().flatten(),
        };
        let label = self.labels.get(index).and_then(Option::as_ref);
        let base = side * AREA_BYTES;
        for row in by..by + bh {
            for column in bx..bx + bw {
                let px = (ax + column) as f32 + 0.5;
                let py = (ay + row) as f32 + 0.5;
                let mut color = match (control.kind, control.shape) {
                    (Kind::Dpad, Shape::Circle { x, y, .. }) => {
                        dpad(&brush, (px, py), (x, y), pressed)
                    }
                    (Kind::Stick(stick), Shape::Circle { x, y, radius }) => {
                        let knob = knobs.get(stick).copied().unwrap_or_default();
                        draw_stick(&brush, (px, py), (x, y, radius), knob)
                    }
                    (_, Shape::Circle { x, y, radius }) => {
                        let (cx, cy) = (f32::from(x) * SCALE, f32::from(y) * SCALE);
                        let d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
                        let r = f32::from(radius) * SCALE * if brush.held { 0.94 } else { 1.0 };
                        brush.disc([0.0; 4], d2, r, cy - r, py)
                    }
                    (_, Shape::Rect { x, y, w, h }) => shoulder(&brush, (px, py), (x, y, w, h)),
                };
                if let Some(label) = label {
                    let (cx, cy) = match control.shape {
                        Shape::Circle { x, y, .. } => (f32::from(x), f32::from(y)),
                        Shape::Rect { x, y, w, h } => (
                            f32::from(x) + f32::from(w) / 2.0,
                            f32::from(y) + f32::from(h) / 2.0,
                        ),
                    };
                    let lx = px - (cx * SCALE - label.width as f32 / 2.0);
                    let ly = py - (cy * SCALE - label.height as f32 / 2.0);
                    if lx >= 0.0
                        && ly >= 0.0
                        && (lx as u32) < label.width
                        && (ly as u32) < label.height
                    {
                        let at = (ly as u32 * label.width + lx as u32) as usize
                            * label.channels as usize;
                        let cover = f32::from(label.bytes[at]) / 255.0;
                        color = over(color, brush.ink(), INK * brush.strength, cover);
                    }
                }
                let at = base + ((row * aw + column) * 4) as usize;
                let byte = |value: f32| (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                area[at..at + 4].copy_from_slice(&[
                    byte(color[0]),
                    byte(color[1]),
                    byte(color[2]),
                    byte(color[3]),
                ]);
            }
        }
        let start = base + ((by * aw + bx) * 4) as usize;
        let end = base + (((by + bh - 1) * aw + bx + bw) * 4) as usize;
        start..end
    }
}

fn shoulder(brush: &Brush, (px, py): (f32, f32), (x, y, w, h): (i16, i16, i16, i16)) -> [f32; 4] {
    let rect = (
        f32::from(x) * SCALE,
        f32::from(y) * SCALE,
        f32::from(w) * SCALE,
        f32::from(h) * SCALE,
    );
    let corner = rect.3 * 0.42;
    let (rgb, alpha) = brush.fill();
    let rgb = shade(rgb, rect.1, rect.3, py);
    let outer = rounded(px, py, rect, corner, 0.0);
    let color = over([0.0; 4], rgb, alpha * brush.strength, outer);
    let edge = (outer - rounded(px, py, rect, corner, OUTLINE)).max(0.0);
    over(color, brush.edge(), EDGE * brush.strength, edge)
}

/// The cross, its arms lit by the directions held: Left, Up, Right and Down from
/// `DPAD_PRESSED_SHIFT` on.
fn dpad(brush: &Brush, (px, py): (f32, f32), (x, y): (i16, i16), pressed: u32) -> [f32; 4] {
    let (cx, cy) = (f32::from(x) * SCALE, f32::from(y) * SCALE);
    let (reach, half, corner) = (
        DPAD_REACH * SCALE,
        DPAD_WIDTH * SCALE / 2.0,
        DPAD_CORNER * SCALE,
    );
    let across = (cx - reach, cy - half, 2.0 * reach, 2.0 * half);
    let down = (cx - half, cy - reach, 2.0 * half, 2.0 * reach);
    let outer = rounded(px, py, across, corner, 0.0).max(rounded(px, py, down, corner, 0.0));
    let inner =
        rounded(px, py, across, corner, OUTLINE).max(rounded(px, py, down, corner, OUTLINE));
    let rest = Brush {
        held: false,
        face: None,
        strength: brush.strength,
    };
    let (rgb, alpha) = rest.fill();
    let mut color = over(
        [0.0; 4],
        shade(rgb, cy - reach, 2.0 * reach, py),
        alpha * brush.strength,
        outer,
    );
    let arms = [(-1.0, 0.0), (0.0, -1.0), (1.0, 0.0), (0.0, 1.0)];
    for (bit, towards) in arms.into_iter().enumerate() {
        let held = pressed & (1 << (DPAD_PRESSED_SHIFT + bit as u32)) != 0;
        let (dx, dy): (f32, f32) = towards;
        let on_arm = dx * (px - cx) + dy * (py - cy) > half;
        if held && on_arm {
            color = over(color, LIGHT, HELD_FILL * brush.strength, inner);
        }
        let tip = (cx + dx * reach * 0.66, cy + dy * reach * 0.66);
        let ink = if held { DARK } else { LIGHT };
        color = over(
            color,
            ink,
            INK * brush.strength,
            arrow(px, py, tip, towards, ARROW * SCALE),
        );
    }
    over(
        color,
        LIGHT,
        EDGE * brush.strength,
        (outer - inner).max(0.0),
    )
}

/// The ring, sunk a little, and its knob where the finger holds it.
fn draw_stick(
    brush: &Brush,
    (px, py): (f32, f32),
    (x, y, radius): (i16, i16, i16),
    knob: (i16, i16),
) -> [f32; 4] {
    let (cx, cy) = (f32::from(x) * SCALE, f32::from(y) * SCALE);
    let r = f32::from(radius) * SCALE;
    let d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
    let sunk = shade(DARK, cy - r, 2.0 * r, 2.0 * cy - py);
    let color = over([0.0; 4], sunk, FILL * brush.strength, disc(d2, r));
    let color = over(color, LIGHT, EDGE * brush.strength, ring(d2, r));
    let (kx, ky) = (
        cx + f32::from(knob.0) * SCALE,
        cy + f32::from(knob.1) * SCALE,
    );
    let kr = f32::from(KNOB_RADIUS) * SCALE;
    let k2 = (px - kx) * (px - kx) + (py - ky) * (py - ky);
    let shadow = disc(
        (px - kx) * (px - kx) + (py - ky - 4.0) * (py - ky - 4.0),
        kr + 2.0,
    );
    let color = over(color, DARK, 0.35 * brush.strength, shadow);
    brush.disc(color, k2, kr, ky - kr, py)
}
