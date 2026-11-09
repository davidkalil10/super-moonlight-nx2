#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "backend.h"
#include "queue.h"

#define SLOT_ALIGNMENT 0x1000u
#define NONE (-1)

typedef enum {
    SLOT_FREE,
    SLOT_RECEIVING,
    SLOT_WAITING,
    SLOT_OUTPUT,
} SlotState;

typedef struct {
    uint8_t header[MOONLIGHT_AUDIO_HEADER_BYTES];
    bool done;
} Entry;

struct MoonlightAudio {
    AoutBackend backend;
    MoonlightAudioConfig config;
    MoonlightAudioLog log;
    uint8_t *memory;
    uint8_t *slots[MOONLIGHT_AUDIO_SLOTS];
    SlotState state[MOONLIGHT_AUDIO_SLOTS];
    int entry_of[MOONLIGHT_AUDIO_SLOTS];
    Entry entries[MOONLIGHT_AUDIO_SLOTS];
    unsigned entry_head;
    unsigned entry_count;
    AudioQueue queue;
    uint8_t header[MOONLIGHT_AUDIO_HEADER_BYTES];
    unsigned header_bytes;
    uint32_t data_bytes;
    int current;
    uint8_t fade[MOONLIGHT_AUDIO_SLOT_BYTES];
    uint32_t fade_bytes;
    bool fade_pending;
    bool opened;
    bool started;
    bool failed;
    bool uncertain;
    int64_t last_pump;
    int64_t last_playing;
    int64_t starved_since;
    MoonlightAudioStats stats;
};

static bool retired;

static void report(const MoonlightAudio *audio, const char *format, ...) __attribute__((format(printf, 2, 3)));

static void report(const MoonlightAudio *audio, const char *format, ...)
{
    if (!audio->log)
        return;

    char message[160];
    va_list args;
    va_start(args, format);
    vsnprintf(message, sizeof(message), format, args);
    va_end(args);
    audio->log(message);
}

const char *moonlightAudioResultName(MoonlightAudioResult result)
{
    static const char *const names[] = {
        "OK", "AGAIN", "INVALID", "UNSUPPORTED", "NO_MEMORY", "REFUSED", "UNCERTAIN", "FAILED", "RETIRED",
    };
    if ((unsigned)result >= sizeof(names) / sizeof(names[0]))
        return "?";
    return names[result];
}

void moonlightAudioDefaultConfig(MoonlightAudioConfig *config)
{
    *config = (MoonlightAudioConfig){
        .sample_rate = 48000,
        .channels = 2,
        .chunk_bytes = 1920,
        .policy = {.target_ms = 20, .burst_ms = 70, .window_ms = 500, .output_ms = 20, .fade_frames = 72},
    };
}

bool moonlightAudioRetired(void)
{
    return retired;
}

void aoutAudioResetRetiredForTests(void)
{
    retired = false;
}

static MoonlightAudioResult fail(MoonlightAudio *audio, const char *stage, AoutStatus status)
{
    audio->failed = true;
    if (status == AOUT_UNCERTAIN)
        audio->uncertain = true;
    report(audio, "audio: %s %s", stage, status == AOUT_UNCERTAIN ? "uncertain" : "refused");
    return status == AOUT_UNCERTAIN ? MOONLIGHT_AUDIO_UNCERTAIN : MOONLIGHT_AUDIO_REFUSED;
}

static bool within(uint64_t value_us, uint64_t low_us, uint64_t high_us)
{
    return value_us >= low_us && value_us <= high_us;
}

