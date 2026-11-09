#include <string.h>

#include "untile.h"

#define GOB_WIDTH 64u
#define GOB_HEIGHT 8u
#define GOB_BYTES 512u
#define KIND_PITCH_NV12 0x0a
#define KIND_PITCH_NV12_ALT 0x14
#define KIND_BLOCK_NV12 0x0d
#define MAX_BLOCK_ROWS 256u

static uint64_t get64(const uint8_t *at)
{
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; i++)
        value |= (uint64_t)at[i] << (8 * i);
    return value;
}

static uint16_t get16(const uint8_t *at)
{
    return (uint16_t)(at[0] | at[1] << 8);
}

static bool block_plane(const uint8_t *descriptor, unsigned offset_at, unsigned fields_at, uint32_t element_bytes,
    VdecPlaneLayout *out)
{
    uint32_t blocks_per_row = get16(descriptor + fields_at);
    uint32_t block_width = get16(descriptor + fields_at + 4);
    uint32_t block_rows = get16(descriptor + fields_at + 6);
    bool width_ok = block_width * element_bytes == GOB_WIDTH;
    bool rows_ok = block_rows && block_rows % GOB_HEIGHT == 0 && block_rows <= MAX_BLOCK_ROWS;
    if (!blocks_per_row || !width_ok || !rows_ok)
        return false;

    out->kind = VDEC_LAYOUT_BLOCK_LINEAR;
    out->offset = get64(descriptor + offset_at) & UINT32_MAX;
    out->pitch = (uint64_t)blocks_per_row * GOB_WIDTH;
    out->block_rows = block_rows;
    return true;
}

VdecUntileStatus vdecParseImageDescriptor(const uint8_t descriptor[128], VdecImageLayout *out)
{
    memset(out, 0, sizeof(*out));
    if (descriptor[0] == KIND_BLOCK_NV12) {
        bool luma_ok = block_plane(descriptor, 0x08, 0x10, 1, &out->luma);
        bool chroma_ok = block_plane(descriptor, 0x18, 0x20, 2, &out->chroma);
        return luma_ok && chroma_ok ? VDEC_UNTILE_OK : VDEC_UNTILE_INVALID;
    }

    bool pitch = descriptor[0] == KIND_PITCH_NV12 || descriptor[0] == KIND_PITCH_NV12_ALT;
    if (!pitch)
        return VDEC_UNTILE_UNSUPPORTED;

    out->luma.kind = VDEC_LAYOUT_PITCH;
    out->luma.offset = get64(descriptor + 0x08) & UINT32_MAX;
    out->luma.pitch = get64(descriptor + 0x10);
    out->chroma.kind = VDEC_LAYOUT_PITCH;
    out->chroma.offset = get64(descriptor + 0x18) & UINT32_MAX;
    out->chroma.pitch = get64(descriptor + 0x20);
    return VDEC_UNTILE_OK;
}

uint64_t vdecBlockLinearOffset(uint32_t x, uint32_t y, uint64_t pitch, uint32_t block_rows)
{
    uint64_t block_bytes = (uint64_t)GOB_WIDTH * block_rows;
    uint64_t blocks_per_row = pitch / GOB_WIDTH;

    uint64_t block = (y / block_rows) * blocks_per_row + x / GOB_WIDTH;
    uint64_t gob = (y % block_rows) / GOB_HEIGHT;

    uint32_t gx = x % GOB_WIDTH;
    uint32_t gy = y % GOB_HEIGHT;
    uint32_t inside = (gx / 32) * 256 + ((gy >> 2) & 1) * 128 + ((gx % 32) / 16) * 64 + (gy & 3) * 16 + gx % 16;

    return block * block_bytes + gob * GOB_BYTES + inside;
}

static uint64_t stored_rows(const VdecPlaneLayout *layout, uint32_t rows)
{
    if (layout->kind == VDEC_LAYOUT_PITCH)
        return rows;

    uint64_t block_rows = layout->block_rows;
    return (rows + block_rows - 1) / block_rows * block_rows;
}

VdecUntileStatus vdecCopyPlane(const uint8_t *image, uint64_t image_bytes,
    const VdecPlaneLayout *layout, uint32_t row_bytes, uint32_t rows,
    uint8_t *out, uint32_t out_stride)
{
    bool sizes_ok = rows > 0 && row_bytes > 0 && row_bytes <= out_stride && row_bytes <= layout->pitch;
    bool block_ok = layout->kind == VDEC_LAYOUT_PITCH ||
        (layout->pitch % GOB_WIDTH == 0 && layout->block_rows && layout->block_rows % GOB_HEIGHT == 0 &&
        layout->block_rows <= MAX_BLOCK_ROWS);
    if (!sizes_ok || !block_ok)
        return VDEC_UNTILE_INVALID;

    if (layout->offset > image_bytes)
        return VDEC_UNTILE_INVALID;
    uint64_t available_rows = (image_bytes - layout->offset) / layout->pitch;
    if (stored_rows(layout, rows) > available_rows)
        return VDEC_UNTILE_INVALID;

    const uint8_t *plane = image + layout->offset;
    if (layout->kind == VDEC_LAYOUT_PITCH) {
        for (uint32_t y = 0; y < rows; y++)
            memcpy(out + (size_t)y * out_stride, plane + y * layout->pitch, row_bytes);
        return VDEC_UNTILE_OK;
    }

    for (uint32_t y = 0; y < rows; y++) {
        uint8_t *row = out + (size_t)y * out_stride;
        for (uint32_t x = 0; x < row_bytes; x += 16) {
            uint32_t span = row_bytes - x < 16 ? row_bytes - x : 16;
            memcpy(row + x, plane + vdecBlockLinearOffset(x, y, layout->pitch, layout->block_rows), span);
        }
    }
    return VDEC_UNTILE_OK;
}
