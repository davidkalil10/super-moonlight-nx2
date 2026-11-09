#pragma once

#include <stdint.h>

// The civ7 renderer contract (src/renderer/civ7/prebuilt/renderer.json). The dev repo test
// compares every value here with that manifest.
#define ML_LAYOUT_ABI 2u
#define ML_NATIVE_ABI 0x484e5633u
#define ML_WIDTH 1920u
#define ML_HEIGHT 1080u

#define ML_INPUT_BYTES 4096u
#define ML_STORAGE_BYTES 48418816u
#define ML_FRAME_BYTES 12533760u
#define ML_FRAME_COUNT 3u
#define ML_FRAMES_OFFSET 2424832u
#define ML_VIDEO_SLOTS 2u
#define ML_UI_OFFSET 40030208u
#define ML_UI_PAGE_BYTES 4194304u
#define ML_UI_PAGES 2u
#define ML_UI_INSTANCES 106u
#define ML_BADGE_INSTANCE 106u
#define ML_BADGE_OFFSET 27492352u

#define ML_CONTROL_MODE 8u
#define ML_MODE_NATIVE 3u

#define ML_VIDEO_BASE 0xb000u
#define ML_VIDEO_SLOT_BYTES 32u
#define ML_SLOT_SEQUENCE 0u
#define ML_SLOT_WIDTH 4u
#define ML_SLOT_HEIGHT 8u
#define ML_SLOT_STRIDE 12u
#define ML_SLOT_SLICE_HEIGHT 16u
#define ML_SLOT_COLOR 20u

#define ML_TARGET_WIDTH 0xb120u
#define ML_TARGET_HEIGHT 0xb124u
#define ML_TARGET_BACKING_WIDTH 0xb128u
#define ML_TARGET_BACKING_HEIGHT 0xb12cu

#define ML_SLOT_MAX_STRIDE 8192u
#define ML_SLOT_MAX_ROWS 8192u

#define ML_CLEAR_RED 0.012f
#define ML_CLEAR_GREEN 0.02f
#define ML_CLEAR_BLUE 0.045f

_Static_assert(ML_FRAMES_OFFSET + ML_FRAME_COUNT * ML_FRAME_BYTES <= ML_UI_OFFSET, "frames overlap the UI pages");
_Static_assert(ML_UI_OFFSET + ML_UI_PAGES * ML_UI_PAGE_BYTES == ML_STORAGE_BYTES, "storage size");
_Static_assert(ML_VIDEO_BASE + ML_VIDEO_SLOTS * ML_VIDEO_SLOT_BYTES <= ML_FRAMES_OFFSET, "slot words");
_Static_assert(ML_BADGE_OFFSET == ML_FRAMES_OFFSET + 2u * ML_FRAME_BYTES, "badge pixels in frame area 2");
_Static_assert(ML_FRAMES_OFFSET % 4u == 0 && ML_FRAME_BYTES % 2u == 0, "texel view alignment");

static inline uint32_t mlSlotWord(uint32_t slot, uint32_t field)
{
    return ML_VIDEO_BASE + slot * ML_VIDEO_SLOT_BYTES + field;
}

static inline uint32_t mlFrameOffset(uint32_t slot)
{
    return ML_FRAMES_OFFSET + slot * ML_FRAME_BYTES;
}
