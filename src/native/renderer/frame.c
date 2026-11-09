#include <string.h>

#include "frame.h"
#include "layout.h"

static uint32_t round_up(uint32_t value, uint32_t step)
{
    return (value + step - 1) / step * step;
}

static void write_word(uint8_t *storage, uint32_t offset, uint32_t value)
{
    memcpy(storage + offset, &value, sizeof(value));
}

static MoonlightRenderResult check_source(const MoonlightNv12Frame *frame)
{
    if (!frame->luma || !frame->chroma)
        return MOONLIGHT_RENDER_INVALID;
    if (!frame->display_width || !frame->display_height)
        return MOONLIGHT_RENDER_INVALID;

    const uint64_t right = (uint64_t)frame->crop_left + frame->display_width;
    const uint64_t bottom = (uint64_t)frame->crop_top + frame->display_height;
    if (right > frame->coded_width || bottom > frame->coded_height)
        return MOONLIGHT_RENDER_INVALID;

    if (frame->luma_stride < frame->coded_width)
        return MOONLIGHT_RENDER_INVALID;
    if (frame->chroma_stride < round_up(frame->coded_width, 2))
        return MOONLIGHT_RENDER_INVALID;

    return MOONLIGHT_RENDER_OK;
}

static MoonlightRenderResult check_format(const MoonlightNv12Frame *frame)
{
    if ((frame->crop_left | frame->crop_top) & 1u)
        return MOONLIGHT_RENDER_UNSUPPORTED;
    if (frame->full_range)
        return MOONLIGHT_RENDER_UNSUPPORTED;
    if (frame->matrix != MOONLIGHT_COLOR_BT601 && frame->matrix != MOONLIGHT_COLOR_BT709)
        return MOONLIGHT_RENDER_UNSUPPORTED;

    return MOONLIGHT_RENDER_OK;
}

MoonlightRenderResult moonlightFramePlan(const MoonlightNv12Frame *frame, MoonlightSlotLayout *layout)
{
    if (!frame || !layout)
        return MOONLIGHT_RENDER_INVALID;

    MoonlightRenderResult result = check_source(frame);
    if (result != MOONLIGHT_RENDER_OK)
        return result;
    result = check_format(frame);
    if (result != MOONLIGHT_RENDER_OK)
        return result;

    const uint32_t stride = round_up(frame->display_width, 64);
    const uint32_t slice_height = round_up(frame->display_height, 2);
    const uint64_t bytes = (uint64_t)stride * slice_height / 2 * 3;
    if (stride > ML_SLOT_MAX_STRIDE || slice_height > ML_SLOT_MAX_ROWS || bytes > ML_FRAME_BYTES)
        return MOONLIGHT_RENDER_UNSUPPORTED;

    *layout = (MoonlightSlotLayout){
        .width = frame->display_width,
        .height = frame->display_height,
        .stride = stride,
        .slice_height = slice_height,
        .chroma_rows = slice_height / 2,
        .chroma_bytes = round_up(frame->display_width, 2),
        .color = frame->matrix == MOONLIGHT_COLOR_BT709 ? 1u : 0u,
    };
    return MOONLIGHT_RENDER_OK;
}

void moonlightFrameCopy(const MoonlightNv12Frame *frame, const MoonlightSlotLayout *layout, uint8_t *slot)
{
    const uint8_t *luma = frame->luma + (size_t)frame->crop_top * frame->luma_stride + frame->crop_left;
    for (uint32_t row = 0; row < layout->height; row++)
        memcpy(slot + (size_t)row * layout->stride, luma + (size_t)row * frame->luma_stride, layout->width);

    const uint8_t *chroma = frame->chroma + (size_t)(frame->crop_top / 2) * frame->chroma_stride + frame->crop_left;
    uint8_t *target = slot + (size_t)layout->stride * layout->slice_height;
    const uint32_t rows = (layout->height + 1) / 2;
    for (uint32_t row = 0; row < rows; row++)
        memcpy(target + (size_t)row * layout->stride, chroma + (size_t)row * frame->chroma_stride, layout->chroma_bytes);
}

void moonlightFramePublish(uint8_t *storage, uint32_t slot, const MoonlightSlotLayout *layout, uint32_t sequence)
{
    write_word(storage, mlSlotWord(slot, ML_SLOT_WIDTH), layout->width);
    write_word(storage, mlSlotWord(slot, ML_SLOT_HEIGHT), layout->height);
    write_word(storage, mlSlotWord(slot, ML_SLOT_STRIDE), layout->stride);
    write_word(storage, mlSlotWord(slot, ML_SLOT_SLICE_HEIGHT), layout->slice_height);
    write_word(storage, mlSlotWord(slot, ML_SLOT_COLOR), layout->color);
    write_word(storage, mlSlotWord(slot, ML_SLOT_SEQUENCE), sequence);
    write_word(storage, ML_CONTROL_MODE, ML_MODE_NATIVE);
}
