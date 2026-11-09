#pragma once

#include "../codec.h"
#include "wire.h"

/* The service operations decoder.c drives. gsv.c is the console backend; tests use a fake. */

#define VDEC_SURFACES 2u

typedef enum {
    VDEC_OK = 0,
    VDEC_REFUSED,
    VDEC_INVALID,
    VDEC_NO_MEMORY,
    VDEC_UNSUPPORTED,
    VDEC_MALFORMED,
    VDEC_UNCERTAIN,
} VdecStatus;

typedef struct {
    uint32_t coded_width;
    uint32_t coded_height;
    uint32_t display_width;
    uint32_t display_height;
    bool frame_registered;
    uint64_t permitted_frame_mode;
    bool native_image_backing;
} VdecOpenParams;

typedef struct {
    uint8_t *luma;
    uint8_t *chroma;
    uint32_t luma_stride;
    uint32_t chroma_stride;
    uint32_t width;
    uint32_t height;
} VdecTarget;

typedef struct {
    void *context;
    VdecStatus (*open)(void *context, const VdecOpenParams *params, uint32_t images[VDEC_SURFACES]);
    VdecStatus (*submit)(void *context, const uint8_t *data, uint32_t length, uint64_t pts_us);
    VdecStatus (*ready)(void *context, unsigned surface, bool *ready);
    VdecStatus (*output)(void *context, VdecOutput *out);
    VdecStatus (*readback)(void *context, unsigned surface, const VdecTarget *target);
    VdecStatus (*release)(void *context, unsigned surface);
    VdecStatus (*close)(void *context);
    uint64_t (*now_ms)(void *context);
} VdecBackend;

MoonlightDecodeResult vdecDecoderOpenWithBackend(const MoonlightDecoderConfig *config,
    MoonlightDecoderLog log, const VdecBackend *backend, MoonlightDecoder **out);

void vdecDecoderResetRetiredForTests(void);
