// The picture geometry and colour both video fragment shaders share. Each defines lumaAt and
// chromaAt (byte offsets from FRAMES_OFFSET) before including this.
layout(location = 0) flat in uint slot;
layout(location = 0) out vec4 color;

uint slotWord(uint field) { return word(VIDEO_BASE + slot * VIDEO_SLOT_WORDS + field); }

vec2 bilinear(vec2 s, uvec2 size, out ivec4 corners) {
  vec2 q = s - 0.5;
  ivec2 i = ivec2(floor(q)), last = ivec2(size) - 1;
  corners = ivec4(clamp(i, ivec2(0), last), clamp(i + 1, ivec2(0), last));
  return q - floor(q);
}

float lanczos2(float x) {
  x = abs(x);
  if (x < 1e-4)
    return 1.0;
  if (x >= 2.0)
    return 0.0;
  float px = 3.14159265 * x;
  return 2.0 * sin(px) * sin(px * 0.5) / (px * px);
}

// Lanczos-2 over four by four luma taps clamped to the picture, kept inside the range of the
// centre 2x2.
float lumaLanczos(uint base, uint stride, uvec2 size, vec2 s) {
  vec2 q = s - 0.5;
  ivec2 low = ivec2(floor(q)), last = ivec2(size) - 1;
  vec2 f = q - floor(q);
  float wx[4], wy[4];
  float sumX = 0.0, sumY = 0.0;
  for (int i = 0; i < 4; i++) {
    wx[i] = lanczos2(f.x - float(i - 1));
    wy[i] = lanczos2(f.y - float(i - 1));
    sumX += wx[i];
    sumY += wy[i];
  }
  float sum = 0.0, lo = 1e9, hi = -1e9;
  for (int y = 0; y < 4; y++) {
    uint row = base + uint(clamp(low.y + y - 1, 0, last.y)) * stride;
    for (int x = 0; x < 4; x++) {
      float tap = lumaAt(row + uint(clamp(low.x + x - 1, 0, last.x)));
      sum += tap * (wx[x] / sumX) * (wy[y] / sumY);
      if ((x == 1 || x == 2) && (y == 1 || y == 2)) {
        lo = min(lo, tap);
        hi = max(hi, tap);
      }
    }
  }
  return clamp(sum, lo, hi);
}

float lumaSample(uint base, uint stride, uvec2 size, vec2 s) {
  uint filterMode = word(UI_FILTER);
  if (filterMode == 3u)
    return lumaLanczos(base, stride, size, s);
  if (filterMode == 1u) {
    ivec2 at = clamp(ivec2(floor(s)), ivec2(0), ivec2(size) - 1);
    return lumaAt(base + uint(at.y) * stride + uint(at.x));
  }
  ivec4 c;
  vec2 f = bilinear(s, size, c);
  uint r0 = base + uint(c.y) * stride, r1 = base + uint(c.w) * stride;
  return mix(mix(lumaAt(r0 + uint(c.x)), lumaAt(r0 + uint(c.z)), f.x),
             mix(lumaAt(r1 + uint(c.x)), lumaAt(r1 + uint(c.z)), f.x), f.y);
}

vec2 chromaSample(uint base, uint stride, uvec2 size, vec2 s) {
  ivec4 c;
  vec2 f = bilinear(s, size, c);
  uint r0 = base + uint(c.y) * stride, r1 = base + uint(c.w) * stride;
  return mix(mix(chromaAt(r0 + uint(c.x) * 2u), chromaAt(r0 + uint(c.z) * 2u), f.x),
             mix(chromaAt(r1 + uint(c.x) * 2u), chromaAt(r1 + uint(c.z) * 2u), f.x), f.y);
}

vec3 toRgb(float luma, vec2 chroma) {
  float y = (luma - 16.0) / 219.0;
  float u = (chroma.x - 128.0) / 224.0, v = (chroma.y - 128.0) / 224.0;
  if (slotWord(SLOT_COLOR) == 1u)
    return vec3(y + 1.5748 * v, y - 0.187324 * u - 0.468124 * v, y + 1.8556 * u);
  return vec3(y + 1.402 * v, y - 0.344136 * u - 0.714136 * v, y + 1.772 * u);
}

void main() {
  if (any(greaterThanEqual(gl_FragCoord.xy, targetSize()))) discard;
  uvec2 size = uvec2(slotWord(SLOT_WIDTH), slotWord(SLOT_HEIGHT));
  uint stride = slotWord(SLOT_STRIDE);
  vec2 target = targetSize();
  float scale = min(target.x / float(size.x), target.y / float(size.y));
  vec2 s = (gl_FragCoord.xy - (target - vec2(size) * scale) * 0.5) / scale;
  if (any(lessThan(s, vec2(0))) || any(greaterThanEqual(s, vec2(size)))) {
    color = vec4(0, 0, 0, 1);
    return;
  }

  uint frame = slot * FRAME_BYTES;
  uint chroma = frame + stride * slotWord(SLOT_SLICE_HEIGHT);
  float y = lumaSample(frame, stride, size, s);
  vec2 uv = chromaSample(chroma, stride, size / 2u, s / 2.0);
  color = vec4(clamp(toRgb(y, uv), 0.0, 1.0), 1);
}
