/**
 * HBV1: a fixed-rate, shader-decodable frame format for the Moonlight app.
 *
 * The frame is split into 16x16 macroblocks of exactly nine 32-bit words: four 8x8 luma DCT
 * blocks followed by one 8x8 Cb and one 8x8 Cr DCT block (4:2:0). Every macroblock has the same
 * size, so the fragment shader finds any pixel's data by index arithmetic and evaluates the
 * inverse DCT at its own position. Fields are packed LSB first and may straddle word boundaries.
 *
 * This file is the single source of the format: the GLSL include in src/renderer is generated
 * from it by glsl().
 */

const MAGIC = 0x31564248;
const HEADER_WORDS = 4;
const MACROBLOCK_WORDS = 9;
const EXCHANGE_BYTES = 0x8000;

/** Header word indices; the last word of the slot repeats the sequence as a trailer. */
const HEADER = {magic: 0, sequence: 1, size: 2, payloadBytes: 3};
/** The size word holds the width in its low half and the height in its high half. */
const SIZE_MASK = 0xffff;
const HEIGHT_SHIFT = 16;
const MACROBLOCK_SIZE = 16;
const BLOCK_SIZE = 8;
const BLOCK_PIXELS = BLOCK_SIZE * BLOCK_SIZE;
const LUMA_BLOCKS = 4;
/** Chroma planes are subsampled by this factor in both directions. */
const CHROMA_STEP = 2;

/**
 * Bit allocation of one 8x8 block: an unsigned DC, a per-block scale and the coded AC terms.
 * @typedef {object} BlockSpec
 * @property {number} dcBits
 * @property {number} dcStep
 * @property {number} scaleBits
 * @property {number[][]} ac [u, v, bits, exponent] per coded coefficient
 */

/**
 * AC entries are [u, v, bits, exponent]; a coded value q dequantises to q * 2^(scale + exponent),
 * where scale is per block (luma) or fixed (chroma).
 * @type {{luma: BlockSpec, chroma: BlockSpec}}
 */
const SPEC = {
  luma: {
    dcBits: 8,
    dcStep: 1,
    scaleBits: 3,
    ac: [
      [1, 0, 5, 0],
      [0, 1, 5, 0],
      [0, 2, 4, 0],
      [1, 1, 4, 0],
      [2, 0, 4, 0],
      [3, 0, 3, 0],
      [2, 1, 3, 0],
      [1, 2, 3, 0],
      [0, 3, 3, 0],
      [0, 4, 3, 1],
      [1, 3, 2, 1],
      [2, 2, 2, 1],
      [3, 1, 2, 1],
      [4, 0, 2, 1]
    ]
  },
  chroma: {
    dcBits: 6,
    dcStep: 4,
    scaleBits: 2,
    ac: [
      [1, 0, 6, 2],
      [0, 1, 6, 2],
      [1, 1, 4, 2],
      [2, 0, 4, 2],
      [0, 2, 4, 2]
    ]
  }
};

/** Orthonormal DCT-II scale factor for frequency k. */
const alpha = k => (k === 0 ? Math.sqrt(1 / 8) : 0.5);
/** COS[k][x]: DCT basis cosine for frequency k at sample x. */
const COS = Array.from({length: 8}, (_, k) =>
  Array.from({length: 8}, (_, x) => Math.cos(((2 * x + 1) * k * Math.PI) / 16))
);

/** @param {BlockSpec} block */
function blockBits(block) {
  return block.dcBits + block.scaleBits + block.ac.reduce((sum, [, , bits]) => sum + bits, 0);
}

function clampInt(value, low, high) {
  return Math.min(high, Math.max(low, Math.round(value)));
}

/**
 * Shader-equivalent field extraction from two consecutive uint words.
 * @param {number} lo
 * @param {number} hi
 * @param {number} offset bit offset into lo, 0..31
 * @param {number} bits
 * @returns {number}
 */
function extract(lo, hi, offset, bits) {
  const mask = 2 ** bits - 1;
  if (offset + bits <= 32) return ((lo >>> offset) & mask) >>> 0;
  return (((lo >>> offset) | (hi << (32 - offset))) & mask) >>> 0;
}

/**
 * @param {number} value
 * @param {number} bits
 * @returns {number}
 */
function signExtend(value, bits) {
  return (value << (32 - bits)) >> (32 - bits);
}

