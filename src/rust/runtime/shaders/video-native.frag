#version 450
#extension GL_GOOGLE_include_directive : require
#include "storage.glsl"
// Samples the decoder's own surface; video.glsl's linear offsets map back to (x, y) in its planes.
layout(set = 1, binding = 0, std430) readonly buffer NativeSurface {
  uint words[];
}
surface;
layout(push_constant) uniform Native {
  uint lumaOffset;
  uint lumaPitch;
  uint lumaRows;
  uint chromaOffset;
  uint chromaPitch;
  uint chromaRows;
  uint stride;
  uint sliceHeight;
}
native;

uint planeOffset(uint base, uint pitch, uint rows, uint x, uint y) {
  if (rows == 0u) return base + y * pitch + x;
  uint block = (y / rows) * (pitch / 64u) + x / 64u;
  uint gob = (y % rows) / 8u;
  uint gx = x % 64u, gy = y % 8u;
  uint swizzled = (gx / 32u) * 256u + ((gy >> 2u) & 1u) * 128u + ((gx % 32u) / 16u) * 64u +
                  (gy & 3u) * 16u + gx % 16u;
  return base + block * 64u * rows + gob * 512u + swizzled;
}

float surfaceByte(uint at) { return float((surface.words[at >> 2u] >> ((at & 3u) * 8u)) & 255u); }

float lumaAt(uint offset) {
  uint at = offset % FRAME_BYTES;
  uint x = at % native.stride, y = at / native.stride;
  return surfaceByte(planeOffset(native.lumaOffset, native.lumaPitch, native.lumaRows, x, y));
}

vec2 chromaAt(uint offset) {
  uint at = offset % FRAME_BYTES - native.stride * native.sliceHeight;
  uint x = at % native.stride, y = at / native.stride;
  uint p = planeOffset(native.chromaOffset, native.chromaPitch, native.chromaRows, x, y);
  return vec2(surfaceByte(p), surfaceByte(p + 1u));
}
#include "video.glsl"
