#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Console PCM output with Moonlight's jitter queue, fed by the PCM channel's record stream.
 * Contract, ownership and errors: moonlight-nx2-dev/src/native/audio/README.md.
 */

#define MOONLIGHT_AUDIO_HEADER_BYTES 16u
#define MOONLIGHT_AUDIO_SLOTS 16u
#define MOONLIGHT_AUDIO_SLOT_BYTES 0x1000u

typedef struct MoonlightAudio MoonlightAudio;

typedef enum {
    MOONLIGHT_AUDIO_OK = 0,
    MOONLIGHT_AUDIO_AGAIN,
    MOONLIGHT_AUDIO_INVALID,
    MOONLIGHT_AUDIO_UNSUPPORTED,
    MOONLIGHT_AUDIO_NO_MEMORY,
    MOONLIGHT_AUDIO_REFUSED,
    MOONLIGHT_AUDIO_UNCERTAIN,
    MOONLIGHT_AUDIO_FAILED,
    MOONLIGHT_AUDIO_RETIRED,
} MoonlightAudioResult;

typedef struct {
    uint32_t target_ms;
    uint32_t burst_ms;
    uint32_t window_ms;
    uint32_t output_ms;
    uint32_t fade_frames;
} MoonlightAudioPolicy;

typedef struct {
    uint32_t sample_rate;
    uint32_t channels;
    uint32_t chunk_bytes;
    MoonlightAudioPolicy policy;
} MoonlightAudioConfig;

typedef struct {
    uint64_t received;
    uint64_t appended;
    uint64_t released;
    uint64_t dropped;
    uint64_t cuts;
    uint64_t crossfades;
    uint64_t acknowledged;
    uint32_t depth_ms;
    uint32_t max_depth_ms;
    uint64_t polled_starvations;
    uint64_t starved_ms_at_least;
    uint64_t starved_ms_at_most;
    uint64_t longest_pump_gap_ms;
    uint64_t pump_gaps_over_output;
} MoonlightAudioStats;

typedef void (*MoonlightAudioLog)(const char *message);

const char *moonlightAudioResultName(MoonlightAudioResult result);

void moonlightAudioDefaultConfig(MoonlightAudioConfig *config);

MoonlightAudioResult moonlightAudioOpen(const MoonlightAudioConfig *config, MoonlightAudioLog log,
    MoonlightAudio **out);

MoonlightAudioResult moonlightAudioReceive(MoonlightAudio *audio, const uint8_t *data, size_t bytes,
    size_t *taken);

MoonlightAudioResult moonlightAudioPump(MoonlightAudio *audio, uint64_t now_ms);

MoonlightAudioResult moonlightAudioTakeAcknowledgement(MoonlightAudio *audio,
    uint8_t header[MOONLIGHT_AUDIO_HEADER_BYTES]);

void moonlightAudioGetStats(const MoonlightAudio *audio, MoonlightAudioStats *stats);

MoonlightAudioResult moonlightAudioClose(MoonlightAudio *audio);

bool moonlightAudioRetired(void);
