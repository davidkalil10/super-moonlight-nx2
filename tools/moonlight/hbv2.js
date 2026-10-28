/**
 * HBV2: inter-coded, variable-rate frames for the Moonlight app.
 *
 * A slot is a header, a list of coded chunks and one bit stream. A chunk is eight consecutive
 * 16x16 macroblocks in raster order; chunks whose blocks are all unchanged are left out of the
 * list. Each list entry holds the chunk index and the bit offset of its data, so every chunk
 * decodes on its own GPU invocation. Inside a chunk, each macroblock is skipped (copied from the
 * previous frame), inter coded (motion vector plus optional DCT residual) or intra coded. The
 * transform is an integer IDCT, so this file and the compute shader reconstruct bit-identical
 * frames and P frames never drift. Bits are packed LSB first; ue() is Exp-Golomb
 * with its zero prefix read from the low bits.
 *
 * This file is the reference decoder and a plan-driven reference encoder; the console decoder is
 * apps/moonlight/backends/hblauncher.gpu-app/hbv2.glsl. Shared tables are generated from here.
 */

const MAGIC = 0x32564248;
const HBV1_MAGIC = 0x31564248;
const HEADER_WORDS = 8;
const EXCHANGE_BYTES = 0x8000;
const CHUNK_MBS = 8;
const CHUNK_INDEX_BITS = 11;
const MAX_CHUNKS = 1 << CHUNK_INDEX_BITS;
const MAX_STREAM_BITS = 2 ** (32 - CHUNK_INDEX_BITS);
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1088;
const MAX_QP = 51;
const MAX_FRAME_BYTES = 8 * EXCHANGE_BYTES;
const COEFFICIENT_LIMIT = 2048;
/** Slots a single compute dispatch may apply. */
const CATCH_UP = 3;

/** Header word indices; the last used word of the slot repeats the sequence as a trailer. */
const HEADER = {
  magic: 0,
  sequence: 1,
  size: 2,
  payloadBytes: 3,
  reference: 4,
  qp: 5,
  count: 6
};
/** The size word holds the width in its low half and the height in its high half. */
const SIZE_MASK = 0xffff;
const HEIGHT_SHIFT = 16;
/** The qp word holds the luma qp in its low byte and the chroma qp in the next. */
const QP_MASK = 0xff;
const CHROMA_QP_SHIFT = 8;
/** Largest frame dimension the shader's header check accepts for either format. */
const MAX_SLOT_DIMENSION = 4096;
/** readHeader's `kind`: which format a slot holds. */
const FORMAT = {hbv1: 1, hbv2: 2};
/** Decoder display mode, mirroring the control word of the app. */
const MODE = {none: 0, hbv1: 1, hbv2: 2};

const MACROBLOCK_SIZE = 16;
const BLOCK_SIZE = 8;
const BLOCK_PIXELS = BLOCK_SIZE * BLOCK_SIZE;
/** Blocks per macroblock: four luma quadrants, then Cb and Cr. */
const MACROBLOCK_BLOCKS = 6;
const LUMA_BLOCKS = 4;
/**
 * Macroblock type codes, read LSB first: a set first bit means skip; otherwise the second bit
 * selects inter (1) or intra (0).
 */
const MB_SKIP = 1;
const MB_INTER = 2;
const MB_INTRA = 0;
const CBP_BITS = 6;
/** Intra DC values are coded in units of the DC basis gain and predicted from this start. */
const DC_SCALE = 8;
const DC_PREDICTOR_START = 128;
const MAX_LEVEL = 2047;
/** The shader caps an Exp-Golomb prefix at this many zeros. */
const MAX_UE_ZEROS = 20;
/** IDCT basis values are fixed point with this gain; the two passes shift it back out. */
const IDCT_SCALE = 4096;
const IDCT_ROW_SHIFT = 9;
const IDCT_COLUMN_SHIFT = 15;
const BIT_WRITER_WORDS = 1024;

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];
/** Orthonormal DCT-II scale factor for frequency k. */
const alpha = k => (k === 0 ? Math.sqrt(1 / 8) : 0.5);
/** COS[k][x]: DCT basis cosine for frequency k at sample x. */
const COS = Array.from({length: 8}, (_, k) =>
  Array.from({length: 8}, (_, x) => Math.cos(((2 * x + 1) * k * Math.PI) / 16))
);
/** IDCT[k][x]: fixed-point scaled basis, shared bit for bit with the shader and C encoder. */
const IDCT = Array.from({length: 8}, (_, k) =>
  Array.from({length: 8}, (_, x) => Math.round(IDCT_SCALE * alpha(k) * COS[k][x]))
);
/** Quantiser base per qp; it doubles every six steps. */
const QBASE = Array.from({length: MAX_QP + 1}, (_, qp) => Math.round(8 * 2 ** (qp / 6)));
/** Per-coefficient weights in 1/16 units: intra favours low frequencies, inter is flat. */
const WEIGHT_INTRA = Array.from({length: 64}, (_, i) => 16 + 2 * ((i & 7) + (i >> 3)));
const WEIGHT_INTER = Array(64).fill(16);

