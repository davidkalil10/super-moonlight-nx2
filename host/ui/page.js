/**
 * The console UI page the host publishes into one of the two UI buffers of the Moonlight
 * app's private memory, and the command words the compute shader writes back. Layout is the
 * host's: a page is text strips (alpha-8, rasterised on the PC) and RGBA8 images at absolute
 * screen positions, plus the item rects the console cursor moves over. The shader validates a
 * page with the same rules as validate() here before it draws it. Contract: team note
 * research/moonlight-ui-design.md, "Memory and words".
 */
import {UI, UI_OFFSET, UI_PAGE_BYTES, UI_OP} from '../../tools/moonlight/ring.js';

const MAGIC = 0x47504248;
const HEADER_WORDS = 16;
const ITEM_WORDS = 8;
const TEXT_WORDS = 8;
const IMAGE_WORDS = 8;
const MAX_ITEMS = 32;
const MAX_TEXTS = 48;
const MAX_IMAGES = 24;
const ITEMS_OFFSET = HEADER_WORDS * 4;
const TEXTS_OFFSET = ITEMS_OFFSET + MAX_ITEMS * ITEM_WORDS * 4;
const IMAGES_OFFSET = TEXTS_OFFSET + MAX_TEXTS * TEXT_WORDS * 4;
const BODY_OFFSET = 0x1000;
const MAX_BODY_BYTES = UI_PAGE_BYTES - BODY_OFFSET;
const SCREEN = {width: 1920, height: 1080};
const MAX_TEXT = {width: 1920, height: 96};
const MAX_IMAGE = {width: 320, height: 180};
const FORMAT_RGBA8 = 1;
/** Header words covered by the checksum, then the three tables. */
const CHECKSUM_WORDS = 10;
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

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

const check = (v, m) => {
  if (!v) throw Error(m);
};
const u32 = v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const inScreen = r =>
  u32(r.x) &&
  u32(r.y) &&
  r.w > 0 &&
  r.h > 0 &&
  r.x + r.w <= SCREEN.width &&
  r.y + r.h <= SCREEN.height;

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
 * The page as bytes: header, the three tables and the body, ready to write at a buffer's
 * offset. Only the bytes used are returned; the rest of the buffer may hold stale data.
 * @param {Page} page
 * @returns {Buffer}
 */
function serialize(page) {
  const items = page.items ?? [],
    texts = page.texts ?? [],
    images = page.images ?? [];
  check(u32(page.epoch) && page.epoch !== 0, 'UI page needs a nonzero epoch');
  check(u32(page.sequence) && page.sequence !== 0, 'UI page needs a nonzero sequence');
  check(items.length <= MAX_ITEMS, 'Too many UI items');
  check(texts.length <= MAX_TEXTS, 'Too many UI texts');
  check(images.length <= MAX_IMAGES, 'Too many UI images');
  check((page.cursorHome ?? 0) < Math.max(1, items.length), 'UI cursor home is not an item');
  const body = [];
  let bodyBytes = 0;
  const place = (bytes, expected, what) => {
    check(bytes.length === expected, what + ' bytes do not match its size');
    const offset = bodyBytes;
    body.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    bodyBytes += bytes.length;
    const padding = (4 - (bodyBytes % 4)) % 4;
    if (padding) {
      body.push(Buffer.alloc(padding));
      bodyBytes += padding;
    }
    check(bodyBytes <= MAX_BODY_BYTES, 'UI page body exceeds the page');
    return offset;
  };
  const out = Buffer.alloc(BODY_OFFSET);
  for (const [i, item] of items.entries()) {
    check(u32(item.id) && item.id !== 0, 'UI item needs a nonzero id');
    check(inScreen(item), 'UI item rect is off screen');
    const at = ITEMS_OFFSET + i * ITEM_WORDS * 4;
    for (const [k, v] of [item.id, item.x, item.y, item.w, item.h, item.flags ?? 0].entries())
      out.writeUInt32LE(v, at + k * 4);
  }
  for (const [i, text] of texts.entries()) {
    check(inScreen(text) && text.w <= MAX_TEXT.width && text.h <= MAX_TEXT.height, 'UI text rect');
    const at = TEXTS_OFFSET + i * TEXT_WORDS * 4,
      offset = place(text.alpha, text.w * text.h, 'UI text strip');
    for (const [k, v] of [
      text.x,
      text.y,
      text.w,
      text.h,
      offset,
      text.color ?? 0xffffffff
    ].entries())
      out.writeUInt32LE(v, at + k * 4);
  }
  for (const [i, image] of images.entries()) {
    check(
      inScreen(image) && image.w <= MAX_IMAGE.width && image.h <= MAX_IMAGE.height,
      'UI image rect'
    );
    const at = IMAGES_OFFSET + i * IMAGE_WORDS * 4,
      offset = place(image.rgba, image.w * image.h * 4, 'UI image');
    for (const [k, v] of [image.x, image.y, image.w, image.h, offset, FORMAT_RGBA8].entries())
      out.writeUInt32LE(v, at + k * 4);
  }
  const header = [
    MAGIC,
    page.epoch,
    page.sequence,
    page.flags ?? 0,
    items.length,
    texts.length,
    images.length,
    bodyBytes,
    page.background ?? 0xff000000,
    page.cursorHome ?? 0
  ];
  header.forEach((v, k) => out.writeUInt32LE(v, k * 4));
  out.writeUInt32LE(checksum(out), CHECKSUM_WORDS * 4);
  return Buffer.concat([out, ...body]);
}

