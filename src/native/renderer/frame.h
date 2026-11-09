#pragma once

#include <stdint.h>

#include "../renderer.h"

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t slice_height;
    uint32_t chroma_rows;
    uint32_t chroma_bytes;
    uint32_t color;
} MoonlightSlotLayout;

MoonlightRenderResult moonlightFramePlan(const MoonlightNv12Frame *frame, MoonlightSlotLayout *layout);
void moonlightFrameCopy(const MoonlightNv12Frame *frame, const MoonlightSlotLayout *layout, uint8_t *slot);
void moonlightFramePublish(uint8_t *storage, uint32_t slot, const MoonlightSlotLayout *layout, uint32_t sequence);
