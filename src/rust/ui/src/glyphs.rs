//! Text strips, button legends and letter tiles from the deflated glyph atlas fonts/glyphs.bin,
//! byte for byte as src/streamer/ui/glyph-raster.js paints them. Port of ui/glyphs.c; Rust never
//! fuses multiply-adds, so the float steps round like the JS doubles.

use alloc::vec;
use alloc::vec::Vec;

use crate::inflate::inflate;
use crate::uppercase::uppercase;

pub const MAX_ATLAS: usize = 32 << 20;

const MAX_STRIP_HEIGHT: u32 = 96;
const KEY_GAP: f64 = 12.0;
const ENTRY_GAP: f64 = 44.0;
const KERN_REFERENCE_SIZE: f64 = 1000.0;
const FACE_SORA: u32 = 0;
const FALLBACK_KEY: u32 = 0;
const LIGATURE_KEY_BASE: u32 = 0xe000;
const HEADER_BYTES: u64 = 16;
const COMBO_BYTES: u64 = 24;
const COMBO_READ_BYTES: u64 = 20;
const TABLE_BYTES: u64 = 12;
const RING_BYTES: u64 = 12;
const GLYPH_BYTES: u64 = 24;
const KERN_ENTRY_BYTES: u64 = 6;
const ATLAS_VERSION: u16 = 1;
const DEFAULT_WEIGHT: u32 = 600;
const KEY_WEIGHT: u32 = 700;
const LETTERS_WEIGHT: u32 = 700;
const ELLIPSIS: u32 = 0x2026;
const MAX_INITIALS: usize = 2;
const LETTER_LIGHT: f64 = 0.32;
const LETTER_SATURATION: f64 = 0.45;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    #[default]
    Left,
    Center,
    Right,
}

/// Weight 0 means the default 600.
#[derive(Clone, Copy, Debug, Default)]
pub struct TextStyle {
    pub weight: u32,
    pub tracking: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub bytes: Vec<u8>,
}

impl Bitmap {
    fn new(width: u32, height: u32, channels: u32) -> Self {
        let bytes = vec![0; width as usize * height as usize * channels as usize];
        Self {
            width,
            height,
            channels,
            bytes,
        }
    }
}

#[derive(Clone, Copy)]
struct Ink {
    levels: [u8; 3],
    count: usize,
}

const WHITE: Ink = Ink {
    levels: [255, 0, 0],
    count: 1,
};
const CUT_OUT: Ink = Ink {
    levels: [0, 0, 0],
    count: 1,
};
const LETTER_INK: Ink = Ink {
    levels: [240, 246, 250],
    count: 3,
};

#[derive(Clone, Copy, Default)]
struct Glyph {
    key: u32,
    face: u32,
    sequence_length: u32,
    sequence_at: u64,
    advance: u32,
    dx: i32,
    dy: i32,
    w: u32,
    h: u32,
    offset: u32,
}

#[derive(Clone, Copy)]
struct CharEntry {
    code: u32,
    glyph: usize,
}

#[derive(Clone, Copy)]
struct Ligature {
    glyph: usize,
    units: u32,
    first_code: usize,
    code_count: usize,
}

#[derive(Clone, Copy)]
struct KernEntry {
    pair: u64,
    kern: i64,
}

struct Face {
    size: u32,
    weight: u32,
    ascent: i32,
    descent: i32,
    glyphs: Vec<Glyph>,
    chars: Vec<CharEntry>,
    ligatures: Vec<Ligature>,
    ligature_codes: Vec<u32>,
    fallback: usize,
    kerns: Vec<KernEntry>,
}

struct KernTable {
    face: u32,
    count: u32,
    offset: u32,
}

enum TableStatus {
    Skipped,
    Used(KernTable),
    Broken,
}

struct RingMask {
    w: u32,
    h: u32,
    offset: u32,
}

#[derive(Clone, Copy)]
struct Placed {
    glyph: usize,
    pen: i64,
}