function readBits(words, base, offset, bits) {
  const at = base + (offset >>> 5);
  return extract(words[at], words[at + 1] ?? 0, offset & 31, bits);
}

/** Packs fields LSB first into a pre-zeroed word array, starting at word `base`. */
class BitWriter {
  constructor(words, base) {
    this.words = words;
    this.base = base;
    this.offset = 0;
  }
  put(value, bits) {
    const field = (value & (2 ** bits - 1)) >>> 0;
    for (let bit = 0; bit < bits; bit++, this.offset++)
      if ((field >>> bit) & 1)
        this.words[this.base + (this.offset >>> 5)] |= 1 << (this.offset & 31);
  }
}

/**
 * Basis images for the DC and the coded AC positions only; the encoder never needs the other
 * coefficients.
 * @param {BlockSpec} block
 * @returns {Float64Array[]}
 */
function bases(block) {
  return [[0, 0], ...block.ac].map(([u, v]) => {
    const basis = new Float64Array(BLOCK_PIXELS);
    for (let y = 0; y < BLOCK_SIZE; y++)
      for (let x = 0; x < BLOCK_SIZE; x++)
        basis[y * BLOCK_SIZE + x] = alpha(u) * alpha(v) * COS[u][x] * COS[v][y];
    return basis;
  });
}

/** Projects an 8x8 block onto each basis image: the DC followed by the coded AC terms. */
function project(pixels, basisList) {
  return basisList.map(basis => {
    let sum = 0;
    for (let i = 0; i < BLOCK_PIXELS; i++) sum += pixels[i] * basis[i];
    return sum;
  });
}

/**
 * Averages step x step source pixels into each of the 8x8 block's samples, repeating the last
 * row and column past the plane edge.
 */
function gatherBlock(plane, width, height, left, top, step) {
  const block = new Float64Array(BLOCK_PIXELS);
  for (let y = 0; y < BLOCK_SIZE; y++)
    for (let x = 0; x < BLOCK_SIZE; x++) {
      let sum = 0;
      for (let dy = 0; dy < step; dy++)
        for (let dx = 0; dx < step; dx++) {
          const px = Math.min(width - 1, left + x * step + dx),
            py = Math.min(height - 1, top + y * step + dy);
          sum += plane[py * width + px];
        }
      block[y * BLOCK_SIZE + x] = sum / (step * step);
    }
  return block;
}

/**
 * RGB24 to full-resolution BT.601 full-range planes.
 * @param {Uint8Array} rgb
 * @param {number} width
 * @param {number} height
 * @returns {{y: Float32Array, cb: Float32Array, cr: Float32Array}}
 */
function toYCbCr(rgb, width, height) {
  const count = width * height,
    y = new Float32Array(count),
    cb = new Float32Array(count),
    cr = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = rgb[i * 3],
      g = rgb[i * 3 + 1],
      b = rgb[i * 3 + 2];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return {y, cb, cr};
}

function isValidSize(width, height) {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= MACROBLOCK_SIZE &&
    height >= MACROBLOCK_SIZE &&
    !(width % MACROBLOCK_SIZE) &&
    !(height % MACROBLOCK_SIZE) &&
    width <= SIZE_MASK &&
    height <= SIZE_MASK
  );
}

/**
 * Round-to-nearest quantisation clamped to a signed field of `limit` magnitude.
 * @param {number} value
 * @param {number} limit
 * @param {number} step
 */
function quantise(value, limit, step) {
  return Math.min(limit - 1, Math.max(-limit, Math.round(value / step)));
}

/**
 * Per-scale step and range tables, so the scale search does no allocation.
 * @param {BlockSpec} block
 */
function quantiser(block) {
  const scales = 2 ** block.scaleBits;
  return {
    scales,
    limits: block.ac.map(([, , bits]) => 2 ** (bits - 1)),
    steps: Array.from({length: scales}, (_, scale) =>
      block.ac.map(([, , , exponent]) => 2 ** (scale + exponent))
    )
  };
}

/**
 * Builds the codec for a bit allocation. The default SPEC fills a macroblock exactly.
 * @param {{luma: BlockSpec, chroma: BlockSpec}} [spec]
 */
