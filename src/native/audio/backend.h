#pragma once

#include "../audio.h"

/* The AudioOut operations audio.c drives. audout.c is the console backend; tests use a fake. */

typedef enum {
    AOUT_OK = 0,
    AOUT_REFUSED,
    AOUT_UNCERTAIN,
} AoutStatus;

typedef struct {
    uint32_t sample_rate;
    uint32_t channels;
    uint32_t sample_bits;
    bool sample_signed;
} AoutFormat;

typedef struct {
    void *context;
    AoutStatus (*open)(void *context, uint8_t *const slots[MOONLIGHT_AUDIO_SLOTS], AoutFormat *format);
    AoutStatus (*append)(void *context, unsigned slot, uint32_t bytes);
    AoutStatus (*released)(void *context, int *slot);
    AoutStatus (*queued)(void *context, uint32_t *count);
    AoutStatus (*contains)(void *context, unsigned slot, bool *contains);
    AoutStatus (*start)(void *context);
    AoutStatus (*stop)(void *context);
    AoutStatus (*flush)(void *context);
    AoutStatus (*close)(void *context);
} AoutBackend;

MoonlightAudioResult aoutAudioOpenWithBackend(const MoonlightAudioConfig *config, MoonlightAudioLog log,
    const AoutBackend *backend, MoonlightAudio **out);

void aoutAudioResetRetiredForTests(void);
