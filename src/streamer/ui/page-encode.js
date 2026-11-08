/**
 * The UI page encoder shared by page.js on the PC and the console payload (toString()), so the
 * layout ui.glsl mirrors has one source. Self-contained: no Buffer, no imports.
 */

/**
 * @typedef {{id: number, x: number, y: number, w: number, h: number, flags?: number}} Item
 * @typedef {{x: number, y: number, w: number, h: number, alpha: Uint8Array, color?: number}} Text
 * @typedef {{x: number, y: number, w: number, h: number, rgba: Uint8Array}} Image
 * @typedef {{epoch: number, sequence: number, flags?: number, background?: number,
 *   cursorHome?: number, items?: Item[], texts?: Text[], images?: Image[]}} Page
 */

/** @param {number} pageBytes One page buffer's size in private storage. */
function createPageEncoder(pageBytes) {
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
  const CHECKSUM_WORDS = 10;
  const FNV_OFFSET_BASIS = 2166136261;
  const FNV_PRIME = 16777619;

  const LAYOUT = {
    MAGIC: 0x47504248,
    HEADER_WORDS,
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
    MAX_BODY_BYTES: pageBytes - BODY_OFFSET,
    SCREEN: {width: 1920, height: 1080},
    MAX_TEXT: {width: 1920, height: 96},
    MAX_IMAGE: {width: 320, height: 180},
    FORMAT_RGBA8: 1,
    CHECKSUM_WORDS,
    PAGE_FLAG: {overlay: 1, hideCursor: 2},
    ITEM_FLAG: {greyed: 1, current: 2, adjustable: 4, pending: 8, editing: 16}
  };

  /** @param {boolean} condition @param {string} message */
  function check(condition, message) {
    if (!condition) throw Error(message);
  }

  /** @param {number} value */
  function isU32(value) {
    return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
  }

  /** @typedef {{x: number, y: number, w: number, h: number}} Rect */

  /** @param {Rect} rect */
  function inScreen(rect) {
    const placed = isU32(rect.x) && isU32(rect.y);
    if (!placed) return false;

    const sized = rect.w > 0 && rect.h > 0;
    const fits = rect.x + rect.w <= LAYOUT.SCREEN.width && rect.y + rect.h <= LAYOUT.SCREEN.height;
    return sized && fits;
  }

  /** @param {Rect} rect */
  function textFits(rect) {
    return inScreen(rect) && rect.w <= LAYOUT.MAX_TEXT.width && rect.h <= LAYOUT.MAX_TEXT.height;
  }

  /** @param {Rect} rect */
  function imageFits(rect) {
    return inScreen(rect) && rect.w <= LAYOUT.MAX_IMAGE.width && rect.h <= LAYOUT.MAX_IMAGE.height;
  }

  /**
   * FNV-1a over whole little-endian words of bytes[start, end), as the shader does it.
   * @param {Uint8Array} bytes @param {number} start @param {number} end @param {number} seed
   */
  function fnv(bytes, start, end, seed) {
    let checksum = seed;
    for (let at = start; at < end; at += 4) {
      const word = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
      checksum = Math.imul(checksum ^ word, FNV_PRIME) >>> 0;
    }
    return checksum;
  }

  /** The checksum over header words 0..9 and the three tables. @param {Uint8Array} page */
  function checksum(page) {
    const header = fnv(page, 0, CHECKSUM_WORDS * 4, FNV_OFFSET_BASIS);
    return fnv(page, ITEMS_OFFSET, BODY_OFFSET, header);
  }

  const padded = (/** @type {number} */ length) => (length + 3) & ~3;

  /**
   * Body offsets for each distinct bitmap: one the buffer already holds at a free offset stays
   * there, the rest fill the gaps first and then go past the end. Strips sharing one bitmap
   * (card fills) share its bytes. Null when the kept offsets leave no room.
   * @param {Uint8Array[]} blocks
   * @param {Map<Uint8Array, number>} resident
   * @returns {{placed: Map<Uint8Array, number>, bodyBytes: number} | null}
   */
  function place(blocks, resident) {
    /** @type {Map<Uint8Array, number>} */
    const placed = new Map();
    /** @type {{start: number, end: number}[]} */
    const used = [];
    const overlaps = (/** @type {number} */ start, /** @type {number} */ end) =>
      used.some(range => start < range.end && range.start < end);

    for (const block of blocks) {
      const offset = resident.get(block);
      if (offset === undefined || placed.has(block)) continue;
      const end = offset + padded(block.length);
      if (overlaps(offset, end)) continue;

      placed.set(block, offset);
      used.push({start: offset, end});
    }

    used.sort((a, b) => a.start - b.start);
    for (const block of blocks) {
      if (placed.has(block)) continue;

      const length = padded(block.length);
      let offset = 0;
      for (const range of used) {
        if (offset + length <= range.start) break;
        offset = Math.max(offset, range.end);
      }
      placed.set(block, offset);
      used.push({start: offset, end: offset + length});
      used.sort((a, b) => a.start - b.start);
    }

    const bodyBytes = used.reduce((end, range) => Math.max(end, range.end), 0);
    if (bodyBytes > LAYOUT.MAX_BODY_BYTES) return null;
    return {placed, bodyBytes};
  }

  /**
   * The page as bytes: header, the three tables and the body. Only the bytes used are
   * returned; the rest of the page buffer may hold stale data.
   * @param {Page} page
   * @returns {Uint8Array}
   */
  function encode(page) {
    return encodeOver(page, null).bytes;
  }

  /**
   * The page encoded over the page a buffer already holds: bitmaps of that page keep their body
   * offsets and its other body bytes stay as they were, so only what changed differs from it.
   * @param {Page} page
   * @param {{bytes: Uint8Array, placed: Map<Uint8Array, number>} | null} resident
   * @returns {{bytes: Uint8Array, placed: Map<Uint8Array, number>}}
   */
  function encodeOver(page, resident) {
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
    for (const text of texts) {
      check(textFits(text), 'UI text rect');
      check(text.alpha.length === text.w * text.h, 'UI text strip bytes do not match its size');
    }
    for (const image of images) {
      check(imageFits(image), 'UI image rect');
      check(image.rgba.length === image.w * image.h * 4, 'UI image bytes do not match its size');
    }

    const blocks = [...texts.map(text => text.alpha), ...images.map(image => image.rgba)];
    const over = resident ? place(blocks, resident.placed) : null;
    const layout = over ?? place(blocks, new Map());
    check(layout !== null, 'UI page body exceeds the page');
    const {placed, bodyBytes} = /** @type {NonNullable<typeof layout>} */ (layout);
    const keptBytes = over && resident ? resident.bytes : null;

    const out = new Uint8Array(BODY_OFFSET + bodyBytes);
    if (keptBytes) out.set(keptBytes.subarray(BODY_OFFSET, Math.min(keptBytes.length, out.length)), BODY_OFFSET);
    const words = new DataView(out.buffer);
    /** @param {number} at @param {number[]} values */
    const put = (at, values) => {
      for (let k = 0; k < values.length; k++) words.setUint32(at + k * 4, values[k] >>> 0, true);
    };

    items.forEach((item, i) => {
      check(isU32(item.id) && item.id !== 0, 'UI item needs a nonzero id');
      check(inScreen(item), 'UI item rect is off screen');
      put(ITEMS_OFFSET + i * ITEM_WORDS * 4, [item.id, item.x, item.y, item.w, item.h, item.flags ?? 0]);
    });

    for (const [block, offset] of placed) out.set(block, BODY_OFFSET + offset);
    texts.forEach((text, i) => {
      const offset = /** @type {number} */ (placed.get(text.alpha));
      put(TEXTS_OFFSET + i * TEXT_WORDS * 4, [text.x, text.y, text.w, text.h, offset, text.color ?? 0xffffffff]);
    });
    images.forEach((image, i) => {
      const offset = /** @type {number} */ (placed.get(image.rgba));
      put(IMAGES_OFFSET + i * IMAGE_WORDS * 4, [image.x, image.y, image.w, image.h, offset, LAYOUT.FORMAT_RGBA8]);
    });

    put(0, [LAYOUT.MAGIC, page.epoch, page.sequence, page.flags ?? 0, items.length, texts.length,
      images.length, bodyBytes, page.background ?? 0xff000000, cursorHome]);
    put(CHECKSUM_WORDS * 4, [checksum(out)]);
    return {bytes: out, placed};
  }

  return {LAYOUT, encode, encodeOver, checksum};
}

export {createPageEncoder};
