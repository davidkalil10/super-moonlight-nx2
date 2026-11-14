//! The console UI pages: one layout per model screen, painted through a bitmap cache whose
//! entry serials are the page block identities. Port of ui/composer.c, after
//! dev legacy/src/streamer/ui/page-composer.js.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::glyphs::{Align, Bitmap, Glyphs, TextStyle};
use crate::model::{Model, item};
use crate::page::{self, Image, Item, Page, Placement, Shape, Strip};
use crate::theme::Palette;

pub(crate) const SCREEN_WIDTH: u32 = 1920;
pub(crate) const SIDE: u32 = 96;
pub(crate) const CONTENT_WIDTH: u32 = SCREEN_WIDTH - 2 * SIDE;
pub(crate) const COVER_WIDTH: u32 = 200;
pub(crate) const COVER_HEIGHT: u32 = 300;
pub(crate) const LEGEND_SIZE: u32 = 26;
pub(crate) const LEGEND_WIDTH: u32 = 1200;
/// The height of a legend at `LEGEND_SIZE`, its discs' diameter.
const LEGEND_HEIGHT: u32 = 40;
/// How far a hint's touch target reaches past its ink.
const HINT_PAD: u32 = 12;
/// How far a value arrow's touch target reaches out past its ink.
const ARROW_REACH: u32 = 32;
/// The console's bits for the pad's left and right, which a value's arrows press.
const BUTTON_LEFT: u32 = 1 << 12;
const BUTTON_RIGHT: u32 = 1 << 14;

/// The console's bit for the button a legend key names, for the keys a touch can press.
fn hint_button(key: &str) -> Option<u32> {
    match key {
        "A" => Some(1),
        "B" => Some(2),
        "X" => Some(4),
        "Y" => Some(8),
        "\u{2212}" => Some(1 << 11),
        _ => None,
    }
}
const DEFAULT_CACHE: usize = 8 << 20;

/// One size and weight of the glyph atlas. Only the pairs fonts/glyphs.bin holds can be drawn.
#[derive(Clone, Copy)]
pub(crate) struct Face {
    pub size: u32,
    pub weight: u32,
}

impl Face {
    pub const fn new(size: u32, weight: u32) -> Self {
        Self { size, weight }
    }
}

pub(crate) type Keys<'k> = &'k [(&'k str, &'k str)];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Strip,
    TextLimit,
    ImageLimit,
    ShapeLimit,
    Cover,
    Page(page::Error),
}

impl Error {
    pub const fn message(self) -> &'static str {
        match self {
            Self::Strip => "UI strip could not be painted",
            Self::TextLimit => "UI page over the item or text limit",
            Self::ImageLimit => "UI page over the image limit",
            Self::ShapeLimit => "UI page over the shape limit",
            Self::Cover => "UI cover could not be painted",
            Self::Page(error) => error.message(),
        }
    }
}

struct Entry {
    key: String,
    bitmap: Bitmap,
    left: u32,
    top: u32,
    bytes: usize,
    used: u64,
    serial: u64,
}

/// Page composer with an LRU cache of painted strips and tiles.
pub struct Composer {
    glyphs: Glyphs,
    budget: usize,
    bytes: usize,
    entries: Vec<Entry>,
    clock: u64,
    serial: u64,
    graveyard: Vec<Entry>,
    /// Box art tiles by app id, with the stamp that keys their cache entry.
    covers: Vec<(u32, u64, Bitmap)>,
    cover_stamp: u64,
}

/// Box art tiles kept at once (two pages of the apps grid and some spare).
pub const MAX_COVERS: usize = 32;

#[derive(Clone, Copy)]
struct Placed {
    x: u32,
    y: u32,
    color: u32,
    cursor_item: u32,
    serial: u64,
    shown: (u32, u32),
    radius: u32,
}

pub(crate) struct Builder<'c> {
    pub(crate) composer: &'c mut Composer,
    pub(crate) pal: Palette,
    pub(crate) flags: u32,
    pub(crate) background: u32,
    pub(crate) cursor_home: u32,
    shapes: Vec<Shape>,
    items: Vec<Item>,
    hints: Vec<Item>,
    texts: Vec<Placed>,
    images: Vec<Placed>,
    pub(crate) error: Option<Error>,
}

