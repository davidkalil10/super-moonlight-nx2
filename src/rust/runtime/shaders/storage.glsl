#include "layout.glsl"
#ifndef STORAGE_ACCESS
#define STORAGE_ACCESS readonly
#endif
layout(set = 0, binding = 1, std430) STORAGE_ACCESS buffer RendererStorage {
  uint words[];
}
storage;
uint word(uint index) { return storage.words[index]; }
vec4 rgba(uint value) {
  return vec4(value & 255u, (value >> 8u) & 255u, (value >> 16u) & 255u,
              value >> 24u) /
         255.0;
}
uint pageBase() { return UI_BASE + (word(UI_SHOWN) & 1u) * UI_PAGE_WORDS; }
// Active drawing size, with 1920x1080 as the unset default.
vec2 targetSize() {
  uvec2 size = uvec2(word(TARGET_WIDTH), word(TARGET_HEIGHT));
  return size.x == 0u || size.y == 0u ? DISPLAY_SIZE : vec2(size);
}
vec2 backingSize() {
  uvec2 size = uvec2(word(TARGET_BACKING_WIDTH), word(TARGET_BACKING_HEIGHT));
  return size.x == 0u || size.y == 0u ? targetSize() : vec2(size);
}
bool pageVisible() {
  return word(UI_MAGIC) == UI_PROTOCOL_MAGIC && word(UI_APPLIED) != 0u &&
         ((word(pageBase() + 3u) & 1u) == 0u || word(UI_OVERLAY) != 0u);
}
