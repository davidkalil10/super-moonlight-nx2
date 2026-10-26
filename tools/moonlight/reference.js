/**
 * Comparison formats for HBV1 and the shared image metrics. BC1 and planar YUV 4:2:0 are decoded
 * the way a fragment shader would read them from a storage buffer (no texture units), and
 * upscaled with manual bilinear taps.
 */

const BC1_BLOCK_SIZE = 4;
const BC1_BLOCK_BYTES = 8;
/** Power-iteration steps when estimating the principal colour axis. */
const AXIS_ITERATIONS = 8;
/** Endpoints are pulled in by this fraction of the projected range on each side. */
const ENDPOINT_INSET = 1 / 16;
/** PSNR reported for identical images. */
const IDENTICAL_PSNR = 99;

function clampByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** RGB to a packed RGB565 endpoint. */
function to565(r, g, b) {
  return ((clampByte(r) >> 3) << 11) | ((clampByte(g) >> 2) << 5) | (clampByte(b) >> 3);
}

function from565(value) {
  const r = (value >> 11) & 31,
    g = (value >> 5) & 63,
    b = value & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/** The four-colour palette used when c0 > c1. */
function bc1Palette(c0, c1) {
  const a = from565(c0),
    b = from565(c1);
  return [a, b, a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)];
}

/** The three-colour palette (plus black) used when c0 <= c1. */
function threeColorPalette(c0, c1) {
  const a = from565(c0),
    b = from565(c1);
  return [a, b, a.map((v, i) => (v + b[i]) / 2), [0, 0, 0]];
}

/**
 * Principal-axis endpoints, one least-squares-free pass. Good enough to rank formats; a
 * production encoder (e.g. squish cluster fit) gains about 1 dB.
 * @param {number[][]} pixels 16 RGB triples in raster order
 * @returns {{c0: number, c1: number, indices: number}}
 */
function encodeBc1Block(pixels) {
  const mean = [0, 1, 2].map(c => pixels.reduce((sum, p) => sum + p[c], 0) / 16);
  let axis = [1, 1, 1];
  const cov = [0, 1, 2].map(i =>
    [0, 1, 2].map(j => pixels.reduce((s, p) => s + (p[i] - mean[i]) * (p[j] - mean[j]), 0))
  );
  for (let k = 0; k < AXIS_ITERATIONS; k++) {
    const next = [0, 1, 2].map(
      i => cov[i][0] * axis[0] + cov[i][1] * axis[1] + cov[i][2] * axis[2]
    );
    const norm = Math.hypot(...next);
    if (norm < 1e-9) break;
    axis = next.map(v => v / norm);
  }
  const project = p =>
    (p[0] - mean[0]) * axis[0] + (p[1] - mean[1]) * axis[1] + (p[2] - mean[2]) * axis[2];
  let low = Infinity,
    high = -Infinity;
  for (const p of pixels) {
    const t = project(p);
    low = Math.min(low, t);
    high = Math.max(high, t);
  }
  const inset = (high - low) * ENDPOINT_INSET;
  low += inset;
  high -= inset;
  let c0 = to565(...mean.map((m, i) => m + axis[i] * high)),
    c1 = to565(...mean.map((m, i) => m + axis[i] * low));
  if (c0 < c1) [c0, c1] = [c1, c0];
  if (c0 === c1) return {c0, c1, indices: 0};
  const palette = bc1Palette(c0, c1);
  let indices = 0;
  pixels.forEach((p, i) => {
    let best = 0,
      bestError = Infinity;
    palette.forEach((q, j) => {
      const error = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (error < bestError) {
        bestError = error;
        best = j;
      }
    });
    indices |= best << (i * 2);
  });
  return {c0, c1, indices: indices >>> 0};
}

/** Edge-clamped 4x4 block of RGB triples at block (bx, by). */
function bc1Pixels(rgb, width, height, bx, by) {
  const pixels = [];
  for (let y = 0; y < BC1_BLOCK_SIZE; y++)
    for (let x = 0; x < BC1_BLOCK_SIZE; x++) {
      const at =
        (Math.min(height - 1, by * BC1_BLOCK_SIZE + y) * width +
          Math.min(width - 1, bx * BC1_BLOCK_SIZE + x)) *
        3;
      pixels.push([rgb[at], rgb[at + 1], rgb[at + 2]]);
    }
  return pixels;
}