pub(crate) fn inked(bitmap: &Bitmap, column: i32) -> bool {
    let width = bitmap.width as usize;
    (0..bitmap.height as usize).any(|row| bitmap.bytes[row * width + column as usize] != 0)
}

/// First column from `from` stepping by `step` with ink, and the last of that inked run.
pub(crate) fn ink_run(bitmap: &Bitmap, from: i32, step: i32) -> (i32, i32) {
    let width = bitmap.width as i32;
    let mut column = from;
    while column >= 0 && column < width && !inked(bitmap, column) {
        column += step;
    }

    let first = column;
    let mut last = column - step;
    while column >= 0 && column < width && inked(bitmap, column) {
        last = column;
        column += step;
    }
    (first, last)
}

pub(crate) fn clear_run(bitmap: &mut Bitmap, from: i32, step: i32) {
    let (first, last) = ink_run(bitmap, from, step);
    let width = bitmap.width as usize;
    let mut column = first;
    while column != last + step {
        if column < 0 || column >= bitmap.width as i32 {
            break;
        }
        for row in 0..bitmap.height as usize {
            bitmap.bytes[row * width + column as usize] = 0;
        }
        column += step;
    }
}

/// The spans across a stepper's strip from each arrow's outer edge to halfway to the value.
fn arrow_spans(strip: &Bitmap, can_left: bool, can_right: bool) -> [Option<(u32, u32)>; 2] {
    let last = strip.width as i32 - 1;
    let left = can_left.then(|| {
        let (start, end) = ink_run(strip, 0, 1);
        let (value, _) = ink_run(strip, end + 1, 1);
        (start as u32, ((end + value) / 2) as u32)
    });
    let right = can_right.then(|| {
        let (end, start) = ink_run(strip, last, -1);
        let (value, _) = ink_run(strip, start - 1, -1);
        (((start + value) / 2 + 1) as u32, end as u32 + 1)
    });
    [left, right]
}

/// Cuts an alpha strip to its ink plus a one-pixel margin; an empty strip becomes 1x1.
pub(crate) fn trim(bitmap: Bitmap) -> (Bitmap, u32, u32) {
    let (width, height) = (bitmap.width as usize, bitmap.height as usize);
    let (mut top, mut bottom, mut left, mut right) = (height, None, width, 0);
    for row in 0..height {
        for column in 0..width {
            if bitmap.bytes[row * width + column] == 0 {
                continue;
            }
            top = top.min(row);
            bottom = Some(bottom.map_or(row, |b: usize| b.max(row)));
            left = left.min(column);
            right = right.max(column);
        }
    }

    let Some(bottom) = bottom else {
        return (
            Bitmap {
                width: 1,
                height: 1,
                channels: 1,
                bytes: alloc::vec![0],
            },
            0,
            0,
        );
    };
    let top = top.saturating_sub(1);
    let left = left.saturating_sub(1);
    let cut_right = (right + 1).min(width - 1);
    let cut_bottom = (bottom + 1).min(height - 1);
    let (cut_width, cut_height) = (cut_right - left + 1, cut_bottom - top + 1);

    let mut bytes = Vec::with_capacity(cut_width * cut_height);
    for row in top..top + cut_height {
        bytes.extend_from_slice(&bitmap.bytes[row * width + left..row * width + left + cut_width]);
    }
    let cut = Bitmap {
        width: cut_width as u32,
        height: cut_height as u32,
        channels: 1,
        bytes,
    };
    (cut, left as u32, top as u32)
}

pub(crate) fn legend_key(prefix: &str, keys: Keys) -> String {
    let mut key = String::from(prefix);
    for (name, label) in keys {
        key.push('\x1f');
        key.push_str(name);
        key.push('\x1e');
        key.push_str(label);
    }
    key
}

pub(crate) fn page_count(length: u32, size: u32) -> u32 {
    length.div_ceil(size).max(1)
}

pub(crate) fn shown_count(length: u32, start: u32, size: u32) -> u32 {
    if start >= length {
        0
    } else {
        (length - start).min(size)
    }
}

