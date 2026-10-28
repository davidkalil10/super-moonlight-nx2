/**
 * The console UI page the host publishes into one of the two UI buffers of the Moonlight
 * app's private memory, and the command words the compute shader writes back. Layout is the
 * host's: a page is text strips (alpha-8, rasterised on the PC) and RGBA8 images at absolute
 * screen positions, plus the item rects the console cursor moves over. The shader validates a
 * page with the same rules as validate() here before it draws it. Contract: team note
 * `moonlight-ui-design.md`, "Memory and words".
 *
 * ui.glsl mirrors the layout below; changing a constant or offset changes the format.
 */
import {UI, UI_OFFSET, UI_PAGE_BYTES, UI_OP} from '../../tools/moonlight/ring.js';

/** "HBPG" read as a little-endian word. */
const MAGIC = 0x47504248;
const HEADER_WORDS = 16;
const ITEM_WORDS = 8;
const TEXT_WORDS = 8;
const IMAGE_WORDS = 8;
const MAX_ITEMS = 32;
const MAX_TEXTS = 48;
const MAX_IMAGES = 24;
/** Byte offsets of the three fixed-size tables, which follow the header back to back. */
const ITEMS_OFFSET = HEADER_WORDS * 4;
const TEXTS_OFFSET = ITEMS_OFFSET + MAX_ITEMS * ITEM_WORDS * 4;
const IMAGES_OFFSET = TEXTS_OFFSET + MAX_TEXTS * TEXT_WORDS * 4;
/** Where the body starts: the strip and image bytes the tables point into. */
const BODY_OFFSET = 0x1000;
const MAX_BODY_BYTES = UI_PAGE_BYTES - BODY_OFFSET;
const SCREEN = {width: 1920, height: 1080};
const MAX_TEXT = {width: 1920, height: 96};
const MAX_IMAGE = {width: 320, height: 180};
/** The only image format the shader reads. */
const FORMAT_RGBA8 = 1;
/** Header words covered by the checksum, then the three tables. */
const CHECKSUM_WORDS = 10;
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

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

const PAGE_FLAG = {overlay: 1, hideCursor: 2};
const ITEM_FLAG = {greyed: 1, current: 2, adjustable: 4, pending: 8};
/** The command block the host reads in one go, uiApplied through cmdEpoch. */
const COMMAND_READ = {offset: UI.uiApplied, bytes: UI.cmdEpoch + 4 - UI.uiApplied};

/**
 * @typedef {{id: number, x: number, y: number, w: number, h: number, flags?: number}} Item
 * @typedef {{x: number, y: number, w: number, h: number, alpha: Uint8Array | Buffer,
 *   color?: number}} Text An alpha-8 strip of w × h bytes; color is RGBA8 packed as 0xAABBGGRR.
 * @typedef {{x: number, y: number, w: number, h: number, rgba: Uint8Array | Buffer}} Image
 * @typedef {{epoch: number, sequence: number, flags?: number, background?: number,
 *   cursorHome?: number, items?: Item[], texts?: Text[], images?: Image[]}} Page
 */

/** Throws `message` unless `condition` holds. */
function check(condition, message) {
  if (!condition) throw Error(message);
}

/** Whether `value` fits an unsigned 32-bit word. */
function isU32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

/** Whether the rect is non-empty and lies wholly on the screen. */
function inScreen(rect) {
  return (
    isU32(rect.x) &&
    isU32(rect.y) &&
    rect.w > 0 &&
    rect.h > 0 &&
    rect.x + rect.w <= SCREEN.width &&
    rect.y + rect.h <= SCREEN.height
  );
}

/** Whether a text rect is on screen and within the strip size limit. */
function textFits(rect) {
  return inScreen(rect) && rect.w <= MAX_TEXT.width && rect.h <= MAX_TEXT.height;
}

/** Whether an image rect is on screen and within the image size limit. */
function imageFits(rect) {
  return inScreen(rect) && rect.w <= MAX_IMAGE.width && rect.h <= MAX_IMAGE.height;
}

/** Writes `words` as consecutive little-endian u32s from byte `at`. */
function writeWords(buffer, at, words) {
  words.forEach((word, k) => buffer.writeUInt32LE(word, at + k * 4));
}

/** Reads `count` consecutive little-endian u32s from byte `at`. */
function readWords(buffer, at, count) {
  return Array.from({length: count}, (_, k) => buffer.readUInt32LE(at + k * 4));
}

/** The x, y, w, h words at the start of a table entry. */
function readRect(buffer, at) {
  const [x, y, w, h] = readWords(buffer, at, 4);
  return {x, y, w, h};
}

/**
 * FNV-1a over whole little-endian words of `bytes`, as nativeChecksum and the shader do it.
 * @param {Buffer} bytes
 * @param {number} [checksum]
 */
function fnv(bytes, checksum = FNV_OFFSET_BASIS) {
  for (let at = 0; at < bytes.length; at += 4)
    checksum = Math.imul(checksum ^ bytes.readUInt32LE(at), FNV_PRIME) >>> 0;
  return checksum;
}

