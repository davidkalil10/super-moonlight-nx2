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
bool pageVisible() {
  return word(UI_MAGIC) == UI_PROTOCOL_MAGIC && word(UI_APPLIED) != 0u &&
         ((word(pageBase() + 3u) & 1u) == 0u || word(UI_OVERLAY) != 0u);
}