pub(crate) fn home_slot(index: u32, start: u32, shown: u32) -> u32 {
    if index < start || index - start >= shown {
        0
    } else {
        index - start
    }
}

impl Composer {
    pub fn glyphs_mut(&mut self) -> &mut Glyphs {
        &mut self.glyphs
    }

    /// `cache_bytes` 0 means the default 8 MiB budget.
    pub fn new(glyphs: Glyphs, cache_bytes: usize) -> Self {
        let budget = if cache_bytes == 0 {
            DEFAULT_CACHE
        } else {
            cache_bytes
        };
        Self {
            glyphs,
            budget,
            bytes: 0,
            entries: Vec::new(),
            clock: 0,
            serial: 0,
            graveyard: Vec::new(),
            covers: Vec::new(),
            cover_stamp: 0,
        }
    }

    /// Box art for `app` (an RGBA tile of the cover size); it replaces the letter tile. The
    /// oldest cover goes when more than `MAX_COVERS` are held.
    pub fn set_cover(&mut self, app: u32, tile: Bitmap) {
        if tile.width != COVER_WIDTH || tile.height != COVER_HEIGHT || tile.channels != 4 {
            return;
        }
        self.covers.retain(|(id, _, _)| *id != app);
        if self.covers.len() >= MAX_COVERS {
            self.covers.remove(0);
        }
        self.cover_stamp += 1;
        self.covers.push((app, self.cover_stamp, tile));
    }

    pub fn has_cover(&self, app: u32) -> bool {
        self.covers.iter().any(|(id, _, _)| *id == app)
    }

    /// Drops all box art (another PC's apps are shown).
    pub fn clear_covers(&mut self) {
        self.covers.clear();
    }

    pub const COVER_SIZE: (u32, u32) = (COVER_WIDTH, COVER_HEIGHT);

    pub fn cached_bytes(&self) -> usize {
        self.bytes
    }

    pub fn glyphs(&mut self) -> &mut Glyphs {
        &mut self.glyphs
    }

    fn drop_entry(&mut self, index: usize) {
        let entry = self.entries.swap_remove(index);
        self.bytes -= entry.bytes;
        self.graveyard.push(entry);
    }

    fn evict(&mut self) {
        while self.bytes > self.budget && self.entries.len() > 1 {
            let oldest = (0..self.entries.len())
                .min_by_key(|&i| self.entries[i].used)
                .unwrap_or(0);
            self.drop_entry(oldest);
        }
    }

    fn lookup(&mut self, key: &str) -> Option<u64> {
        let entry = self.entries.iter_mut().find(|e| e.key == key)?;
        self.clock += 1;
        entry.used = self.clock;
        Some(entry.serial)
    }

    fn store_sized(
        &mut self,
        key: String,
        bitmap: Bitmap,
        left: u32,
        top: u32,
        bytes: usize,
    ) -> u64 {
        self.serial += 1;
        self.clock += 1;
        let serial = self.serial;
        self.entries.push(Entry {
            key,
            bitmap,
            left,
            top,
            bytes,
            used: self.clock,
            serial,
        });
        self.bytes += bytes;
        self.evict();
        serial
    }

    fn store(&mut self, key: String, (bitmap, left, top): (Bitmap, u32, u32)) -> u64 {
        let bytes = bitmap.width as usize * bitmap.height as usize;
        self.store_sized(key, bitmap, left, top, bytes)
    }

    fn entry(&self, serial: u64) -> Option<&Entry> {
        self.entries
            .iter()
            .chain(&self.graveyard)
            .find(|e| e.serial == serial)
    }

    /// Composes the model's screen and encodes it into `out`. `Ok(None)` when the screen has no
    /// page. With `resident`, `out` must be the buffer that placement was made in.
    pub fn render(
        &mut self,
        model: &Model,
        settings_error: Option<&str>,
        epoch: u32,
        sequence: u32,
        resident: Option<&Placement>,
        out: &mut [u8],
    ) -> Result<Option<Placement>, Error> {
        self.render_with(model, epoch, sequence, resident, out, |b| {
            b.compose(model, settings_error)
        })
    }