function createFormat(spec = SPEC) {
  const lumaBits = blockBits(spec.luma),
    chromaBits = blockBits(spec.chroma);
  const macroblockBits = LUMA_BLOCKS * lumaBits + 2 * chromaBits;
  if (macroblockBits !== MACROBLOCK_WORDS * 32)
    throw Error(
      `Macroblock allocation is ${macroblockBits} bits, expected ${MACROBLOCK_WORDS * 32}`
    );
  const lumaBases = bases(spec.luma),
    chromaBases = bases(spec.chroma);
  const lumaQuantiser = quantiser(spec.luma),
    chromaQuantiser = quantiser(spec.chroma);
  const cbOffset = LUMA_BLOCKS * lumaBits,
    crOffset = cbOffset + chromaBits;

  /**
   * Slot geometry for a frame size; the slot is padded to whole exchanges.
   * @param {number} width
   * @param {number} height
   */
  function layout(width, height) {
    if (!isValidSize(width, height)) throw Error('HBV1 frame sizes must be multiples of 16');
    const blocksX = width / MACROBLOCK_SIZE,
      blocksY = height / MACROBLOCK_SIZE;
    const usedWords = HEADER_WORDS + blocksX * blocksY * MACROBLOCK_WORDS + 1;
    const exchanges = Math.ceil((usedWords * 4) / EXCHANGE_BYTES);
    const slotWords = (exchanges * EXCHANGE_BYTES) / 4;
    return {
      width,
      height,
      blocksX,
      blocksY,
      trailerWord: slotWords - 1,
      slotWords,
      slotBytes: slotWords * 4,
      exchanges,
      payloadBytes: usedWords * 4
    };
  }

  /** Picks the per-block scale with the least squared coefficient error. */
  function bestScale(coefficients, {scales, limits, steps}) {
    let best = 0,
      bestError = Infinity;
    for (let scale = 0; scale < scales; scale++) {
      const step = steps[scale];
      let error = 0;
      for (let i = 0; i < limits.length; i++) {
        const source = coefficients[i + 1];
        error += (source - quantise(source, limits[i], step[i]) * step[i]) ** 2;
      }
      if (error < bestError) {
        bestError = error;
        best = scale;
      }
    }
    return best;
  }

  function encodeBlock(writer, coefficients, block, blockQuantiser) {
    writer.put(
      clampInt(coefficients[0] / (8 * block.dcStep), 0, 2 ** block.dcBits - 1),
      block.dcBits
    );
    const scale = bestScale(coefficients, blockQuantiser);
    const {limits, steps} = blockQuantiser;
    writer.put(scale, block.scaleBits);
    block.ac.forEach(([, , bits], i) =>
      writer.put(quantise(coefficients[i + 1], limits[i], steps[scale][i]), bits)
    );
  }

  function encodeChroma(writer, plane, width, height, left, top) {
    encodeBlock(
      writer,
      project(gatherBlock(plane, width, height, left, top, CHROMA_STEP), chromaBases),
      spec.chroma,
      chromaQuantiser
    );
  }

  function encodeMacroblock(words, map, planes, mx, my) {
    const {width, height} = map,
      left = mx * MACROBLOCK_SIZE,
      top = my * MACROBLOCK_SIZE;
    const writer = new BitWriter(words, HEADER_WORDS + (my * map.blocksX + mx) * MACROBLOCK_WORDS);
    for (let i = 0; i < LUMA_BLOCKS; i++)
      encodeBlock(
        writer,
        project(
          gatherBlock(
            planes.y,
            width,
            height,
            left + (i & 1) * BLOCK_SIZE,
            top + (i >> 1) * BLOCK_SIZE,
            1
          ),
          lumaBases
        ),
        spec.luma,
        lumaQuantiser
      );
    encodeChroma(writer, planes.cb, width, height, left, top);
    encodeChroma(writer, planes.cr, width, height, left, top);
  }

  /**
   * Encodes one RGB24 frame into a complete slot: header, macroblocks, trailer.
   * @param {Uint8Array} rgb
   * @param {number} width
   * @param {number} height
   * @param {number} sequence
   * @returns {Buffer}
   */
  function encode(rgb, width, height, sequence) {
    const map = layout(width, height),
      words = new Uint32Array(map.slotWords);
    const planes = toYCbCr(rgb, width, height);
    words.set([MAGIC, sequence >>> 0, (width | (height << HEIGHT_SHIFT)) >>> 0, map.payloadBytes]);
    for (let my = 0; my < map.blocksY; my++)
      for (let mx = 0; mx < map.blocksX; mx++) encodeMacroblock(words, map, planes, mx, my);
    words[map.trailerWord] = sequence >>> 0;
    return Buffer.from(words.buffer);
  }

  /**
   * Validates a slot; null unless it is a complete HBV1 frame whose trailer matches.
   * @param {Buffer} slot
   */
  function readHeader(slot) {
    const words = new Uint32Array(slot.buffer, slot.byteOffset, slot.byteLength >> 2);
    if (words[HEADER.magic] !== MAGIC) return null;
    let map;
    try {
      map = layout(words[HEADER.size] & SIZE_MASK, words[HEADER.size] >>> HEIGHT_SHIFT);
    } catch {
      return null;
    }
    if (map.slotBytes > slot.byteLength) return null;
    const sequence = words[HEADER.sequence];
    if (sequence === 0 || sequence !== words[map.trailerWord]) return null;
    return {words, map, sequence};
  }

  /** Evaluates one block's inverse DCT at block-local position (tx, ty). */
  function decodeBlock(words, base, offset, block, tx, ty) {
    let value = readBits(words, base, offset, block.dcBits) * block.dcStep;
    offset += block.dcBits;
    const scale = readBits(words, base, offset, block.scaleBits);
    offset += block.scaleBits;
    for (const [u, v, bits, exponent] of block.ac) {
      const q = signExtend(readBits(words, base, offset, bits), bits);
      offset += bits;
      value +=
        q *
        2 ** (scale + exponent) *
        alpha(u) *
        alpha(v) *
        Math.cos((u * Math.PI * tx) / 8) *
        Math.cos((v * Math.PI * ty) / 8);
    }
    return value;
  }

  /**
   * Per-pixel decode as the fragment shader does it, at continuous source coordinates (sx, sy)
   * in pixels.
   * @returns {number[]} unclamped RGB in 0..255 units
   */
  function samplePixel(words, map, sx, sy) {
    const mx = Math.min(map.blocksX - 1, Math.floor(sx / MACROBLOCK_SIZE)),
      my = Math.min(map.blocksY - 1, Math.floor(sy / MACROBLOCK_SIZE));
    const base = HEADER_WORDS + (my * map.blocksX + mx) * MACROBLOCK_WORDS;
    const lx = sx - mx * MACROBLOCK_SIZE,
      ly = sy - my * MACROBLOCK_SIZE;
    const quadrant = (lx >= BLOCK_SIZE ? 1 : 0) + (ly >= BLOCK_SIZE ? 2 : 0);
    const luma = decodeBlock(
      words,
      base,
      quadrant * lumaBits,
      spec.luma,
      lx - (quadrant & 1) * BLOCK_SIZE,
      ly - (quadrant >> 1) * BLOCK_SIZE
    );
    const cx = lx / CHROMA_STEP,
      cy = ly / CHROMA_STEP;
    const cb = decodeBlock(words, base, cbOffset, spec.chroma, cx, cy) - 128;
    const cr = decodeBlock(words, base, crOffset, spec.chroma, cx, cy) - 128;
    return [luma + 1.402 * cr, luma - 0.344136 * cb - 0.714136 * cr, luma + 1.772 * cb];
  }

  /**
   * Decodes a slot to RGB24, sampling like a fragment shader stretched over the target.
   * @param {Buffer} slot
   * @param {number} [outWidth] defaults to the coded width
   * @param {number} [outHeight] defaults to the coded height
   * @returns {Buffer}
   */
  function decode(slot, outWidth, outHeight) {
    const header = readHeader(slot);
    if (!header) throw Error('Not a complete HBV1 slot');
    const {words, map} = header;
    outWidth ??= map.width;
    outHeight ??= map.height;
    const rgb = Buffer.alloc(outWidth * outHeight * 3),
      fx = map.width / outWidth,
      fy = map.height / outHeight;
    for (let y = 0; y < outHeight; y++)
      for (let x = 0; x < outWidth; x++) {
        const pixel = samplePixel(words, map, (x + 0.5) * fx, (y + 0.5) * fy),
          at = (y * outWidth + x) * 3;
        for (let c = 0; c < 3; c++) rgb[at + c] = clampInt(pixel[c], 0, 255);
      }
    return rgb;
  }

  return {spec, lumaBits, chromaBits, layout, encode, decode, readHeader, samplePixel};
}

