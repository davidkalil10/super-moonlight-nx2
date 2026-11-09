//! The console UI pages: one layout per model screen, painted through a bitmap cache whose
//! entry serials are the page block identities. Port of ui/composer.c, after
//! src/streamer/ui/page-composer.js.

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::glyphs::{Align, Bitmap, Glyphs, TextStyle};
use crate::model::{APPS_PER_PAGE, App, HOSTS_PER_PAGE, Model, Screen, is_address, item};
use crate::page::{self, Image, Item, Page, Placement, Strip};
use crate::settings::{Setting, SettingRow};

const COLOR_INK: u32 = 0xfff9_fafa;
const COLOR_SOFT: u32 = 0xffd1_d3d6;
const COLOR_MUTED: u32 = 0xff9e_a2a8;
const COLOR_GREY: u32 = 0xff6c_7178;
const COLOR_ACCENT: u32 = 0xfff8_bd38;
const COLOR_RUNNING: u32 = 0xffac_ef86;
const COLOR_CARD: u32 = 0xff24_2529;
const COLOR_DIM: u32 = 0xff1d_1f23;
const COLOR_BACKGROUND: u32 = 0xff17_191c;
const COLOR_CLEAR: u32 = 0;

const SCREEN_WIDTH: u32 = 1920;
const SIDE: u32 = 96;
const CONTENT_WIDTH: u32 = SCREEN_WIDTH - 2 * SIDE;
const COVER_WIDTH: u32 = 240;
const COVER_HEIGHT: u32 = 135;
const GRID_Y: u32 = 380;
const GRID_COLUMNS: u32 = 5;
const GRID_GAP: u32 = 48;
const GRID_NAME: u32 = 16;
const GRID_ROW: u32 = 135 + 16 + 34 + 24;
const CHIP_Y: u32 = 64;
const CHIP_HEIGHT: u32 = 54;
const CHIP_PAD: u32 = 10;
const CHIP_SIZE: u32 = 26;
const LEGEND_Y: u32 = 984;
const LEGEND_SIZE: u32 = 26;
const LEGEND_HEIGHT: u32 = 40;
const LEGEND_WIDTH: u32 = 1200;
const CARD_WIDTH: u32 = 840;
const CARD_HEIGHT: u32 = 96;
const CARD_GAP_X: u32 = 48;
const CARD_GAP_Y: u32 = 32;
const CARD_PAD: u32 = 32;
const HOST_CARDS_Y: u32 = 430;
const SETTING_GRID_Y: u32 = 180;
const SETTING_GRID_GAP_Y: u32 = 24;
const KEYPAD_Y: u32 = 430;
const KEYPAD_WIDTH: u32 = 160;
const KEYPAD_GAP: u32 = 24;
const LABEL_SIZE: u32 = 22;
const HEADING_Y: u32 = 200;
const HEADING_STATUS: u32 = 340;
const HEADING_KICKER: u32 = 24;
const HEADING_SIZE: u32 = 72;
const BUTTON_Y: u32 = 640;
const BUTTON_WIDTH: u32 = 400;
const BUTTON_GAP: u32 = 48;
const PAGER_WIDTH: u32 = 300;
const RUNNING_WIDTH: u32 = 112;
const RUNNING_HEIGHT: u32 = 30;
const NOTE_WIDTH: u32 = 700;
const OVERLAY_BUTTON: u32 = 520;
const STRIP_HEIGHT: u32 = 96;
const DEFAULT_CACHE: usize = 8 << 20;

const KEY_LABELS: [&str; 12] = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "Erase",
];

type Keys<'k> = &'k [(&'k str, &'k str)];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Strip,
    TextLimit,
    ImageLimit,
    Cover,
    Page(page::Error),
}

impl Error {
    pub const fn message(self) -> &'static str {
        match self {
            Self::Strip => "UI strip could not be painted",
            Self::TextLimit => "UI page over the item or text limit",
            Self::ImageLimit => "UI page over the image limit",
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
}

struct Builder<'c> {
    composer: &'c mut Composer,
    flags: u32,
    background: u32,
    cursor_home: u32,
    items: Vec<Item>,
    texts: Vec<Placed>,
    images: Vec<Placed>,
    error: Option<Error>,
}

struct Chip<'a> {
    label: Option<&'a str>,
    color: u32,
    width: u32,
}

#[derive(Default)]
struct Frame<'a> {
    chips: &'a [Chip<'a>],
    note: Option<&'a str>,
    keys: Keys<'a>,
    footer: Option<&'a str>,
    background: u32,
    cursor_home: u32,
    flags: u32,
}

#[derive(Clone, Copy)]
struct HeadingStyle {
    y: u32,
    size: u32,
    color: u32,
    tracking: f64,
}

fn heading_style(y: u32) -> HeadingStyle {
    HeadingStyle {
        y,
        size: HEADING_SIZE,
        color: COLOR_INK,
        tracking: 0.0,
    }
}

