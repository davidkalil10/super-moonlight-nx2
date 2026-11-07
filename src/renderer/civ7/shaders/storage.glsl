#include "layout.glsl"
#ifndef STORAGE_ACCESS
#define STORAGE_ACCESS readonly
#endif
layout(set = 0, binding = 1, std430) STORAGE_ACCESS buffer RendererStorage {
  uint words[];
}
storage;
uint word(uint index) { return storage.words[index]; }
uint pageBase() { return UI_BASE + (word(UI_SHOWN) & 1u) * UI_PAGE_WORDS; }
// The render target's size: the layer's once startup writes it, else the UI's 1920x1080.
vec2 targetSize() {
  uvec2 size = uvec2(word(TARGET_WIDTH), word(TARGET_HEIGHT));
  return size.x == 0u || size.y == 0u ? DISPLAY_SIZE : vec2(size);
}
bool pageVisible() {
  return word(UI_MAGIC) == UI_PROTOCOL_MAGIC && word(UI_APPLIED) != 0u &&
         ((word(pageBase() + 3u) & 1u) == 0u || word(UI_OVERLAY) != 0u);
}
