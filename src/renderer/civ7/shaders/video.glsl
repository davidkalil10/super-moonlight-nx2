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

float lumaSample(uint base, uint stride, uvec2 size, vec2 s) {
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