/** BC1 (DXT1): 4x4 blocks of two RGB565 endpoints and 2-bit indices. */
const bc1 = {
  name: 'BC1',
  bytes: (width, height) =>
    Math.ceil(width / BC1_BLOCK_SIZE) * Math.ceil(height / BC1_BLOCK_SIZE) * BC1_BLOCK_BYTES,
  encode(rgb, width, height) {
    const blocksX = Math.ceil(width / BC1_BLOCK_SIZE),
      blocksY = Math.ceil(height / BC1_BLOCK_SIZE),
      out = Buffer.alloc(blocksX * blocksY * BC1_BLOCK_BYTES);
    for (let by = 0; by < blocksY; by++)
      for (let bx = 0; bx < blocksX; bx++) {
        const {c0, c1, indices} = encodeBc1Block(bc1Pixels(rgb, width, height, bx, by)),
          at = (by * blocksX + bx) * BC1_BLOCK_BYTES;
        out.writeUInt16LE(c0, at);
        out.writeUInt16LE(c1, at + 2);
        out.writeUInt32LE(indices, at + 4);
      }
    return out;
  },
  decode(data, width, height) {
    const blocksX = Math.ceil(width / BC1_BLOCK_SIZE),
      rgb = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = ((y >> 2) * blocksX + (x >> 2)) * BC1_BLOCK_BYTES;
        const c0 = data.readUInt16LE(at),
          c1 = data.readUInt16LE(at + 2);
        const index = (data.readUInt32LE(at + 4) >>> (((y & 3) * 4 + (x & 3)) * 2)) & 3;
        const color = c0 > c1 ? bc1Palette(c0, c1)[index] : threeColorPalette(c0, c1)[index];
        color.forEach((v, c) => {
          rgb[(y * width + x) * 3 + c] = clampByte(v);
        });
      }
    return rgb;
  }
};

/** Planar YUV 4:2:0: a full luma plane, then the Cb and Cr planes at half size. */
const yuv420 = {
  name: 'YUV420',
  bytes: (width, height) => width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2),
  encode(rgb, width, height) {
    const cw = Math.ceil(width / 2),
      ch = Math.ceil(height / 2),
      out = Buffer.alloc(this.bytes(width, height));
    const plane = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const r = rgb[i * 3],
        g = rgb[i * 3 + 1],
        b = rgb[i * 3 + 2];
      out[i] = clampByte(0.299 * r + 0.587 * g + 0.114 * b);
      plane[i * 3] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      plane[i * 3 + 1] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++)
        for (let c = 0; c < 2; c++) {
          let sum = 0;
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++)
              sum +=
                plane[
                  (Math.min(height - 1, y * 2 + dy) * width + Math.min(width - 1, x * 2 + dx)) * 3 +
                    c
                ];
          out[width * height + c * cw * ch + y * cw + x] = clampByte(sum / 4);
        }
    return out;
  },
  decode(data, width, height) {
    const cw = Math.ceil(width / 2),
      ch = Math.ceil(height / 2),
      rgb = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const luma = data[y * width + x],
          at = width * height + (y >> 1) * cw + (x >> 1);
        const cb = data[at] - 128,
          cr = data[at + cw * ch] - 128,
          o = (y * width + x) * 3;
        rgb[o] = clampByte(luma + 1.402 * cr);
        rgb[o + 1] = clampByte(luma - 0.344136 * cb - 0.714136 * cr);
        rgb[o + 2] = clampByte(luma + 1.772 * cb);
      }
    return rgb;
  }
};

/**
 * Bilinear RGB24 resize with edge clamping; returns the input unchanged at equal size.
 * @param {Buffer} rgb
 * @param {number} width
 * @param {number} height
 * @param {number} outWidth
 * @param {number} outHeight
 * @returns {Buffer}
 */
function bilinear(rgb, width, height, outWidth, outHeight) {
  if (width === outWidth && height === outHeight) return rgb;
  const out = Buffer.alloc(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(height - 1, Math.max(0, ((y + 0.5) * height) / outHeight - 0.5));
    const y0 = Math.floor(sy),
      y1 = Math.min(height - 1, y0 + 1),
      fy = sy - y0;
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(width - 1, Math.max(0, ((x + 0.5) * width) / outWidth - 0.5));
      const x0 = Math.floor(sx),
        x1 = Math.min(width - 1, x0 + 1),
        fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const top = rgb[(y0 * width + x0) * 3 + c] * (1 - fx) + rgb[(y0 * width + x1) * 3 + c] * fx;
        const bottom =
          rgb[(y1 * width + x0) * 3 + c] * (1 - fx) + rgb[(y1 * width + x1) * 3 + c] * fx;
        out[(y * outWidth + x) * 3 + c] = clampByte(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

/**
 * Peak signal-to-noise ratio in dB over all bytes; 99 when identical.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {number}
 */
function psnr(a, b) {
  if (a.length !== b.length) throw Error('Image sizes differ');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  const mse = sum / a.length;
  return mse === 0 ? IDENTICAL_PSNR : 10 * Math.log10((255 * 255) / mse);
}

/**
 * Fraction of fixed-size blocks whose encoded bytes changed since the last frame.
 * @param {Buffer | null | undefined} previous
 * @param {Buffer} current
 * @param {number} blockBytes
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number}
 */
function changedFraction(previous, current, blockBytes, start = 0, end = current.length) {
  if (!previous) return 1;
  let changed = 0,
    total = 0;
  for (let at = start; at + blockBytes <= end; at += blockBytes, total++)
    if (previous.compare(current, at, at + blockBytes, at, at + blockBytes) !== 0) changed++;
  return changed / total;
}

export {bc1, yuv420, bilinear, psnr, changedFraction};
