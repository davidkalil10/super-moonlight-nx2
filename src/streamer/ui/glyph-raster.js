/**
 * The UI painter without Python: text strips from the glyph atlas fonts/glyphs.bin makes, letter
 * tiles and PNG cover tiles, as text.py paints them. Shipped by toString() to the console later,
 * so createGlyphRaster keeps every name it uses inside itself (src/streamer/ui/CLAUDE.md, Text).
 */

/**
 * @typedef {{width: number, height: number, bytes: Uint8Array}} Bitmap
 * @typedef {(data: Uint8Array, expected: number) => Uint8Array} Inflate
 */

/**
 * @param {Uint8Array} atlas The inflated glyphs.bin
 * @param {{inflate?: Inflate}} [options] zlib inflate for PNG covers; without it covers are refused
 */
function createGlyphRaster(atlas, {inflate} = {}) {
  const MAX_STRIP_HEIGHT = 96;
  const MAX_COVER_SIDE = 4096;
  const ELLIPSIS = '…';
  const KEY_GAP = 12;
  const ENTRY_GAP = 44;
  const FILL_LEVEL = 0.35;
  const LETTER_INK = [240, 246, 250];
  const KERN_REFERENCE_SIZE = 1000;
  const FACE_SORA = 0;
  const FALLBACK_KEY = 0;
  const LIGATURE_KEY_BASE = 0xe000;
  const HEADER_BYTES = 16;
  const COMBO_BYTES = 24;
  const TABLE_BYTES = 12;
  const RING_BYTES = 12;
  const GLYPH_BYTES = 24;

  /**
   * @typedef {{key: number, face: number, sequence: string, advance: number, dx: number,
   *   dy: number, w: number, h: number, offset: number}} Glyph
   */
  /**
   * @typedef {{size: number, weight: number, ascent: number, descent: number,
   *   chars: Map<string, Glyph>, ligatures: Glyph[], fallback: Glyph,
   *   kerns: Map<number, number>}} Face
   */
  /** @typedef {{x: number, glyphs: {glyph: Glyph, pen: number}[]}} Run */

  const view = new DataView(atlas.buffer, atlas.byteOffset, atlas.byteLength);
  const magic = String.fromCharCode(atlas[0], atlas[1], atlas[2], atlas[3]);
  if (magic !== 'HBGA' || view.getUint16(4, true) !== 1) throw Error('Not a version 1 glyph atlas');

  const comboCount = view.getUint16(6, true);
  const tableCount = view.getUint16(8, true);
  const ringCount = view.getUint16(10, true);
  const tablesAt = HEADER_BYTES + comboCount * COMBO_BYTES;
  const ringsAt = tablesAt + tableCount * TABLE_BYTES;

  /** @type {Map<string, Face>} */
  const faces = new Map();

  /**
   * The kern tables a combo of `weight` uses, in file order: its the UI face weight and DejaVu.
   * @param {number} weight
   */
  function tablesFor(weight) {
    const tables = [];
    for (let t = 0; t < tableCount; t++) {
      const at = tablesAt + t * TABLE_BYTES;
      const face = view.getUint16(at, true);
      const tableWeight = view.getUint16(at + 2, true);
      if (face === FACE_SORA && tableWeight !== weight) continue;

      tables.push({face, count: view.getUint32(at + 4, true), offset: view.getUint32(at + 8, true)});
    }
    return tables;
  }

  /** @param {number} at @returns {Glyph} */
  function readGlyph(at) {
    const length = atlas[at + 3];
    let sequence = '';
    for (let i = 0; i < length; i++) sequence += String.fromCharCode(view.getUint16(at + 4 + 2 * i, true));

    return {
      key: view.getUint16(at, true),
      face: atlas[at + 2],
      sequence,
      advance: view.getUint16(at + 10, true),
      dx: view.getInt16(at + 12, true),
      dy: view.getInt16(at + 14, true),
      w: view.getUint16(at + 16, true),
      h: view.getUint16(at + 18, true),
      offset: view.getUint32(at + 20, true)
    };
  }

  /** @param {number} c @returns {Face} */
  function readFace(c) {
    const at = HEADER_BYTES + c * COMBO_BYTES;
    const size = view.getUint16(at, true);
    const weight = view.getUint16(at + 2, true);
    const glyphCount = view.getUint32(at + 8, true);
    const recordsAt = view.getUint32(at + 12, true);
    let correctionAt = view.getUint32(at + 16, true);

    /** @type {Map<string, Glyph>} */
    const chars = new Map();
    /** @type {Glyph[]} */
    const ligatures = [];
    /** @type {Glyph | null} */
    let fallback = null;
    for (let g = 0; g < glyphCount; g++) {
      const glyph = readGlyph(recordsAt + g * GLYPH_BYTES);
      if (glyph.key === FALLBACK_KEY) fallback = glyph;
      else if (glyph.key >= LIGATURE_KEY_BASE) ligatures.push(glyph);
      else chars.set(glyph.sequence, glyph);
    }
    if (!fallback) throw Error('Glyph atlas face has no missing-glyph box');

    /** @type {Face} */
    const face = {
      size,
      weight,
      ascent: view.getInt16(at + 4, true),
      descent: view.getInt16(at + 6, true),
      chars,
      ligatures,
      fallback,
      kerns: new Map()
    };
    face.ligatures.sort((a, b) => b.sequence.length - a.sequence.length);

    for (const table of tablesFor(weight)) {
      for (let i = 0; i < table.count; i++) {
        const entry = table.offset + 6 * i;
        const units = view.getInt16(entry + 4, true);
        const kern = Math.round((units * size) / KERN_REFERENCE_SIZE) + view.getInt8(correctionAt + i);
        const pair = kernKey(table.face, view.getUint16(entry, true), view.getUint16(entry + 2, true));
        if (kern) face.kerns.set(pair, kern);
      }
      correctionAt += table.count;
    }
    return face;
  }

  /** @param {number} face @param {number} left @param {number} right */
  function kernKey(face, left, right) {
    return (face * 0x10000 + left) * 0x10000 + right;
  }

  /**
   * The face drawn at size and weight; the atlas has a fixed list (glyphs.py COMBOS).
   * @param {number} size @param {number} weight
   */
  function faceAt(size, weight) {
    const name = size + ':' + weight;
    const cached = faces.get(name);
    if (cached) return cached;

    for (let c = 0; c < comboCount; c++) {
      const at = HEADER_BYTES + c * COMBO_BYTES;
      if (view.getUint16(at, true) !== size || view.getUint16(at + 2, true) !== weight) continue;

      const face = readFace(c);
      faces.set(name, face);
      return face;
    }
    throw Error(`No glyphs for size ${size} weight ${weight}`);
  }

  /** Python's round(): halves go to the even neighbour. @param {number} value */
  function pyRound(value) {
    const rounded = Math.round(value);
    const half = value - Math.floor(value) === 0.5;
    if (half && rounded % 2 !== 0) return rounded - 1;

    return rounded;
  }

  /** The glyph for a character, or the missing-glyph box. @param {Face} face @param {string} char */
  function glyphFor(face, char) {
    return face.chars.get(char) ?? face.fallback;
  }

  /**
   * One run's glyphs with their pens in 1/64 px from its start: ligatures longest first, then
   * kerning between neighbours, as the shaper places them.
   * @param {Face} face @param {string[]} chars
   */
  function shape(face, chars) {
    const glyphs = [];
    let pen = 0;
    /** @type {Glyph | null} */
    let previous = null;

    for (let i = 0; i < chars.length; ) {
      let glyph = glyphFor(face, chars[i]);
      let used = 1;
      if (glyph.face === FACE_SORA) {
        for (const ligature of face.ligatures) {
          const ligatureChars = Array.from(ligature.sequence);
          const matches = ligatureChars.every((char, k) => chars[i + k] === char);
          if (!matches) continue;

          glyph = ligature;
          used = ligatureChars.length;
          break;
        }
      }

      if (previous) pen += face.kerns.get(kernKey(glyph.face, previous.key, glyph.key)) ?? 0;
      glyphs.push({glyph, pen});
      pen += glyph.advance;
      previous = glyph;
      i += used;
    }
    return {glyphs, length: pen};
  }

  /**
   * The text as runs and its width in px, as text.py's runs(): neighbours drawn by the same
   * font share a run unless tracking spaces every character.
   * @param {string} text @param {Face} face @param {number} tracking
   */
  function runs(text, face, tracking) {
    /** @type {string[][]} */
    const pieces = [];
    let lastFont = -1;
    for (const char of text) {
      const font = glyphFor(face, char).face;
      if (tracking || !pieces.length || font !== lastFont) pieces.push([char]);
      else pieces[pieces.length - 1].push(char);
      lastFont = font;
    }

    /** @type {Run[]} */
    const placed = [];
    let x = 0;
    for (const piece of pieces) {
      const shaped = shape(face, piece);
      placed.push({x, glyphs: shaped.glyphs});
      x += shaped.length / 64 + tracking;
    }
    return {placed, length: Math.max(0, x - tracking)};
  }

  /**
   * The text, shortened with an ellipsis until it fits, as text.py's fit().
   * @param {string} text @param {Face} face @param {number} tracking @param {number} width
   */
  function fit(text, face, tracking, width) {
    let chars = Array.from(text);
    while (chars.length && runs(chars.join(''), face, tracking).length > width) {
      const kept = chars[chars.length - 1] === ELLIPSIS ? chars.slice(0, -1) : chars;
      if (kept.length > 1) chars = Array.from(kept.slice(0, -1).join('').trimEnd() + ELLIPSIS);
      else chars = [];
    }
    return chars.join('');
  }

  /** Pillow's DIV255 of an 8-bit blend. @param {number} value */
  function div255(value) {
    const biased = value + 128;
    return ((biased >> 8) + biased) >> 8;
  }

  /**
   * Blends a 4-bit mask in `ink` over the target's channels at x, y, as Pillow pastes a fill.
   * @param {Bitmap & {channels: number}} target @param {number} offset @param {number} w
   * @param {number} h @param {number} x @param {number} y @param {number[]} ink
   */
  function blendMask(target, offset, w, h, x, y, ink) {
    const {width, height, bytes, channels} = target;
    for (let row = 0; row < h; row++) {
      const ty = y + row;
      if (ty < 0 || ty >= height) continue;

      for (let col = 0; col < w; col++) {
        const tx = x + col;
        if (tx < 0 || tx >= width) continue;

        const index = row * w + col;
        const packed = atlas[offset + (index >> 1)];
        const alpha = ((index & 1 ? packed : packed >> 4) & 15) * 17;
        if (!alpha) continue;

        const at = (ty * width + tx) * channels;
        for (let c = 0; c < ink.length; c++)
          bytes[at + c] = div255(bytes[at + c] * (255 - alpha) + ink[c] * alpha);
      }
    }
  }

  /**
   * Draws runs from x with their baselines on `baseline`. Pillow puts every glyph on the whole
   * pixel nearest its pen and drops the fraction of a row; so does this.
   * @param {Bitmap & {channels: number}} target @param {number} x @param {number} baseline
   * @param {Run[]} placed @param {number[]} ink
   */
  function drawRuns(target, x, baseline, placed, ink) {
    for (const run of placed) {
      const start = x + run.x;
      const whole = Math.trunc(start);
      const startPen = Math.floor((start - whole) * 64);

      for (const {glyph, pen} of run.glyphs) {
        const column = whole + Math.floor((startPen + pen + 32) / 64);
        const top = Math.floor(baseline) + glyph.dy;
        blendMask(target, glyph.offset, glyph.w, glyph.h, column + glyph.dx, top, ink);
      }
    }
  }

  /** @param {number} width @param {number} height @param {number} channels */
  function blank(width, height, channels) {
    return {width, height, channels, bytes: new Uint8Array(width * height * channels)};
  }

  /** @param {{width: number, height: number, bytes: Uint8Array}} bitmap @returns {Bitmap} */
  function painted({width, height, bytes}) {
    return {width, height, bytes};
  }

  /**
   * One line of text fitted to the width and aligned in it, as an alpha strip.
   * @param {string} text @param {number} size @param {number} width
   * @param {'left' | 'center' | 'right'} [align] @param {{weight?: number, tracking?: number}} [style]
   */
  function textStrip(text, size, width, align = 'left', {weight = 600, tracking = 0} = {}) {
    const face = faceAt(size, weight);
    const height = Math.min(MAX_STRIP_HEIGHT, face.ascent + face.descent);
    const label = fit(text, face, tracking, width);
    const {placed, length} = runs(label, face, tracking);

    let x = 0;
    if (align === 'center') x = (width - length) / 2;
    else if (align === 'right') x = width - length;

    const strip = blank(width, height, 1);
    drawRuns(strip, x, face.ascent, placed, [255]);
    return painted(strip);
  }

  /** @param {number} size */
  function ringAt(size) {
    for (let r = 0; r < ringCount; r++) {
      const at = ringsAt + r * RING_BYTES;
      if (view.getUint16(at, true) !== size) continue;

      return {
        w: view.getUint16(at + 2, true),
        h: view.getUint16(at + 4, true),
        offset: view.getUint32(at + 8, true)
      };
    }
    throw Error('No legend ring for size ' + size);
  }

  /**
   * Button hints in one strip, each key in a ring and its label after it.
   * @param {[string, string][]} keys @param {number} size @param {number} width
   */
  function legend(keys, size, width) {
    const face = faceAt(size, 600);
    const keyFace = faceAt(size, 700);
    const ring = pyRound(size * 1.55);
    const height = Math.min(MAX_STRIP_HEIGHT, Math.max(ring, face.ascent + face.descent));
    const baseline = (height + face.ascent - face.descent) / 2;
    const ringMask = ringAt(size);

    const strip = blank(width, height, 1);
    let x = 0;
    for (const [key, label] of keys) {
      blendMask(strip, ringMask.offset, ringMask.w, ringMask.h, Math.trunc(x), 0, [255]);
      const keyRuns = runs(key, keyFace, 0);
      drawRuns(strip, x + (ring - keyRuns.length) / 2, baseline, keyRuns.placed, [255]);
      x += ring + KEY_GAP;

      const labelRuns = runs(label, face, 0);
      drawRuns(strip, x, baseline, labelRuns.placed, [255]);
      x += labelRuns.length + ENTRY_GAP;
    }
    return painted(strip);
  }

  /** UTF-8 bytes of a string, without TextEncoder (absent on the console). @param {string} text */
  function utf8(text) {
    const out = [];
    for (const char of text) {
      let code = char.codePointAt(0) ?? 0xfffd;
      if (code >= 0xd800 && code < 0xe000) code = 0xfffd;

      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000)
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 63),
          0x80 | ((code >> 6) & 63),
          0x80 | (code & 63)
        );
    }
    return out;
  }

  /** SHA-256 as hex, for the letter tile hue text.py hashes the name with. @param {number[]} bytes */
  function sha256(bytes) {
    /** @type {number[]} */
    const k = [];
    /** @type {number[]} */
    const h = [];
    /** @type {number[]} */
    const primes = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every(p => n % p)) primes.push(n);
    const fraction = (/** @type {number} */ value) => ((value - Math.floor(value)) * 0x100000000) >>> 0;
    for (let i = 0; i < 64; i++) k.push(fraction(Math.cbrt(primes[i])));
    for (let i = 0; i < 8; i++) h.push(fraction(Math.sqrt(primes[i])));

    const bitLength = bytes.length * 8;
    const message = bytes.concat([0x80]);
    while (message.length % 64 !== 56) message.push(0);
    for (let shift = 56; shift >= 0; shift -= 8)
      message.push(shift >= 32 ? Math.floor(bitLength / 2 ** shift) & 255 : (bitLength >>> shift) & 255);

    /** @param {number} value @param {number} bits */
    const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
    const w = new Array(64);
    for (let block = 0; block < message.length; block += 64) {
      for (let i = 0; i < 16; i++) {
        const at = block + 4 * i;
        w[i] = ((message[at] << 24) | (message[at + 1] << 16) | (message[at + 2] << 8) | message[at + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
        const choose = (e & f) ^ (~e & g);
        const t1 = (hh + s1 + choose + k[i] + w[i]) >>> 0;
        const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + majority) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, hh].forEach((value, i) => (h[i] = (h[i] + value) >>> 0));
    }
    return h.map(value => value.toString(16).padStart(8, '0')).join('');
  }

  /** colorsys.hls_to_rgb. @param {number} hue @param {number} light @param {number} saturation */
  function hlsToRgb(hue, light, saturation) {
    const m2 = light <= 0.5 ? light * (1 + saturation) : light + saturation - light * saturation;
    const m1 = 2 * light - m2;
    const channel = (/** @type {number} */ value) => {
      const h = ((value % 1) + 1) % 1;
      if (h < 1 / 6) return m1 + (m2 - m1) * h * 6;
      if (h < 0.5) return m2;
      if (h < 2 / 3) return m1 + (m2 - m1) * (2 / 3 - h) * 6;
      return m1;
    };
    return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
  }

  /**
   * Pillow's textbbox of runs drawn at 0 with the baseline at the ascent: the ink rows, and the
   * columns from the leftmost mask to the rounded advance.
   * @param {Run[]} placed @param {number} length @param {Face} face
   */
  function textBox(placed, length, face) {
    let left = 0;
    let top = Infinity;
    let bottom = -Infinity;
    for (const run of placed) {
      for (const {glyph, pen} of run.glyphs) {
        if (!glyph.w || !glyph.h) continue;

        const x = Math.floor((Math.round(run.x * 64) + pen + 32) / 64) + glyph.dx;
        left = Math.min(left, x);
        top = Math.min(top, face.ascent + glyph.dy);
        bottom = Math.max(bottom, face.ascent + glyph.dy + glyph.h);
      }
    }
    const right = Math.floor(length + 0.5);
    if (top === Infinity) return {left, top: 0, right, bottom: 0};

    return {left, top, right, bottom};
  }

  /**
   * Up to two initials of the name, centred on a hue hashed from the name, as RGBA.
   * @param {string} text @param {number} width @param {number} height
   */
  function letters(text, width, height) {
    const name = text.trim() || '?';
    const hue = parseInt(sha256(utf8(name)).slice(0, 4), 16) / 65535;
    const background = hlsToRgb(hue, 0.32, 0.45).map(value => Math.trunc(value * 255));

    const tile = blank(width, height, 4);
    for (let i = 0; i < width * height; i++) tile.bytes.set([...background, 255], i * 4);

    const words = name.split(/\s+/).filter(Boolean).slice(0, 2);
    const initials = words.map(word => Array.from(word)[0]).join('').toUpperCase();
    const face = faceAt(Math.trunc(height * 0.5), 700);
    const {placed, length} = runs(initials || Array.from(name)[0].toUpperCase(), face, 0);

    const box = textBox(placed, length, face);
    const x = (width - (box.right - box.left)) / 2 - box.left;
    const y = (height - (box.bottom - box.top)) / 2 - box.top;
    drawRuns(tile, x, Math.trunc(y) + face.ascent, placed, LETTER_INK);
    return painted(tile);
  }

  /** CRC-32 of PNG chunks. */
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }

  /** @param {Uint8Array} bytes @param {number} start @param {number} end */
  function crc32(bytes, start, end) {
    let crc = 0xffffffff;
    for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * The PNG's chunks with checked CRCs, or null when it is not a whole PNG.
   * @param {Uint8Array} bytes
   */
  function pngChunks(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 8 || signature.some((value, i) => bytes[i] !== value)) return null;

    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks = [];
    for (let at = 8; at + 12 <= bytes.length; ) {
      const length = data.getUint32(at);
      const end = at + 8 + length;
      if (end + 4 > bytes.length) return null;
      if (crc32(bytes, at + 4, end) !== data.getUint32(end)) return null;

      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
      chunks.push({type, body: bytes.subarray(at + 8, end)});
      if (type === 'IEND') return chunks;
      at = end + 4;
    }
    return null;
  }

  /**
   * Undoes the PNG row filters of one pass in place.
   * @param {Uint8Array} raw @param {number} at @param {number} rows @param {number} rowBytes
   * @param {number} pixelBytes
   */
  function unfilter(raw, at, rows, rowBytes, pixelBytes) {
    const out = new Uint8Array(rows * rowBytes);
    for (let y = 0; y < rows; y++) {
      const filter = raw[at];
      const line = raw.subarray(at + 1, at + 1 + rowBytes);
      const row = y * rowBytes;
      if (line.length < rowBytes || filter > 4) return null;

      for (let x = 0; x < rowBytes; x++) {
        const left = x >= pixelBytes ? out[row + x - pixelBytes] : 0;
        const up = y ? out[row - rowBytes + x] : 0;
        const corner = y && x >= pixelBytes ? out[row - rowBytes + x - pixelBytes] : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        else if (filter === 3) predicted = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - corner;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - corner);
          if (pa <= pb && pa <= pc) predicted = left;
          else if (pb <= pc) predicted = up;
          else predicted = corner;
        }
        out[row + x] = (line[x] + predicted) & 255;
      }
      at += 1 + rowBytes;
    }
    return {out, at};
  }

  /**
   * The sample at index i of a row, at the bit depth; 16-bit samples keep their high byte, as
   * Pillow reads them. @param {Uint8Array} row @param {number} i @param {number} depth
   */
  function sample(row, i, depth) {
    if (depth === 8) return row[i];
    if (depth === 16) return row[2 * i];

    const perByte = 8 / depth;
    const shift = 8 - depth * ((i % perByte) + 1);
    return (row[Math.floor(i / perByte)] >> shift) & ((1 << depth) - 1);
  }

  /**
   * One decoded pixel as RGBA, as Pillow's convert("RGBA") makes it from the PNG's mode.
   * @typedef {{colorType: number, depth: number, palette: Uint8Array | null,
   *   alphas: Uint8Array | null, key: number[] | null}} Png
   * @param {Png} png
   * @param {Uint8Array} row @param {number} x @param {Uint8Array} out @param {number} at
   */
  function pixel(png, row, x, out, at) {
    const {colorType, depth} = png;
    const gray = (/** @type {number} */ value) => {
      if (depth === 16) return Math.min(255, (row[2 * value] << 8) | row[2 * value + 1]);
      return sample(row, value, depth) * (255 / ((1 << depth) - 1));
    };

    if (colorType === 0) {
      const level = gray(x);
      const raw = depth === 16 ? (row[2 * x] << 8) | row[2 * x + 1] : level;
      out.set([level, level, level, png.key && png.key[0] === raw ? 0 : 255], at);
    } else if (colorType === 2) {
      const rgb = [0, 1, 2].map(c => sample(row, 3 * x + c, depth));
      const keyed = png.key && rgb.every((value, c) => png.key?.[c] === value);
      out.set([...rgb, keyed ? 0 : 255], at);
    } else if (colorType === 3) {
      const index = sample(row, x, depth);
      const palette = png.palette ?? new Uint8Array(0);
      const rgb = [0, 1, 2].map(c => palette[3 * index + c] ?? 0);
      out.set([...rgb, png.alphas?.[index] ?? 255], at);
    } else if (colorType === 4) {
      const level = sample(row, 2 * x, depth);
      out.set([level, level, level, sample(row, 2 * x + 1, depth)], at);
    } else {
      out.set([0, 1, 2, 3].map(c => sample(row, 4 * x + c, depth)), at);
    }
  }

  /**
   * A PNG as RGBA8, or null for anything Pillow would not open as a PNG or the tile refuses.
   * @param {Uint8Array} bytes
   */
  function decodePng(bytes) {
    const chunks = pngChunks(bytes);
    if (!chunks || chunks[0].type !== 'IHDR' || chunks[0].body.length !== 13) return null;

    const header = new DataView(chunks[0].body.buffer, chunks[0].body.byteOffset, 13);
    const width = header.getUint32(0);
    const height = header.getUint32(4);
    const depth = header.getUint8(8);
    const colorType = header.getUint8(9);
    const interlaced = header.getUint8(12) === 1;
    const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colorType];
    const sizeOk = width > 0 && height > 0 && Math.max(width, height) <= MAX_COVER_SIDE;
    const depthOk = [1, 2, 4, 8, 16].includes(depth) && !(colorType === 3 && depth === 16);
    const typeOk = channels !== undefined && (depth >= 8 || colorType === 0 || colorType === 3);
    if (!sizeOk || !depthOk || !typeOk || !inflate) return null;

    const plte = chunks.find(chunk => chunk.type === 'PLTE')?.body ?? null;
    const trns = chunks.find(chunk => chunk.type === 'tRNS')?.body ?? null;
    if (colorType === 3 && !plte) return null;

    /** @type {Png} */
    const png = {colorType, depth, palette: plte, alphas: null, key: null};
    if (trns && colorType === 3) png.alphas = trns;
    if (trns && (colorType === 0 || colorType === 2)) {
      const values = [];
      for (let i = 0; i + 1 < trns.length; i += 2) values.push((trns[i] << 8) | trns[i + 1]);
      png.key = values;
    }

    const bitsPerPixel = channels * depth;
    const pixelBytes = Math.max(1, bitsPerPixel >> 3);
    const passes = interlaced
      ? [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2]
        ]
      : [[0, 0, 1, 1]];
    const shapes = passes.map(([x0, y0, dx, dy]) => ({
      x0, y0, dx, dy,
      columns: Math.ceil((width - x0) / dx),
      rows: Math.ceil((height - y0) / dy)
    }));
    const expected = shapes.reduce((sum, pass) => {
      if (pass.columns <= 0 || pass.rows <= 0) return sum;
      return sum + pass.rows * (1 + Math.ceil((pass.columns * bitsPerPixel) / 8));
    }, 0);

    const idat = chunks.filter(chunk => chunk.type === 'IDAT');
    const joined = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.body.length, 0));
    idat.reduce((at, chunk) => (joined.set(chunk.body, at), at + chunk.body.length), 0);
    let raw;
    try {
      raw = inflate(joined, expected);
    } catch {
      return null;
    }
    if (raw.length < expected) return null;

    const rgba = new Uint8Array(width * height * 4);
    let at = 0;
    for (const pass of shapes) {
      if (pass.columns <= 0 || pass.rows <= 0) continue;

      const rowBytes = Math.ceil((pass.columns * bitsPerPixel) / 8);
      const result = unfilter(raw, at, pass.rows, rowBytes, pixelBytes);
      if (!result) return null;

      at = result.at;
      for (let y = 0; y < pass.rows; y++) {
        const row = result.out.subarray(y * rowBytes, (y + 1) * rowBytes);
        for (let x = 0; x < pass.columns; x++) {
          const target = ((pass.y0 + y * pass.dy) * width + pass.x0 + x * pass.dx) * 4;
          pixel(png, row, x, rgba, target);
        }
      }
    }
    return {width, height, bytes: rgba};
  }

  /**
   * Pillow's Lanczos coefficients for one axis, as 22-bit fixed point.
   * @param {number} inSize @param {number} in0 @param {number} in1 @param {number} outSize
   */
  function coefficients(inSize, in0, in1, outSize) {
    const lanczos = (/** @type {number} */ x) => {
      if (x < -3 || x >= 3) return 0;
      const sinc = (/** @type {number} */ value) => (value === 0 ? 1 : Math.sin(value * Math.PI) / (value * Math.PI));
      return sinc(x) * sinc(x / 3);
    };
    const scale = (in1 - in0) / outSize;
    const filterScale = Math.max(1, scale);
    const support = 3 * filterScale;

    const taps = [];
    for (let xx = 0; xx < outSize; xx++) {
      const center = in0 + (xx + 0.5) * scale;
      const min = Math.max(0, Math.trunc(center - support + 0.5));
      const max = Math.min(inSize, Math.trunc(center + support + 0.5)) - min;
      const weights = [];
      let total = 0;
      for (let x = 0; x < max; x++) {
        const weight = lanczos((x + min - center + 0.5) / filterScale);
        weights.push(weight);
        total += weight;
      }
      const fixed = weights.map(weight => {
        const normal = total ? weight / total : weight;
        return Math.trunc(normal * (1 << 22) + (normal < 0 ? -0.5 : 0.5));
      });
      taps.push({min, fixed});
    }
    return taps;
  }

  /** @param {number} value */
  function clip8(value) {
    return Math.min(255, Math.max(0, value >> 22));
  }

  /**
   * Pillow's two-pass Lanczos resize of RGBA8 (premultiplied by the caller), with a source box.
   * @param {Bitmap} image @param {number} width @param {number} height
   * @param {number[]} box
   */
  function resample(image, width, height, box) {
    const horizontal = coefficients(image.width, box[0], box[2], width);
    const vertical = coefficients(image.height, box[1], box[3], height);
    const needHorizontal = width !== image.width || box[0] !== 0 || box[2] !== width;
    const needVertical = height !== image.height || box[1] !== 0 || box[3] !== height;

    let source = image;
    let firstRow = 0;
    if (needHorizontal) {
      firstRow = vertical[0].min;
      const last = vertical[height - 1];
      const rows = last.min + last.fixed.length - firstRow;
      const out = new Uint8Array(width * rows * 4);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < width; x++) {
          const {min, fixed} = horizontal[x];
          for (let c = 0; c < 4; c++) {
            let sum = 1 << 21;
            for (let k = 0; k < fixed.length; k++)
              sum += image.bytes[((y + firstRow) * image.width + min + k) * 4 + c] * fixed[k];
            out[(y * width + x) * 4 + c] = clip8(sum);
          }
        }
      }
      source = {width, height: rows, bytes: out};
    }
    if (!needVertical) return source;

    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const {min, fixed} = vertical[y];
      const base = needHorizontal ? min - firstRow : min;
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 1 << 21;
          for (let k = 0; k < fixed.length; k++)
            sum += source.bytes[((base + k) * source.width + x) * 4 + c] * fixed[k];
          out[(y * width + x) * 4 + c] = clip8(sum);
        }
      }
    }
    return {width, height, bytes: out};
  }

  /**
   * Image.resize(size, LANCZOS, box) of RGBA: through premultiplied alpha, as Pillow does.
   * @param {Bitmap} image @param {number} width @param {number} height @param {number[]} [box]
   */
  function resize(image, width, height, box = [0, 0, image.width, image.height]) {
    const same = width === image.width && height === image.height;
    const whole = box[0] === 0 && box[1] === 0 && box[2] === image.width && box[3] === image.height;
    if (same && whole) return {width, height, bytes: image.bytes.slice()};

    const premultiplied = image.bytes.slice();
    for (let i = 0; i < premultiplied.length; i += 4) {
      const alpha = premultiplied[i + 3];
      for (let c = 0; c < 3; c++) premultiplied[i + c] = div255(premultiplied[i + c] * alpha);
    }

    const out = resample({...image, bytes: premultiplied}, width, height, box);
    for (let i = 0; i < out.bytes.length; i += 4) {
      const alpha = out.bytes[i + 3];
      if (alpha === 0 || alpha === 255) continue;

      for (let c = 0; c < 3; c++) out.bytes[i + c] = Math.min(255, Math.floor((255 * out.bytes[i + c]) / alpha));
    }
    return out;
  }

  /** Pillow's box radius for a three-pass Gaussian, in single precision. @param {number} radius */
  function boxRadius(radius) {
    const f = Math.fround;
    const sigma2 = f(f(f(radius) * f(radius)) / 3);
    const length = f(Math.sqrt(12 * sigma2 + 1));
    const integer = f(Math.floor((length - 1) / 2));
    let fraction = f(f(f(2 * integer) + 1) * f(f(integer * f(integer + 1)) - f(3 * sigma2)));
    fraction = f(fraction / f(6 * f(sigma2 - f(f(integer + 1) * f(integer + 1)))));
    return f(integer + fraction);
  }

  /**
   * One box blur pass along rows (stride 4 between pixels of a line), edges clamped, in
   * Pillow's 24-bit fixed point. @param {Uint8Array} bytes @param {number} lines
   * @param {number} length @param {number} pixelStride @param {number} lineStride
   * @param {number} radius
   */
  function boxBlurPass(bytes, lines, length, pixelStride, lineStride, radius) {
    const whole = Math.trunc(radius);
    const weight = Math.trunc(Math.fround(16777216 / Math.fround(Math.fround(radius * 2) + 1)));
    const edge = Math.trunc((16777216 - (whole * 2 + 1) * weight) / 2);
    const line = new Uint8Array(length);
    const clamp = (/** @type {number} */ x) => Math.min(length - 1, Math.max(0, x));

    for (let l = 0; l < lines; l++) {
      for (let c = 0; c < 4; c++) {
        const base = l * lineStride + c;
        for (let x = 0; x < length; x++) line[x] = bytes[base + x * pixelStride];

        let sum = 0;
        for (let k = -whole; k <= whole; k++) sum += line[clamp(k)];
        for (let x = 0; x < length; x++) {
          const far = line[clamp(x - whole - 1)] + line[clamp(x + whole + 1)];
          bytes[base + x * pixelStride] = Math.floor((sum * weight + far * edge + 8388608) / 16777216);
          sum += line[clamp(x + whole + 1)] - line[clamp(x - whole)];
        }
      }
    }
  }

  /**
   * ImageFilter.GaussianBlur(radius) of RGBA8, in place: three box passes per axis.
   * @param {Bitmap} image @param {number} radius
   */
  function gaussianBlur(image, radius) {
    const box = boxRadius(radius);
    const {width, height, bytes} = image;
    for (let pass = 0; pass < 3; pass++) boxBlurPass(bytes, height, width, 4, width * 4, box);
    for (let pass = 0; pass < 3; pass++) boxBlurPass(bytes, width, height, width * 4, 4, box);
  }

  /**
   * Pillow's alpha_composite of `source` over `target` at x, y; target stays opaque.
   * @param {Bitmap} target @param {Bitmap} source @param {number} left @param {number} top
   */
  function alphaComposite(target, source, left, top) {
    const shiftDiv255 = (/** @type {number} */ value) => ((value >> 8) + value) >> 8;
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const from = (y * source.width + x) * 4;
        const to = ((top + y) * target.width + left + x) * 4;
        const alpha = source.bytes[from + 3];
        if (!alpha) continue;

        const blend = target.bytes[to + 3] * (255 - alpha);
        const outAlpha255 = alpha * 255 + blend;
        const coef1 = Math.floor((alpha * 255 * 255 * 128) / outAlpha255);
        const coef2 = 255 * 128 - coef1;
        for (let c = 0; c < 3; c++) {
          const mixed = source.bytes[from + c] * coef1 + target.bytes[to + c] * coef2;
          target.bytes[to + c] = shiftDiv255(mixed + (0x80 << 7)) >> 7;
        }
        target.bytes[to + 3] = shiftDiv255(outAlpha255 + 0x80);
      }
    }
  }

  /**
   * The cover fitted whole inside the tile over a blurred, darkened fill of itself, as RGBA;
   * 0 x 0 when the bytes are not a PNG the tile takes.
   * @param {Uint8Array} png @param {number} width @param {number} height
   */
  function tile(png, width, height) {
    const art = decodePng(png);
    if (!art) return {width: 0, height: 0, bytes: new Uint8Array(0)};

    const artRatio = art.width / art.height;
    const ratio = width / height;
    let cropWidth = art.width;
    let cropHeight = art.height;
    if (artRatio !== ratio && artRatio >= ratio) cropWidth = ratio * art.height;
    else if (artRatio !== ratio) cropHeight = art.width / ratio;
    const cropLeft = (art.width - cropWidth) * 0.5;
    const cropTop = (art.height - cropHeight) * 0.5;
    const box = [cropLeft, cropTop, cropLeft + cropWidth, cropTop + cropHeight];

    const out = resize(art, width, height, box);
    gaussianBlur(out, height / 12);
    const level = Math.fround(FILL_LEVEL);
    for (let i = 0; i < out.bytes.length; i += 4) {
      for (let c = 0; c < 3; c++) out.bytes[i + c] = Math.trunc(Math.fround(level * out.bytes[i + c]));
      out.bytes[i + 3] = 255;
    }

    let coverWidth = width;
    let coverHeight = height;
    if (artRatio !== ratio && artRatio > ratio) coverHeight = pyRound((art.height / art.width) * width);
    else if (artRatio !== ratio) coverWidth = pyRound((art.width / art.height) * height);
    const cover = resize(art, coverWidth, coverHeight);
    const left = Math.floor((width - cover.width) / 2);
    const top = Math.floor((height - cover.height) / 2);
    alphaComposite(out, cover, left, top);
    return out;
  }

  /**
   * The width in px of the text drawn on one line, unshortened.
   * @param {string} text @param {number} size @param {{weight?: number, tracking?: number}} [style]
   */
  function measure(text, size, {weight = 600, tracking = 0} = {}) {
    return runs(text, faceAt(size, weight), tracking).length;
  }

  return {text: textStrip, legend, letters, tile, measure};
}

export {createGlyphRaster};