/**
 * Quantiser step for a qp and coefficient weight, never below 1.
 * @param {number} qp
 * @param {number} weight
 * @returns {number}
 */
function step(qp, weight) {
  return Math.max(1, (QBASE[qp] * weight + 64) >> 7);
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** Count of trailing zero bits. */
function ctz(value) {
  return 31 - Math.clz32(value & -value);
}

/** Growable LSB-first bit stream with Exp-Golomb helpers. */
class BitWriter {
  constructor() {
    this.words = new Uint32Array(BIT_WRITER_WORDS);
    this.length = 0;
  }
  /**
   * @param {number} value
   * @param {number} bits
   */
  put(value, bits) {
    for (let bit = 0; bit < bits; bit++, this.length++) {
      if (this.length >>> 5 >= this.words.length) this.grow();
      if ((value / 2 ** bit) & 1) this.words[this.length >>> 5] |= 1 << (this.length & 31);
    }
  }
  grow() {
    const grown = new Uint32Array(this.words.length * 2);
    grown.set(this.words);
    this.words = grown;
  }
  /** @param {number} value */
  ue(value) {
    const zeros = 31 - Math.clz32(value + 1);
    this.put(2 ** zeros, zeros + 1);
    this.put(value + 1 - 2 ** zeros, zeros);
  }
  /** @param {number} value */
  se(value) {
    this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }
  /** @param {BitWriter} other */
  append(other) {
    for (let at = 0; at < other.length; at++)
      this.put((other.words[at >>> 5] >>> (at & 31)) & 1, 1);
  }
}

/**
 * Length in bits of ue(value).
 * @param {number} value
 * @returns {number}
 */
function ueBits(value) {
  return 2 * (31 - Math.clz32(value + 1)) + 1;
}

/**
 * Length in bits of se(value).
 * @param {number} value
 * @returns {number}
 */
function seBits(value) {
  return ueBits(value > 0 ? 2 * value - 1 : -2 * value);
}

/** Mirrors the shader's reader: every word index is clamped to the slot end. */
class BitReader {
  /**
   * @param {Uint32Array} words
   * @param {number} base first word of the bit stream
   * @param {number} end last readable word
   * @param {number} position bit position relative to base
   */
  constructor(words, base, end, position) {
    this.words = words;
    this.base = base;
    this.end = end;
    this.position = position;
  }
  word(index) {
    return this.words[Math.min(this.base + index, this.end)];
  }
  /** The next 32 bits without consuming them. */
  peek() {
    const index = this.position >>> 5,
      shift = this.position & 31,
      low = this.word(index) >>> shift;
    return shift === 0 ? low : (low | (this.word(index + 1) << (32 - shift))) >>> 0;
  }
  bits(count) {
    const value = count === 0 ? 0 : (this.peek() & (2 ** count - 1)) >>> 0;
    this.position += count;
    return value;
  }
  ue() {
    const window = this.peek(),
      zeros = window === 0 ? MAX_UE_ZEROS : Math.min(ctz(window), MAX_UE_ZEROS);
    this.position += zeros + 1;
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se() {
    const code = this.ue();
    return code & 1 ? (code + 1) >> 1 : -(code >> 1) | 0;
  }
}

/**
 * Integer 8x8 IDCT: rows then columns, each pass rounding off its fixed-point gain.
 * @param {ArrayLike<number>} coefficients
 * @param {Int32Array} out
 * @returns {Int32Array}
 */
function idct(coefficients, out) {
  const rows = new Int32Array(64);
  const rowRound = 1 << (IDCT_ROW_SHIFT - 1),
    columnRound = 1 << (IDCT_COLUMN_SHIFT - 1);
  for (let v = 0; v < 8; v++)
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += IDCT[u][x] * coefficients[v * 8 + u];
      rows[v * 8 + x] = (sum + rowRound) >> IDCT_ROW_SHIFT;
    }
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += IDCT[v][y] * rows[v * 8 + x];
      out[y * 8 + x] = (sum + columnRound) >> IDCT_COLUMN_SHIFT;
    }
  return out;
}

