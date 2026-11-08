/**
 * The UI page the host writes into the Moonlight app's private memory, and its checks
 * (CLAUDE.md; team note `moonlight-ui-design.md`, "Memory and words").
 * ui.glsl mirrors the layout below; changing a constant or offset changes the format.
 */
import {UI_OFFSET, UI_PAGE_BYTES} from '../shared/ring.js';
import {createPageEncoder} from './page-encode.js';

const encoder = createPageEncoder(UI_PAGE_BYTES);
const {
  MAGIC,
  ITEM_WORDS,
  TEXT_WORDS,
  IMAGE_WORDS,
  MAX_ITEMS,
  MAX_TEXTS,
  MAX_IMAGES,
  ITEMS_OFFSET,
  TEXTS_OFFSET,
  IMAGES_OFFSET,
  BODY_OFFSET,
  MAX_BODY_BYTES,
  SCREEN,
  MAX_TEXT,
  MAX_IMAGE,
  FORMAT_RGBA8,
  CHECKSUM_WORDS,
  PAGE_FLAG,
  ITEM_FLAG
} = encoder.LAYOUT;

/** Byte offsets of the header words that validate() and parse() read back. */
const HEADER = {
  magic: 0,
  epoch: 4,
  sequence: 8,
  flags: 12,
  items: 16,
  texts: 20,
  images: 24,
  bodyBytes: 28,
  background: 32,
  cursorHome: 36
};

/**
 * @typedef {{id: number, x: number, y: number, w: number, h: number, flags?: number}} Item
 * @typedef {{x: number, y: number, w: number, h: number, alpha: Uint8Array | Buffer,
 *   color?: number}} Text An alpha-8 strip of w × h bytes; color is RGBA8 packed as 0xAABBGGRR.
 * @typedef {{x: number, y: number, w: number, h: number, rgba: Uint8Array | Buffer}} Image
 * @typedef {{epoch: number, sequence: number, flags?: number, background?: number,
 *   cursorHome?: number, items?: Item[], texts?: Text[], images?: Image[]}} Page
 */

/** Throws `message` unless `condition` holds. @param {boolean} condition @param {string} message */
function check(condition, message) {
  if (!condition) throw Error(message);
}

/** Whether `value` fits an unsigned 32-bit word. @param {number} value */
function isU32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

/**
 * @typedef {{x: number, y: number, w: number, h: number}} Rect
 */

/** Whether the rect is non-empty and lies wholly on the screen. @param {Rect} rect */
function inScreen(rect) {
  const placed = isU32(rect.x) && isU32(rect.y);
  if (!placed) return false;

  const sized = rect.w > 0 && rect.h > 0;
  const fits = rect.x + rect.w <= SCREEN.width && rect.y + rect.h <= SCREEN.height;
  return sized && fits;
}

/** Whether a text rect is on screen and within the strip size limit. @param {Rect} rect */
function textFits(rect) {
  return inScreen(rect) && rect.w <= MAX_TEXT.width && rect.h <= MAX_TEXT.height;
}

/** Whether an image rect is on screen and within the image size limit. @param {Rect} rect */
function imageFits(rect) {
  return inScreen(rect) && rect.w <= MAX_IMAGE.width && rect.h <= MAX_IMAGE.height;
}

/**
 * Reads `count` consecutive little-endian u32s from byte `at`.
 * @param {Buffer} buffer @param {number} at @param {number} count
 */
function readWords(buffer, at, count) {
  return Array.from({length: count}, (_, k) => buffer.readUInt32LE(at + k * 4));
}

/** The x, y, w, h words at the start of a table entry. @param {Buffer} buffer @param {number} at */
function readRect(buffer, at) {
  const [x, y, w, h] = readWords(buffer, at, 4);
  return {x, y, w, h};
}

/** @param {Buffer} page A page buffer; its checksum over header words 0..9 and the tables. */
function checksum(page) {
  return encoder.checksum(page);
}

/**
 * The page as bytes (page-encode.js), ready to write at a buffer's offset.
 * @param {Page} page
 * @returns {Buffer}
 */
function serialize(page) {
  const bytes = encoder.encode(page);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
}

/**
 * The page encoded over the one a buffer holds (page-encode.js `encodeOver`), so a republish
 * differs from it only where the page changed.
 * @param {Page} page
 * @param {{bytes: Uint8Array, placed: Map<Uint8Array, number>} | null} resident
 */
function serializeOver(page, resident) {
  const {bytes, placed} = encoder.encodeOver(page, resident);
  return {bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), placed};
}

/**
 * The checks the shader makes before it applies a page, on a serialized page or the whole
 * buffer. Throws with the first failure, as the host wants to know why a page stays unapplied.
 * @param {Buffer} page
 * @param {{epoch?: number, sequence?: number}} [expected] The control words the shader compares.
 */