static MoonlightAudioResult check_config(const MoonlightAudioConfig *config, AudioQueuePolicy *policy)
{
    bool rate_ok = config->sample_rate >= 8000 && config->sample_rate <= 192000;
    bool channels_ok = config->channels >= 1 && config->channels <= 8;
    if (!rate_ok || !channels_ok)
        return MOONLIGHT_AUDIO_INVALID;

    uint32_t frame_bytes = config->channels * 2;
    bool chunk_ok = config->chunk_bytes >= frame_bytes && config->chunk_bytes <= MOONLIGHT_AUDIO_SLOT_BYTES;
    if (!chunk_ok || config->chunk_bytes % frame_bytes)
        return MOONLIGHT_AUDIO_INVALID;

    uint64_t scaled = (uint64_t)config->chunk_bytes * 1000000u;
    uint64_t byte_rate = (uint64_t)config->sample_rate * frame_bytes;
    if (scaled % byte_rate)
        return MOONLIGHT_AUDIO_UNSUPPORTED;

    const MoonlightAudioPolicy *in = &config->policy;
    uint64_t chunk_us = scaled / byte_rate;
    uint64_t capacity_us = chunk_us * MOONLIGHT_AUDIO_SLOTS;
    *policy = (AudioQueuePolicy){
        .chunk_us = chunk_us,
        .target_us = (uint64_t)in->target_ms * 1000,
        .burst_us = (uint64_t)in->burst_ms * 1000,
        .window_us = (uint64_t)in->window_ms * 1000,
        .output_us = (uint64_t)in->output_ms * 1000,
    };

    bool output_ok = within(policy->output_us, chunk_us * 2, capacity_us);
    bool target_ok = within(policy->target_us, policy->output_us, capacity_us);
    bool burst_ok = within(policy->burst_us, policy->target_us, capacity_us - chunk_us);
    if (!output_ok || !target_ok || !burst_ok)
        return MOONLIGHT_AUDIO_INVALID;

    bool window_ok = in->window_ms >= 50 && in->window_ms <= 10000;
    bool fade_ok = in->fade_frames <= config->chunk_bytes / frame_bytes;
    if (!window_ok || !fade_ok)
        return MOONLIGHT_AUDIO_INVALID;

    return MOONLIGHT_AUDIO_OK;
}

static void keep_memory(MoonlightAudio *audio, const char *why)
{
    retired = true;
    report(audio, "audio: media memory kept (%s); restart before reopening audio", why);
}

static void free_audio(MoonlightAudio *audio)
{
    free(audio->memory);
    free(audio);
}

static bool format_matches(const MoonlightAudioConfig *config, const AoutFormat *format)
{
    bool rate_ok = format->sample_rate == config->sample_rate;
    bool channels_ok = format->channels == config->channels;
    bool sample_ok = format->sample_bits == 16 && format->sample_signed;
    return rate_ok && channels_ok && sample_ok;
}

MoonlightAudioResult aoutAudioOpenWithBackend(const MoonlightAudioConfig *config, MoonlightAudioLog log,
    const AoutBackend *backend, MoonlightAudio **out)
{
    if (!out)
        return MOONLIGHT_AUDIO_INVALID;
    *out = NULL;
    if (!config || !backend)
        return MOONLIGHT_AUDIO_INVALID;
    if (retired)
        return MOONLIGHT_AUDIO_RETIRED;

    AudioQueuePolicy policy;
    MoonlightAudioResult checked = check_config(config, &policy);
    if (checked != MOONLIGHT_AUDIO_OK)
        return checked;

    MoonlightAudio *audio = calloc(1, sizeof(*audio));
    if (!audio)
        return MOONLIGHT_AUDIO_NO_MEMORY;
    audio->memory = aligned_alloc(SLOT_ALIGNMENT, MOONLIGHT_AUDIO_SLOTS * MOONLIGHT_AUDIO_SLOT_BYTES);
    if (!audio->memory) {
        free(audio);
        return MOONLIGHT_AUDIO_NO_MEMORY;
    }

    memset(audio->memory, 0, MOONLIGHT_AUDIO_SLOTS * MOONLIGHT_AUDIO_SLOT_BYTES);
    audio->backend = *backend;
    audio->config = *config;
    audio->log = log;
    for (unsigned i = 0; i < MOONLIGHT_AUDIO_SLOTS; i++) {
        audio->slots[i] = audio->memory + (size_t)i * MOONLIGHT_AUDIO_SLOT_BYTES;
        audio->entry_of[i] = NONE;
    }
    audio->current = NONE;
    audio->fade_bytes = config->policy.fade_frames * config->channels * 2;
    audio->last_pump = NONE;
    audio->last_playing = NONE;
    audio->starved_since = NONE;
    audioQueueInit(&audio->queue, &policy);

    AoutFormat format = {0};
    AoutStatus status = backend->open(backend->context, audio->slots, &format);
    if (status == AOUT_UNCERTAIN) {
        fail(audio, "open", status);
        keep_memory(audio, "open uncertain");
        return MOONLIGHT_AUDIO_UNCERTAIN;
    }
    if (status != AOUT_OK) {
        MoonlightAudioResult result = fail(audio, "open", status);
        free_audio(audio);
        return result;
    }

    audio->opened = true;
    report(audio, "audio: output %u Hz, %u channels, %u-bit %s", format.sample_rate, format.channels,
        format.sample_bits, format.sample_signed ? "signed" : "unsigned");
    if (!format_matches(config, &format)) {
        report(audio, "audio: wanted %u Hz, %u channels, 16-bit signed", config->sample_rate, config->channels);
        MoonlightAudioResult closed = moonlightAudioClose(audio);
        return closed == MOONLIGHT_AUDIO_OK ? MOONLIGHT_AUDIO_UNSUPPORTED : closed;
    }

    *out = audio;
    return MOONLIGHT_AUDIO_OK;
}

