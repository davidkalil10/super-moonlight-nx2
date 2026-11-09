#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* CPU readback of a decoder image described by GSV 961. Layouts: codec/README.md. */

typedef enum {
    VDEC_LAYOUT_PITCH,
    VDEC_LAYOUT_BLOCK_LINEAR,
} VdecLayoutKind;

typedef struct {
    VdecLayoutKind kind;
    uint64_t offset;
    uint64_t pitch;
    uint32_t block_rows;
} VdecPlaneLayout;

typedef struct {
    VdecPlaneLayout luma;
    VdecPlaneLayout chroma;
} VdecImageLayout;

typedef enum {
    VDEC_UNTILE_OK = 0,
    VDEC_UNTILE_INVALID,
    VDEC_UNTILE_UNSUPPORTED,
} VdecUntileStatus;

VdecUntileStatus vdecParseImageDescriptor(const uint8_t descriptor[128], VdecImageLayout *out);

uint64_t vdecBlockLinearOffset(uint32_t x, uint32_t y, uint64_t pitch, uint32_t block_rows);

VdecUntileStatus vdecCopyPlane(const uint8_t *image, uint64_t image_bytes,
    const VdecPlaneLayout *layout, uint32_t row_bytes, uint32_t rows,
    uint8_t *out, uint32_t out_stride);