/** A GLSL float literal of the single-precision value, always with a '.' or exponent. */
const glslFloat = value => {
  const text = String(Math.fround(value));
  return /[.e]/.test(text) ? text : text + '.0';
};

/** One `value += ...` line per coded AC term of a block. */
function glslTerms(block) {
  return block.ac
    .map(
      ([u, v, bits, exponent]) =>
        `    value += hbvCoefficient(base, offset, ${bits}u, scale + ${exponent}, ${glslFloat(alpha(u) * alpha(v))}) * ` +
        `cos(${u}.0 * HBV_PI * t.x / 8.0) * cos(${v}.0 * HBV_PI * t.y / 8.0);`
    )
    .join('\n');
}

/** A GLSL block decoder mirroring decodeBlock for one block spec. */
function glslBlockDecoder(name, block) {
  return `float ${name}(uint base, uint offset, vec2 t) {
    float value = float(hbvBits(base, offset, ${block.dcBits}u)) * ${glslFloat(block.dcStep)};
    offset += ${block.dcBits}u;
    int scale = int(hbvBits(base, offset, ${block.scaleBits}u));
    offset += ${block.scaleBits}u;
${glslTerms(block)}
    return value;
}`;
}

/**
 * GLSL include mirroring samplePixel. The app defines uint hbvWord(uint) for its storage binding
 * before including the generated file.
 * @param {ReturnType<typeof createFormat>} [format]
 * @returns {string}
 */