fn inked(bitmap: &Bitmap, column: i32) -> bool {
    let width = bitmap.width as usize;
    (0..bitmap.height as usize).any(|row| bitmap.bytes[row * width + column as usize] != 0)
}

/// First column from `from` stepping by `step` with ink, and the last of that inked run.
fn ink_run(bitmap: &Bitmap, from: i32, step: i32) -> (i32, i32) {
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

fn clear_run(bitmap: &mut Bitmap, from: i32, step: i32) {
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

/// Cuts an alpha strip to its ink plus a one-pixel margin; an empty strip becomes 1x1.
fn trim(bitmap: Bitmap) -> (Bitmap, u32, u32) {
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

fn legend_key(prefix: &str, keys: Keys) -> String {
    let mut key = String::from(prefix);
    for (name, label) in keys {
        key.push('\x1f');
        key.push_str(name);
        key.push('\x1e');
        key.push_str(label);
    }
    key
}

fn page_count(length: u32, size: u32) -> u32 {
    length.div_ceil(size).max(1)
}

fn shown_count(length: u32, start: u32, size: u32) -> u32 {
    if start >= length {
        0
    } else {
        (length - start).min(size)
    }
}

fn home_slot(index: u32, start: u32, shown: u32) -> u32 {
    if index < start || index - start >= shown {
        0
    } else {
        index - start
    }
}

fn card_at(i: u32, top: u32, gap_y: u32) -> (u32, u32) {
    (
        SIDE + (i % 2) * (CARD_WIDTH + CARD_GAP_X),
        top + (i / 2) * (CARD_HEIGHT + gap_y),
    )
}

fn join(out: &mut String, part: Option<&str>) {
    let Some(part) = part.filter(|p| !p.is_empty()) else {
        return;
    };
    if !out.is_empty() {
        out.push_str(" \u{b7} ");
    }
    out.push_str(part);
}

fn host_name(model: &Model) -> Option<&str> {
    model.host().map(|h| h.name.as_str())
}

fn host_chips(model: &Model) -> [Chip<'_>; 2] {
    [
        Chip {
            label: host_name(model),
            color: COLOR_INK,
            width: 300,
        },
        Chip {
            label: model.host().map(|h| h.address.as_str()),
            color: COLOR_MUTED,
            width: 300,
        },
    ]
}

fn stream_shape(model: &Model) -> String {
    let used = model
        .settings()
        .in_use(model.docked(), model.capabilities());
    let rows = used.rows(model.docked(), model.capabilities());
    let value = |s: Setting| rows[s as usize].value;
    format!(
        "{} \u{b7} {} \u{b7} {}",
        value(Setting::Size),
        value(Setting::Fps),
        value(Setting::Bitrate)
    )
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
        self.graveyard.clear();
        let mut b = Builder {
            composer: self,
            flags: 0,
            background: 0xff00_0000,
            cursor_home: 0,
            items: Vec::new(),
            texts: Vec::new(),
            images: Vec::new(),
            error: None,
        };
        let has_page = b.compose(model, settings_error);
        let Builder {
            flags,
            background,
            cursor_home,
            items,
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
        for item in items {
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
        });
    }

    fn painted_text(
        &mut self,
        label: &str,
        size: u32,
        width: u32,
        align: Align,
        weight: u32,
        tracking: f64,
    ) -> Option<u64> {
        let key = format!(
            "t\x1f{label}\x1f{size}\x1f{width}\x1f{}\x1f{weight}\x1f{:x}",
            align as u32,
            tracking.to_bits()
        );
        if let Some(serial) = self.composer.lookup(&key) {
            return Some(serial);
        }

        let style = TextStyle { weight, tracking };
        let bitmap = self
            .composer
            .glyphs
            .text(label, size, width, align, Some(&style))?;
        Some(self.composer.store(key, trim(bitmap)))
    }

    #[allow(clippy::too_many_arguments)]
    fn text(
        &mut self,
        x: u32,
        y: u32,
        label: &str,
        size: u32,
        width: u32,
        color: u32,
        align: Align,
        weight: u32,
        tracking: f64,
        cursor_item: u32,
    ) {
        let serial = self.painted_text(label, size, width, align, weight, tracking);
        self.add_text(x, y, color, serial, cursor_item);
    }

    #[allow(clippy::too_many_arguments)]
    fn plain(
        &mut self,
        x: u32,
        y: u32,
        label: &str,
        size: u32,
        width: u32,
        color: u32,
        align: Align,
    ) {
        self.text(x, y, label, size, width, color, align, 600, 0.0, 0);
    }

    #[allow(clippy::too_many_arguments)]
    fn stepper(
        &mut self,
        x: u32,
        y: u32,
        value: &str,
        size: u32,
        width: u32,
        can_left: bool,
        can_right: bool,
    ) {
        let key = format!(
            "v\x1f{value}\x1f{size}\x1f{width}\x1f{}\x1f{}",
            u8::from(can_left),
            u8::from(can_right)
        );
        let mut serial = self.composer.lookup(&key);
        if serial.is_none() {
            let label = format!("\u{2039}   {value}   \u{203a}");
            let style = TextStyle {
                weight: 700,
                tracking: 0.0,
            };
            if let Some(mut bitmap) =
                self.composer
                    .glyphs
                    .text(&label, size, width, Align::Center, Some(&style))
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
        self.add_text(x, y, COLOR_INK, serial, 0);
    }

    fn solid(&mut self, x: u32, y: u32, w: u32, h: u32, color: u32) {
        let key = format!("s\x1f{w}\x1f{h}");
        let serial = match self.composer.lookup(&key) {
            Some(serial) => serial,
            None => {
                let fill = Bitmap {
                    width: w,
                    height: h,
                    channels: 1,
                    bytes: alloc::vec![255; w as usize * h as usize],
                };
                self.composer.store(key, (fill, 0, 0))
            }
        };
        self.add_text(x, y, color, Some(serial), 0);
    }

    fn legend(&mut self, x: u32, y: u32, keys: Keys) {
        let key = legend_key("l", keys);
        let serial = self.composer.lookup(&key).or_else(|| {
            let bitmap = self
                .composer
                .glyphs
                .legend(keys, LEGEND_SIZE, LEGEND_WIDTH)?;
            Some(self.composer.store(key, trim(bitmap)))
        });
        self.add_text(x, y, COLOR_SOFT, serial, 0);
    }

    /// The legend of `head` + `tail`, cut after the last ink of `head` alone.
    fn tail_bitmap(&mut self, head: Keys, tail: Keys) -> Option<(Bitmap, u32, u32)> {
        let all: Vec<(&str, &str)> = head.iter().chain(tail).copied().collect();
        let glyphs = &mut self.composer.glyphs;
        let whole = glyphs.legend(&all, LEGEND_SIZE, LEGEND_WIDTH)?;
        let first = glyphs.legend(head, LEGEND_SIZE, LEGEND_WIDTH)?;
        let (run_first, _) = ink_run(&first, first.width as i32 - 1, -1);
        if run_first < 0 {
            return None;
        }

        let from = run_first as usize + 1;
        let width = whole.width as usize;
        let cut_width = width - from;
        let mut bytes = Vec::with_capacity(cut_width * whole.height as usize);
        for row in 0..whole.height as usize {
            bytes.extend_from_slice(&whole.bytes[row * width + from..(row + 1) * width]);
        }
        let cut = Bitmap {
            width: cut_width as u32,
            height: whole.height,
            channels: 1,
            bytes,
        };
        let (cut, left, top) = trim(cut);
        Some((cut, left + from as u32, top))
    }

    #[allow(clippy::too_many_arguments)]
    fn legend_tail(&mut self, x: u32, y: u32, head: Keys, tail: Keys, cursor_item: u32) {
        let key = legend_key("lt", head) + &legend_key("\x1d", tail);
        let serial = self.composer.lookup(&key).or_else(|| {
            let cut = self.tail_bitmap(head, tail)?;
            Some(self.composer.store(key, cut))
        });
        self.add_text(x, y, COLOR_SOFT, serial, cursor_item);
    }

    fn item(&mut self, id: u32, x: u32, y: u32, w: u32, h: u32, flags: u32) {
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
        });
    }

    fn image(&mut self, x: u32, y: u32, serial: u64) {
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
        });
    }

    fn horizon(&mut self, frame: &Frame) {
        self.background = frame.background;
        self.cursor_home = frame.cursor_home;
        self.flags = frame.flags;

        let mut x = SIDE;
        for chip in frame.chips {
            let Some(label) = chip.label.filter(|l| !l.is_empty()) else {
                continue;
            };
            self.solid(x, CHIP_Y, chip.width, CHIP_HEIGHT, COLOR_CARD);
            self.plain(
                x,
                CHIP_Y + CHIP_PAD,
                label,
                CHIP_SIZE,
                chip.width,
                chip.color,
                Align::Center,
            );
            x += chip.width + 16;
        }

        let note_x = SCREEN_WIDTH - SIDE - NOTE_WIDTH;
        if let Some(note) = frame.note.filter(|n| !n.is_empty()) {
            self.plain(
                note_x,
                CHIP_Y + CHIP_PAD,
                note,
                26,
                NOTE_WIDTH,
                COLOR_MUTED,
                Align::Right,
            );
        }
        if !frame.keys.is_empty() {
            self.legend(SIDE, LEGEND_Y, frame.keys);
        }
        if let Some(footer) = frame.footer.filter(|f| !f.is_empty()) {
            self.text(
                note_x,
                LEGEND_Y + 5,
                footer,
                24,
                NOTE_WIDTH,
                COLOR_GREY,
                Align::Right,
                500,
                0.0,
                0,
            );
        }
    }

    fn heading(&mut self, kicker: &str, title: &str, line: Option<&str>, style: &HeadingStyle) {
        let kicker = kicker.to_ascii_uppercase();
        let tracking = f64::from(HEADING_KICKER) * 0.1;
        self.text(
            SIDE,
            style.y,
            &kicker,
            HEADING_KICKER,
            CONTENT_WIDTH,
            COLOR_ACCENT,
            Align::Left,
            600,
            tracking,
            0,
        );
        self.text(
            SIDE,
            style.y + 44,
            title,
            style.size,
            CONTENT_WIDTH,
            style.color,
            Align::Left,
            700,
            style.tracking,
            0,
        );
        if let Some(line) = line.filter(|l| !l.is_empty()) {
            self.text(
                SIDE,
                style.y + 148,
                line,
                28,
                CONTENT_WIDTH,
                COLOR_MUTED,
                Align::Left,
                500,
                0.0,
                0,
            );
        }
    }

    fn panel(&mut self, x: u32, y: u32, w: u32, h: u32, color: u32) {
        for top in (0..h).step_by(STRIP_HEIGHT as usize) {
            self.solid(x, y + top, w, (h - top).min(STRIP_HEIGHT), color);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn button(&mut self, id: u32, x: u32, y: u32, width: u32, label: &str, greyed: bool) {
        self.item(
            id,
            x,
            y,
            width,
            CARD_HEIGHT,
            if greyed { page::ITEM_GREYED } else { 0 },
        );
        self.solid(
            x,
            y,
            width,
            CARD_HEIGHT,
            if greyed { COLOR_DIM } else { COLOR_CARD },
        );
        let color = if greyed { COLOR_GREY } else { COLOR_INK };
        self.text(
            x,
            y + 28,
            label,
            32,
            width,
            color,
            Align::Center,
            700,
            0.0,
            0,
        );
    }

    fn pager(&mut self, y: u32, at: u32, pages: u32) {
        let x = SCREEN_WIDTH - SIDE - 2 * PAGER_WIDTH - BUTTON_GAP;
        let next_x = x + PAGER_WIDTH + BUTTON_GAP;
        self.button(
            item::PREVIOUS,
            x,
            y,
            PAGER_WIDTH,
            "\u{2039}  Previous",
            at == 0,
        );
        self.button(
            item::NEXT,
            next_x,
            y,
            PAGER_WIDTH,
            "Next  \u{203a}",
            at + 1 >= pages,
        );
    }

    fn status(&mut self, model: &Model, kicker: &str, title: &str, line: Option<&str>, keys: Keys) {
        let chips = host_chips(model);
        let frame = Frame {
            chips: &chips,
            keys,
            background: COLOR_BACKGROUND,
            flags: page::FLAG_HIDE_CURSOR,
            ..Default::default()
        };
        self.horizon(&frame);
        self.heading(kicker, title, line, &heading_style(HEADING_STATUS));
    }

    fn hosts_page(&mut self, model: &Model) {
        let keys: Keys = &[("A", "Open"), ("X", "Settings"), ("Y", "PC options")];
        let hosts = model.hosts();
        let count = hosts.len() as u32;
        let pages = page_count(count, HOSTS_PER_PAGE);
        let start = model.host_page() * HOSTS_PER_PAGE;
        let shown = shown_count(count, start, HOSTS_PER_PAGE);
        let note = if pages > 1 {
            format!("Page {} of {pages}", model.host_page() + 1)
        } else {
            String::new()
        };
        let chips = [Chip {
            label: Some("Moonlight"),
            color: COLOR_INK,
            width: 240,
        }];
        let cursor_home = home_slot(model.host_index(), start, shown);
        let frame = Frame {
            chips: &chips,
            note: Some(&note),
            keys,
            background: COLOR_BACKGROUND,
            cursor_home,
            ..Default::default()
        };
        self.horizon(&frame);

        let style = heading_style(HEADING_Y);
        if shown == 0 {
            let line = model
                .message()
                .unwrap_or("Add one by its address, or find PCs on this network");
            self.heading("No PCs yet", "Add a PC", Some(line), &style);
        } else {
            let line = match model.message() {
                Some(message) => String::from(message),
                None => format!("{count} {} saved", if count == 1 { "PC" } else { "PCs" }),
            };
            self.heading("Moonlight", "Choose a PC", Some(&line), &style);
        }

        let inner = CARD_WIDTH - 2 * CARD_PAD;
        for i in 0..shown {
            let host = &hosts[(start + i) as usize];
            let (x, y) = card_at(i, HOST_CARDS_Y, CARD_GAP_Y);
            self.item(item::HOST + start + i, x, y, CARD_WIDTH, CARD_HEIGHT, 0);
            self.solid(x, y, CARD_WIDTH, CARD_HEIGHT, COLOR_CARD);
            self.text(
                x + CARD_PAD,
                y + 12,
                host.name.as_str(),
                36,
                inner,
                COLOR_INK,
                Align::Left,
                700,
                0.0,
                0,
            );
            self.text(
                x + CARD_PAD,
                y + 60,
                host.address.as_str(),
                24,
                inner,
                COLOR_MUTED,
                Align::Left,
                500,
                0.0,
                0,
            );
        }

        let buttons_y = HOST_CARDS_Y + 3 * (CARD_HEIGHT + CARD_GAP_Y);
        self.button(
            item::ADD_HOST,
            SIDE,
            buttons_y,
            PAGER_WIDTH,
            "+  Add PC",
            false,
        );
        self.button(
            item::FIND_HOSTS,
            SIDE + PAGER_WIDTH + BUTTON_GAP,
            buttons_y,
            PAGER_WIDTH,
            "Find PCs",
            false,
        );
        if pages > 1 {
            self.pager(buttons_y, model.host_page(), pages);
        }
    }

    fn add_host_page(&mut self, model: &Model) {
        let keys: Keys = &[("A", "Type"), ("Y", "Erase"), ("B", "Cancel")];
        let chips = [
            Chip {
                label: Some("Moonlight"),
                color: COLOR_INK,
                width: 240,
            },
            Chip {
                label: Some("Add PC"),
                color: COLOR_MUTED,
                width: 180,
            },
        ];
        self.horizon(&Frame {
            chips: &chips,
            keys,
            background: COLOR_BACKGROUND,
            ..Default::default()
        });

        let entry = model.entry();
        let mut style = heading_style(HEADING_Y);
        style.color = if entry.is_empty() {
            COLOR_GREY
        } else {
            COLOR_INK
        };
        let title = if entry.is_empty() { "_" } else { entry };
        self.heading(
            "Add a PC",
            title,
            Some("The IP address of the PC running Sunshine, as 192.168.1.20"),
            &style,
        );

        for (i, label) in (0u32..).zip(KEY_LABELS) {
            let x = SIDE + (i % 3) * (KEYPAD_WIDTH + KEYPAD_GAP);
            let y = KEYPAD_Y + (i / 3) * (CARD_HEIGHT + KEYPAD_GAP);
            let id = if i < 11 { item::KEY + i } else { item::ERASE };
            self.button(id, x, y, KEYPAD_WIDTH, label, false);
        }

        let actions_x = SIDE + 3 * (KEYPAD_WIDTH + KEYPAD_GAP) + BUTTON_GAP;
        self.button(
            item::CONNECT,
            actions_x,
            KEYPAD_Y,
            BUTTON_WIDTH,
            "Connect",
            !is_address(entry),
        );
        self.button(
            item::CANCEL,
            actions_x,
            KEYPAD_Y + CARD_HEIGHT + KEYPAD_GAP,
            BUTTON_WIDTH,
            "Cancel",
            false,
        );
    }

    fn host_menu_page(&mut self, model: &Model) {
        let keys: Keys = &[("A", "Choose"), ("B", "Back")];
        let chips = host_chips(model);
        self.horizon(&Frame {
            chips: &chips,
            keys,
            background: COLOR_BACKGROUND,
            cursor_home: 3,
            ..Default::default()
        });
        let line = "Remove keeps pairing; unpair makes the PC forget this console";
        self.heading(
            "PC options",
            host_name(model).unwrap_or("PC"),
            Some(line),
            &heading_style(HEADING_STATUS),
        );

        let width = 300;
        self.button(item::UNPAIR, SIDE, BUTTON_Y, width, "Unpair", false);
        self.button(
            item::REMOVE_HOST,
            SIDE + width + BUTTON_GAP,
            BUTTON_Y,
            width,
            "Remove PC",
            false,
        );
        self.button(
            item::RENAME_HOST,
            SIDE + 2 * (width + BUTTON_GAP),
            BUTTON_Y,
            width,
            "Rename PC",
            false,
        );
        self.button(
            item::CANCEL,
            SIDE + 3 * (width + BUTTON_GAP),
            BUTTON_Y,
            width,
            "Cancel",
            false,
        );
    }

    fn rename_host_page(&mut self, model: &Model) {
        self.horizon(&Frame {
            background: COLOR_BACKGROUND,
            ..Default::default()
        });
        let name = model.rename_entry();
        self.heading(
            "Rename PC",
            if name.is_empty() { "_" } else { name },
            Some("A: type  X: change keys  Y: erase  B: cancel"),
            &heading_style(HEADING_Y),
        );
        let keys = model.name_keys();
        for (i, key) in keys.iter().enumerate() {
            let mut label = [0u8; 1];
            label[0] = *key;
            let text = if *key == b' ' {
                "Space"
            } else {
                core::str::from_utf8(&label).unwrap_or("")
            };
            let x = SIDE + (i as u32 % 7) * 144;
            let y = KEYPAD_Y + (i as u32 / 7) * 112;
            self.button(item::KEY + i as u32, x, y, 132, text, false);
        }
        let x = SIDE + 7 * 144 + 48;
        self.button(item::KEY_PAGE, x, KEYPAD_Y, 300, "Change keys", false);
        self.button(item::ERASE, x, KEYPAD_Y + 112, 300, "Erase", false);
        self.button(
            item::SAVE_NAME,
            x,
            KEYPAD_Y + 224,
            300,
            "Save",
            name.trim().is_empty(),
        );
        self.button(item::CANCEL, x, KEYPAD_Y + 336, 300, "Cancel", false);
    }

    fn cover_tile(&mut self, app: &App) -> Option<u64> {
        let art = self
            .composer
            .covers
            .iter()
            .find(|(id, _, _)| *id == app.id)
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
                .find(|(id, _, _)| *id == app.id)?;
            let tile = tile.clone();
            let bytes = tile.bytes.len();
            return Some(self.composer.store_sized(key, tile, 0, 0, bytes));
        }
        let key = format!("c\x1f{}", app.name);
        if let Some(serial) = self.composer.lookup(&key) {
            return Some(serial);
        }

        let tile = self
            .composer
            .glyphs
            .letters(app.name.as_str(), COVER_WIDTH, COVER_HEIGHT)?;
        let bytes = tile.width as usize * tile.height as usize * 4;
        Some(self.composer.store_sized(key, tile, 0, 0, bytes))
    }

    fn apps_page(&mut self, model: &Model) {
        let keys: Keys = &[("A", "Launch"), ("B", "PCs"), ("X", "Settings")];
        let quit: Keys = &[("Y", "Quit host app")];
        let apps = model.apps();
        let count = apps.len() as u32;
        let pages = page_count(count, APPS_PER_PAGE);
        let start = model.app_page() * APPS_PER_PAGE;
        let shown = shown_count(count, start, APPS_PER_PAGE);
        let shape = stream_shape(model);

        let chips = host_chips(model);
        let cursor_home = home_slot(model.app_index(), start, shown);
        let frame = Frame {
            chips: &chips,
            note: Some(&shape),
            keys,
            background: COLOR_BACKGROUND,
            cursor_home,
            ..Default::default()
        };
        self.horizon(&frame);
        let current = model.current_game();
        let running =
            (0..shown).find(|&i| current != 0 && apps[(start + i) as usize].id == current);
        if let Some(i) = running {
            self.legend_tail(SIDE, LEGEND_Y, keys, quit, item::APP + start + i);
        }

        let mut line = String::new();
        join(&mut line, model.message());
        join(
            &mut line,
            Some(&format!(
                "{count} {}",
                if count == 1 { "app" } else { "apps" }
            )),
        );
        if pages > 1 {
            join(
                &mut line,
                Some(&format!("page {} of {pages}", model.app_page() + 1)),
            );
        }
        join(&mut line, Some("Press A to launch"));
        self.heading(
            "Apps",
            host_name(model).unwrap_or("Moonlight"),
            Some(&line),
            &heading_style(150),
        );

        let left = (SCREEN_WIDTH - GRID_COLUMNS * COVER_WIDTH - (GRID_COLUMNS - 1) * GRID_GAP) / 2;
        for i in 0..shown {
            let app = &apps[(start + i) as usize];
            let x = left + (i % GRID_COLUMNS) * (COVER_WIDTH + GRID_GAP);
            let y = GRID_Y + (i / GRID_COLUMNS) * GRID_ROW;
            let is_current = app.id == current;

            self.item(
                item::APP + start + i,
                x,
                y,
                COVER_WIDTH,
                COVER_HEIGHT,
                if is_current { page::ITEM_CURRENT } else { 0 },
            );
            match self.cover_tile(app) {
                Some(serial) => self.image(x, y, serial),
                None => self.error = Some(Error::Cover),
            }

            if is_current {
                self.solid(x + 8, y + 8, RUNNING_WIDTH, RUNNING_HEIGHT, COLOR_RUNNING);
                self.text(
                    x + 8,
                    y + 13,
                    "RUNNING",
                    18,
                    RUNNING_WIDTH,
                    COLOR_BACKGROUND,
                    Align::Center,
                    700,
                    1.2,
                    0,
                );
            }
            let color = if is_current { COLOR_RUNNING } else { COLOR_INK };
            self.plain(
                x,
                y + COVER_HEIGHT + GRID_NAME,
                app.name.as_str(),
                26,
                COVER_WIDTH,
                color,
                Align::Center,
            );
        }

        let buttons_y = GRID_Y + 2 * GRID_ROW + 8;
        self.button(
            item::BACK,
            SIDE,
            buttons_y,
            PAGER_WIDTH,
            "\u{2039}  PCs",
            false,
        );
        if pages > 1 {
            self.pager(buttons_y, model.app_page(), pages);
        }
    }

    fn pairing_page(&mut self, model: &Model) {
        let keys: Keys = &[("B", "Cancel")];
        let chips = host_chips(model);
        let frame = Frame {
            chips: &chips,
            keys,
            background: COLOR_BACKGROUND,
            flags: page::FLAG_HIDE_CURSOR,
            ..Default::default()
        };
        self.horizon(&frame);

        let mut style = heading_style(HEADING_STATUS);
        let Some(pin) = model.pin().filter(|p| !p.is_empty()) else {
            style.size = 56;
            self.heading(
                "Pairing",
                "Waiting for a PIN\u{2026}",
                Some("The PC is starting the pairing"),
                &style,
            );
            return;
        };

        style.color = COLOR_ACCENT;
        style.tracking = f64::from(HEADING_SIZE) * 0.2;
        self.heading(
            "Pairing",
            pin,
            Some("Enter this PIN in Sunshine; waiting for the PC"),
            &style,
        );
        if let Some(url) = model.url().filter(|u| !u.is_empty()) {
            self.text(
                SIDE,
                HEADING_STATUS + 196,
                url,
                26,
                CONTENT_WIDTH,
                COLOR_GREY,
                Align::Left,
                500,
                0.0,
                0,
            );
        }
    }

    fn setting_card(&mut self, row: &SettingRow, i: u32, editing: bool) {
        let (x, y) = card_at(i, SETTING_GRID_Y, SETTING_GRID_GAP_Y);
        let inner = CARD_WIDTH - 2 * CARD_PAD;
        let left = x + CARD_PAD;
        let mut flags = 0;
        if row.adjustable {
            flags |= page::ITEM_ADJUSTABLE;
        }
        if row.adjustable && editing {
            flags |= page::ITEM_EDITING;
        }
        if row.greyed {
            flags |= page::ITEM_GREYED;
        }

        self.item(item::SETTING + i, x, y, CARD_WIDTH, CARD_HEIGHT, flags);
        self.solid(
            x,
            y,
            CARD_WIDTH,
            CARD_HEIGHT,
            if row.greyed { COLOR_DIM } else { COLOR_CARD },
        );
        let label = row.setting.label().to_ascii_uppercase();
        let color = if row.greyed { COLOR_GREY } else { COLOR_MUTED };
        let tracking = f64::from(LABEL_SIZE) * 0.08;
        self.text(
            left,
            y + 12,
            &label,
            LABEL_SIZE,
            inner,
            color,
            Align::Left,
            600,
            tracking,
            0,
        );

        if row.greyed {
            self.plain(
                left,
                y + 46,
                "Not available yet",
                28,
                inner,
                COLOR_GREY,
                Align::Left,
            );
            return;
        }
        if !row.adjustable {
            self.text(
                left,
                y + 40,
                row.value.as_str(),
                40,
                inner,
                COLOR_INK,
                Align::Center,
                700,
                0.0,
                0,
            );
            return;
        }
        self.stepper(
            left,
            y + 40,
            row.value.as_str(),
            40,
            inner,
            editing && row.can_left,
            editing && row.can_right,
        );
    }

    fn settings_page(&mut self, model: &Model, settings_error: Option<&str>) {
        let editing_keys: Keys = &[("\u{25c2}\u{25b8}", "Change"), ("A", "Done"), ("B", "Done")];
        let browsing_keys: Keys = &[("A", "Edit"), ("B", "Back"), ("Y", "Reset")];
        let rows = model.settings().rows(model.docked(), model.capabilities());
        let editing = model.editing().is_some_and(|s| rows[s as usize].adjustable);

        let note = match settings_error.filter(|e| !e.is_empty()) {
            Some(error) => format!("Settings could not be saved: {error}"),
            None => String::from("Applies to the next launch"),
        };
        let chips = [
            Chip {
                label: host_name(model),
                color: COLOR_INK,
                width: 300,
            },
            Chip {
                label: Some("Settings"),
                color: COLOR_MUTED,
                width: 180,
            },
        ];
        let keys = if editing { editing_keys } else { browsing_keys };
        self.horizon(&Frame {
            chips: &chips,
            note: Some(&note),
            keys,
            background: COLOR_BACKGROUND,
            ..Default::default()
        });

        for (i, row) in (0u32..).zip(&rows) {
            self.setting_card(row, i, model.editing() == Some(row.setting));
        }
        if !model.docked() {
            let x = SCREEN_WIDTH - SIDE - NOTE_WIDTH;
            let note = "1440p and 4K are only available when docked";
            let cursor = item::SETTING + Setting::Size as u32;
            self.text(
                x,
                LEGEND_Y + 5,
                note,
                24,
                NOTE_WIDTH,
                COLOR_MUTED,
                Align::Right,
                500,
                0.0,
                cursor,
            );
        }
    }

    fn quit_confirm_page(&mut self, model: &Model) {
        let keys: Keys = &[("A", "Choose"), ("B", "Back")];
        let chips = host_chips(model);
        self.horizon(&Frame {
            chips: &chips,
            keys,
            background: COLOR_BACKGROUND,
            cursor_home: 1,
            ..Default::default()
        });

        let current = model.current_game();
        let running = model
            .apps()
            .iter()
            .find(|a| a.id == current)
            .map_or("the running app", |a| a.name.as_str());
        let title = format!("Quit {running}?");
        let line = "The stream ends and the app closes on the PC";
        self.heading(
            "Quit host app",
            &title,
            Some(line),
            &heading_style(HEADING_STATUS),
        );

        self.button(
            item::CONFIRM_QUIT,
            SIDE,
            BUTTON_Y,
            BUTTON_WIDTH,
            "Quit",
            false,
        );
        self.button(
            item::CANCEL,
            SIDE + BUTTON_WIDTH + BUTTON_GAP,
            BUTTON_Y,
            BUTTON_WIDTH,
            "Cancel",
            false,
        );
    }

    fn overlay_page(&mut self, model: &Model) {
        let keys: Keys = &[("A", "Choose"), ("B", "Hide")];
        let flags = page::FLAG_OVERLAY | page::FLAG_NO_CHORD;
        self.horizon(&Frame {
            background: COLOR_CLEAR,
            flags,
            ..Default::default()
        });

        let width = 2 * OVERLAY_BUTTON + BUTTON_GAP;
        let top = HEADING_STATUS - 40;
        let bottom = BUTTON_Y + 2 * CARD_HEIGHT + 64;
        self.panel(SIDE - 40, top, width + 80, bottom - top, COLOR_BACKGROUND);
        self.panel(
            SIDE - 40,
            LEGEND_Y - 16,
            440,
            LEGEND_HEIGHT + 32,
            COLOR_BACKGROUND,
        );
        self.legend(SIDE, LEGEND_Y, keys);

        let title = model.app().map_or("Moonlight", |a| a.name.as_str());
        self.heading(
            "Streaming",
            title,
            host_name(model),
            &heading_style(HEADING_STATUS),
        );
        self.plain(
            SIDE,
            560,
            model.stream_stats(),
            26,
            width,
            COLOR_SOFT,
            Align::Left,
        );
        self.button(
            item::RETURN_TO_APPS,
            SIDE,
            BUTTON_Y,
            OVERLAY_BUTTON,
            "Disconnect",
            false,
        );
        let quit_x = SIDE + OVERLAY_BUTTON + BUTTON_GAP;
        self.button(
            item::QUIT_HOST,
            quit_x,
            BUTTON_Y,
            OVERLAY_BUTTON,
            "Quit app",
            false,
        );
        self.button(
            item::TOGGLE_STATS,
            SIDE,
            BUTTON_Y + CARD_HEIGHT + 24,
            OVERLAY_BUTTON,
            "Toggle stats",
            false,
        );
    }

    fn error_page(&mut self, model: &Model) {
        let reconnect: Keys = &[("A", "Reconnect"), ("B", "PCs")];
        let back: Keys = &[("A", "Back")];
        let lost = model.screen() == Screen::ConnectionLost;
        let can_reconnect = lost && model.host().is_some();
        let chips = host_chips(model);
        let keys = if can_reconnect { reconnect } else { back };
        self.horizon(&Frame {
            chips: &chips,
            keys,
            background: COLOR_BACKGROUND,
            ..Default::default()
        });

        let mut style = heading_style(HEADING_STATUS);
        style.size = 48;
        let kicker = if lost {
            "Connection lost"
        } else {
            "Something went wrong"
        };
        self.heading(
            kicker,
            model.message().unwrap_or("Something went wrong"),
            None,
            &style,
        );
        let label = if can_reconnect { "Reconnect" } else { "Back" };
        self.button(item::BACK, SIDE, BUTTON_Y, BUTTON_WIDTH, label, false);
    }

    fn compose(&mut self, model: &Model, settings_error: Option<&str>) -> bool {
        let cancel: Keys = &[("B", "Cancel")];
        let host = host_name(model).unwrap_or("");
        match model.screen() {
            Screen::Hosts => self.hosts_page(model),
            Screen::AddHost => self.add_host_page(model),
            Screen::HostMenu => self.host_menu_page(model),
            Screen::RenameHost => self.rename_host_page(model),
            Screen::Unpairing => {
                self.status(
                    model,
                    "Unpairing",
                    host,
                    Some("Asking the PC to forget this console\u{2026}"),
                    &[],
                );
            }
            Screen::Connecting => {
                let address = model.host().map(|h| h.address.as_str());
                self.status(model, "Connecting", host, address, cancel);
            }
            Screen::Pairing => self.pairing_page(model),
            Screen::Apps => self.apps_page(model),
            Screen::QuitConfirm => self.quit_confirm_page(model),
            Screen::Settings => self.settings_page(model, settings_error),
            Screen::Launching => {
                let title = model.app().map_or("", |a| a.name.as_str());
                let line = model.message().unwrap_or("Starting the stream\u{2026}");
                self.status(model, "Launching", title, Some(line), cancel);
            }
            Screen::Streaming => self.overlay_page(model),
            Screen::Quitting => self.status(
                model,
                "Quitting",
                host,
                Some("Closing the app on the PC\u{2026}"),
                &[],
            ),
            Screen::ConnectionLost | Screen::Error => self.error_page(model),
            Screen::Splash | Screen::Stopped => return false,
        }
        true
    }
}
