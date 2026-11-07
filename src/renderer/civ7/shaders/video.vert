#version 450
#extension GL_GOOGLE_include_directive : require
#include "storage.glsl"
layout(location = 0) flat out uint slot;

uint slotWord(uint field) { return word(VIDEO_BASE + slot * VIDEO_SLOT_WORDS + field); }

// The console checks the layout before publishing; this keeps a bad word from reading past the slot.
bool slotFits() {
  uint width = slotWord(SLOT_WIDTH), height = slotWord(SLOT_HEIGHT);
  uint stride = slotWord(SLOT_STRIDE), rows = slotWord(SLOT_SLICE_HEIGHT);
  bool sizeOk = width > 0u && height > 0u && stride >= width && rows >= height;
  bool boundOk = stride <= 8192u && rows <= 8192u && stride * rows / 2u * 3u <= FRAME_BYTES;
  return sizeOk && boundOk;
}

void main() {
  vec2 p = vec2((gl_VertexIndex << 1) & 2, gl_VertexIndex & 2);
  slot = uint(gl_InstanceIndex);
  bool covered = pageVisible() && (word(pageBase() + 3u) & 1u) == 0u;
  bool shown = slotWord(SLOT_SEQUENCE) != 0u && slotFits();
  gl_Position = covered || !shown ? vec4(2, 2, 0, 1) : vec4(p * 2.0 - 1.0, 0, 1);
}
