#pragma once

#include <stddef.h>
#include <stdint.h>

/* The known records the host fixture sends; media-diag-host.mjs implements the same rules. */

#define DIAG_VIDEO_UNITS 16u
#define DIAG_VIDEO_PTS_STEP 16667u
#define DIAG_PCM_CHUNKS 300u
#define DIAG_PCM_CHUNK_BYTES 1920u
#define DIAG_PCM_FRAMES_PER_CHUNK 480u
#define DIAG_PCM_PTS_STEP 10000u
#define DIAG_PCM_PERIOD 108u

static const uint32_t diag_video_lengths[DIAG_VIDEO_UNITS] = {
    1, 16, 1460, 1461, 4096, 65536, 65537, 200000,
    1048576, 3000, 7, 524288, 1048575, 100, 32768, 999999,
};

static inline uint8_t diag_video_byte(uint32_t sequence, uint32_t index)
{
    return (uint8_t)(sequence * 131u + index * 7u + (index >> 8));
}

static inline int16_t diag_pcm_sample(uint32_t frame, unsigned channel)
{
    uint32_t phase = frame % DIAG_PCM_PERIOD;
    int32_t ramp = phase < DIAG_PCM_PERIOD / 2 ? (int32_t)phase : (int32_t)(DIAG_PCM_PERIOD - phase);
    int32_t sample = (ramp - (int32_t)DIAG_PCM_PERIOD / 4) * 3;
    return (int16_t)(channel ? -sample : sample);
}
