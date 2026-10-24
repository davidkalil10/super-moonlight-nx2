// HBV1: a fixed-rate, shader-decodable frame format for the Moonlight app.
//
// The frame is split into 16x16 macroblocks of exactly nine 32-bit words:
// four 8x8 luma DCT blocks followed by one 8x8 Cb and one 8x8 Cr DCT block
// (4:2:0). Every macroblock has the same size, so the fragment shader finds
// any pixel's data by index arithmetic and evaluates the inverse DCT at its
// own position. Fields are packed LSB first and may straddle word boundaries.
// This file is the single source of the format: the GLSL include in
// apps/moonlight is generated from it by glsl().

const MAGIC = 0x31564248;
const HEADER_WORDS = 4;
const MACROBLOCK_WORDS = 9;
const EXCHANGE_BYTES = 0x8000;

// AC entries are [u, v, bits, exponent]; a coded value q dequantises to
// q * 2^(scale + exponent), where scale is per block (luma) or fixed (chroma).
const SPEC = {
  luma: {dcBits: 8, dcStep: 1, scaleBits: 3, ac: [
    [1, 0, 5, 0], [0, 1, 5, 0], [0, 2, 4, 0], [1, 1, 4, 0], [2, 0, 4, 0],
    [3, 0, 3, 0], [2, 1, 3, 0], [1, 2, 3, 0], [0, 3, 3, 0], [0, 4, 3, 1],
    [1, 3, 2, 1], [2, 2, 2, 1], [3, 1, 2, 1], [4, 0, 2, 1],
  ]},
  chroma: {dcBits: 6, dcStep: 4, scaleBits: 2, ac: [
    [1, 0, 6, 2], [0, 1, 6, 2], [1, 1, 4, 2], [2, 0, 4, 2], [0, 2, 4, 2],
  ]},
};

const alpha = k => (k === 0 ? Math.sqrt(1 / 8) : 0.5);
const COS = Array.from({length: 8}, (_, k) => Array.from({length: 8}, (_, x) => Math.cos((2 * x + 1) * k * Math.PI / 16)));

function blockBits(block) {
  return block.dcBits + block.scaleBits + block.ac.reduce((sum, [, , bits]) => sum + bits, 0);
}

function clampInt(value, low, high) {
  return Math.min(high, Math.max(low, Math.round(value)));
}

// Shader-equivalent field extraction from two consecutive uint words.
function extract(lo, hi, offset, bits) {
  const mask = (2 ** bits) - 1;
  if (offset + bits <= 32) return ((lo >>> offset) & mask) >>> 0;
  return (((lo >>> offset) | (hi << (32 - offset))) & mask) >>> 0;
}

function signExtend(value, bits) {
  return (value << (32 - bits)) >> (32 - bits);
}

function readBits(words, base, offset, bits) {
  const at = base + (offset >>> 5);
  return extract(words[at], words[at + 1] ?? 0, offset & 31, bits);
}

class BitWriter {
  constructor(words, base) { this.words = words; this.base = base; this.offset = 0; }
  put(value, bits) {
    const field = (value & ((2 ** bits) - 1)) >>> 0;
    for (let bit = 0; bit < bits; bit++, this.offset++)
      if ((field >>> bit) & 1) this.words[this.base + (this.offset >>> 5)] |= 1 << (this.offset & 31);
  }
}

// Basis images for the DC and the coded AC positions only; the encoder never
// needs the other coefficients.
function bases(block) {
  return [[0, 0], ...block.ac].map(([u, v]) => {
    const basis = new Float64Array(64);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) basis[y * 8 + x] = alpha(u) * alpha(v) * COS[u][x] * COS[v][y];
    return basis;
  });
}

function project(pixels, basisList) {
  return basisList.map(basis => {
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += pixels[i] * basis[i];
    return sum;
  });
}

function gatherBlock(plane, width, height, left, top, step) {
  const block = new Float64Array(64);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let dy = 0; dy < step; dy++)
        for (let dx = 0; dx < step; dx++) {
          const px = Math.min(width - 1, left + x * step + dx), py = Math.min(height - 1, top + y * step + dy);
          sum += plane[py * width + px];
        }
      block[y * 8 + x] = sum / (step * step);
    }
  return block;
}

function toYCbCr(rgb, width, height) {
  const count = width * height, y = new Float32Array(count), cb = new Float32Array(count), cr = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return {y, cb, cr};
}