static int free_slot(const MoonlightAudio *audio)
{
    for (unsigned i = 0; i < MOONLIGHT_AUDIO_SLOTS; i++) {
        if (audio->state[i] == SLOT_FREE)
            return (int)i;
    }
    return NONE;
}

static uint32_t get32(const uint8_t *at)
{
    return (uint32_t)at[0] | (uint32_t)at[1] << 8 | (uint32_t)at[2] << 16 | (uint32_t)at[3] << 24;
}

static void complete_chunk(MoonlightAudio *audio)
{
    unsigned slot = (unsigned)audio->current;
    unsigned position = (audio->entry_head + audio->entry_count) % MOONLIGHT_AUDIO_SLOTS;
    memcpy(audio->entries[position].header, audio->header, MOONLIGHT_AUDIO_HEADER_BYTES);
    audio->entries[position].done = false;
    audio->entry_count++;

    audio->entry_of[slot] = (int)position;
    audio->state[slot] = SLOT_WAITING;
    audioQueuePush(&audio->queue, (uint8_t)slot);
    audio->stats.received++;

    audio->current = NONE;
    audio->header_bytes = 0;
    audio->data_bytes = 0;
}

static size_t copy_some(uint8_t *to, size_t room, const uint8_t *from, size_t available)
{
    size_t count = room < available ? room : available;
    memcpy(to, from, count);
    return count;
}

MoonlightAudioResult moonlightAudioReceive(MoonlightAudio *audio, const uint8_t *data, size_t bytes,
    size_t *taken)
{
    if (!audio || !taken || (!data && bytes))
        return MOONLIGHT_AUDIO_INVALID;
    *taken = 0;
    if (audio->failed)
        return MOONLIGHT_AUDIO_FAILED;

    while (*taken < bytes) {
        if (audio->current == NONE) {
            if (audio->entry_count == MOONLIGHT_AUDIO_SLOTS)
                break;
            audio->current = free_slot(audio);
            if (audio->current == NONE)
                break;
            audio->state[audio->current] = SLOT_RECEIVING;
        }

        const uint8_t *from = data + *taken;
        size_t available = bytes - *taken;
        if (audio->header_bytes < MOONLIGHT_AUDIO_HEADER_BYTES) {
            size_t room = MOONLIGHT_AUDIO_HEADER_BYTES - audio->header_bytes;
            size_t count = copy_some(audio->header + audio->header_bytes, room, from, available);
            audio->header_bytes += (unsigned)count;
            *taken += count;
            if (audio->header_bytes < MOONLIGHT_AUDIO_HEADER_BYTES)
                break;

            uint32_t length = get32(audio->header);
            if (length != audio->config.chunk_bytes) {
                audio->failed = true;
                report(audio, "audio: record of %u bytes, expected %u", length, audio->config.chunk_bytes);
                return MOONLIGHT_AUDIO_INVALID;
            }
            continue;
        }

        uint8_t *slot = audio->slots[audio->current];
        size_t room = audio->config.chunk_bytes - audio->data_bytes;
        size_t count = copy_some(slot + audio->data_bytes, room, from, available);
        audio->data_bytes += (uint32_t)count;
        *taken += count;
        if (audio->data_bytes == audio->config.chunk_bytes)
            complete_chunk(audio);
    }

    if (bytes && *taken == 0)
        return MOONLIGHT_AUDIO_AGAIN;
    return MOONLIGHT_AUDIO_OK;
}

static void finish(MoonlightAudio *audio, unsigned slot)
{
    if (audio->entry_of[slot] != NONE)
        audio->entries[audio->entry_of[slot]].done = true;
    audio->entry_of[slot] = NONE;
    audio->state[slot] = SLOT_FREE;
}

static void track_pump_gap(MoonlightAudio *audio, int64_t now)
{
    if (audio->last_pump != NONE) {
        uint64_t gap = (uint64_t)(now - audio->last_pump);
        if (gap > audio->stats.longest_pump_gap_ms)
            audio->stats.longest_pump_gap_ms = gap;
        if (gap > audio->config.policy.output_ms)
            audio->stats.pump_gaps_over_output++;
    }
    audio->last_pump = now;
}