/**
 * Floating-point orthonormal 8x8 DCT, used only by the reference encoder.
 * @param {ArrayLike<number>} pixels
 * @returns {Float64Array}
 */
function forwardDct(pixels) {
  const out = new Float64Array(64);
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) sum += pixels[y * 8 + x] * COS[u][x] * COS[v][y];
      out[v * 8 + u] = sum * alpha(u) * alpha(v);
    }
  return out;
}

/**
 * A decoded frame: 8-bit Y, Cb, Cr planes at 4:2:0, stride equal to width.
 * @typedef {{width: number, height: number, y: Uint8Array, cb: Uint8Array, cr: Uint8Array}} Frame
 */

/**
 * @param {number} width
 * @param {number} height
 * @returns {Frame}
 */
function createFrame(width, height) {
  return {
    width,
    height,
    y: new Uint8Array(width * height),
    cb: new Uint8Array((width / 2) * (height / 2)),
    cr: new Uint8Array((width / 2) * (height / 2))
  };
}

/** Component 0 is luma, 1 Cb, 2 Cr. */
function plane(frame, component) {
  return component === 0
    ? {data: frame.y, width: frame.width, height: frame.height}
    : {
        data: component === 1 ? frame.cb : frame.cr,
        width: frame.width / 2,
        height: frame.height / 2
      };
}

/**
 * Block b of a macroblock: 0-3 luma quadrants, 4 Cb, 5 Cr.
 * @returns {number[]} [left, top, component] in that component's plane
 */
function blockOrigin(b, mbx, mby) {
  return b < LUMA_BLOCKS
    ? [mbx * 16 + (b & 1) * 8, mby * 16 + (b >> 1) * 8, 0]
    : [mbx * 8, mby * 8, b - 3];
}

/** Bilinear half-pel chroma tap at doubled coordinates (x2, y2). */
function chromaTap(at, x2, y2) {
  const ix = x2 >> 1,
    iy = y2 >> 1,
    fx = x2 & 1,
    fy = y2 & 1;
  return (
    (at(ix, iy) * (2 - fx) * (2 - fy) +
      at(ix + 1, iy) * fx * (2 - fy) +
      at(ix, iy + 1) * (2 - fx) * fy +
      at(ix + 1, iy + 1) * fx * fy +
      2) >>
    2
  );
}

/**
 * Motion-compensated prediction of one 8x8 block, edge-clamped. Luma vectors are in whole
 * pixels; the same vector is half-pel for the subsampled chroma.
 * @param {Frame} reference
 * @param {number} component
 * @param {number} left
 * @param {number} top
 * @param {number} mvx
 * @param {number} mvy
 * @param {Int32Array} out
 * @returns {Int32Array}
 */
function predict(reference, component, left, top, mvx, mvy, out) {
  const {data, width, height} = plane(reference, component);
  const at = (x, y) => data[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
  for (let j = 0; j < 8; j++)
    for (let i = 0; i < 8; i++) {
      if (component === 0) {
        out[j * 8 + i] = at(left + i + mvx, top + j + mvy);
        continue;
      }
      out[j * 8 + i] = chromaTap(at, 2 * (left + i) + mvx, 2 * (top + j) + mvy);
    }
  return out;
}

function store(frame, component, left, top, pixels) {
  const {data, width} = plane(frame, component);
  for (let j = 0; j < 8; j++)
    for (let i = 0; i < 8; i++) data[(top + j) * width + left + i] = pixels[j * 8 + i];
}

function copyMacroblock(from, to, mbx, mby) {
  for (let b = 0; b < MACROBLOCK_BLOCKS; b++) {
    const [left, top, component] = blockOrigin(b, mbx, mby),
      source = plane(from, component),
      target = plane(to, component);
    for (let j = 0; j < 8; j++) {
      const at = (top + j) * source.width + left;
      target.data.set(source.data.subarray(at, at + 8), at);
    }
  }
}

function isValidSize(width, height) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= MACROBLOCK_SIZE &&
    height >= MACROBLOCK_SIZE &&
    !(width % MACROBLOCK_SIZE) &&
    !(height % MACROBLOCK_SIZE) &&
    width <= MAX_WIDTH &&
    height <= MAX_HEIGHT
  );
}

/**
 * Macroblock and chunk counts for a frame size.
 * @param {number} width
 * @param {number} height
 */