function createFormat(spec = SPEC) {
  const lumaBits = blockBits(spec.luma), chromaBits = blockBits(spec.chroma);
  if (4 * lumaBits + 2 * chromaBits !== MACROBLOCK_WORDS * 32)
    throw Error(`Macroblock allocation is ${4 * lumaBits + 2 * chromaBits} bits, expected ${MACROBLOCK_WORDS * 32}`);
  const lumaBases = bases(spec.luma), chromaBases = bases(spec.chroma);
  const lumaQuantiser = quantiser(spec.luma), chromaQuantiser = quantiser(spec.chroma);

  function layout(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 ||
        width % 16 || height % 16 || width > 0xffff || height > 0xffff)
      throw Error('HBV1 frame sizes must be multiples of 16');
    const blocksX = width / 16, blocksY = height / 16;
    const usedWords = HEADER_WORDS + blocksX * blocksY * MACROBLOCK_WORDS + 1;
    const exchanges = Math.ceil(usedWords * 4 / EXCHANGE_BYTES);
    const slotWords = exchanges * EXCHANGE_BYTES / 4;
    return {width, height, blocksX, blocksY, trailerWord: slotWords - 1, slotWords,
      slotBytes: slotWords * 4, exchanges, payloadBytes: usedWords * 4};
  }

  function quantise(value, limit, step) {
    return Math.min(limit - 1, Math.max(-limit, Math.round(value / step)));
  }

  // Per-scale step and range tables, so the scale search does no allocation.
  function quantiser(block) {
    const scales = 2 ** block.scaleBits;
    return {scales, limits: block.ac.map(([, , bits]) => 2 ** (bits - 1)),
      steps: Array.from({length: scales}, (_, scale) => block.ac.map(([, , , exponent]) => 2 ** (scale + exponent)))};
  }

  // Picks the per-block scale with the least squared coefficient error.
  function encodeBlock(writer, coefficients, block, {scales, limits, steps}) {
    writer.put(clampInt(coefficients[0] / (8 * block.dcStep), 0, 2 ** block.dcBits - 1), block.dcBits);
    let bestScale = 0, bestError = Infinity;
    for (let scale = 0; scale < scales; scale++) {
      const step = steps[scale];
      let error = 0;
      for (let i = 0; i < limits.length; i++) {
        const source = coefficients[i + 1];
        error += (source - quantise(source, limits[i], step[i]) * step[i]) ** 2;
      }
      if (error < bestError) { bestError = error; bestScale = scale; }
    }
    writer.put(bestScale, block.scaleBits);
    block.ac.forEach(([, , bits], i) => writer.put(quantise(coefficients[i + 1], limits[i], steps[bestScale][i]), bits));
  }

  // Encodes one RGB24 frame into a complete slot: header, macroblocks, trailer.
  function encode(rgb, width, height, sequence) {
    const map = layout(width, height), words = new Uint32Array(map.slotWords);
    const {y, cb, cr} = toYCbCr(rgb, width, height);
    words.set([MAGIC, sequence >>> 0, (width | (height << 16)) >>> 0, map.payloadBytes]);
    for (let my = 0; my < map.blocksY; my++)
      for (let mx = 0; mx < map.blocksX; mx++) {
        const writer = new BitWriter(words, HEADER_WORDS + (my * map.blocksX + mx) * MACROBLOCK_WORDS);
        for (let i = 0; i < 4; i++)
          encodeBlock(writer, project(gatherBlock(y, width, height, mx * 16 + (i & 1) * 8, my * 16 + (i >> 1) * 8, 1), lumaBases), spec.luma, lumaQuantiser);
        encodeBlock(writer, project(gatherBlock(cb, width, height, mx * 16, my * 16, 2), chromaBases), spec.chroma, chromaQuantiser);
        encodeBlock(writer, project(gatherBlock(cr, width, height, mx * 16, my * 16, 2), chromaBases), spec.chroma, chromaQuantiser);
      }
    words[map.trailerWord] = sequence >>> 0;
    return Buffer.from(words.buffer);
  }

  function readHeader(slot) {
    const words = new Uint32Array(slot.buffer, slot.byteOffset, slot.byteLength >> 2);
    if (words[0] !== MAGIC) return null;
    let map;
    try { map = layout(words[2] & 0xffff, words[2] >>> 16); } catch { return null; }
    if (map.slotBytes > slot.byteLength) return null;
    if (words[1] === 0 || words[1] !== words[map.trailerWord]) return null;
    return {words, map, sequence: words[1]};
  }

  function decodeBlock(words, base, offset, block, tx, ty) {
    let value = readBits(words, base, offset, block.dcBits) * block.dcStep;
    offset += block.dcBits;
    const scale = readBits(words, base, offset, block.scaleBits);
    offset += block.scaleBits;
    for (const [u, v, bits, exponent] of block.ac) {
      const q = signExtend(readBits(words, base, offset, bits), bits);
      offset += bits;
      value += q * 2 ** (scale + exponent) * alpha(u) * alpha(v) *
        Math.cos(u * Math.PI * tx / 8) * Math.cos(v * Math.PI * ty / 8);
    }
    return value;
  }

  // Per-pixel decode as the fragment shader does it, at continuous source
  // coordinates (sx, sy) in pixels. Returns unclamped RGB in 0..255 units.
  function samplePixel(words, map, sx, sy) {
    const mx = Math.min(map.blocksX - 1, Math.floor(sx / 16)), my = Math.min(map.blocksY - 1, Math.floor(sy / 16));
    const base = HEADER_WORDS + (my * map.blocksX + mx) * MACROBLOCK_WORDS;
    const lx = sx - mx * 16, ly = sy - my * 16;
    const quadrant = (lx >= 8 ? 1 : 0) + (ly >= 8 ? 2 : 0);
    const luma = decodeBlock(words, base, quadrant * lumaBits, spec.luma, lx - (quadrant & 1) * 8, ly - (quadrant >> 1) * 8);
    const cb = decodeBlock(words, base, 4 * lumaBits, spec.chroma, lx / 2, ly / 2) - 128;
    const cr = decodeBlock(words, base, 4 * lumaBits + chromaBits, spec.chroma, lx / 2, ly / 2) - 128;
    return [luma + 1.402 * cr, luma - 0.344136 * cb - 0.714136 * cr, luma + 1.772 * cb];
  }

  // Decodes a slot to RGB24 at outWidth x outHeight (default: coded size),
  // sampling like a fragment shader stretched over that target.
  function decode(slot, outWidth, outHeight) {
    const header = readHeader(slot);
    if (!header) throw Error('Not a complete HBV1 slot');
    const {words, map} = header;
    outWidth ??= map.width; outHeight ??= map.height;
    const rgb = Buffer.alloc(outWidth * outHeight * 3), fx = map.width / outWidth, fy = map.height / outHeight;
    for (let y = 0; y < outHeight; y++)
      for (let x = 0; x < outWidth; x++) {
        const pixel = samplePixel(words, map, (x + 0.5) * fx, (y + 0.5) * fy), at = (y * outWidth + x) * 3;
        for (let c = 0; c < 3; c++) rgb[at + c] = clampInt(pixel[c], 0, 255);
      }
    return rgb;
  }

  return {spec, lumaBits, chromaBits, layout, encode, decode, readHeader, samplePixel};
}

