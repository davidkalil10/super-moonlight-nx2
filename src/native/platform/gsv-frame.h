#pragma once

#include <stdbool.h>
#include <stdint.h>

/* Process-wide record of the one GSV frame registration (libounce gsvRegisterFrame).
 * Linked with -Wl,--wrap=gsvRegisterFrame; see the dev repo's src/native/platform/README.md. */

typedef enum {
    MOONLIGHT_GSV_FRAME_UNREGISTERED = 0,
    MOONLIGHT_GSV_FRAME_REGISTERED,
    MOONLIGHT_GSV_FRAME_FAILED,
} MoonlightGsvFrameState;

typedef struct {
    MoonlightGsvFrameState state;
    uint64_t requested_mode;
    uint64_t permitted_mode;
    uint32_t result;
    uint32_t forwarded;
    uint32_t answered_from_cache;
    uint32_t refused;
} MoonlightGsvFrameStatus;

void moonlightGsvFrameGetStatus(MoonlightGsvFrameStatus *out);

bool moonlightGsvFrameGetPermittedMode(uint64_t *out_mode);