function layout(width, height) {
  if (!isValidSize(width, height))
    throw Error(`HBV2 frames are multiples of 16 up to ${MAX_WIDTH}x${MAX_HEIGHT}`);
  const blocksX = width / MACROBLOCK_SIZE,
    blocksY = height / MACROBLOCK_SIZE,
    macroblocks = blocksX * blocksY;
  return {width, height, blocksX, blocksY, macroblocks, chunks: Math.ceil(macroblocks / CHUNK_MBS)};
}

/**
 * @param {number} payloadBytes
 * @returns {number}
 */
function exchangesFor(payloadBytes) {
  return Math.ceil(payloadBytes / EXCHANGE_BYTES);
}

/**
 * Validates a slot the way the compute shader does.
 * @param {Uint32Array} words the slot's words
 * @param {number} [slotWords]
 */
function readHeader(words, slotWords = words.length) {
  const magic = words[HEADER.magic],
    sequence = words[HEADER.sequence],
    size = words[HEADER.size],
    payloadBytes = words[HEADER.payloadBytes];
  if ((magic !== MAGIC && magic !== HBV1_MAGIC) || sequence === 0) return null;
  const width = size & SIZE_MASK,
    height = size >>> HEIGHT_SHIFT;
  if (
    !width ||
    !height ||
    width % MACROBLOCK_SIZE ||
    height % MACROBLOCK_SIZE ||
    width > MAX_SLOT_DIMENSION ||
    height > MAX_SLOT_DIMENSION
  )
    return null;
  const exchanges = exchangesFor(payloadBytes),
    exchangeWords = EXCHANGE_BYTES / 4;
  if (exchanges === 0 || exchanges * exchangeWords > slotWords) return null;
  const trailer = exchanges * exchangeWords - 1;
  if (words[trailer] !== sequence) return null;
  if (magic === HBV1_MAGIC) return {kind: FORMAT.hbv1, sequence, width, height, trailer};
  if (width > MAX_WIDTH || height > MAX_HEIGHT) return null;
  const count = words[HEADER.count],
    qp = words[HEADER.qp] & QP_MASK,
    chromaQp = (words[HEADER.qp] >>> CHROMA_QP_SHIFT) & QP_MASK,
    map = layout(width, height);
  if (count > map.chunks || HEADER_WORDS + count > trailer) return null;
  if (qp > MAX_QP || chromaQp > MAX_QP) return null;
  return {
    kind: FORMAT.hbv2,
    sequence,
    reference: words[HEADER.reference],
    width,
    height,
    qp,
    chromaQp,
    count,
    trailer,
    map
  };
}

function isIndependent(header) {
  return header.kind === FORMAT.hbv1 || header.reference === 0;
}

/**
 * The console's decoder state. Mirrors the control words and both frame buffers of
 * apps/moonlight; written[] holds, per macroblock, the apply count at which it was last coded so
 * skipped blocks are copied only when needed.
 */
class Decoder {
  constructor() {
    this.applied = 0;
    this.applyCount = 0;
    this.mode = MODE.none;
    this.current = 0;
    this.hbv1Slot = 0;
    this.frames = [null, null];
    this.written = new Uint32Array(MAX_CHUNKS * CHUNK_MBS);
  }

  /** @returns {Frame | null} the shown HBV2 frame */
  get frame() {
    return this.mode === MODE.hbv2 ? this.frames[this.current] : null;
  }

  eligible(header) {
    if (!header || header.sequence <= this.applied) return false;
    if (isIndependent(header)) return true;
    const frame = this.frame;
    return (
      header.reference === this.applied &&
      frame !== null &&
      frame.width === header.width &&
      frame.height === header.height
    );
  }

  /**
   * Returns the slot to apply or -1: the newest independent frame (HBV1 or keyframe) if it is
   * newer than the P frame that continues the current one, otherwise that P frame.
   * @param {Uint32Array[]} slots one per ring slot
   * @returns {number}
   */
  pick(slots) {
    let independent = -1,
      independentSequence = 0,
      dependent = -1,
      dependentSequence = 0;
    slots.forEach((words, index) => {
      const header = readHeader(words);
      if (!this.eligible(header)) return;
      if (isIndependent(header)) {
        if (header.sequence > independentSequence) {
          independent = index;
          independentSequence = header.sequence;
        }
      } else if (dependent < 0 || header.sequence < dependentSequence) {
        dependent = index;
        dependentSequence = header.sequence;
      }
    });
    if (independent >= 0 && (dependent < 0 || independentSequence > dependentSequence))
      return independent;
    return dependent;
  }