/** @param {Buffer} page A page buffer; its checksum over header words 0..9 and the tables. */
function checksum(page) {
  const header = fnv(page.subarray(0, CHECKSUM_WORDS * 4));
  return fnv(page.subarray(ITEMS_OFFSET, BODY_OFFSET), header);
}

/**
 * The body under construction: each placed buffer is padded to a whole word, and the body
 * may not outgrow the page.
 */
function createBody() {
  const chunks = [];
  let length = 0;

  /** Appends `bytes`, which must be `expected` long, and returns its offset in the body. */
  function place(bytes, expected, what) {
    check(bytes.length === expected, what + ' bytes do not match its size');
    const offset = length;
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    length += bytes.length;

    const padding = (4 - (length % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      length += padding;
    }

    check(length <= MAX_BODY_BYTES, 'UI page body exceeds the page');
    return offset;
  }

  return {
    place,
    get length() {
      return length;
    },
    chunks
  };
}

/**
 * The page as bytes: header, the three tables and the body, ready to write at a buffer's
 * offset. Only the bytes used are returned; the rest of the buffer may hold stale data.
 * @param {Page} page
 * @returns {Buffer}
 */
function serialize(page) {
  const items = page.items ?? [];
  const texts = page.texts ?? [];
  const images = page.images ?? [];
  const cursorHome = page.cursorHome ?? 0;

  check(isU32(page.epoch) && page.epoch !== 0, 'UI page needs a nonzero epoch');
  check(isU32(page.sequence) && page.sequence !== 0, 'UI page needs a nonzero sequence');
  check(items.length <= MAX_ITEMS, 'Too many UI items');
  check(texts.length <= MAX_TEXTS, 'Too many UI texts');
  check(images.length <= MAX_IMAGES, 'Too many UI images');
  check(cursorHome < Math.max(1, items.length), 'UI cursor home is not an item');

  const out = Buffer.alloc(BODY_OFFSET);
  const body = createBody();

  for (const [i, item] of items.entries()) {
    check(isU32(item.id) && item.id !== 0, 'UI item needs a nonzero id');
    check(inScreen(item), 'UI item rect is off screen');
    const at = ITEMS_OFFSET + i * ITEM_WORDS * 4;
    writeWords(out, at, [item.id, item.x, item.y, item.w, item.h, item.flags ?? 0]);
  }

  for (const [i, text] of texts.entries()) {
    check(textFits(text), 'UI text rect');
    const at = TEXTS_OFFSET + i * TEXT_WORDS * 4;
    const offset = body.place(text.alpha, text.w * text.h, 'UI text strip');
    writeWords(out, at, [text.x, text.y, text.w, text.h, offset, text.color ?? 0xffffffff]);
  }

  for (const [i, image] of images.entries()) {
    check(imageFits(image), 'UI image rect');
    const at = IMAGES_OFFSET + i * IMAGE_WORDS * 4;
    const offset = body.place(image.rgba, image.w * image.h * 4, 'UI image');
    writeWords(out, at, [image.x, image.y, image.w, image.h, offset, FORMAT_RGBA8]);
  }

  writeWords(out, 0, [
    MAGIC,
    page.epoch,
    page.sequence,
    page.flags ?? 0,
    items.length,
    texts.length,
    images.length,
    body.length,
    page.background ?? 0xff000000,
    cursorHome
  ]);
  out.writeUInt32LE(checksum(out), CHECKSUM_WORDS * 4);

  return Buffer.concat([out, ...body.chunks]);
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

  /** The first `width` words of each of `count` table entries from `offset`. */
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
 * Where a page buffer lives in private memory.
 * @param {number} mapped The private storage's mapped address.
 * @param {number} page 0 or 1.
 */
function pageAddress(mapped, page) {
  check(page === 0 || page === 1, 'UI page buffer is 0 or 1');
  return mapped + UI_OFFSET + page * UI_PAGE_BYTES;
}

/**
 * The host words that announce a service (uiMagic, uiEpoch) or a published page
 * (uiSequence, uiPage), as 16 bytes to write at UI.uiMagic.
 * @param {{magic: number, epoch: number, sequence: number, page: number}} words
 */
function hostWords({magic, epoch, sequence, page}) {
  const out = Buffer.alloc(16);
  writeWords(out, 0, [magic >>> 0, epoch >>> 0, sequence >>> 0, page >>> 0]);
  return out;
}

/**
 * The compute shader's words from the host's one read at COMMAND_READ.
 * @param {Buffer} bytes
 */
function readCommand(bytes) {
  check(bytes.length >= COMMAND_READ.bytes, 'UI command read is short');
  const word = name => bytes.readUInt32LE(UI[name] - COMMAND_READ.offset);
  const value = word('cmdValue');

  return {
    applied: word('uiApplied'),
    cursor: word('uiCursor'),
    overlay: word('uiOverlay') !== 0,
    touchItem: word('uiTouchItem'),
    command: {
      sequence: word('cmdSequence'),
      op: word('cmdOp'),
      item: word('cmdItem'),
      value: value === 0xffffffff ? -1 : value,
      page: word('cmdPage'),
      epoch: word('cmdEpoch')
    }
  };
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
  COMMAND_READ,
  UI_OP,
  checksum,
  serialize,
  validate,
  parse,
  pageAddress,
  hostWords,
  readCommand
};