const glslFloat = value => {
  const text = String(Math.fround(value));
  return /[.e]/.test(text) ? text : text + '.0';
};

// GLSL include mirroring samplePixel. The app defines uint hbvWord(uint)
// for its storage binding before including the generated file.
function glsl(format = createFormat()) {
  const {spec, lumaBits, chromaBits} = format;
  const terms = block => block.ac.map(([u, v, bits, exponent]) =>
    `    value += hbvCoefficient(base, offset, ${bits}u, scale + ${exponent}, ${glslFloat(alpha(u) * alpha(v))}) * ` +
    `cos(${u}.0 * HBV_PI * t.x / 8.0) * cos(${v}.0 * HBV_PI * t.y / 8.0);`).join('\n');
  const decoder = (name, block) => `float ${name}(uint base, uint offset, vec2 t) {
    float value = float(hbvBits(base, offset, ${block.dcBits}u)) * ${glslFloat(block.dcStep)};
    offset += ${block.dcBits}u;
    int scale = int(hbvBits(base, offset, ${block.scaleBits}u));
    offset += ${block.scaleBits}u;
${terms(block)}
    return value;
}`;
  return `// Generated by tools/moonlight/hbv.cjs; edit the generator, not this file.
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

${decoder('hbvLumaBlock', spec.luma)}

${decoder('hbvChromaBlock', spec.chroma)}

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

const format = createFormat();
module.exports = {MAGIC, HEADER_WORDS, MACROBLOCK_WORDS, EXCHANGE_BYTES, SPEC, createFormat, glsl,
  extract, signExtend, toYCbCr, ...format};