  /**
   * Applies one eligible slot, decoding HBV2 into the back frame and flipping to it.
   * @param {Uint32Array} words
   * @param {number} [index] the slot's ring index, recorded for HBV1
   */
  apply(words, index = 0) {
    const header = readHeader(words);
    if (!this.eligible(header)) throw Error('Slot is not eligible');
    if (header.kind === FORMAT.hbv1) {
      this.mode = MODE.hbv1;
      this.hbv1Slot = index;
      this.applied = header.sequence;
      return header;
    }
    const target = this.mode === MODE.hbv2 ? this.current ^ 1 : 0,
      count = this.applyCount + 1;
    const frame = targetFrame(this.frames, target, header);
    const reference = header.reference ? this.frames[this.current] : null;
    if (reference) carryForward(reference, frame, header.map, this.written, count - 1);
    decodeChunks(words, header, reference, frame, this.written, count);
    this.applyCount = count;
    this.current = target;
    this.mode = MODE.hbv2;
    this.applied = header.sequence;
    return header;
  }

  /**
   * One compute dispatch: apply up to catchUp slots in order.
   * @param {Uint32Array[]} slots
   * @param {number} [catchUp]
   * @returns {number} slots applied
   */
  step(slots, catchUp = CATCH_UP) {
    let applied = 0;
    for (; applied < catchUp; applied++) {
      const index = this.pick(slots);
      if (index < 0) break;
      this.apply(slots[index], index);
    }
    return applied;
  }
}

/** The frame buffer at index target, reallocated when the size changed. */
function targetFrame(frames, target, header) {
  let frame = frames[target];
  if (!frame || frame.width !== header.width || frame.height !== header.height)
    frame = frames[target] = createFrame(header.width, header.height);
  return frame;
}

/**
 * Copies the macroblocks coded by the previous apply into the back buffer, which still holds the
 * frame from before it.
 */
function carryForward(reference, frame, map, written, previousCount) {
  for (let mb = 0; mb < map.macroblocks; mb++)
    if (written[mb] === previousCount)
      copyMacroblock(reference, frame, mb % map.blocksX, Math.floor(mb / map.blocksX));
}

function decodeChunks(words, header, reference, frame, written, count) {
  const {map} = header,
    streamBase = HEADER_WORDS + header.count;
  for (let entry = 0; entry < header.count; entry++) {
    const value = words[HEADER_WORDS + entry],
      chunk = value & (MAX_CHUNKS - 1);
    if (chunk >= map.chunks) continue;
    decodeChunk(
      new BitReader(words, streamBase, header.trailer, value >>> CHUNK_INDEX_BITS),
      chunk,
      header,
      reference,
      frame,
      written,
      count
    );
  }
}

/** Reads one block's run-level coefficients into natural order, dequantised. */
function readCoefficients(reader, intra, qp, predictor, out) {
  out.fill(0);
  const weights = intra ? WEIGHT_INTRA : WEIGHT_INTER;
  let position = 0,
    count;
  if (intra) {
    predictor.dc += reader.se();
    out[0] = clamp(predictor.dc * DC_SCALE, -COEFFICIENT_LIMIT, COEFFICIENT_LIMIT - 1);
    count = reader.ue();
    position = 1;
  } else count = reader.ue() + 1;
  count = Math.min(count, 64);
  for (let i = 0; i < count; i++) {
    position += reader.ue();
    if (position > 63) break;
    const magnitude = reader.ue() + 1,
      level = reader.bits(1) ? -magnitude : magnitude,
      natural = ZIGZAG[position];
    out[natural] = clamp(
      level * step(qp, weights[natural]),
      -COEFFICIENT_LIMIT,
      COEFFICIENT_LIMIT - 1
    );
    position++;
  }
  return out;
}

function newPredictors() {
  return [{dc: DC_PREDICTOR_START}, {dc: DC_PREDICTOR_START}, {dc: DC_PREDICTOR_START}];
}