#[derive(Clone, Copy)]
struct Run {
    x: f64,
    first: usize,
    count: usize,
}

#[derive(Default)]
struct Layout {
    placed: Vec<Placed>,
    runs: Vec<Run>,
    length: f64,
}

/// The atlas plus the faces read from it so far.
pub struct Glyphs {
    atlas: Vec<u8>,
    combo_count: u32,
    table_count: u32,
    ring_count: u32,
    tables_at: u64,
    rings_at: u64,
    faces: Vec<Option<Face>>,
}

fn trunc(value: f64) -> f64 {
    if value.abs() < 4_503_599_627_370_496.0 {
        value as i64 as f64
    } else {
        value
    }
}

pub(crate) fn floor(value: f64) -> f64 {
    let whole = trunc(value);
    if whole > value { whole - 1.0 } else { whole }
}

fn js_round(value: f64) -> f64 {
    let floored = floor(value);
    if value - floored >= 0.5 {
        floored + 1.0
    } else {
        floored
    }
}

fn python_round(value: f64) -> f64 {
    let rounded = js_round(value);
    let half = value - floor(value) == 0.5;
    if half && rounded % 2.0 != 0.0 {
        rounded - 1.0
    } else {
        rounded
    }
}

fn non_negative(value: f64) -> f64 {
    if value.is_nan() || value > 0.0 {
        value
    } else {
        0.0
    }
}