    /// The test pattern page `view` (1 or 2) in place of the model's page; see `Builder::pattern`.
    pub fn render_pattern(
        &mut self,
        model: &Model,
        view: u32,
        epoch: u32,
        sequence: u32,
        resident: Option<&Placement>,
        out: &mut [u8],
    ) -> Result<Option<Placement>, Error> {
        self.render_with(model, epoch, sequence, resident, out, |b| {
            b.pattern(view);
            true
        })
    }

    fn render_with(
        &mut self,
        model: &Model,
        epoch: u32,
        sequence: u32,
        resident: Option<&Placement>,
        out: &mut [u8],
        compose: impl FnOnce(&mut Builder) -> bool,
    ) -> Result<Option<Placement>, Error> {
        self.graveyard.clear();
        let pal = model.look().palette();
        let mut b = Builder {
            composer: self,
            pal,
            flags: 0,
            background: pal.ground,
            cursor_home: 0,
            shapes: Vec::new(),
            items: Vec::new(),
            hints: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
            error: None,
        };
        let has_page = compose(&mut b);
        let Builder {
            flags,
            background,
            cursor_home,
            shapes,
            items,
            hints,
            texts,
            images,
            error,
            ..
        } = b;
        if let Some(error) = error {
            return Err(error);
        }
        if !has_page {
            return Ok(None);
        }

        let mut page = Page::new();
        page.epoch = epoch;
        page.sequence = sequence;
        page.flags = flags;
        page.background = background;
        page.cursor_home = cursor_home;
        page.accent = pal.accent;
        for shape in shapes {
            page.push_shape(shape);
        }
        let room = page::MAX_ITEMS - items.len();
        for item in items.into_iter().chain(hints.into_iter().take(room)) {
            page.push_item(item);
        }
        for text in &texts {
            let entry = self
                .entry(text.serial)
                .expect("strip entry stays until the next render");
            page.push_text(Strip {
                x: text.x,
                y: text.y,
                w: entry.bitmap.width,
                h: entry.bitmap.height,
                alpha: &entry.bitmap.bytes,
                color: text.color,
                cursor_item: text.cursor_item,
                identity: entry.serial,
            });
        }
        for image in &images {
            let entry = self
                .entry(image.serial)
                .expect("tile entry stays until the next render");
            page.push_image(Image {
                x: image.x,
                y: image.y,
                w: entry.bitmap.width,
                h: entry.bitmap.height,
                rgba: &entry.bitmap.bytes,
                identity: entry.serial,
                shown: image.shown,
                radius: image.radius,
            });
        }
        page.encode(resident, out).map(Some).map_err(Error::Page)
    }
}