function decodeChunk(reader, chunk, header, reference, frame, written, count) {
  const {map} = header,
    coefficients = new Int32Array(64),
    residual = new Int32Array(64),
    prediction = new Int32Array(64),
    pixels = new Int32Array(64),
    predictors = newPredictors();
  let mvx = 0,
    mvy = 0;
  for (let m = 0; m < CHUNK_MBS; m++) {
    const mb = chunk * CHUNK_MBS + m;
    if (mb >= map.macroblocks) break;
    if (reader.bits(1)) continue;
    const inter = reader.bits(1) === 1 && reference !== null,
      mbx = mb % map.blocksX,
      mby = Math.floor(mb / map.blocksX);
    let cbp = 0;
    if (inter) {
      mvx += reader.se();
      mvy += reader.se();
      cbp = reader.bits(CBP_BITS);
    }
    for (let b = 0; b < MACROBLOCK_BLOCKS; b++) {
      const [left, top, component] = blockOrigin(b, mbx, mby),
        qp = component ? header.chromaQp : header.qp;
      if (inter) {
        predict(reference, component, left, top, mvx, mvy, prediction);
        if ((cbp >> b) & 1) idct(readCoefficients(reader, false, qp, null, coefficients), residual);
        else residual.fill(0);
        for (let i = 0; i < 64; i++) pixels[i] = clamp(prediction[i] + residual[i], 0, 255);
      } else {
        idct(readCoefficients(reader, true, qp, predictors[component], coefficients), residual);
        for (let i = 0; i < 64; i++) pixels[i] = clamp(residual[i], 0, 255);
      }
      store(frame, component, left, top, pixels);
    }
    written[mb] = count;
  }
}

/** BT.601 full-range luma of one RGB24 pixel, rounded and clamped. */
function lumaAt(rgb, at) {
  return clamp(Math.round(0.299 * rgb[at] + 0.587 * rgb[at + 1] + 0.114 * rgb[at + 2]), 0, 255);
}

/**
 * RGB24 to 4:2:0 planes (BT.601 full range), coded height padded by row repeat.
 * @param {Uint8Array} rgb
 * @param {number} width
 * @param {number} height
 * @param {number} [codedHeight]
 * @returns {Frame}
 */
function toFrame(rgb, width, height, codedHeight = Math.ceil(height / 16) * 16) {
  const frame = createFrame(width, codedHeight),
    row = y => Math.min(y, height - 1) * width;
  for (let y = 0; y < codedHeight; y++)
    for (let x = 0; x < width; x++) frame.y[y * width + x] = lumaAt(rgb, (row(y) + x) * 3);
  const chromaWidth = width / 2;
  for (let y = 0; y < codedHeight / 2; y++)
    for (let x = 0; x < chromaWidth; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const at = (row(2 * y + dy) + 2 * x + dx) * 3;
          r += rgb[at];
          g += rgb[at + 1];
          b += rgb[at + 2];
        }
      r /= 4;
      g /= 4;
      b /= 4;
      frame.cb[y * chromaWidth + x] = clamp(
        Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b),
        0,
        255
      );
      frame.cr[y * chromaWidth + x] = clamp(
        Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b),
        0,
        255
      );
    }
  return frame;
}