function glsl(format = createFormat()) {
  const {spec, lumaBits, chromaBits} = format;
  return `// Generated by tools/moonlight/hbv.js; edit the generator, not this file.
// HBV1 decode. Define uint hbvWord(uint index) before including.
const uint HBV_MAGIC = ${MAGIC}u;
const uint HBV_HEADER_WORDS = ${HEADER_WORDS}u;
const uint HBV_MACROBLOCK_WORDS = ${MACROBLOCK_WORDS}u;
const uint HBV_LUMA_BITS = ${lumaBits}u;
const uint HBV_CHROMA_BITS = ${chromaBits}u;
const float HBV_PI = 3.14159265;

uint hbvBits(uint base, uint offset, uint bits) {
    uint at = base + (offset >> 5), shift = offset & 31u, mask = (1u << bits) - 1u;
    uint lo = hbvWord(at) >> shift;
    if (shift + bits <= 32u) return lo & mask;
    return (lo | (hbvWord(at + 1u) << (32u - shift))) & mask;
}

float hbvCoefficient(uint base, inout uint offset, uint bits, int exponent, float weight) {
    uint raw = hbvBits(base, offset, bits);
    offset += bits;
    int q = int(raw << (32u - bits)) >> int(32u - bits);
    return float(q) * exp2(float(exponent)) * weight;
}

${glslBlockDecoder('hbvLumaBlock', spec.luma)}

${glslBlockDecoder('hbvChromaBlock', spec.chroma)}

// slot: first word of a complete slot. s: source pixel position (continuous).
vec3 hbvSample(uint slot, vec2 s) {
    uint size = hbvWord(slot + 2u);
    uvec2 blocks = uvec2(size & 0xffffu, size >> 16) / 16u;
    uvec2 m = min(uvec2(s / 16.0), blocks - 1u);
    uint base = slot + HBV_HEADER_WORDS + (m.y * blocks.x + m.x) * HBV_MACROBLOCK_WORDS;
    vec2 l = s - vec2(m) * 16.0;
    uvec2 q = uvec2(greaterThanEqual(l, vec2(8.0)));
    float luma = hbvLumaBlock(base, (q.x + q.y * 2u) * HBV_LUMA_BITS, l - vec2(q) * 8.0);
    float cb = hbvChromaBlock(base, 4u * HBV_LUMA_BITS, l / 2.0) - 128.0;
    float cr = hbvChromaBlock(base, 4u * HBV_LUMA_BITS + HBV_CHROMA_BITS, l / 2.0) - 128.0;
    vec3 rgb = vec3(luma + 1.402 * cr, luma - 0.344136 * cb - 0.714136 * cr, luma + 1.772 * cb);
    return clamp(rgb / 255.0, 0.0, 1.0);
}
`;
}

const {spec, lumaBits, chromaBits, layout, encode, decode, readHeader, samplePixel} =
  createFormat();
export {
  MAGIC,
  HEADER_WORDS,
  MACROBLOCK_WORDS,
  EXCHANGE_BYTES,
  SPEC,
  createFormat,
  glsl,
  extract,
  signExtend,
  toYCbCr,
  spec,
  lumaBits,
  chromaBits,
  layout,
  encode,
  decode,
  readHeader,
  samplePixel
};
