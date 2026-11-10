//! The UI page format ui.glsl reads: header, item/text/image tables, then a body of glyph
//! strips and RGBA images. Port of ui/page.c, which follows
//! dev legacy/src/streamer/ui/page-encode.js.

pub const MAGIC: u32 = 0x4750_4248;
pub const HEADER_WORDS: usize = 16;
pub const ROW_WORDS: usize = 8;
pub const MAX_ITEMS: usize = 32;
pub const MAX_TEXTS: usize = 48;
pub const MAX_IMAGES: usize = 24;
pub const MAX_SHAPES: usize = 22;
pub const BLOCKS: usize = MAX_TEXTS + MAX_IMAGES;
pub const ITEMS_OFFSET: usize = HEADER_WORDS * 4;
pub const TEXTS_OFFSET: usize = ITEMS_OFFSET + MAX_ITEMS * ROW_WORDS * 4;
pub const IMAGES_OFFSET: usize = TEXTS_OFFSET + MAX_TEXTS * ROW_WORDS * 4;
pub const SHAPES_OFFSET: usize = IMAGES_OFFSET + MAX_IMAGES * ROW_WORDS * 4;
pub const BODY_OFFSET: usize = 0x1000;
pub const CHECKSUM_WORDS: usize = 10;
pub const SCREEN_WIDTH: u32 = 1920;
pub const SCREEN_HEIGHT: u32 = 1080;
pub const MAX_TEXT_HEIGHT: u32 = 96;
pub const MAX_IMAGE_WIDTH: u32 = 320;
pub const MAX_IMAGE_HEIGHT: u32 = 360;
pub const MAX_SHOWN_WIDTH: u32 = 480;
pub const MAX_SHOWN_HEIGHT: u32 = 540;
pub const FORMAT_RGBA8: u32 = 1;

pub const FLAG_OVERLAY: u32 = 1;
pub const FLAG_HIDE_CURSOR: u32 = 2;
pub const FLAG_NO_CHORD: u32 = 4;

pub const ITEM_GREYED: u32 = 1;
pub const ITEM_CURRENT: u32 = 2;
pub const ITEM_ADJUSTABLE: u32 = 4;
pub const ITEM_PENDING: u32 = 8;
pub const ITEM_EDITING: u32 = 16;
pub const ITEM_REPORTS_FOCUS: u32 = 32;

const FNV_OFFSET_BASIS: u32 = 2_166_136_261;
const FNV_PRIME: u32 = 16_777_619;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Item {
    pub id: u32,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub flags: u32,
    pub radius: u32,
}

/// A filled and outlined rounded rectangle drawn under the strips and images. A radius of half
/// the shorter side makes a pill or a circle; `dashed` breaks the outline.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Shape {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub fill: u32,
    pub radius: u32,
    pub stroke: u32,
    pub stroke_width: u32,
    pub dashed: bool,
}

/// An alpha strip of `w * h` bytes. Identity 0 means the strip's address.
#[derive(Clone, Copy, Debug, Default)]
pub struct Strip<'a> {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub alpha: &'a [u8],
    pub color: u32,
    pub cursor_item: u32,
    pub identity: u64,
}

/// An RGBA image of `w * h * 4` bytes. Identity 0 means the image's address. A nonzero `shown`
/// scales it to that size on screen and `radius` rounds its corners.
#[derive(Clone, Copy, Debug, Default)]
pub struct Image<'a> {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub rgba: &'a [u8],
    pub identity: u64,
    pub shown: (u32, u32),
    pub radius: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Epoch,
    Sequence,
    CursorHome,
    TextRect,
    TextBytes,
    TextCursor,
    ImageRect,
    ImageBytes,
    ItemRect,
    ShapeRect,
    TooBig,
}

impl Error {
    pub const fn message(self) -> &'static str {
        match self {
            Self::Epoch => "UI page needs a nonzero epoch",
            Self::Sequence => "UI page needs a nonzero sequence",
            Self::CursorHome => "UI cursor home is not an item",
            Self::TextRect => "UI text rect",
            Self::TextBytes => "UI text strip bytes do not match its size",
            Self::TextCursor => "UI text follows an item the page lacks",
            Self::ImageRect => "UI image rect",
            Self::ImageBytes => "UI image bytes do not match its size",
            Self::ItemRect => "UI item needs a nonzero id or is off screen",
            Self::ShapeRect => "UI shape rect",
            Self::TooBig => "UI page body exceeds the page",
        }
    }
}