/** Edge-clamped bilinear sample of a plane at a continuous position, texel centres at +0.5. */
function sampleBilinear(frame, component, sx, sy) {
  const {data, width, height} = plane(frame, component),
    qx = sx - 0.5,
    qy = sy - 0.5,
    ix = Math.floor(qx),
    iy = Math.floor(qy),
    fx = qx - ix,
    fy = qy - iy;
  const at = (x, y) => data[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
  const top = at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx,
    bottom = at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Fragment-shader sampling: bilinear luma and chroma at the continuous source position of each
 * output pixel, scaled by width like HBV1.
 * @param {Frame} frame
 * @param {number} [outWidth]
 * @param {number} [outHeight]
 * @returns {Buffer} RGB24
 */
function toRgb(frame, outWidth = frame.width, outHeight = frame.height) {
  const rgb = Buffer.alloc(outWidth * outHeight * 3),
    scale = frame.width / outWidth;
  for (let y = 0; y < outHeight; y++)
    for (let x = 0; x < outWidth; x++) {
      const sx = (x + 0.5) * scale,
        sy = (y + 0.5) * scale,
        luma = sampleBilinear(frame, 0, sx, sy),
        cb = sampleBilinear(frame, 1, sx / 2, sy / 2) - 128,
        cr = sampleBilinear(frame, 2, sx / 2, sy / 2) - 128,
        at = (y * outWidth + x) * 3;
      rgb[at] = clamp(Math.round(luma + 1.402 * cr), 0, 255);
      rgb[at + 1] = clamp(Math.round(luma - 0.344136 * cb - 0.714136 * cr), 0, 255);
      rgb[at + 2] = clamp(Math.round(luma + 1.772 * cb), 0, 255);
    }
  return rgb;
}

function gather(frame, component, left, top, out) {
  const {data, width} = plane(frame, component);
  for (let j = 0; j < 8; j++)
    for (let i = 0; i < 8; i++) out[j * 8 + i] = data[(top + j) * width + left + i];
  return out;
}

/** Round half away from zero. */
function quantise(value, size) {
  return Math.sign(value) * Math.floor(Math.abs(value) / size + 0.5);
}

/** Zigzag scan of nonzero quantised levels as [run of zeros, level] pairs. */
function runLevelPairs(dct, intra, qp) {
  const weights = intra ? WEIGHT_INTRA : WEIGHT_INTER,
    pairs = [];
  let run = 0;
  for (let position = intra ? 1 : 0; position < 64; position++) {
    const natural = ZIGZAG[position],
      level = clamp(quantise(dct[natural], step(qp, weights[natural])), -MAX_LEVEL, MAX_LEVEL);
    if (level === 0) run++;
    else {
      pairs.push([run, level]);
      run = 0;
    }
  }
  return pairs;
}

/**
 * Writes one block's coefficients. Intra blocks code their DC against the predictor; inter
 * blocks with nothing to code write nothing and return false.
 */
function writeCoefficients(writer, dct, intra, qp, predictor) {
  const pairs = runLevelPairs(dct, intra, qp);
  if (intra) {
    const dc = clamp(Math.round(dct[0] / DC_SCALE), 0, 255);
    writer.se(dc - predictor.dc);
    predictor.dc = dc;
    writer.ue(pairs.length);
  } else {
    if (pairs.length === 0) return false;
    writer.ue(pairs.length - 1);
  }
  for (const [skip, level] of pairs) {
    writer.ue(skip);
    writer.ue(Math.abs(level) - 1);
    writer.put(level < 0 ? 1 : 0, 1);
  }
  return true;
}

/**
 * Codes an inter macroblock's residual blocks into a side writer, then writes the coded block
 * pattern followed by them.
 */
function writeInterBlocks(writer, source, reference, mbx, mby, mvx, mvy, qps, scratch) {
  const {pixels, prediction, difference} = scratch,
    blocks = new BitWriter();
  let cbp = 0;
  for (let b = 0; b < MACROBLOCK_BLOCKS; b++) {
    const [left, top, component] = blockOrigin(b, mbx, mby);
    predict(reference, component, left, top, mvx, mvy, prediction);
    gather(source, component, left, top, pixels);
    for (let i = 0; i < 64; i++) difference[i] = pixels[i] - prediction[i];
    if (writeCoefficients(blocks, forwardDct(difference), false, qps[component ? 1 : 0], null))
      cbp |= 1 << b;
  }
  writer.put(cbp, CBP_BITS);
  writer.append(blocks);
}

function writeIntraBlocks(writer, source, mbx, mby, qps, predictors, pixels) {
  for (let b = 0; b < MACROBLOCK_BLOCKS; b++) {
    const [left, top, component] = blockOrigin(b, mbx, mby);
    writeCoefficients(
      writer,
      forwardDct(gather(source, component, left, top, pixels)),
      true,
      qps[component ? 1 : 0],
      predictors[component]
    );
  }
}

/**
 * Codes one chunk into its own writer.
 * @returns {BitWriter | null} null when every macroblock was skipped
 */
function encodeChunk(chunk, map, source, reference, plan, qps, scratch) {
  const writer = new BitWriter(),
    predictors = newPredictors();
  let coded = false,
    mvx = 0,
    mvy = 0;
  for (let m = 0; m < CHUNK_MBS; m++) {
    const mb = chunk * CHUNK_MBS + m;
    if (mb >= map.macroblocks) break;
    const mbx = mb % map.blocksX,
      mby = Math.floor(mb / map.blocksX),
      choice = reference ? plan(mb, mbx, mby) : {mode: 'intra'};
    if (choice.mode === 'skip') {
      writer.put(MB_SKIP, 1);
      continue;
    }
    coded = true;
    if (choice.mode === 'inter') {
      writer.put(MB_INTER, 2);
      writer.se(choice.mvx - mvx);
      writer.se(choice.mvy - mvy);
      mvx = choice.mvx;
      mvy = choice.mvy;
      writeInterBlocks(writer, source, reference, mbx, mby, mvx, mvy, qps, scratch);
    } else {
      writer.put(MB_INTRA, 2);
      writeIntraBlocks(writer, source, mbx, mby, qps, predictors, scratch.pixels);
    }
  }
  return coded ? writer : null;
}

/**
 * Plan-driven reference encoder. plan(mb, mbx, mby) returns {mode: 'skip'|'inter'|'intra', mvx,
 * mvy}; a keyframe (no reference) must code every macroblock intra.
 * @param {Frame} source
 * @param {{sequence: number, reference?: Frame | null, referenceSequence?: number, qp: number,
 *   chromaQp?: number, plan?: (mb: number, mbx: number, mby: number) => any}} options
 * @returns {Buffer} the complete slot
 */
function encode(source, {sequence, reference = null, referenceSequence = 0, qp, chromaQp, plan}) {
  const map = layout(source.width, source.height);
  chromaQp ??= Math.min(MAX_QP, qp + 2);
  plan ??= () => ({mode: 'intra'});
  const qps = [qp, chromaQp],
    entries = [],
    stream = new BitWriter(),
    scratch = {
      pixels: new Int32Array(64),
      prediction: new Int32Array(64),
      difference: new Float64Array(64)
    };
  for (let chunk = 0; chunk < map.chunks; chunk++) {
    const writer = encodeChunk(chunk, map, source, reference, plan, qps, scratch);
    if (!writer) continue;
    entries.push((chunk | (stream.length * 2 ** CHUNK_INDEX_BITS)) >>> 0);
    stream.append(writer);
  }
  if (stream.length >= MAX_STREAM_BITS) throw Error('HBV2 stream exceeds the entry offset range');
  const streamWords = Math.ceil(stream.length / 32),
    payloadWords = HEADER_WORDS + entries.length + streamWords;
  const payloadBytes = payloadWords * 4 + 4,
    exchanges = exchangesFor(payloadBytes);
  if (exchanges * EXCHANGE_BYTES > MAX_FRAME_BYTES) throw Error('HBV2 frame exceeds 256 KiB');
  const words = new Uint32Array((exchanges * EXCHANGE_BYTES) / 4);
  words.set([
    MAGIC,
    sequence >>> 0,
    (source.width | (source.height << HEIGHT_SHIFT)) >>> 0,
    payloadBytes,
    reference ? referenceSequence >>> 0 : 0,
    qp | (chromaQp << CHROMA_QP_SHIFT),
    entries.length,
    0
  ]);
  words.set(entries, HEADER_WORDS);
  words.set(stream.words.subarray(0, streamWords), HEADER_WORDS + entries.length);
  words[words.length - 1] = sequence >>> 0;
  return Buffer.from(words.buffer);
}

/**
 * A word view of a slot buffer.
 * @param {Buffer} slot
 * @returns {Uint32Array}
 */
function words(slot) {
  return new Uint32Array(slot.buffer, slot.byteOffset, slot.byteLength >> 2);
}

const glslArray = (name, values, type = 'int') =>
  `const ${type} ${name}[${values.length}] = ${type}[](${values.map(v => (type === 'uint' ? v + 'u' : v)).join(', ')});`;

/** Constants shared with the shader and the C encoder, by their generated names. */
function constants() {
  return {
    HBV2_MAGIC: MAGIC,
    HBV1_MAGIC,
    HBV2_HEADER_WORDS: HEADER_WORDS,
    HBV2_CHUNK_MBS: CHUNK_MBS,
    HBV2_CHUNK_INDEX_BITS: CHUNK_INDEX_BITS,
    HBV2_MAX_WIDTH: MAX_WIDTH,
    HBV2_MAX_HEIGHT: MAX_HEIGHT,
    HBV2_MAX_QP: MAX_QP,
    HBV2_COEFFICIENT_LIMIT: COEFFICIENT_LIMIT,
    HBV2_CATCH_UP: CATCH_UP
  };
}

/**
 * Tables and constants shared with the compute shader.
 * @returns {string}
 */
function glslTables() {
  return [
    '// Generated by tools/moonlight/hbv2.js; edit the generator, not this file.',
    ...Object.entries(constants()).map(([name, value]) => `const uint ${name} = ${value}u;`),
    glslArray('HBV2_ZIGZAG', ZIGZAG, 'uint'),
    glslArray('HBV2_IDCT', IDCT.flat()),
    glslArray('HBV2_QBASE', QBASE),
    glslArray('HBV2_WEIGHT_INTRA', WEIGHT_INTRA),
    ''
  ].join('\n');
}

export {
  MAGIC,
  HBV1_MAGIC,
  HEADER_WORDS,
  EXCHANGE_BYTES,
  CHUNK_MBS,
  CHUNK_INDEX_BITS,
  MAX_CHUNKS,
  MAX_WIDTH,
  MAX_HEIGHT,
  MAX_QP,
  MAX_FRAME_BYTES,
  CATCH_UP,
  ZIGZAG,
  IDCT,
  QBASE,
  WEIGHT_INTRA,
  BitWriter,
  BitReader,
  ueBits,
  seBits,
  step,
  idct,
  forwardDct,
  predict,
  createFrame,
  layout,
  exchangesFor,
  readHeader,
  Decoder,
  toFrame,
  toRgb,
  encode,
  words,
  glslTables
};