impl Builder<'_> {
    fn add_text(&mut self, x: u32, y: u32, color: u32, serial: Option<u64>, cursor_item: u32) {
        let Some(serial) = serial else {
            self.error.get_or_insert(Error::Strip);
            return;
        };
        if self.texts.len() >= page::MAX_TEXTS {
            self.error = Some(Error::TextLimit);
            return;
        }

        let entry = self
            .composer
            .entry(serial)
            .expect("just stored or looked up");
        let (x, y) = (x + entry.left, y + entry.top);
        self.texts.push(Placed {
            x,
            y,
            color,
            cursor_item,
            serial,
            shown: (0, 0),
            radius: 0,
        });
    }

    fn painted_text(&mut self, label: &str, face: Face, width: u32, align: Align) -> Option<u64> {
        let key = format!(
            "t\x1f{label}\x1f{}\x1f{width}\x1f{}\x1f{}",
            face.size, align as u32, face.weight
        );
        if let Some(serial) = self.composer.lookup(&key) {
            return Some(serial);
        }

        let style = TextStyle {
            weight: face.weight,
            tracking: 0.0,
        };
        let bitmap = self
            .composer
            .glyphs
            .text(label, face.size, width, align, Some(&style))?;
        Some(self.composer.store(key, trim(bitmap)))
    }

    /// Where a `put` of `label` goes so that its ink is centred on `middle`. Words centre on
    /// their capitals, so a line sits the same whatever letters it holds; a lone mark such
    /// as a dot centres on its own ink.
    pub(crate) fn top_for(&mut self, middle: u32, label: &str, face: Face) -> u32 {
        middle.saturating_sub(self.ink_middle(label, face))
    }

    /// How far below the top of a `put` the middle of `label`'s ink sits, by the rule of `top_for`.
    pub(crate) fn ink_middle(&mut self, label: &str, face: Face) -> u32 {
        let style = TextStyle {
            weight: face.weight,
            tracking: 0.0,
        };
        let sample = if label.chars().any(char::is_alphanumeric) {
            "H"
        } else {
            label
        };
        let ink = self
            .composer
            .glyphs
            .ink_middle(sample, face.size, Some(&style))
            .unwrap_or(f64::from(face.size) / 2.0);
        (ink + 0.5) as u32
    }

    /// As `put`, with the ink centred on `middle` rather than the line's top at `y`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn put_middle(
        &mut self,
        x: u32,
        middle: u32,
        width: u32,
        label: &str,
        face: Face,
        color: u32,
        align: Align,
    ) {
        let y = self.top_for(middle, label, face);
        self.put(x, y, width, label, face, color, align);
    }

    pub(crate) fn text_width(&mut self, label: &str, face: Face) -> u32 {
        let style = TextStyle {
            weight: face.weight,
            tracking: 0.0,
        };
        self.composer
            .glyphs
            .measure(label, face.size, Some(&style))
            .map_or(0, |length| length as u32 + 1)
    }

    /// Text in a box `width` wide whose left edge is `x`; `align` places it inside the box.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn put(
        &mut self,
        x: u32,
        y: u32,
        width: u32,
        label: &str,
        face: Face,
        color: u32,
        align: Align,
    ) {
        self.put_when(x, y, width, label, face, color, align, 0);
    }

    /// As `put`, shown only while the cursor is on item `cursor_item`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn put_when(
        &mut self,
        x: u32,
        y: u32,
        width: u32,
        label: &str,
        face: Face,
        color: u32,
        align: Align,
        cursor_item: u32,
    ) {
        let serial = self.painted_text(label, face, width, align);
        self.add_text(x, y, color, serial, cursor_item);
    }

    /// A value between the arrows it can step to, right aligned in `width` at `x`, `y`. Each
    /// arrow shown is a touch target over the `band` rows, pressing the pad's left or right.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn stepper(
        &mut self,
        (x, y, width): (u32, u32, u32),
        band: (u32, u32),
        value: &str,
        face: Face,
        color: u32,
        can_left: bool,
        can_right: bool,
    ) {
        let key = format!(
            "v\x1f{value}\x1f{}\x1f{width}\x1f{}\x1f{}",
            face.size,
            u8::from(can_left),
            u8::from(can_right)
        );
        let mut serial = self.composer.lookup(&key);
        if serial.is_none() {
            let label = format!("\u{2039}   {value}   \u{203a}");
            let style = TextStyle {
                weight: face.weight,
                tracking: 0.0,
            };
            if let Some(mut bitmap) =
                self.composer
                    .glyphs
                    .text(&label, face.size, width, Align::Right, Some(&style))
            {
                if !can_left {
                    clear_run(&mut bitmap, 0, 1);
                }
                if !can_right {
                    let right = bitmap.width as i32 - 1;
                    clear_run(&mut bitmap, right, -1);
                }
                serial = Some(self.composer.store(key, trim(bitmap)));
            }
        }
        self.add_text(x, y, color, serial, 0);
        let Some(entry) = serial.and_then(|serial| self.composer.entry(serial)) else {
            return;
        };
        let [left, right] = arrow_spans(&entry.bitmap, can_left, can_right);
        let origin = x + entry.left;
        let (top, height) = band;
        if let Some((start, end)) = left {
            let start = (origin + start).saturating_sub(ARROW_REACH);
            self.hint(BUTTON_LEFT, (start, top, origin + end - start, height));
        }
        if let Some((start, end)) = right {
            let width = end - start + ARROW_REACH;
            self.hint(BUTTON_RIGHT, (origin + start, top, width, height));
        }
    }

    pub(crate) fn shape(&mut self, shape: Shape) {
        if self.shapes.len() >= page::MAX_SHAPES {
            self.error = Some(Error::ShapeLimit);
            return;
        }
        self.shapes.push(shape);
    }

    pub(crate) fn fill(&mut self, x: u32, y: u32, w: u32, h: u32, color: u32, radius: u32) {
        self.shape(Shape {
            x,
            y,
            w,
            h,
            fill: color,
            radius,
            ..Shape::default()
        });
    }

    pub(crate) fn dot(&mut self, x: u32, y: u32, size: u32, color: u32) {
        self.fill(x, y, size, size, color, size / 2);
    }

    fn legend_serial(&mut self, keys: Keys) -> Option<u64> {
        let key = legend_key("l", keys);
        self.composer.lookup(&key).or_else(|| {
            let bitmap = self
                .composer
                .glyphs
                .legend(keys, LEGEND_SIZE, LEGEND_WIDTH)?;
            Some(self.composer.store(key, trim(bitmap)))
        })
    }

    /// The button legend with its right edge at `right`; returns the left edge it took. With a
    /// `cursor_item` it shows only while the cursor is on that item.
    pub(crate) fn legend_right(
        &mut self,
        right: u32,
        y: u32,
        keys: Keys,
        color: u32,
        cursor_item: u32,
    ) -> u32 {
        let serial = self.legend_serial(keys);
        let Some((left, width)) = serial
            .and_then(|serial| self.composer.entry(serial))
            .map(|entry| (entry.left, entry.bitmap.width))
        else {
            self.error.get_or_insert(Error::Strip);
            return right;
        };
        let x = right.saturating_sub(left + width);
        self.add_text(x, y, color, serial, cursor_item);
        if cursor_item == 0 {
            self.hints(x, y, keys);
        }
        x + left
    }

    /// Touch targets over the entries of a legend drawn at `x`, `y`, taken after the page's
    /// own items so the cursor never lands on them.
    fn hints(&mut self, x: u32, y: u32, keys: Keys) {
        let Some(spans) = self.composer.glyphs.legend_spans(keys, LEGEND_SIZE) else {
            return;
        };
        for ((key, _), (start, end)) in keys.iter().zip(spans) {
            let Some(button) = hint_button(key) else {
                continue;
            };
            let left = x + start as u32;
            self.hint(
                button,
                (
                    left.saturating_sub(HINT_PAD),
                    y.saturating_sub(HINT_PAD),
                    (end as u32).saturating_sub(start as u32) + 2 * HINT_PAD,
                    LEGEND_HEIGHT + 2 * HINT_PAD,
                ),
            );
        }
    }

    /// A touch target that presses `button`, taken after the page's own items.
    fn hint(&mut self, button: u32, (x, y, w, h): (u32, u32, u32, u32)) {
        self.hints.push(Item {
            id: item::HINT | button,
            x,
            y,
            w,
            h,
            flags: page::ITEM_HINT,
            radius: 0,
        });
    }

    pub(crate) fn item(
        &mut self,
        id: u32,
        (x, y, w, h): (u32, u32, u32, u32),
        flags: u32,
        radius: u32,
    ) {
        if self.items.len() >= page::MAX_ITEMS {
            self.error = Some(Error::TextLimit);
            return;
        }
        self.items.push(Item {
            id,
            x,
            y,
            w,
            h,
            flags,
            radius,
        });
    }

    /// An image at `x`, `y`; `shown` scales it on screen.
    pub(crate) fn image(&mut self, x: u32, y: u32, serial: u64, shown: (u32, u32), radius: u32) {
        if self.images.len() >= page::MAX_IMAGES {
            self.error = Some(Error::ImageLimit);
            return;
        }
        self.images.push(Placed {
            x,
            y,
            color: 0,
            cursor_item: 0,
            serial,
            shown,
            radius,
        });
    }

    /// A flat rectangle drawn as a stretched one-pixel image, which keeps the shape table free.
    pub(crate) fn solid(&mut self, (x, y, w, h): (u32, u32, u32, u32), color: u32, radius: u32) {
        let key = format!("s\x1f{color:08x}");
        let serial = self.composer.lookup(&key).unwrap_or_else(|| {
            let bitmap = Bitmap {
                width: 1,
                height: 1,
                channels: 4,
                bytes: color.to_le_bytes().to_vec(),
            };
            self.composer.store_sized(key, bitmap, 0, 0, 4)
        });
        self.image(x, y, serial, (w, h), radius);
    }

    /// The tile for `app`: its box art, or a letter tile on a colour taken from its name.
    pub(crate) fn cover_tile(&mut self, id: u32, name: &str) -> Option<u64> {
        let art = self
            .composer
            .covers
            .iter()
            .find(|(known, _, _)| *known == id)
            .map(|(_, stamp, _)| *stamp);
        if let Some(stamp) = art {
            let key = format!("p\x1f{stamp}");
            if let Some(serial) = self.composer.lookup(&key) {
                return Some(serial);
            }
            let (_, _, tile) = self
                .composer
                .covers
                .iter()
                .find(|(known, _, _)| *known == id)?;
            let tile = tile.clone();
            let bytes = tile.bytes.len();
            return Some(self.composer.store_sized(key, tile, 0, 0, bytes));
        }
        let key = format!("c\x1f{name}");
        if let Some(serial) = self.composer.lookup(&key) {
            return Some(serial);
        }

        let tile = self
            .composer
            .glyphs
            .letters(name, COVER_WIDTH, COVER_HEIGHT)?;
        let bytes = tile.width as usize * tile.height as usize * 4;
        Some(self.composer.store_sized(key, tile, 0, 0, bytes))
    }
}

