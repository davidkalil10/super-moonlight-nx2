// Comparison formats for HBV1 and the shared image metrics. BC1 and planar
// YUV 4:2:0 are decoded the way a fragment shader would read them from a
// storage buffer (no texture units), and upscaled with manual bilinear taps.

function clampByte(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function to565(r, g, b) {
  return (clampByte(r) >> 3 << 11) | (clampByte(g) >> 2 << 5) | (clampByte(b) >> 3);
}

function from565(value) {
  const r = (value >> 11) & 31, g = (value >> 5) & 63, b = value & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function bc1Palette(c0, c1) {
  const a = from565(c0), b = from565(c1);
  return [a, b, a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3)];
}

function threeColorPalette(c0, c1) {
  const a = from565(c0), b = from565(c1);
  return [a, b, a.map((v, i) => (v + b[i]) / 2), [0, 0, 0]];
}

// Principal-axis endpoints, one least-squares-free pass. Good enough to rank
// formats; a production encoder (e.g. squish cluster fit) gains about 1 dB.
function encodeBc1Block(pixels) {
  const mean = [0, 1, 2].map(c => pixels.reduce((sum, p) => sum + p[c], 0) / 16);
  let axis = [1, 1, 1];
  const cov = [0, 1, 2].map(i => [0, 1, 2].map(j => pixels.reduce((s, p) => s + (p[i] - mean[i]) * (p[j] - mean[j]), 0)));
  for (let k = 0; k < 8; k++) {
    const next = [0, 1, 2].map(i => cov[i][0] * axis[0] + cov[i][1] * axis[1] + cov[i][2] * axis[2]);
    const norm = Math.hypot(...next);
    if (norm < 1e-9) break;
    axis = next.map(v => v / norm);
  }
  const project = p => (p[0] - mean[0]) * axis[0] + (p[1] - mean[1]) * axis[1] + (p[2] - mean[2]) * axis[2];
  let low = Infinity, high = -Infinity;
  for (const p of pixels) { const t = project(p); low = Math.min(low, t); high = Math.max(high, t); }
  const inset = (high - low) / 16;
  low += inset; high -= inset;
  let c0 = to565(...mean.map((m, i) => m + axis[i] * high)), c1 = to565(...mean.map((m, i) => m + axis[i] * low));
  if (c0 < c1) [c0, c1] = [c1, c0];
  if (c0 === c1) return {c0, c1, indices: 0};
  const palette = bc1Palette(c0, c1);
  let indices = 0;
  pixels.forEach((p, i) => {
    let best = 0, bestError = Infinity;
    palette.forEach((q, j) => {
      const error = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (error < bestError) { bestError = error; best = j; }
    });
    indices |= best << (i * 2);
  });
  return {c0, c1, indices: indices >>> 0};
}

const bc1 = {
  name: 'BC1',
  bytes: (width, height) => Math.ceil(width / 4) * Math.ceil(height / 4) * 8,
  encode(rgb, width, height) {
    const blocksX = Math.ceil(width / 4), blocksY = Math.ceil(height / 4), out = Buffer.alloc(blocksX * blocksY * 8);
    for (let by = 0; by < blocksY; by++)
      for (let bx = 0; bx < blocksX; bx++) {
        const pixels = [];
        for (let y = 0; y < 4; y++)
          for (let x = 0; x < 4; x++) {
            const at = (Math.min(height - 1, by * 4 + y) * width + Math.min(width - 1, bx * 4 + x)) * 3;
            pixels.push([rgb[at], rgb[at + 1], rgb[at + 2]]);
          }
        const {c0, c1, indices} = encodeBc1Block(pixels), at = (by * blocksX + bx) * 8;
        out.writeUInt16LE(c0, at); out.writeUInt16LE(c1, at + 2); out.writeUInt32LE(indices, at + 4);
      }
    return out;
  },
  decode(data, width, height) {
    const blocksX = Math.ceil(width / 4), rgb = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = ((y >> 2) * blocksX + (x >> 2)) * 8;
        const c0 = data.readUInt16LE(at), c1 = data.readUInt16LE(at + 2);
        const index = (data.readUInt32LE(at + 4) >>> (((y & 3) * 4 + (x & 3)) * 2)) & 3;
        const color = c0 > c1 ? bc1Palette(c0, c1)[index] : threeColorPalette(c0, c1)[index];
        color.forEach((v, c) => { rgb[(y * width + x) * 3 + c] = clampByte(v); });
      }
    return rgb;
  },
};

const yuv420 = {
  name: 'YUV420',
  bytes: (width, height) => width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2),
  encode(rgb, width, height) {
    const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2), out = Buffer.alloc(this.bytes(width, height));
    const plane = new Float32Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
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
              sum += plane[(Math.min(height - 1, y * 2 + dy) * width + Math.min(width - 1, x * 2 + dx)) * 3 + c];
          out[width * height + c * cw * ch + y * cw + x] = clampByte(sum / 4);
        }
    return out;
  },
  decode(data, width, height) {
    const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2), rgb = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const luma = data[y * width + x], at = width * height + (y >> 1) * cw + (x >> 1);
        const cb = data[at] - 128, cr = data[at + cw * ch] - 128, o = (y * width + x) * 3;
        rgb[o] = clampByte(luma + 1.402 * cr);
        rgb[o + 1] = clampByte(luma - 0.344136 * cb - 0.714136 * cr);
        rgb[o + 2] = clampByte(luma + 1.772 * cb);
      }
    return rgb;
  },
};

function bilinear(rgb, width, height, outWidth, outHeight) {
  if (width === outWidth && height === outHeight) return rgb;
  const out = Buffer.alloc(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) * height / outHeight - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) * width / outWidth - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const top = rgb[(y0 * width + x0) * 3 + c] * (1 - fx) + rgb[(y0 * width + x1) * 3 + c] * fx;
        const bottom = rgb[(y1 * width + x0) * 3 + c] * (1 - fx) + rgb[(y1 * width + x1) * 3 + c] * fx;
        out[(y * outWidth + x) * 3 + c] = clampByte(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return out;
}

function psnr(a, b) {
  if (a.length !== b.length) throw Error('Image sizes differ');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  const mse = sum / a.length;
  return mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
}

// Fraction of fixed-size blocks whose encoded bytes changed since the last frame.
function changedFraction(previous, current, blockBytes, start = 0, end = current.length) {
  if (!previous) return 1;
  let changed = 0, total = 0;
  for (let at = start; at + blockBytes <= end; at += blockBytes, total++)
    if (previous.compare(current, at, at + blockBytes, at, at + blockBytes) !== 0) changed++;
  return changed / total;
}

module.exports = {bc1, yuv420, bilinear, psnr, changedFraction};