static MoonlightAudioResult collect_released(MoonlightAudio *audio)
{
    for (unsigned i = 0; i < MOONLIGHT_AUDIO_SLOTS; i++) {
        int slot = NONE;
        AoutStatus status = audio->backend.released(audio->backend.context, &slot);
        if (status != AOUT_OK)
            return fail(audio, "released", status);
        if (slot == NONE)
            break;

        bool known = slot >= 0 && slot < (int)MOONLIGHT_AUDIO_SLOTS && audio->state[slot] == SLOT_OUTPUT;
        if (!known || !audioQueueRelease(&audio->queue))
            return fail(audio, "unexpected released buffer", AOUT_UNCERTAIN);

        finish(audio, (unsigned)slot);
        audio->stats.released++;
    }
    return MOONLIGHT_AUDIO_OK;
}

static MoonlightAudioResult poll_starvation(MoonlightAudio *audio, int64_t now)
{
    if (!audio->started || audio->starved_since != NONE)
        return MOONLIGHT_AUDIO_OK;
    if (audio->queue.output > 1) {
        audio->last_playing = now;
        return MOONLIGHT_AUDIO_OK;
    }

    uint32_t count = 0;
    AoutStatus status = audio->backend.queued(audio->backend.context, &count);
    if (status != AOUT_OK)
        return fail(audio, "queued", status);
    if (count > 0) {
        audio->last_playing = now;
        return MOONLIGHT_AUDIO_OK;
    }

    audio->stats.polled_starvations++;
    audio->starved_since = now;
    return MOONLIGHT_AUDIO_OK;
}

static void end_starvation(MoonlightAudio *audio, int64_t now)
{
    if (audio->starved_since == NONE)
        return;

    audio->stats.starved_ms_at_least += (uint64_t)(now - audio->starved_since);
    audio->stats.starved_ms_at_most += (uint64_t)(now - audio->last_playing);
    audio->starved_since = NONE;
}

static MoonlightAudioResult append_slot(MoonlightAudio *audio, unsigned slot, int64_t now)
{
    if (audio->fade_pending) {
        audioCrossfade(audio->fade, audio->fade_bytes, audio->slots[slot], audio->fade_bytes,
            audio->config.policy.fade_frames, audio->config.channels);
        audio->fade_pending = false;
        audio->stats.crossfades++;
    }

    AoutStatus status = audio->backend.append(audio->backend.context, slot, audio->config.chunk_bytes);
    if (status == AOUT_UNCERTAIN)
        audio->state[slot] = SLOT_OUTPUT;
    if (status != AOUT_OK)
        return fail(audio, "append", status);

    audio->state[slot] = SLOT_OUTPUT;
    audio->stats.appended++;
    end_starvation(audio, now);
    return MOONLIGHT_AUDIO_OK;
}

static MoonlightAudioResult apply(MoonlightAudio *audio, const AudioQueueStep *step, int64_t now)
{
    if (step->dropped_count && !audio->fade_pending && audio->fade_bytes) {
        memcpy(audio->fade, audio->slots[step->dropped[0]], audio->fade_bytes);
        audio->fade_pending = true;
    }
    for (unsigned i = 0; i < step->dropped_count; i++)
        finish(audio, step->dropped[i]);

    for (unsigned i = 0; i < step->appended_count; i++) {
        MoonlightAudioResult result = append_slot(audio, step->appended[i], now);
        if (result != MOONLIGHT_AUDIO_OK)
            return result;
    }

    if (audio->started || audio->queue.output < 2)
        return MOONLIGHT_AUDIO_OK;

    AoutStatus status = audio->backend.start(audio->backend.context);
    if (status != AOUT_OK)
        return fail(audio, "start", status);
    audio->started = true;
    audio->last_playing = now;
    return MOONLIGHT_AUDIO_OK;
}

static void copy_queue_stats(MoonlightAudio *audio)
{
    const AudioQueueStats *queue = &audio->queue.stats;
    audio->stats.dropped = queue->dropped;
    audio->stats.cuts = queue->cuts;
    audio->stats.depth_ms = (uint32_t)(queue->depth_us / 1000);
    audio->stats.max_depth_ms = (uint32_t)(queue->max_depth_us / 1000);
}

MoonlightAudioResult moonlightAudioPump(MoonlightAudio *audio, uint64_t now_ms)
{
    if (!audio || now_ms > INT64_MAX)
        return MOONLIGHT_AUDIO_INVALID;
    if (audio->failed)
        return MOONLIGHT_AUDIO_FAILED;
    if (audio->last_pump != NONE && (int64_t)now_ms < audio->last_pump)
        return MOONLIGHT_AUDIO_INVALID;

    int64_t now = (int64_t)now_ms;
    track_pump_gap(audio, now);
    MoonlightAudioResult result = collect_released(audio);
    if (result == MOONLIGHT_AUDIO_OK)
        result = poll_starvation(audio, now);
    if (result == MOONLIGHT_AUDIO_OK) {
        AudioQueueStep step;
        audioQueueStep(&audio->queue, now_ms * 1000, &step);
        result = apply(audio, &step, now);
    }

    copy_queue_stats(audio);
    return result;
}

