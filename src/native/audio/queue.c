#include <math.h>
#include <string.h>

#include "queue.h"

static uint64_t depth(const AudioQueue *queue)
{
    return (uint64_t)(queue->count + queue->output) * queue->policy.chunk_us;
}

static uint8_t take(AudioQueue *queue)
{
    uint8_t item = queue->waiting[queue->head];
    queue->head = (queue->head + 1) % AUDIO_QUEUE_CAPACITY;
    queue->count--;
    return item;
}

static void drop_to(AudioQueue *queue, int64_t limit_us, AudioQueueStep *step)
{
    int64_t over = (int64_t)depth(queue) - limit_us;
    if (over <= 0)
        return;

    uint64_t excess = (uint64_t)over / queue->policy.chunk_us;
    unsigned count = excess < queue->count ? (unsigned)excess : queue->count;
    if (count == 0)
        return;

    queue->stats.dropped += count;
    queue->stats.cuts++;
    for (unsigned i = 0; i < count; i++)
        step->dropped[step->dropped_count++] = take(queue);
}

static void restart_window(AudioQueue *queue, uint64_t now_us)
{
    queue->window_open = true;
    queue->window_started_us = now_us;
    queue->window_lowest_us = UINT64_MAX;
}

void audioQueueInit(AudioQueue *queue, const AudioQueuePolicy *policy)
{
    memset(queue, 0, sizeof(*queue));
    queue->policy = *policy;
}

bool audioQueuePush(AudioQueue *queue, uint8_t item)
{
    if (queue->count + queue->output >= AUDIO_QUEUE_CAPACITY)
        return false;

    queue->waiting[(queue->head + queue->count) % AUDIO_QUEUE_CAPACITY] = item;
    queue->count++;
    return true;
}

bool audioQueueRelease(AudioQueue *queue)
{
    if (queue->output == 0)
        return false;

    queue->output--;
    return true;
}

void audioQueueStep(AudioQueue *queue, uint64_t now_us, AudioQueueStep *step)
{
    step->dropped_count = 0;
    step->appended_count = 0;

    uint64_t current = depth(queue);
    queue->stats.depth_us = current;
    if (current > queue->stats.max_depth_us)
        queue->stats.max_depth_us = current;
    if (!queue->window_open)
        restart_window(queue, now_us);
    if (current < queue->window_lowest_us)
        queue->window_lowest_us = current;

    const AudioQueuePolicy *policy = &queue->policy;
    if (current > policy->burst_us) {
        drop_to(queue, (int64_t)policy->target_us, step);
        restart_window(queue, now_us);
    } else if (now_us - queue->window_started_us >= policy->window_us) {
        int64_t standing = (int64_t)queue->window_lowest_us - (int64_t)policy->target_us;
        if (standing > 0)
            drop_to(queue, (int64_t)current - standing, step);
        restart_window(queue, now_us);
    }

    while (queue->count && (queue->output + 1) * policy->chunk_us <= policy->output_us) {
        step->appended[step->appended_count++] = take(queue);
        queue->output++;
    }

    queue->stats.depth_us = depth(queue);
}

static int16_t sample_at(const uint8_t *at)
{
    return (int16_t)(uint16_t)(at[0] | at[1] << 8);
}

void audioCrossfade(const uint8_t *from, size_t from_bytes, uint8_t *to, size_t to_bytes,
    unsigned frames, unsigned channels)
{
    size_t samples = (size_t)frames * channels;
    if (samples > from_bytes / 2)
        samples = from_bytes / 2;
    if (samples > to_bytes / 2)
        samples = to_bytes / 2;

    for (size_t i = 0; i < samples; i++) {
        uint8_t *at = to + i * 2;
        double weight = (double)(i / channels + 1) / (double)(frames + 1);
        double start = sample_at(from + i * 2);
        double end = sample_at(at);
        int value = (int)floor(start + (end - start) * weight + 0.5);
        at[0] = (uint8_t)(value & 0xff);
        at[1] = (uint8_t)((value >> 8) & 0xff);
    }
}
