#version 450
#extension GL_GOOGLE_include_directive : require
// Volatile keeps NVK off the incoherent constant load path.
#define STORAGE_ACCESS readonly volatile
#include "storage.glsl"
layout(location = 0) flat out uvec4 rect;
layout(location = 1) flat out uvec4 info;
layout(location = 2) flat out uint item;
const float GLOW_REACH = 56.0;
const vec2 CORNERS[6] = vec2[](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1),
                               vec2(1, 0), vec2(1, 1));
void main() {
  uint instance = uint(gl_InstanceIndex), base = pageBase();
  bool visible = pageVisible();
  vec2 origin = vec2(0), extent = DISPLAY_SIZE;
  rect = uvec4(0, 0, uvec2(DISPLAY_SIZE));
  info = uvec4(0);
  item = 0u;
  if (instance == 0u) {
    info = uvec4(0u, 0u, word(base + 8u), word(base + 3u));
  } else if (instance <= 22u) {
    uint index = instance - 1u, at = base + 848u + index * 8u;
    visible = visible && index < word(base + 11u);
    rect = uvec4(word(at), word(at + 1u), word(at + 2u), word(at + 3u));
    info = uvec4(6u, word(at + 4u), word(at + 5u), word(at + 6u));
  } else if (instance <= 46u) {
    uint index = instance - 23u, at = base + 656u + index * 8u;
    visible = visible && index < word(base + 6u);
    rect = uvec4(word(at), word(at + 1u), word(at + 2u), word(at + 3u));
    info = uvec4(1u, word(at + 4u), word(at + 6u), word(at + 7u));
  } else if (instance <= 94u) {
    uint index = instance - 47u, at = base + 272u + index * 8u;
    uint follows = word(at + 6u);
    visible = visible && index < word(base + 5u) &&
              (follows == 0u || follows == word(UI_CURSOR) + 1u);
    rect = uvec4(word(at), word(at + 1u), word(at + 2u), word(at + 3u));
    info = uvec4(2u, word(at + 4u), word(at + 5u), 0u);
  } else if (instance <= 126u) {
    item = instance - 95u;
    uint at = base + 16u + item * 8u;
    uint flags = word(at + 5u);
    bool cursor = item == word(UI_CURSOR) && (word(base + 3u) & 2u) == 0u &&
                  (flags & 64u) == 0u;
    visible =
        visible && item < word(base + 4u) && (cursor || (flags & 2u) != 0u);
    rect = uvec4(word(at + 1u), word(at + 2u), word(at + 3u), word(at + 4u));
    info = uvec4(3u, cursor ? 1u : 0u, flags, word(at + 6u));
  } else if (instance == 127u) {
    bool starting = !visible && word(MODE) == 0u;
    visible = starting || (visible && word(HOST_BUSY) != 0u);
    rect = starting ? uvec4(936, 516, 48, 48) : uvec4(1836, 36, 48, 48);
    info.x = 4u;
  } else {
    visible = word(BADGE_VISIBLE) != 0u;
    rect = uvec4(word(BADGE_X), word(BADGE_Y), word(BADGE_WIDTH),
                 word(BADGE_HEIGHT));
    info.x = 5u;
  }
  if (instance != 0u) {
    origin = vec2(rect.xy);
    extent = vec2(rect.zw);
    if (info.x == 3u) {
      origin -= vec2(GLOW_REACH);
      extent += vec2(2.0 * GLOW_REACH);
    }
  }
  vec2 p = origin + CORNERS[gl_VertexIndex] * extent;
  gl_Position =
      visible ? vec4(p / DISPLAY_SIZE * targetSize() / backingSize() * 2.0 - 1.0, 0, 1)
              : vec4(2, 2, 0, 1);
}