fn is_js_space(code: u32) -> bool {
    matches!(
        code,
        0x09..=0x0d | 0x2000..=0x200a | 0x20 | 0xa0 | 0x1680 | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

fn div255(value: u32) -> u32 {
    let biased = value + 128;
    ((biased >> 8) + biased) >> 8
}

fn keep_last<T: Copy, K: PartialEq>(entries: &mut Vec<T>, key: impl Fn(&T) -> K) {
    let mut kept = 0;
    for i in 0..entries.len() {
        let last = i + 1 == entries.len() || key(&entries[i + 1]) != key(&entries[i]);
        if last {
            entries[kept] = entries[i];
            kept += 1;
        }
    }
    entries.truncate(kept);
}

impl Face {
    fn glyph_for(&self, code: u32) -> usize {
        match self.chars.binary_search_by_key(&code, |c| c.code) {
            Ok(found) => self.chars[found].glyph,
            Err(_) => self.fallback,
        }
    }

    fn kern_for(&self, face_id: u32, left: u32, right: u32) -> i64 {
        let pair = u64::from(face_id) << 32 | u64::from(left) << 16 | u64::from(right);
        match self.kerns.binary_search_by_key(&pair, |k| k.pair) {
            Ok(found) => self.kerns[found].kern,
            Err(_) => 0,
        }
    }

    fn next_glyph(&self, codes: &[u32]) -> (usize, usize) {
        let glyph = self.glyph_for(codes[0]);
        if self.glyphs[glyph].face != FACE_SORA {
            return (glyph, 1);
        }

        for ligature in &self.ligatures {
            let expected = &self.ligature_codes
                [ligature.first_code..ligature.first_code + ligature.code_count];
            if ligature.code_count != 0 && codes.starts_with(expected) {
                return (ligature.glyph, ligature.code_count);
            }
        }
        (glyph, 1)
    }

    fn shape_piece(&self, codes: &[u32], layout: &mut Layout) -> i64 {
        let mut pen = 0i64;
        let mut previous: Option<&Glyph> = None;
        let mut i = 0;
        while i < codes.len() {
            let (index, used) = self.next_glyph(&codes[i..]);
            let glyph = &self.glyphs[index];
            if let Some(previous) = previous {
                pen += self.kern_for(glyph.face, previous.key, glyph.key);
            }

            layout.placed.push(Placed { glyph: index, pen });
            pen += i64::from(glyph.advance);
            previous = Some(glyph);
            i += used;
        }
        pen
    }

    fn piece_end(&self, codes: &[u32], start: usize, spaced: bool) -> usize {
        if spaced {
            return start + 1;
        }

        let font = self.glyphs[self.glyph_for(codes[start])].face;
        let mut end = start + 1;
        while end < codes.len() && self.glyphs[self.glyph_for(codes[end])].face == font {
            end += 1;
        }
        end
    }

    fn layout(&self, codes: &[u32], tracking: f64, layout: &mut Layout) {
        let spaced = tracking != 0.0 && !tracking.is_nan();
        layout.placed.clear();
        layout.runs.clear();

        let mut x = 0.0;
        let mut start = 0;
        while start < codes.len() {
            let end = self.piece_end(codes, start, spaced);
            let first = layout.placed.len();
            let length = self.shape_piece(&codes[start..end], layout);
            layout.runs.push(Run {
                x,
                first,
                count: layout.placed.len() - first,
            });
            x += length as f64 / 64.0 + tracking;
            start = end;
        }
        layout.length = non_negative(x - tracking);
    }

    fn fit(&self, codes: &mut Vec<u32>, tracking: f64, width: f64, layout: &mut Layout) {
        while !codes.is_empty() {
            self.layout(codes, tracking, layout);
            let fits = layout.length <= width || layout.length.is_nan();
            if fits {
                return;
            }

            let count = shortened(codes);
            if count > 0 {
                codes[count - 1] = ELLIPSIS;
            }
            codes.truncate(count);
        }
    }

    fn text_box(&self, layout: &Layout) -> (f64, f64, f64, f64) {
        let (mut left, mut top, mut bottom) = (0.0, f64::INFINITY, f64::NEG_INFINITY);
        for run in &layout.runs {
            for placed in &layout.placed[run.first..run.first + run.count] {
                let glyph = &self.glyphs[placed.glyph];
                if glyph.w == 0 || glyph.h == 0 {
                    continue;
                }

                let pen = js_round(run.x * 64.0) + placed.pen as f64;
                let x = floor((pen + 32.0) / 64.0) + f64::from(glyph.dx);
                let glyph_top = f64::from(self.ascent) + f64::from(glyph.dy);
                left = if x < left { x } else { left };
                top = if glyph_top < top { glyph_top } else { top };
                let glyph_bottom = glyph_top + f64::from(glyph.h);
                bottom = if glyph_bottom > bottom {
                    glyph_bottom
                } else {
                    bottom
                };
            }
        }

        let right = floor(layout.length + 0.5);
        if top == f64::INFINITY {
            return (left, 0.0, right, 0.0);
        }
        (left, top, right, bottom)
    }
}

fn shortened(codes: &[u32]) -> usize {
    let count = codes.len();
    let kept = if codes[count - 1] == ELLIPSIS {
        count - 1
    } else {
        count
    };
    if kept <= 1 {
        return 0;
    }

    let mut end = kept - 1;
    while end > 0 && is_js_space(codes[end - 1]) {
        end -= 1;
    }
    end + 1
}

fn codes_of(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}

fn span_visible(start: f64, length: u32, limit: u32) -> bool {
    start.is_finite() && start < f64::from(limit) && start + f64::from(length) > 0.0
}

fn aligned_x(align: Align, width: u32, length: f64) -> f64 {
    match align {
        Align::Left => 0.0,
        Align::Center => (f64::from(width) - length) / 2.0,
        Align::Right => f64::from(width) - length,
    }
}

fn style_weight(style: Option<&TextStyle>) -> u32 {
    match style {
        Some(style) if style.weight != 0 => style.weight,
        _ => DEFAULT_WEIGHT,
    }
}

fn style_tracking(style: Option<&TextStyle>) -> f64 {
    style.map_or(0.0, |style| style.tracking)
}

impl Glyphs {
    /// Inflates and checks the atlas; faces are read on first use.
    pub fn new(zlib: &[u8]) -> Option<Self> {
        let atlas = inflate(zlib, MAX_ATLAS)?;
        let header_ok = atlas.len() >= 12
            && atlas.starts_with(b"HBGA")
            && u16::from_le_bytes([atlas[4], atlas[5]]) == ATLAS_VERSION;
        if !header_ok {
            return None;
        }

        let mut glyphs = Self {
            atlas,
            combo_count: 0,
            table_count: 0,
            ring_count: 0,
            tables_at: 0,
            rings_at: 0,
            faces: Vec::new(),
        };
        glyphs.combo_count = glyphs.u16_at(6);
        glyphs.table_count = glyphs.u16_at(8);
        glyphs.ring_count = glyphs.u16_at(10);
        glyphs.tables_at = HEADER_BYTES + u64::from(glyphs.combo_count) * COMBO_BYTES;
        glyphs.rings_at = glyphs.tables_at + u64::from(glyphs.table_count) * TABLE_BYTES;
        glyphs
            .faces
            .resize_with(glyphs.combo_count as usize, || None);
        Some(glyphs)
    }

    fn in_atlas(&self, at: u64, length: u64) -> bool {
        let size = self.atlas.len() as u64;
        at <= size && length <= size - at
    }

    fn u8_at(&self, at: u64) -> u32 {
        u32::from(self.atlas[at as usize])
    }

    fn u16_at(&self, at: u64) -> u32 {
        self.u8_at(at) | self.u8_at(at + 1) << 8
    }

    fn i16_at(&self, at: u64) -> i32 {
        i32::from(self.u16_at(at) as u16 as i16)
    }

    fn u32_at(&self, at: u64) -> u32 {
        self.u16_at(at) | self.u16_at(at + 2) << 16
    }

    fn i8_at(&self, at: u64) -> i32 {
        i32::from(self.u8_at(at) as u8 as i8)
    }

    fn glyph_at(&self, at: u64) -> Option<Glyph> {
        if !self.in_atlas(at, GLYPH_BYTES) {
            return None;
        }
        let length = self.u8_at(at + 3);
        if length != 0 && !self.in_atlas(at + 4, 2 * u64::from(length)) {
            return None;
        }

        Some(Glyph {
            key: self.u16_at(at),
            face: self.u8_at(at + 2),
            sequence_length: length,
            sequence_at: at + 4,
            advance: self.u16_at(at + 10),
            dx: self.i16_at(at + 12),
            dy: self.i16_at(at + 14),
            w: self.u16_at(at + 16),
            h: self.u16_at(at + 18),
            offset: self.u32_at(at + 20),
        })
    }

    fn sequence_codes(&self, glyph: &Glyph, codes: &mut Vec<u32>) -> usize {
        let before = codes.len();
        let length = glyph.sequence_length;
        let unit_at = |i: u32| self.u16_at(glyph.sequence_at + 2 * u64::from(i));
        let mut i = 0;
        while i < length {
            let unit = unit_at(i);
            let next = if i + 1 < length { unit_at(i + 1) } else { 0 };
            if (0xd800..=0xdbff).contains(&unit) && (0xdc00..=0xdfff).contains(&next) {
                codes.push(0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00));
                i += 2;
            } else {
                codes.push(unit);
                i += 1;
            }
        }
        codes.len() - before
    }

    fn read_face_glyphs(&self, face: &mut Face, count: u32, records_at: u32) -> Option<()> {
        let records_at = u64::from(records_at);
        if count == 0 || !self.in_atlas(records_at, u64::from(count) * GLYPH_BYTES) {
            return None;
        }

        face.glyphs = (0..u64::from(count))
            .map(|g| self.glyph_at(records_at + g * GLYPH_BYTES))
            .collect::<Option<_>>()?;
        let mut char_order = Vec::new();
        let mut ligature_order = Vec::new();
        let mut fallback = None;
        let mut codes = Vec::new();
        for (index, glyph) in face.glyphs.iter().enumerate() {
            if glyph.key == FALLBACK_KEY {
                fallback = Some(index);
            } else if glyph.key >= LIGATURE_KEY_BASE {
                let first_code = face.ligature_codes.len();
                let code_count = self.sequence_codes(glyph, &mut face.ligature_codes);
                ligature_order.push(Ligature {
                    glyph: index,
                    units: glyph.sequence_length,
                    first_code,
                    code_count,
                });
            } else if (1..=2).contains(&glyph.sequence_length) {
                codes.clear();
                if self.sequence_codes(glyph, &mut codes) == 1 {
                    char_order.push(CharEntry {
                        code: codes[0],
                        glyph: index,
                    });
                }
            }
        }
        face.fallback = fallback?;

        char_order.sort_by_key(|c| (c.code, c.glyph));
        keep_last(&mut char_order, |c| c.code);
        ligature_order.sort_by_key(|l| (u32::MAX - l.units, l.glyph));
        face.chars = char_order;
        face.ligatures = ligature_order;
        Some(())
    }

    fn table(&self, index: u32, weight: u32) -> TableStatus {
        let at = self.tables_at + u64::from(index) * TABLE_BYTES;
        if !self.in_atlas(at, 4) {
            return TableStatus::Broken;
        }
        let face = self.u16_at(at);
        if face == FACE_SORA && self.u16_at(at + 2) != weight {
            return TableStatus::Skipped;
        }

        if !self.in_atlas(at + 4, 8) {
            return TableStatus::Broken;
        }
        TableStatus::Used(KernTable {
            face,
            count: self.u32_at(at + 4),
            offset: self.u32_at(at + 8),
        })
    }

    fn read_face_kerns(&self, face: &mut Face, correction_at: u32) -> Option<()> {
        let mut at = u64::from(correction_at);
        let mut total = 0u64;
        for t in 0..self.table_count {
            let table = match self.table(t, face.weight) {
                TableStatus::Broken => return None,
                TableStatus::Skipped => continue,
                TableStatus::Used(table) if table.count == 0 => continue,
                TableStatus::Used(table) => table,
            };
            let entries_ok = self.in_atlas(
                u64::from(table.offset),
                u64::from(table.count) * KERN_ENTRY_BYTES,
            );
            if !entries_ok || !self.in_atlas(at, u64::from(table.count)) {
                return None;
            }
            at += u64::from(table.count);
            total += u64::from(table.count);
        }
        if total > u64::from(u32::MAX) {
            return None;
        }

        let mut kerns: Vec<(KernEntry, usize)> = Vec::new();
        let mut at = u64::from(correction_at);
        for t in 0..self.table_count {
            let TableStatus::Used(table) = self.table(t, face.weight) else {
                continue;
            };
            for i in 0..u64::from(table.count) {
                let entry = u64::from(table.offset) + i * KERN_ENTRY_BYTES;
                let units = f64::from(self.i16_at(entry + 4));
                let scaled = js_round(units * f64::from(face.size) / KERN_REFERENCE_SIZE);
                let kern = scaled as i64 + i64::from(self.i8_at(at + i));
                if kern == 0 {
                    continue;
                }

                let pair = u64::from(table.face) << 32
                    | u64::from(self.u16_at(entry)) << 16
                    | u64::from(self.u16_at(entry + 2));
                let order = kerns.len();
                kerns.push((KernEntry { pair, kern }, order));
            }
            at += u64::from(table.count);
        }

        kerns.sort_by_key(|(k, order)| (k.pair, *order));
        let mut kerns: Vec<KernEntry> = kerns.into_iter().map(|(k, _)| k).collect();
        keep_last(&mut kerns, |k| k.pair);
        face.kerns = kerns;
        Some(())
    }

    fn read_face(&self, combo: u32) -> Option<Face> {
        let at = HEADER_BYTES + u64::from(combo) * COMBO_BYTES;
        if !self.in_atlas(at, COMBO_READ_BYTES) {
            return None;
        }

        let mut face = Face {
            size: self.u16_at(at),
            weight: self.u16_at(at + 2),
            ascent: self.i16_at(at + 4),
            descent: self.i16_at(at + 6),
            glyphs: Vec::new(),
            chars: Vec::new(),
            ligatures: Vec::new(),
            ligature_codes: Vec::new(),
            fallback: 0,
            kerns: Vec::new(),
        };
        self.read_face_glyphs(&mut face, self.u32_at(at + 8), self.u32_at(at + 12))?;
        self.read_face_kerns(&mut face, self.u32_at(at + 16))?;
        Some(face)
    }

    /// Reads the face for `size` and `weight` once and returns its combo index.
    fn face_at(&mut self, size: u32, weight: u32) -> Option<usize> {
        for c in 0..self.combo_count {
            let at = HEADER_BYTES + u64::from(c) * COMBO_BYTES;
            if !self.in_atlas(at, 2) {
                return None;
            }
            if self.u16_at(at) != size {
                continue;
            }
            if !self.in_atlas(at + 2, 2) {
                return None;
            }
            if self.u16_at(at + 2) != weight {
                continue;
            }

            let c = c as usize;
            if self.faces[c].is_none() {
                self.faces[c] = self.read_face(c as u32);
            }
            return self.faces[c].as_ref().map(|_| c);
        }
        None
    }

    fn face(&self, index: usize) -> &Face {
        self.faces[index].as_ref().expect("face_at loaded it")
    }

    fn ring_at(&self, size: u32) -> Option<RingMask> {
        for r in 0..self.ring_count {
            let at = self.rings_at + u64::from(r) * RING_BYTES;
            if !self.in_atlas(at, 2) {
                return None;
            }
            if self.u16_at(at) != size {
                continue;
            }
            if !self.in_atlas(at, RING_BYTES) {
                return None;
            }
            return Some(RingMask {
                w: self.u16_at(at + 2),
                h: self.u16_at(at + 4),
                offset: self.u32_at(at + 8),
            });
        }
        None
    }

    fn mask_alpha(&self, offset: u32, index: u32) -> u32 {
        let half = if index >= 0x8000_0000 {
            -(((1i64 << 32) - i64::from(index) + 1) / 2)
        } else {
            i64::from(index >> 1)
        };
        let position = i64::from(offset) + half;
        if position < 0 || position as u64 >= self.atlas.len() as u64 {
            return 0;
        }

        let packed = u32::from(self.atlas[position as usize]);
        let nibble = if index & 1 != 0 {
            packed & 15
        } else {
            packed >> 4
        };
        nibble * 17
    }

    #[allow(clippy::too_many_arguments)]
    fn blend_mask(
        &self,
        target: &mut Bitmap,
        offset: u32,
        w: u32,
        h: u32,
        x: f64,
        y: f64,
        ink: &Ink,
    ) {
        if !span_visible(x, w, target.width) || !span_visible(y, h, target.height) {
            return;
        }

        let (left, top) = (x as i64, y as i64);
        for row in 0..h {
            let ty = top + i64::from(row);
            if ty < 0 || ty >= i64::from(target.height) {
                continue;
            }

            for col in 0..w {
                let tx = left + i64::from(col);
                if tx < 0 || tx >= i64::from(target.width) {
                    continue;
                }
                let alpha = self.mask_alpha(offset, row.wrapping_mul(w).wrapping_add(col));
                if alpha == 0 {
                    continue;
                }

                let at =
                    (ty as usize * target.width as usize + tx as usize) * target.channels as usize;
                for (c, &level) in ink.levels[..ink.count].iter().enumerate() {
                    let mixed =
                        u32::from(target.bytes[at + c]) * (255 - alpha) + u32::from(level) * alpha;
                    target.bytes[at + c] = div255(mixed) as u8;
                }
            }
        }
    }

    fn draw_runs(
        &self,
        face: &Face,
        target: &mut Bitmap,
        x: f64,
        baseline: f64,
        layout: &Layout,
        ink: &Ink,
    ) {
        let top_line = floor(baseline);
        for run in &layout.runs {
            let start = x + run.x;
            let whole = trunc(start);
            let start_pen = floor((start - whole) * 64.0);

            for placed in &layout.placed[run.first..run.first + run.count] {
                let glyph = &face.glyphs[placed.glyph];
                let column = whole + floor((start_pen + placed.pen as f64 + 32.0) / 64.0);
                let gx = column + f64::from(glyph.dx);
                let gy = top_line + f64::from(glyph.dy);
                self.blend_mask(target, glyph.offset, glyph.w, glyph.h, gx, gy, ink);
            }
        }
    }

    /// One line of white-on-black text, cut with an ellipsis to `width`.
    pub fn text(
        &mut self,
        text: &str,
        size: u32,
        width: u32,
        align: Align,
        style: Option<&TextStyle>,
    ) -> Option<Bitmap> {
        let index = self.face_at(size, style_weight(style))?;
        let face = self.face(index);
        let tracking = style_tracking(style);
        let line_height = face.ascent + face.descent;
        if line_height < 0 {
            return None;
        }
        let height = (line_height as u32).min(MAX_STRIP_HEIGHT);

        let mut codes = codes_of(text);
        let mut layout = Layout::default();
        face.fit(&mut codes, tracking, f64::from(width), &mut layout);
        face.layout(&codes, tracking, &mut layout);

        let x = aligned_x(align, width, layout.length);
        let mut out = Bitmap::new(width, height, 1);
        self.draw_runs(face, &mut out, x, f64::from(face.ascent), &layout, &WHITE);
        Some(out)
    }

    /// The laid-out width of `text`, before any cut.
    pub fn measure(&mut self, text: &str, size: u32, style: Option<&TextStyle>) -> Option<f64> {
        let index = self.face_at(size, style_weight(style))?;
        let mut layout = Layout::default();
        self.face(index)
            .layout(&codes_of(text), style_tracking(style), &mut layout);
        Some(layout.length)
    }

    /// Button legend: a disc with each key name cut out of it, then its label, left to right.
    pub fn legend(&mut self, keys: &[(&str, &str)], size: u32, width: u32) -> Option<Bitmap> {
        let face = self.face_at(size, DEFAULT_WEIGHT)?;
        let key_face = self.face_at(size, KEY_WEIGHT)?;
        let mask = self.ring_at(size)?;
        let (face, key_face) = (self.face(face), self.face(key_face));

        let ring = python_round(f64::from(size) * 1.55);
        let line_height = f64::from(face.ascent + face.descent);
        let tallest = if ring > line_height {
            ring
        } else {
            line_height
        };
        let height = if tallest < f64::from(MAX_STRIP_HEIGHT) {
            tallest
        } else {
            f64::from(MAX_STRIP_HEIGHT)
        };
        let baseline = (height + f64::from(face.ascent) - f64::from(face.descent)) / 2.0;
        let mut out = Bitmap::new(width, height as u32, 1);

        let mut x = 0.0;
        let (mut key, mut label) = (Layout::default(), Layout::default());
        for (name, text) in keys {
            self.blend_mask(&mut out, mask.offset, mask.w, mask.h, trunc(x), 0.0, &WHITE);
            key_face.layout(&codes_of(name), 0.0, &mut key);
            face.layout(&codes_of(text), 0.0, &mut label);

            self.draw_runs(
                key_face,
                &mut out,
                x + (ring - key.length) / 2.0,
                baseline,
                &key,
                &CUT_OUT,
            );
            x += ring + KEY_GAP;
            self.draw_runs(face, &mut out, x, baseline, &label, &WHITE);
            x += label.length + ENTRY_GAP;
        }
        Some(out)
    }

    /// An RGBA tile in the name's hue with up to two initials.
    pub fn letters(&mut self, name: &str, width: u32, height: u32) -> Option<Bitmap> {
        let trimmed = name.trim_matches(|c: char| is_js_space(c.into()));
        let name = if trimmed.is_empty() { "?" } else { trimmed };
        let hue = f64::from(sha256_first_word(name.as_bytes()) >> 16) / 65535.0;
        let rgb = letter_background(hue);
        let mut out = Bitmap::new(width, height, 4);
        for pixel in out.bytes.as_chunks_mut::<4>().0 {
            pixel.copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
        }

        let initials = initials_of(name);
        let index = self.face_at(height / 2, LETTERS_WEIGHT)?;
        let face = self.face(index);
        let mut layout = Layout::default();
        face.layout(&initials, 0.0, &mut layout);

        let (left, top, right, bottom) = face.text_box(&layout);
        let x = (f64::from(out.width) - (right - left)) / 2.0 - left;
        let y = (f64::from(out.height) - (bottom - top)) / 2.0 - top;
        self.draw_runs(
            face,
            &mut out,
            x,
            trunc(y) + f64::from(face.ascent),
            &layout,
            &LETTER_INK,
        );
        Some(out)
    }
}

fn initials_of(name: &str) -> Vec<u32> {
    let mut initials = Vec::new();
    let mut previous_space = true;
    let mut words = 0;
    for c in name.chars() {
        let space = is_js_space(c.into());
        if !space && previous_space && words < MAX_INITIALS {
            let (upper, count) = uppercase(c.into());
            initials.extend_from_slice(&upper[..count]);
            words += 1;
        }
        previous_space = space;
    }
    initials
}

fn hls_channel(value: f64, m1: f64, m2: f64) -> f64 {
    let h = ((value % 1.0) + 1.0) % 1.0;
    if h < 1.0 / 6.0 {
        return m1 + (m2 - m1) * h * 6.0;
    }
    if h < 0.5 {
        return m2;
    }
    if h < 2.0 / 3.0 {
        return m1 + (m2 - m1) * (2.0 / 3.0 - h) * 6.0;
    }
    m1
}

fn letter_background(hue: f64) -> [u8; 3] {
    let (light, saturation) = (LETTER_LIGHT, LETTER_SATURATION);
    let m2 = if light <= 0.5 {
        light * (1.0 + saturation)
    } else {
        light + saturation - light * saturation
    };
    let m1 = 2.0 * light - m2;
    let channels = [
        hls_channel(hue + 1.0 / 3.0, m1, m2),
        hls_channel(hue, m1, m2),
        hls_channel(hue - 1.0 / 3.0, m1, m2),
    ];
    channels.map(|c| trunc(c * 255.0) as u8)
}

const SHA256_ROUNDS: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256_block(state: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    for (i, word) in block.as_chunks::<4>().0.iter().enumerate() {
        w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ w[i - 15] >> 3;
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ w[i - 2] >> 10;
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
    }

    let mut v = *state;
    for i in 0..64 {
        let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
        let choose = (v[4] & v[5]) ^ (!v[4] & v[6]);
        let t1 = v[7]
            .wrapping_add(s1)
            .wrapping_add(choose)
            .wrapping_add(SHA256_ROUNDS[i])
            .wrapping_add(w[i]);
        let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
        let majority = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
        v.copy_within(0..7, 1);
        v[4] = v[4].wrapping_add(t1);
        v[0] = t1.wrapping_add(s0).wrapping_add(majority);
    }
    for (s, v) in state.iter_mut().zip(v) {
        *s = s.wrapping_add(v);
    }
}

/// The first big-endian word of SHA-256(bytes), which sets a letter tile's hue.
fn sha256_first_word(bytes: &[u8]) -> u32 {
    let mut state = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let (blocks, rest) = bytes.as_chunks::<64>();
    for block in blocks {
        sha256_block(&mut state, block);
    }

    let mut tail = [0u8; 128];
    tail[..rest.len()].copy_from_slice(rest);
    tail[rest.len()] = 0x80;
    let tail_length = if rest.len() < 56 { 64 } else { 128 };
    tail[tail_length - 8..tail_length].copy_from_slice(&(bytes.len() as u64 * 8).to_be_bytes());
    for block in tail[..tail_length].as_chunks::<64>().0 {
        sha256_block(&mut state, block);
    }
    state[0]
}
