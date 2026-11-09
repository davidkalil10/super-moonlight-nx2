#pragma once

#include "backend.h"

/* Console backend over libounce's GSV root. Builds only for __SWITCH2__. */

typedef struct {
    const uint8_t *descriptor;
    const uint8_t *memory;
    uint64_t bytes;
    uint32_t image;
    uint32_t last_result;
    const char *last_stage;
} VdecGsvEvidence;

VdecStatus vdecGsvCreate(MoonlightDecoderLog log, VdecBackend *out);
void vdecGsvDestroyUnopened(VdecBackend *backend);
void vdecGsvEvidence(void *context, unsigned surface, VdecGsvEvidence *out);