impl Image<'_> {
    /// The size drawn on screen: `shown`, or the bitmap's own size when `shown` is unset.
    pub fn shown_size(&self) -> (u32, u32) {
        if self.shown == (0, 0) {
            (self.w, self.h)
        } else {
            self.shown
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Page<'a> {
    pub epoch: u32,
    pub sequence: u32,
    pub flags: u32,
    pub background: u32,
    pub cursor_home: u32,
    pub accent: u32,
    shapes: [Shape; MAX_SHAPES],
    items: [Item; MAX_ITEMS],
    texts: [Strip<'a>; MAX_TEXTS],
    images: [Image<'a>; MAX_IMAGES],
    shape_count: usize,
    item_count: usize,
    text_count: usize,
    image_count: usize,
}

impl Default for Page<'_> {
    fn default() -> Self {
        Self {
            epoch: 0,
            sequence: 0,
            flags: 0,
            background: 0xff00_0000,
            cursor_home: 0,
            accent: 0,
            shapes: [Shape::default(); MAX_SHAPES],
            items: [Item::default(); MAX_ITEMS],
            texts: [Strip::default(); MAX_TEXTS],
            images: [Image::default(); MAX_IMAGES],
            shape_count: 0,
            item_count: 0,
            text_count: 0,
            image_count: 0,
        }
    }
}

/// Where each body block went, kept by the owner so the next page can leave them in place.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    count: usize,
    source: [u8; BLOCKS],
    identity: [u64; BLOCKS],
    offset: [u32; BLOCKS],
    length: [u32; BLOCKS],
    bytes: usize,
}

impl Default for Placement {
    fn default() -> Self {
        Self {
            count: 0,
            source: [0; BLOCKS],
            identity: [0; BLOCKS],
            offset: [0; BLOCKS],
            length: [0; BLOCKS],
            bytes: 0,
        }
    }
}

impl Placement {
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Identity, body offset and length of block `index`.
    pub fn get(&self, index: usize) -> Option<(u64, u32, u32)> {
        (index < self.count).then(|| (self.identity[index], self.offset[index], self.length[index]))
    }

    /// Page bytes in use: header and tables plus the body.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    fn offset_of(&self, identity: u64) -> Option<u32> {
        (0..self.count)
            .find(|&i| self.identity[i] == identity)
            .map(|i| self.offset[i])
    }

    fn add(&mut self, block: &Block, source: usize, offset: u32) {
        let i = self.count;
        self.count += 1;
        self.source[i] = source as u8;
        self.identity[i] = block.identity;
        self.offset[i] = offset;
        self.length[i] = block.length;
    }
}

#[derive(Clone, Copy, Default)]
struct Block<'a> {
    bytes: &'a [u8],
    identity: u64,
    length: u32,
}

#[derive(Clone, Copy, Default)]
struct Range {
    start: u32,
    end: u32,
}

struct Used {
    ranges: [Range; BLOCKS],
    count: usize,
}

impl Used {
    fn new() -> Self {
        Self {
            ranges: [Range::default(); BLOCKS],
            count: 0,
        }
    }

    fn overlaps(&self, start: u32, end: u32) -> bool {
        self.ranges[..self.count]
            .iter()
            .any(|r| start < r.end && r.start < end)
    }

    fn take(&mut self, start: u32, end: u32) {
        let mut at = self.count;
        self.count += 1;
        while at > 0 && self.ranges[at - 1].start > start {
            self.ranges[at] = self.ranges[at - 1];
            at -= 1;
        }
        self.ranges[at] = Range { start, end };
    }

    fn first_fit(&self, length: u32) -> u32 {
        let mut offset = 0u32;
        for r in &self.ranges[..self.count] {
            if offset.wrapping_add(length) <= r.start {
                break;
            }
            offset = offset.max(r.end);
        }
        offset
    }

    fn end(&self) -> u32 {
        self.ranges[..self.count]
            .iter()
            .map(|r| r.end)
            .max()
            .unwrap_or(0)
    }
}

fn padded(length: u32) -> u32 {
    length.wrapping_add(3) & !3
}

fn in_screen(x: u32, y: u32, w: u32, h: u32) -> bool {
    if w == 0 || h == 0 {
        return false;
    }
    u64::from(x) + u64::from(w) <= u64::from(SCREEN_WIDTH)
        && u64::from(y) + u64::from(h) <= u64::from(SCREEN_HEIGHT)
}

