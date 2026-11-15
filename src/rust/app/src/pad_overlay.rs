//! Draws the on-screen gamepad into two RGBA areas the renderer shows over the stream. A
//! control is drawn again only when its pressed state changes, so a held stick or button costs
//! nothing per frame.

extern crate alloc;

use crate::virtual_pad::{A, B, CONTROLS, Control, DPAD_PRESSED_SHIFT, Kind, REGIONS, Shape, X, Y};
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

const DPAD_GAP: f32 = 62.0;
const DPAD_RADIUS: f32 = 30.0;
const OUTLINE: f32 = 3.0;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Look {
    opacity: u32,
    nintendo: bool,
}

#[derive(Default)]
pub struct Overlay {
    drawn: Option<(Look, u32)>,
    labels: Vec<Option<Bitmap>>,
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

fn rect_cover(px: f32, py: f32, (x, y, w, h): (f32, f32, f32, f32), inset: f32) -> f32 {
    let inside = |value: f32, low: f32, high: f32| {
        ((value - low - inset + 0.5).min(high - inset - value + 0.5)).clamp(0.0, 1.0)
    };
    inside(px, x, x + w) * inside(py, y, y + h)
}

#[derive(Clone, Copy)]
struct Paint {
    rgb: [f32; 3],
    alpha: f32,
}

fn over(below: [f32; 4], paint: Paint, cover: f32) -> [f32; 4] {
    let a = paint.alpha * cover;
    if a <= 0.0 {
        return below;
    }
    let out = a + below[3] * (1.0 - a);
    let mix = |index: usize| (paint.rgb[index] * a + below[index] * below[3] * (1.0 - a)) / out;
    [mix(0), mix(1), mix(2), out]
}

const LIGHT: [f32; 3] = [0.94, 0.95, 0.97];
const DARK: [f32; 3] = [0.10, 0.11, 0.13];

impl Overlay {
    pub fn new() -> Self {
        Self::default()
    }

    /// Forgets what was drawn, as after the areas were cleared or reused.
    pub fn reset(&mut self) {
        self.drawn = None;
    }

    /// Brings `area` (both areas, left then right) up to `pressed`. Returns the bytes written,
    /// or None when nothing changed.
    pub fn draw(
        &mut self,
        glyphs: &mut Glyphs,
        area: &mut [u8],
        pressed: u32,
        opacity: u32,
        nintendo: bool,
    ) -> Option<Range<usize>> {
        if area.len() < BYTES {
            return None;
        }
        let look = Look { opacity, nintendo };
        let changed = match self.drawn {
            Some((drawn, was)) if drawn == look => was ^ pressed,
            _ => {
                self.labels = CONTROLS
                    .iter()
                    .map(|control| {
                        let text = label(control, nintendo)?;
                        let size = if matches!(control.shape, Shape::Rect { .. }) {
                            30
                        } else {
                            32
                        };
                        glyphs.text(text, size, 120, Align::Center, None)
                    })
                    .collect();
                area[..BYTES].fill(0);
                u32::MAX
            }
        };
        self.drawn = Some((look, pressed));
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
            let range = self.draw_control(area, index, pressed, opacity);
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
        opacity: u32,
    ) -> Range<usize> {
        let control = &CONTROLS[index];
        let (side, (bx, by, bw, bh)) = bounds(control);
        let (ax, ay, aw, _) = AREAS[side];
        let strength = opacity as f32 / 100.0;
        let held = pressed & (1 << index) != 0;
        let label = self.labels.get(index).and_then(Option::as_ref);
        let base = side * AREA_BYTES;
        for row in by..by + bh {
            for column in bx..bx + bw {
                let px = (ax + column) as f32 + 0.5;
                let py = (ay + row) as f32 + 0.5;
                let mut color = [0.0; 4];
                match control.shape {
                    Shape::Circle { x, y, .. } if control.kind == Kind::Dpad => {
                        let (cx, cy) = (f32::from(x) * SCALE, f32::from(y) * SCALE);
                        for (bit, (dx, dy)) in [(-1.0, 0.0), (0.0, -1.0), (1.0, 0.0), (0.0, 1.0)]
                            .into_iter()
                            .enumerate()
                        {
                            let (ox, oy) = (cx + dx * DPAD_GAP * SCALE, cy + dy * DPAD_GAP * SCALE);
                            let d2 = (px - ox) * (px - ox) + (py - oy) * (py - oy);
                            let r = DPAD_RADIUS * SCALE;
                            let on = pressed & (1 << (DPAD_PRESSED_SHIFT + bit as u32)) != 0;
                            color = self.button(color, d2, r, on, strength);
                        }
                    }
                    Shape::Circle { x, y, radius } => {
                        let (cx, cy) = (f32::from(x) * SCALE, f32::from(y) * SCALE);
                        let d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
                        let r = f32::from(radius) * SCALE;
                        if let Kind::Stick(_) = control.kind {
                            let paint = Paint {
                                rgb: LIGHT,
                                alpha: strength * 0.25,
                            };
                            color = over(color, paint, disc(d2, r));
                            let edge = Paint {
                                rgb: LIGHT,
                                alpha: strength,
                            };
                            color = over(color, edge, ring(d2, r));
                            let knob = Paint {
                                rgb: LIGHT,
                                alpha: strength * if held { 0.9 } else { 0.5 },
                            };
                            color = over(color, knob, disc(d2, r * 0.42));
                        } else {
                            color = self.button(color, d2, r, held, strength);
                        }
                    }
                    Shape::Rect { x, y, w, h } => {
                        let rect = (
                            f32::from(x) * SCALE,
                            f32::from(y) * SCALE,
                            f32::from(w) * SCALE,
                            f32::from(h) * SCALE,
                        );
                        let fill = Paint {
                            rgb: LIGHT,
                            alpha: strength * if held { 0.9 } else { 0.3 },
                        };
                        let outer = rect_cover(px, py, rect, 0.0);
                        color = over(color, fill, outer);
                        let edge = Paint {
                            rgb: LIGHT,
                            alpha: strength,
                        };
                        color = over(
                            color,
                            edge,
                            (outer - rect_cover(px, py, rect, OUTLINE)).max(0.0),
                        );
                    }
                }
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
                        let ink = Paint {
                            rgb: if held { DARK } else { LIGHT },
                            alpha: strength.max(0.5),
                        };
                        color = over(color, ink, cover);
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

    fn button(&self, color: [f32; 4], d2: f32, radius: f32, held: bool, strength: f32) -> [f32; 4] {
        let fill = Paint {
            rgb: LIGHT,
            alpha: strength * if held { 0.9 } else { 0.3 },
        };
        let color = over(color, fill, disc(d2, radius));
        over(
            color,
            Paint {
                rgb: LIGHT,
                alpha: strength,
            },
            ring(d2, radius),
        )
    }
}