/**
 * The checks the shader makes before it applies a page, on a serialized page or the whole
 * buffer. Throws with the first failure, as the host wants to know why a page stays unapplied.
 * @param {Buffer} page
 * @param {{epoch?: number, sequence?: number}} [expected] The control words the shader compares.
 */
function validate(page, expected = {}) {
  check(page.length >= BODY_OFFSET, 'UI page is shorter than its tables');
  check(page.readUInt32LE(0) === MAGIC, 'UI page magic');
  const epoch = page.readUInt32LE(4),
    sequence = page.readUInt32LE(8),
    counts = [16, 20, 24].map(at => page.readUInt32LE(at)),
    bodyBytes = page.readUInt32LE(28),
    cursorHome = page.readUInt32LE(36);
  check(expected.epoch === undefined || epoch === expected.epoch, 'UI page epoch');
  check(expected.sequence === undefined || sequence === expected.sequence, 'UI page sequence');
  check(counts[0] <= MAX_ITEMS && counts[1] <= MAX_TEXTS && counts[2] <= MAX_IMAGES, 'UI counts');
  check(bodyBytes <= MAX_BODY_BYTES && BODY_OFFSET + bodyBytes <= page.length, 'UI body bytes');
  check(cursorHome < Math.max(1, counts[0]), 'UI cursor home');
  check(page.readUInt32LE(CHECKSUM_WORDS * 4) === checksum(page), 'UI page checksum');
  const rect = at => ({
    x: page.readUInt32LE(at),
    y: page.readUInt32LE(at + 4),
    w: page.readUInt32LE(at + 8),
    h: page.readUInt32LE(at + 12)
  });
  for (let i = 0; i < counts[0]; i++) {
    const at = ITEMS_OFFSET + i * ITEM_WORDS * 4;
    check(page.readUInt32LE(at) !== 0, 'UI item id');
    check(inScreen(rect(at + 4)), 'UI item rect');
  }
  const inBody = (offset, bytes) => offset % 4 === 0 && offset + bytes <= bodyBytes;
  for (let i = 0; i < counts[1]; i++) {
    const at = TEXTS_OFFSET + i * TEXT_WORDS * 4,
      r = rect(at);
    check(inScreen(r) && r.w <= MAX_TEXT.width && r.h <= MAX_TEXT.height, 'UI text rect');
    check(inBody(page.readUInt32LE(at + 16), r.w * r.h), 'UI text strip bytes');
  }
  for (let i = 0; i < counts[2]; i++) {
    const at = IMAGES_OFFSET + i * IMAGE_WORDS * 4,
      r = rect(at);
    check(inScreen(r) && r.w <= MAX_IMAGE.width && r.h <= MAX_IMAGE.height, 'UI image rect');
    check(page.readUInt32LE(at + 20) === FORMAT_RGBA8, 'UI image format');
    check(inBody(page.readUInt32LE(at + 16), r.w * r.h * 4), 'UI image bytes');
  }
  return {epoch, sequence, items: counts[0], texts: counts[1], images: counts[2], bodyBytes};
}

/**
 * The page's tables back as objects, for tests and the host's log.
 * @param {Buffer} page
 */
function parse(page) {
  const {items, texts, images, bodyBytes} = validate(page);
  const words = (offset, count, n) =>
    Array.from({length: count}, (_, i) =>
      Array.from({length: n}, (_, k) => page.readUInt32LE(offset + (i * n + k) * 4))
    );
  const body = page.subarray(BODY_OFFSET, BODY_OFFSET + bodyBytes);
  return {
    epoch: page.readUInt32LE(4),
    sequence: page.readUInt32LE(8),
    flags: page.readUInt32LE(12),
    background: page.readUInt32LE(32),
    cursorHome: page.readUInt32LE(36),
    items: words(ITEMS_OFFSET, items, ITEM_WORDS).map(([id, x, y, w, h, flags]) => ({
      id,
      x,
      y,
      w,
      h,
      flags
    })),
    texts: words(TEXTS_OFFSET, texts, TEXT_WORDS).map(([x, y, w, h, offset, color]) => ({
      x,
      y,
      w,
      h,
      color,
      alpha: body.subarray(offset, offset + w * h)
    })),
    images: words(IMAGES_OFFSET, images, IMAGE_WORDS).map(([x, y, w, h, offset]) => ({
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
  [magic, epoch, sequence, page].forEach((v, k) => out.writeUInt32LE(v >>> 0, k * 4));
  return out;
}

/**
 * The compute shader's words from the host's one read at COMMAND_READ.
 * @param {Buffer} bytes
 */
function readCommand(bytes) {
  check(bytes.length >= COMMAND_READ.bytes, 'UI command read is short');
  const word = name => bytes.readUInt32LE(UI[name] - COMMAND_READ.offset);
  return {
    applied: word('uiApplied'),
    cursor: word('uiCursor'),
    overlay: word('uiOverlay') !== 0,
    touchItem: word('uiTouchItem'),
    command: {
      sequence: word('cmdSequence'),
      op: word('cmdOp'),
      item: word('cmdItem'),
      value: word('cmdValue') === 0xffffffff ? -1 : word('cmdValue'),
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