fn identity_of(bytes: &[u8], identity: u64) -> u64 {
    if identity != 0 {
        identity
    } else {
        bytes.as_ptr() as usize as u64
    }
}

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn put(out: &mut [u8], at: usize, values: &[u32]) {
    for (i, value) in values.iter().enumerate() {
        out[at + i * 4..at + i * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
}

fn fnv(bytes: &[u8], start: usize, end: usize, seed: u32) -> u32 {
    (start..end).step_by(4).fold(seed, |sum, at| {
        (sum ^ word(bytes, at)).wrapping_mul(FNV_PRIME)
    })
}

/// The header checksum ui.glsl checks: header words, then the tables. The body is not covered.
pub fn checksum(page: &[u8]) -> u32 {
    let header = fnv(page, 0, CHECKSUM_WORDS * 4, FNV_OFFSET_BASIS);
    fnv(page, ITEMS_OFFSET, BODY_OFFSET, header)
}

impl<'a> Page<'a> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn shapes(&self) -> &[Shape] {
        &self.shapes[..self.shape_count]
    }

    pub fn push_shape(&mut self, shape: Shape) -> bool {
        push(&mut self.shapes, &mut self.shape_count, shape)
    }

    pub fn items(&self) -> &[Item] {
        &self.items[..self.item_count]
    }

    pub fn texts(&self) -> &[Strip<'a>] {
        &self.texts[..self.text_count]
    }

    pub fn images(&self) -> &[Image<'a>] {
        &self.images[..self.image_count]
    }

    pub fn push_item(&mut self, item: Item) -> bool {
        push(&mut self.items, &mut self.item_count, item)
    }

    pub fn push_text(&mut self, text: Strip<'a>) -> bool {
        push(&mut self.texts, &mut self.text_count, text)
    }

    pub fn push_image(&mut self, image: Image<'a>) -> bool {
        push(&mut self.images, &mut self.image_count, image)
    }

    fn item_index(&self, id: u32) -> Option<usize> {
        self.items().iter().position(|item| item.id == id)
    }

    fn validate(&self) -> Result<(), Error> {
        if self.epoch == 0 {
            return Err(Error::Epoch);
        }
        if self.sequence == 0 {
            return Err(Error::Sequence);
        }
        if self.cursor_home as usize >= self.item_count.max(1) {
            return Err(Error::CursorHome);
        }

        for text in self.texts() {
            let fits = in_screen(text.x, text.y, text.w, text.h) && text.h <= MAX_TEXT_HEIGHT;
            if !fits {
                return Err(Error::TextRect);
            }
            if text.alpha.len() != (text.w * text.h) as usize {
                return Err(Error::TextBytes);
            }
            if text.cursor_item != 0 && self.item_index(text.cursor_item).is_none() {
                return Err(Error::TextCursor);
            }
        }

        for shape in self.shapes() {
            if !in_screen(shape.x, shape.y, shape.w, shape.h) {
                return Err(Error::ShapeRect);
            }
        }

        for image in self.images() {
            let (shown_w, shown_h) = image.shown_size();
            let small = shown_w <= MAX_SHOWN_WIDTH && shown_h <= MAX_SHOWN_HEIGHT;
            let source = image.w <= MAX_IMAGE_WIDTH && image.h <= MAX_IMAGE_HEIGHT;
            if !small || !source || !in_screen(image.x, image.y, shown_w, shown_h) {
                return Err(Error::ImageRect);
            }
            if image.rgba.len() != (image.w * image.h * 4) as usize {
                return Err(Error::ImageBytes);
            }
        }

        let items_ok = self
            .items()
            .iter()
            .all(|item| item.id != 0 && in_screen(item.x, item.y, item.w, item.h));
        if !items_ok {
            return Err(Error::ItemRect);
        }
        Ok(())
    }

    fn blocks(&self) -> ([Block<'a>; BLOCKS], usize) {
        let mut blocks = [Block::default(); BLOCKS];
        let mut count = 0;
        for text in self.texts() {
            blocks[count] = Block {
                bytes: text.alpha,
                identity: identity_of(text.alpha, text.identity),
                length: text.w * text.h,
            };
            count += 1;
        }
        for image in self.images() {
            let length = image.w * image.h * 4;
            blocks[count] = Block {
                bytes: image.rgba,
                identity: identity_of(image.rgba, image.identity),
                length,
            };
            count += 1;
        }
        (blocks, count)
    }

    /// Writes the page into `out`. With `resident`, blocks that page already holds keep their
    /// offsets and the body bytes up to its size are not cleared, so `out` must be the buffer
    /// that placement was made in.
    pub fn encode(&self, resident: Option<&Placement>, out: &mut [u8]) -> Result<Placement, Error> {
        self.validate()?;
        if out.len() < BODY_OFFSET {
            return Err(Error::TooBig);
        }

        let (blocks, count) = self.blocks();
        let blocks = &blocks[..count];
        let max_body = out.len() - BODY_OFFSET;
        let kept = resident.and_then(|r| place(blocks, Some(r), max_body).map(|p| (p, r.bytes)));
        let (placed, kept) = match kept {
            Some(found) => found,
            None => (
                place(blocks, None, max_body).ok_or(Error::TooBig)?,
                BODY_OFFSET,
            ),
        };

        out[..BODY_OFFSET].fill(0);
        if placed.bytes > kept {
            out[kept..placed.bytes].fill(0);
        }
        for i in 0..placed.count {
            let block = &blocks[placed.source[i] as usize];
            let at = BODY_OFFSET + placed.offset[i] as usize;
            out[at..at + block.length as usize].copy_from_slice(block.bytes);
        }
        self.write_tables(&placed, out);

        let body = (placed.bytes - BODY_OFFSET) as u32;
        let header = [
            MAGIC,
            self.epoch,
            self.sequence,
            self.flags,
            self.item_count as u32,
            self.text_count as u32,
            self.image_count as u32,
            body,
            self.background,
            self.cursor_home,
        ];
        put(out, 0, &header);
        let sum = checksum(out);
        put(out, CHECKSUM_WORDS * 4, &[sum, self.shape_count as u32, self.accent]);
        Ok(placed)
    }

    fn write_tables(&self, placed: &Placement, out: &mut [u8]) {
        for (i, item) in self.items().iter().enumerate() {
            let row = [
                item.id,
                item.x,
                item.y,
                item.w,
                item.h,
                item.flags,
                item.radius,
            ];
            put(out, ITEMS_OFFSET + i * ROW_WORDS * 4, &row);
        }

        for (i, text) in self.texts().iter().enumerate() {
            let cursor = match text.cursor_item {
                0 => 0,
                id => self.item_index(id).map_or(0, |index| index as u32 + 1),
            };
            let offset = placed
                .offset_of(identity_of(text.alpha, text.identity))
                .unwrap_or(u32::MAX);
            let row = [text.x, text.y, text.w, text.h, offset, text.color, cursor];
            put(out, TEXTS_OFFSET + i * ROW_WORDS * 4, &row);
        }

        for (i, image) in self.images().iter().enumerate() {
            let offset = placed
                .offset_of(identity_of(image.rgba, image.identity))
                .unwrap_or(u32::MAX);
            let (shown_w, shown_h) = image.shown_size();
            let scaled = (shown_w, shown_h) != (image.w, image.h);
            let source = if scaled || image.radius != 0 {
                [image.w | image.radius << 16, image.h]
            } else {
                [0, 0]
            };
            let row = [
                image.x,
                image.y,
                shown_w,
                shown_h,
                offset,
                FORMAT_RGBA8,
                source[0],
                source[1],
            ];
            put(out, IMAGES_OFFSET + i * ROW_WORDS * 4, &row);
        }

        for (i, shape) in self.shapes().iter().enumerate() {
            let style = shape.radius.min(255)
                | shape.stroke_width.min(255) << 8
                | u32::from(shape.dashed) << 16;
            let row = [
                shape.x,
                shape.y,
                shape.w,
                shape.h,
                shape.fill,
                style,
                shape.stroke,
            ];
            put(out, SHAPES_OFFSET + i * ROW_WORDS * 4, &row);
        }
    }
}

fn push<T>(slots: &mut [T], count: &mut usize, value: T) -> bool {
    let Some(slot) = slots.get_mut(*count) else {
        return false;
    };
    *slot = value;
    *count += 1;
    true
}

/// First pass keeps resident blocks where they are, second pass fits the rest first-fit.
fn place(blocks: &[Block], resident: Option<&Placement>, max_body: usize) -> Option<Placement> {
    let mut used = Used::new();
    let mut placed = Placement::default();

    if let Some(resident) = resident {
        for (i, block) in blocks.iter().enumerate() {
            let Some(offset) = resident.offset_of(block.identity) else {
                continue;
            };
            if placed.offset_of(block.identity).is_some() {
                continue;
            }
            let end = offset.wrapping_add(padded(block.length));
            if used.overlaps(offset, end) {
                continue;
            }
            placed.add(block, i, offset);
            used.take(offset, end);
        }
    }

    for (i, block) in blocks.iter().enumerate() {
        if placed.offset_of(block.identity).is_some() {
            continue;
        }
        let length = padded(block.length);
        let offset = used.first_fit(length);
        placed.add(block, i, offset);
        used.take(offset, offset + length);
    }

    let body = used.end() as usize;
    placed.bytes = BODY_OFFSET + body;
    (body <= max_body).then_some(placed)
}
