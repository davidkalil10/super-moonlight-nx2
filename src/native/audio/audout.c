// libounce AudioOut backend: the default output, one AudioOutBuffer per slot.
#include <stdio.h>

#include <switch.h>

#include "backend.h"

typedef struct {
    MoonlightAudioLog log;
    AudioOutBuffer buffers[MOONLIGHT_AUDIO_SLOTS];
    bool initialized;
} Audout;

static Audout output;

static AoutStatus checked(const char *stage, Result rc)
{
    if (R_SUCCEEDED(rc))
        return AOUT_OK;

    if (output.log) {
        char message[96];
        snprintf(message, sizeof(message), "audout: %s 0x%x", stage, rc);
        output.log(message);
    }
    return R_MODULE(rc) == Module_Kernel ? AOUT_UNCERTAIN : AOUT_REFUSED;
}

static AoutStatus audout_open(void *context, uint8_t *const slots[MOONLIGHT_AUDIO_SLOTS], AoutFormat *format)
{
    Audout *state = context;
    AoutStatus status = checked("initialize", audoutInitialize());
    if (status != AOUT_OK)
        return status;

    state->initialized = true;
    for (unsigned i = 0; i < MOONLIGHT_AUDIO_SLOTS; i++) {
        state->buffers[i] = (AudioOutBuffer){
            .buffer = slots[i],
            .buffer_size = MOONLIGHT_AUDIO_SLOT_BYTES,
        };
    }

    *format = (AoutFormat){
        .sample_rate = audoutGetSampleRate(),
        .channels = audoutGetChannelCount(),
        .sample_bits = audoutGetPcmFormat() == PcmFormat_Int16 ? 16 : 0,
        .sample_signed = audoutGetPcmFormat() == PcmFormat_Int16,
    };
    return AOUT_OK;
}

static AoutStatus audout_append(void *context, unsigned slot, uint32_t bytes)
{
    Audout *state = context;
    AudioOutBuffer *buffer = &state->buffers[slot];
    buffer->data_size = bytes;
    buffer->data_offset = 0;
    armDCacheFlush(buffer->buffer, bytes);
    return checked("append", audoutAppendAudioOutBuffer(buffer));
}

static AoutStatus audout_released(void *context, int *slot)
{
    Audout *state = context;
    AudioOutBuffer *released = NULL;
    u32 count = 0;
    AoutStatus status = checked("released", audoutGetReleasedAudioOutBuffer(&released, &count));
    if (status != AOUT_OK)
        return status;

    *slot = -1;
    if (count == 0)
        return AOUT_OK;

    *slot = -2;
    for (unsigned i = 0; i < MOONLIGHT_AUDIO_SLOTS; i++) {
        if (released == &state->buffers[i])
            *slot = (int)i;
    }
    return AOUT_OK;
}

static AoutStatus audout_queued(void *context, uint32_t *count)
{
    (void)context;
    u32 value = 0;
    AoutStatus status = checked("buffer count", audoutGetAudioOutBufferCount(&value));
    *count = value;
    return status;
}

static AoutStatus audout_contains(void *context, unsigned slot, bool *contains)
{
    Audout *state = context;
    return checked("contains", audoutContainsAudioOutBuffer(&state->buffers[slot], contains));
}

static AoutStatus audout_start(void *context)
{
    (void)context;
    return checked("start", audoutStartAudioOut());
}

static AoutStatus audout_stop(void *context)
{
    (void)context;
    return checked("stop", audoutStopAudioOut());
}

static AoutStatus audout_flush(void *context)
{
    (void)context;
    bool flushed = false;
    return checked("flush", audoutFlushAudioOutBuffers(&flushed));
}

static AoutStatus audout_close(void *context)
{
    Audout *state = context;
    if (state->initialized)
        audoutExit();
    state->initialized = false;
    return AOUT_OK;
}

MoonlightAudioResult moonlightAudioOpen(const MoonlightAudioConfig *config, MoonlightAudioLog log,
    MoonlightAudio **out)
{
    if (moonlightAudioRetired())
        return MOONLIGHT_AUDIO_RETIRED;
    if (output.initialized)
        return MOONLIGHT_AUDIO_INVALID;

    output.log = log;
    const AoutBackend backend = {
        .context = &output,
        .open = audout_open,
        .append = audout_append,
        .released = audout_released,
        .queued = audout_queued,
        .contains = audout_contains,
        .start = audout_start,
        .stop = audout_stop,
        .flush = audout_flush,
        .close = audout_close,
    };
    return aoutAudioOpenWithBackend(config, log, &backend, out);
}