MoonlightAudioResult moonlightAudioTakeAcknowledgement(MoonlightAudio *audio,
    uint8_t header[MOONLIGHT_AUDIO_HEADER_BYTES])
{
    if (!audio || !header)
        return MOONLIGHT_AUDIO_INVALID;
    if (audio->entry_count == 0 || !audio->entries[audio->entry_head].done)
        return MOONLIGHT_AUDIO_AGAIN;

    memcpy(header, audio->entries[audio->entry_head].header, MOONLIGHT_AUDIO_HEADER_BYTES);
    audio->entry_head = (audio->entry_head + 1) % MOONLIGHT_AUDIO_SLOTS;
    audio->entry_count--;
    audio->stats.acknowledged++;
    return MOONLIGHT_AUDIO_OK;
}

void moonlightAudioGetStats(const MoonlightAudio *audio, MoonlightAudioStats *stats)
{
    if (audio && stats)
        *stats = audio->stats;
}

static MoonlightAudioResult worse(MoonlightAudioResult current, MoonlightAudioResult next)
{
    if (current == MOONLIGHT_AUDIO_UNCERTAIN || next == MOONLIGHT_AUDIO_OK)
        return current;
    return next;
}

static MoonlightAudioResult drain_device(MoonlightAudio *audio)
{
    MoonlightAudioResult result = MOONLIGHT_AUDIO_OK;
    if (audio->started) {
        AoutStatus status = audio->backend.stop(audio->backend.context);
        if (status != AOUT_OK)
            result = fail(audio, "stop", status);
    }
    if (audio->uncertain)
        return result;

    AoutStatus status = audio->backend.flush(audio->backend.context);
    if (status != AOUT_OK)
        result = worse(result, fail(audio, "flush", status));
    if (audio->uncertain)
        return result;

    for (unsigned i = 0; i < MOONLIGHT_AUDIO_SLOTS * 2; i++) {
        int slot = NONE;
        status = audio->backend.released(audio->backend.context, &slot);
        if (status != AOUT_OK)
            return worse(result, fail(audio, "released", status));
        if (slot == NONE)
            break;
        if (slot >= 0 && slot < (int)MOONLIGHT_AUDIO_SLOTS && audio->state[slot] == SLOT_OUTPUT)
            finish(audio, (unsigned)slot);
    }
    return result;
}

static bool device_holds_buffers(MoonlightAudio *audio)
{
    for (unsigned i = 0; i < MOONLIGHT_AUDIO_SLOTS; i++) {
        if (audio->state[i] != SLOT_OUTPUT)
            continue;

        bool contains = true;
        AoutStatus status = audio->backend.contains(audio->backend.context, i, &contains);
        if (status != AOUT_OK) {
            fail(audio, "contains", status);
            return true;
        }
        if (contains) {
            report(audio, "audio: buffer %u still queued after flush", i);
            return true;
        }
        finish(audio, i);
    }
    return false;
}

MoonlightAudioResult moonlightAudioClose(MoonlightAudio *audio)
{
    if (!audio)
        return MOONLIGHT_AUDIO_INVALID;

    if (audio->uncertain) {
        keep_memory(audio, "an earlier call was uncertain");
        return MOONLIGHT_AUDIO_UNCERTAIN;
    }

    MoonlightAudioResult result = drain_device(audio);
    bool held = audio->uncertain || device_holds_buffers(audio);
    if (held) {
        keep_memory(audio, "the device may still read a buffer");
        return audio->uncertain ? MOONLIGHT_AUDIO_UNCERTAIN : MOONLIGHT_AUDIO_FAILED;
    }

    AoutStatus status = audio->backend.close(audio->backend.context);
    if (status != AOUT_OK) {
        result = worse(result, fail(audio, "close", status));
        retired = true;
        report(audio, "audio: output may still be open; restart before reopening audio");
    }

    report(audio, "audio: closed, %llu appended, %llu dropped, %llu acknowledged",
        (unsigned long long)audio->stats.appended, (unsigned long long)audio->stats.dropped,
        (unsigned long long)audio->stats.acknowledged);
    free_audio(audio);
    return result;
}
