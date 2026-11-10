#version 450
#extension GL_GOOGLE_include_directive : require
#include "storage.glsl"
// The fallback when the texel buffer limits do not cover the frame slots.
float storageByte(uint offset) {
  uint at = FRAMES_OFFSET + offset;
  return float((word(at >> 2u) >> ((at & 3u) * 8u)) & 255u);
}
float lumaAt(uint offset) { return storageByte(offset); }
vec2 chromaAt(uint offset) { return vec2(storageByte(offset), storageByte(offset + 1u)); }
#include "video.glsl"
