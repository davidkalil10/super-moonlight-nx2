#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "glyphs.h"

// The stream badge of src/streamer/civ7/rate-badge.js: composed RGBA in the renderer's third
// frame area, its rectangle in the badge words, shown for a duration or for the whole stream.
#define ML_BADGE_WORDS 0xb100u
#define ML_BADGE_PIXELS 27492352u
#define ML_BADGE_MAX_BYTES (960u * 64u * 4u)
#define ML_BADGE_MS 4000u
#define ML_BADGE_STAYS 0u
#define ML_BADGE_NOTE_MS 7000u
#define ML_BADGE_TEXT_BYTES 192u
#define ML_BADGE_TOUCH_NOTE "Touch is off on this PC \xc2\xb7 enable Native Pen/Touch Support in Sunshine"

typedef struct {
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
    uint8_t *rgba;
    bool has_counter;
    uint32_t counter_from;
    uint32_t counter_top;
} MoonlightBadge;

const char *moonlightBadgeCompose(MoonlightGlyphs *glyphs, const char *text, uint32_t frame_width,
    uint32_t frame_height, const char *counter, MoonlightBadge *out);
const char *moonlightBadgeComposeCounter(MoonlightGlyphs *glyphs, const MoonlightBadge *badge, const char *counter,
    uint32_t frame_width, uint32_t frame_height, uint8_t **rgba, size_t *offset, size_t *length);
void moonlightBadgeFree(MoonlightBadge *badge);

void moonlightBadgeCounterText(char *out, size_t size, int64_t presented, int64_t caught_up, int64_t dropped,
    int64_t console_ms);
void moonlightBadgeRateText(char *out, size_t size, uint32_t from_height, uint32_t from_fps, uint32_t to_height,
    uint32_t to_fps);

typedef struct {
    uint8_t *storage;
    MoonlightGlyphs *glyphs;
    char text[ML_BADGE_TEXT_BYTES];
    uint32_t duration_ms;
    bool counter;
    bool failed;
    const char *failure;
    MoonlightBadge shown;
    char counted[ML_BADGE_TEXT_BYTES];
    int64_t dropped;
    int64_t console_ms;
    bool armed;
    uint32_t armed_ms;
    uint64_t until_ns;
    uint64_t restore_ns;
} MoonlightBadgeController;

void moonlightBadgeStart(MoonlightBadgeController *badge, uint8_t *storage, MoonlightGlyphs *glyphs, const char *text,
    uint32_t duration_ms, bool counter);
void moonlightBadgeShow(MoonlightBadgeController *badge);
void moonlightBadgeNote(MoonlightBadgeController *badge, const char *line, uint64_t now_ns);
void moonlightBadgeStats(MoonlightBadgeController *badge, int64_t presented, int64_t caught_up, int64_t dropped_total,
    bool has_console, int64_t console_mean_ms);
void moonlightBadgeFrame(MoonlightBadgeController *badge, uint64_t now_ns);
void moonlightBadgeStop(MoonlightBadgeController *badge);