function validate(page, expected = {}) {
  check(page.length >= BODY_OFFSET, 'UI page is shorter than its tables');
  check(page.readUInt32LE(HEADER.magic) === MAGIC, 'UI page magic');

  const epoch = page.readUInt32LE(HEADER.epoch);
  const sequence = page.readUInt32LE(HEADER.sequence);
  const items = page.readUInt32LE(HEADER.items);
  const texts = page.readUInt32LE(HEADER.texts);
  const images = page.readUInt32LE(HEADER.images);
  const bodyBytes = page.readUInt32LE(HEADER.bodyBytes);
  const cursorHome = page.readUInt32LE(HEADER.cursorHome);

  check(expected.epoch === undefined || epoch === expected.epoch, 'UI page epoch');
  check(expected.sequence === undefined || sequence === expected.sequence, 'UI page sequence');
  check(items <= MAX_ITEMS && texts <= MAX_TEXTS && images <= MAX_IMAGES, 'UI counts');
  check(bodyBytes <= MAX_BODY_BYTES && BODY_OFFSET + bodyBytes <= page.length, 'UI body bytes');
  check(cursorHome < Math.max(1, items), 'UI cursor home');
  check(page.readUInt32LE(CHECKSUM_WORDS * 4) === checksum(page), 'UI page checksum');

  /** @param {number} offset @param {number} bytes */
  const inBody = (offset, bytes) => offset % 4 === 0 && offset + bytes <= bodyBytes;

  for (let i = 0; i < items; i++) {
    const at = ITEMS_OFFSET + i * ITEM_WORDS * 4;
    check(page.readUInt32LE(at) !== 0, 'UI item id');
    check(inScreen(readRect(page, at + 4)), 'UI item rect');
  }

  for (let i = 0; i < texts; i++) {
    const at = TEXTS_OFFSET + i * TEXT_WORDS * 4;
    const rect = readRect(page, at);
    check(textFits(rect), 'UI text rect');
    check(inBody(page.readUInt32LE(at + 16), rect.w * rect.h), 'UI text strip bytes');
  }

  for (let i = 0; i < images; i++) {
    const at = IMAGES_OFFSET + i * IMAGE_WORDS * 4;
    const rect = readRect(page, at);
    check(imageFits(rect), 'UI image rect');
    check(page.readUInt32LE(at + 20) === FORMAT_RGBA8, 'UI image format');
    check(inBody(page.readUInt32LE(at + 16), rect.w * rect.h * 4), 'UI image bytes');
  }

  return {epoch, sequence, items, texts, images, bodyBytes};
}

/**
 * The page's tables back as objects, for tests and the host's log.
 * @param {Buffer} page
 */
function parse(page) {
  const {items, texts, images, bodyBytes} = validate(page);
  const body = page.subarray(BODY_OFFSET, BODY_OFFSET + bodyBytes);

  /**
   * The first `width` words of each of `count` table entries from `offset`.
   * @param {number} offset @param {number} count @param {number} width
   */
  const table = (offset, count, width) =>
    Array.from({length: count}, (_, i) => readWords(page, offset + i * width * 4, width));

  return {
    epoch: page.readUInt32LE(HEADER.epoch),
    sequence: page.readUInt32LE(HEADER.sequence),
    flags: page.readUInt32LE(HEADER.flags),
    background: page.readUInt32LE(HEADER.background),
    cursorHome: page.readUInt32LE(HEADER.cursorHome),
    items: table(ITEMS_OFFSET, items, ITEM_WORDS).map(([id, x, y, w, h, flags]) => ({
      id,
      x,
      y,
      w,
      h,
      flags
    })),
    texts: table(TEXTS_OFFSET, texts, TEXT_WORDS).map(([x, y, w, h, offset, color]) => ({
      x,
      y,
      w,
      h,
      color,
      alpha: body.subarray(offset, offset + w * h)
    })),
    images: table(IMAGES_OFFSET, images, IMAGE_WORDS).map(([x, y, w, h, offset]) => ({
      x,
      y,
      w,
      h,
      rgba: body.subarray(offset, offset + w * h * 4)
    }))
  };
}

/**
 * The byte ranges of `next` that differ from `previous`, the page a buffer already holds, so a
 * republish writes only those. Ranges closer than `gap` bytes merge, since each write is one
 * request. Without a previous page the whole page is one range.
 * @param {Uint8Array | null} previous
 * @param {Uint8Array} next
 * @param {number} [gap]
 * @returns {{start: number, end: number}[]}
 */
function changedRanges(previous, next, gap = 4096) {
  if (!previous) return [{start: 0, end: next.length}];

  /** @type {{start: number, end: number}[]} */
  const ranges = [];
  let at = 0;
  while (at < next.length) {
    const same = at < previous.length && previous[at] === next[at];
    if (same) {
      at++;
      continue;
    }

    const start = at;
    let end = at + 1;
    let quiet = 0;
    for (at = end; at < next.length && quiet < gap; at++) {
      const differs = at >= previous.length || previous[at] !== next[at];
      quiet = differs ? 0 : quiet + 1;
      if (differs) end = at + 1;
    }
    ranges.push({start, end});
  }
  return ranges;
}

/**
 * Where a page buffer lives in private memory.
 * @param {number} mapped The private storage's mapped address.
 * @param {number} page 0 or 1.
 */
function pageAddress(mapped, page) {
  check(page === 0 || page === 1, 'UI page buffer is 0 or 1');
  return mapped + UI_OFFSET + page * UI_PAGE_BYTES;
}

export {
  MAGIC,
  MAX_ITEMS,
  MAX_TEXTS,
  MAX_IMAGES,
  BODY_OFFSET,
  MAX_BODY_BYTES,
  MAX_TEXT,
  MAX_IMAGE,
  PAGE_FLAG,
  ITEM_FLAG,
  checksum,
  changedRanges,
  serialize,
  serializeOver,
  validate,
  parse,
  pageAddress
};