const PATTERN_FACES: [Face; 4] = [
    Face::new(24, 500),
    Face::new(28, 500),
    Face::new(32, 600),
    Face::new(44, 500),
];

fn pattern_tile(view: u32) -> Bitmap {
    let (width, height) = (COVER_WIDTH as usize, COVER_HEIGHT as usize);
    let mut bytes = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        for x in 0..width {
            let ramp = (x * 120 / width + y * 120 / height) / 2;
            let level = if view == 1 { 40 + ramp } else { 220 - ramp };
            let line = view == 2 && y % 32 == 0;
            let value = if line { 255 - level } else { level } as u8;
            bytes.extend([value, value, value, 255]);
        }
    }
    Bitmap {
        width: COVER_WIDTH,
        height: COVER_HEIGHT,
        channels: 4,
        bytes,
    }
}

impl Builder<'_> {
    /// A page of known art for telling a bad draw from bad content: smooth tiles at 1:1 and
    /// scaled, thin rules and text in four sizes. Views 1 and 2 differ in every byte but share
    /// their layout, so an old page showing through in the other one is easy to see.
    pub(crate) fn pattern(&mut self, view: u32) {
        let tile = |b: &mut Builder<'_>, n: u32, x: u32, shown: (u32, u32)| {
            let key = format!("pat\x1f{view}\x1f{n}");
            let serial = b.composer.lookup(&key).unwrap_or_else(|| {
                let bitmap = pattern_tile(view);
                let bytes = bitmap.bytes.len();
                b.composer.store_sized(key, bitmap, 0, 0, bytes)
            });
            b.image(x, 64, serial, shown, 12);
        };
        tile(self, 0, 96, (COVER_WIDTH, COVER_HEIGHT));
        tile(self, 1, 340, (326, 489));
        tile(self, 2, 700, (150, 225));
        tile(self, 3, 900, (COVER_WIDTH, COVER_HEIGHT));

        let ink = self.pal.ink;
        self.fill(96, 600, 1728, 2, self.pal.line, 0);
        self.fill(96, 953, 1728, 2, self.pal.line, 0);
        let sentence = if view == 1 {
            "Fair link (136 Mbps, 5 ms): 2160p60 at 41 Mbps"
        } else {
            "Good link (80 Mbps, 7 ms): 1080p60 at 14 Mbps"
        };
        for (row, face) in PATTERN_FACES.into_iter().enumerate() {
            self.put(
                96,
                630 + row as u32 * 70,
                1700,
                sentence,
                face,
                ink,
                Align::Left,
            );
        }
        let name = format!("Pattern {view} of 2");
        self.put(96, 990, 600, &name, PATTERN_FACES[1], ink, Align::Left);
    }
}
