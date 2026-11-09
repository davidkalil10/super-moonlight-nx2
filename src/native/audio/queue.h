#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The console jitter queue and crossfade, ported from civ7/audio-queue.js. Policy: audio/README.md. */

#define AUDIO_QUEUE_CAPACITY 32u

typedef struct {
    uint64_t chunk_us;
    uint64_t target_us;
    uint64_t burst_us;
    uint64_t window_us;
    uint64_t output_us;
} AudioQueuePolicy;

typedef struct {
    uint64_t dropped;
    uint64_t cuts;
    uint64_t depth_us;
    uint64_t max_depth_us;
} AudioQueueStats;

typedef struct {
    AudioQueuePolicy policy;
    uint8_t waiting[AUDIO_QUEUE_CAPACITY];
    unsigned head;
    unsigned count;
    unsigned output;
    bool window_open;
    uint64_t window_started_us;
    uint64_t window_lowest_us;
    AudioQueueStats stats;
} AudioQueue;

typedef struct {
    uint8_t dropped[AUDIO_QUEUE_CAPACITY];
    unsigned dropped_count;
    uint8_t appended[AUDIO_QUEUE_CAPACITY];
    unsigned appended_count;
} AudioQueueStep;

void audioQueueInit(AudioQueue *queue, const AudioQueuePolicy *policy);

bool audioQueuePush(AudioQueue *queue, uint8_t item);

bool audioQueueRelease(AudioQueue *queue);

void audioQueueStep(AudioQueue *queue, uint64_t now_us, AudioQueueStep *step);

void audioCrossfade(const uint8_t *from, size_t from_bytes, uint8_t *to, size_t to_bytes,
    unsigned frames, unsigned channels);
