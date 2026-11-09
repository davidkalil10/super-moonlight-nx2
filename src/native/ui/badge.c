#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "badge.h"

#if defined(__clang__)
#pragma STDC FP_CONTRACT OFF
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

#define REFERENCE_HEIGHT 1080.0
#define PADDING_X 14
#define PADDING_Y 4
#define MARGIN 24
#define ACCENT_WIDTH 4
#define MAX_WIDTH 960
#define MAX_HEIGHT 96
#define WIDTH 1920u
#define HEIGHT 1080u

typedef struct {
    uint32_t size;
    uint32_t weight;
} Font;

typedef struct {
    Font font;
    uint32_t padding_x;
    uint32_t padding_y;
    uint32_t accent;
    uint32_t margin;
} Metrics;

static const Font FONTS[] = {{26, 600}, {24, 600}, {22, 600}, {18, 700}};
static const double BACKGROUND[3] = {12, 16, 24};
static const double INK[3] = {240, 246, 250};
static const double ACCENT[3] = {64, 217, 230};

static uint32_t even(double value)
{
    return (uint32_t)(floor(value / 2 + 0.5) * 2);
}

static Metrics metrics(uint32_t frame_height)
{
    const double scale = frame_height / REFERENCE_HEIGHT;
    const double wanted = FONTS[0].size * scale + 0.5;
    Font font = FONTS[3];
    for (unsigned i = 0; i < 4; i++) {
        if (FONTS[i].size <= wanted) {
            font = FONTS[i];
            break;
        }
    }
    const uint32_t accent = even(ACCENT_WIDTH * scale);
    return (Metrics){font, even(PADDING_X * scale), even(PADDING_Y * scale), accent > 2 ? accent : 2,
        even(MARGIN * scale)};
}

static bool line(MoonlightGlyphs *glyphs, const char *text, uint32_t frame_width, Font font, MoonlightBitmap *out)
{
    const MoonlightTextStyle style = {font.weight, 0};
    return moonlightGlyphsText(glyphs, text, font.size, frame_width / 2, MOONLIGHT_ALIGN_LEFT, &style, out);
}

static uint32_t ink_width(const MoonlightBitmap *strip)
{
    for (uint32_t x = strip->width; x > 0; x--) {
        for (uint32_t y = 0; y < strip->height; y++) {
            if (strip->bytes[y * strip->width + x - 1])
                return x;
        }
    }
    return 0;
}

static void paint_rows(uint8_t *rgba, uint32_t width, uint32_t from, uint32_t to, const MoonlightBitmap *strip,
    uint32_t top, const Metrics *metric)
{
    for (uint32_t y = from; y < to; y++) {
        for (uint32_t x = 0; x < width; x++) {
            const int64_t text_x = (int64_t)x - metric->accent - metric->padding_x;
            const int64_t text_y = (int64_t)y - top;
            const bool in_strip = text_x >= 0 && text_x < strip->width && text_y >= 0 && text_y < strip->height;
            const double alpha = in_strip ? strip->bytes[text_y * strip->width + text_x] / 255.0 : 0;
            const double *under = x < metric->accent ? ACCENT : BACKGROUND;
            uint8_t *at = rgba + ((size_t)(y - from) * width + x) * 4;
            for (int channel = 0; channel < 3; channel++)
                at[channel] = (uint8_t)floor(under[channel] + (INK[channel] - under[channel]) * alpha + 0.5);
            at[3] = 255;
        }
    }
}

void moonlightBadgeFree(MoonlightBadge *badge)
{
    free(badge->rgba);
    *badge = (MoonlightBadge){0};
}

static const char *counter_widest(char *out, size_t size)
{
    moonlightBadgeCounterText(out, size, 888, 888, 888, 888);
    return out;
}

const char *moonlightBadgeCompose(MoonlightGlyphs *glyphs, const char *text, uint32_t frame_width,
    uint32_t frame_height, const char *counter, MoonlightBadge *out)
{
    *out = (MoonlightBadge){0};
    const Metrics metric = metrics(frame_height);
    const char *lines[2];
    uint32_t count = 0;
    if (!counter || text[0])
        lines[count++] = text;
    if (counter)
        lines[count++] = counter;

    MoonlightBitmap strips[3] = {{0}};
    uint32_t sized = count;
    char widest[ML_BADGE_TEXT_BYTES];
    bool ok = true;
    for (uint32_t i = 0; i < count; i++)
        ok = ok && line(glyphs, lines[i], frame_width, metric.font, &strips[i]);
    if (ok && counter)
        ok = line(glyphs, counter_widest(widest, sizeof(widest)), frame_width, metric.font, &strips[sized++]);

    const char *error = ok ? NULL : "Badge text could not be painted";
    uint32_t widest_ink = 0;
    for (uint32_t i = 0; ok && i < sized; i++) {
        const uint32_t ink = ink_width(&strips[i]);
        if (ink > widest_ink)
            widest_ink = ink;
    }
    const uint32_t line_height = ok ? strips[0].height : 0;
    const uint32_t width = even(widest_ink + metric.accent + 2.0 * metric.padding_x);
    const uint32_t height = even((double)line_height * count + 2.0 * metric.padding_y);
    const bool fits = width <= MAX_WIDTH && height <= MAX_HEIGHT && width <= frame_width && height <= frame_height;
    if (!error && !fits)
        error = "Badge does not fit the frame";

    uint8_t *rgba = error ? NULL : calloc((size_t)width * height, 4);
    if (!error && !rgba)
        error = "Badge allocation failed";

    uint32_t tops[2] = {0};
    for (uint32_t i = 0; i < count; i++)
        tops[i] = metric.padding_y + i * line_height;
    for (uint32_t i = 0; !error && i < count; i++) {
        const uint32_t from = i ? tops[i] : 0;
        const uint32_t to = i == count - 1 ? height : tops[i + 1];
        paint_rows(rgba + (size_t)from * width * 4, width, from, to, &strips[i], tops[i], &metric);
    }
    for (uint32_t i = 0; i < sized; i++)
        moonlightBitmapFree(&strips[i]);
    if (error)
        return error;

    const uint32_t last = count - 1;
    *out = (MoonlightBadge){
        .x = frame_width - metric.margin - width,
        .y = metric.margin,
        .width = width,
        .height = height,
        .rgba = rgba,
        .has_counter = counter != NULL,
        .counter_from = last ? tops[last] : 0,
        .counter_top = tops[last],
    };
    return NULL;
}

const char *moonlightBadgeComposeCounter(MoonlightGlyphs *glyphs, const MoonlightBadge *badge, const char *counter,
    uint32_t frame_width, uint32_t frame_height, uint8_t **rgba, size_t *offset, size_t *length)
{
    if (!badge->has_counter)
        return "The badge has no counter line";

    const Metrics metric = metrics(frame_height);
    MoonlightBitmap strip = {0};
    if (!line(glyphs, counter, frame_width, metric.font, &strip))
        return "Badge text could not be painted";

    const uint32_t rows = badge->height - badge->counter_from;
    *length = (size_t)rows * badge->width * 4;
    *offset = (size_t)badge->counter_from * badge->width * 4;
    *rgba = calloc(*length ? *length : 1, 1);
    if (*rgba)
        paint_rows(*rgba, badge->width, badge->counter_from, badge->height, &strip, badge->counter_top, &metric);
    moonlightBitmapFree(&strip);
    return *rgba ? NULL : "Badge allocation failed";
}

static void number_or_dash(char *out, size_t size, int64_t value)
{
    if (value < 0)
        snprintf(out, size, "-");
    else
        snprintf(out, size, "%lld", (long long)value);
}

void moonlightBadgeCounterText(char *out, size_t size, int64_t presented, int64_t caught_up, int64_t dropped,
    int64_t console_ms)
{
    char parts[4][24];
    number_or_dash(parts[0], sizeof(parts[0]), presented);
    number_or_dash(parts[1], sizeof(parts[1]), caught_up);
    number_or_dash(parts[2], sizeof(parts[2]), dropped);
    number_or_dash(parts[3], sizeof(parts[3]), console_ms);
    snprintf(out, size, "%s fps \xc2\xb7 %s skipped \xc2\xb7 %s dropped \xc2\xb7 console %s ms", parts[0], parts[1],
        parts[2], parts[3]);
}

void moonlightBadgeRateText(char *out, size_t size, uint32_t from_height, uint32_t from_fps, uint32_t to_height,
    uint32_t to_fps)
{
    if (from_fps == to_fps && from_height != to_height)
        snprintf(out, size, "%up \xe2\x96\xb8 %up", from_height, to_height);
    else
        snprintf(out, size, "%up%u \xe2\x96\xb8 %up%u", from_height, from_fps, to_height, to_fps);
}

static void put_word(uint8_t *storage, uint32_t offset, uint32_t value)
{
    memcpy(storage + offset, &value, sizeof(value));
}

static void set_visible(MoonlightBadgeController *badge, bool visible)
{
    put_word(badge->storage, ML_BADGE_WORDS, visible ? 1u : 0u);
}

static void hide(MoonlightBadgeController *badge)
{
    if (badge->armed)
        set_visible(badge, false);
    badge->armed = false;
}

static void fail(MoonlightBadgeController *badge, const char *error)
{
    badge->failed = true;
    badge->failure = error;
}

static bool put(MoonlightBadgeController *badge, const MoonlightBadge *composed, uint32_t duration_ms)
{
    const size_t bytes = (size_t)composed->width * composed->height * 4;
    if (bytes > ML_BADGE_MAX_BYTES) {
        fail(badge, "Badge exceeds its pixel area");
        return false;
    }

    hide(badge);
    memcpy(badge->storage + ML_BADGE_PIXELS, composed->rgba, bytes);
    const uint32_t words[5] = {0, composed->x, composed->y, composed->width, composed->height};
    memcpy(badge->storage + ML_BADGE_WORDS, words, sizeof(words));
    badge->armed_ms = duration_ms;
    badge->until_ns = 0;
    badge->armed = true;
    set_visible(badge, true);
    return true;
}

void moonlightBadgeStart(MoonlightBadgeController *badge, uint8_t *storage, MoonlightGlyphs *glyphs, const char *text,
    uint32_t duration_ms, bool counter)
{
    *badge = (MoonlightBadgeController){.storage = storage, .glyphs = glyphs, .duration_ms = duration_ms,
        .counter = counter, .console_ms = -1};
    snprintf(badge->text, sizeof(badge->text), "%s", text);
    moonlightBadgeCounterText(badge->counted, sizeof(badge->counted), -1, -1, -1, -1);
}

void moonlightBadgeShow(MoonlightBadgeController *badge)
{
    if (badge->failed)
        return;

    MoonlightBadge composed;
    const char *error = moonlightBadgeCompose(badge->glyphs, badge->text, WIDTH, HEIGHT,
        badge->counter ? badge->counted : NULL, &composed);
    if (error) {
        fail(badge, error);
        return;
    }
    if (!put(badge, &composed, badge->duration_ms)) {
        moonlightBadgeFree(&composed);
        return;
    }
    moonlightBadgeFree(&badge->shown);
    badge->shown = composed;
}

void moonlightBadgeNote(MoonlightBadgeController *badge, const char *line, uint64_t now_ns)
{
    if (badge->failed)
        return;

    const bool back = badge->duration_ms == ML_BADGE_STAYS && badge->shown.rgba != NULL;
    moonlightBadgeFree(&badge->shown);
    MoonlightBadge composed;
    const char *error = moonlightBadgeCompose(badge->glyphs, line, WIDTH, HEIGHT, NULL, &composed);
    if (error) {
        fail(badge, error);
        return;
    }
    const bool shown = put(badge, &composed, back ? ML_BADGE_STAYS : ML_BADGE_NOTE_MS);
    moonlightBadgeFree(&composed);
    if (shown && back)
        badge->restore_ns = now_ns + (uint64_t)ML_BADGE_NOTE_MS * 1000000u;
}

void moonlightBadgeStats(MoonlightBadgeController *badge, int64_t presented, int64_t caught_up, int64_t dropped_total,
    bool has_console, int64_t console_mean_ms)
{
    if (!badge->counter)
        return;

    if (has_console)
        badge->console_ms = console_mean_ms;
    const int64_t dropped = dropped_total - badge->dropped > 0 ? dropped_total - badge->dropped : 0;
    char line[ML_BADGE_TEXT_BYTES];
    moonlightBadgeCounterText(line, sizeof(line), presented, caught_up, dropped, badge->console_ms);
    badge->dropped = dropped_total;
    if (!strcmp(line, badge->counted))
        return;

    snprintf(badge->counted, sizeof(badge->counted), "%s", line);
    if (badge->failed || !badge->shown.rgba)
        return;

    uint8_t *rgba = NULL;
    size_t offset = 0;
    size_t length = 0;
    const char *error = moonlightBadgeComposeCounter(badge->glyphs, &badge->shown, line, WIDTH, HEIGHT, &rgba,
        &offset, &length);
    if (error) {
        fail(badge, error);
        return;
    }
    memcpy(badge->storage + ML_BADGE_PIXELS + offset, rgba, length);
    free(rgba);
}

void moonlightBadgeFrame(MoonlightBadgeController *badge, uint64_t now_ns)
{
    if (badge->restore_ns && now_ns >= badge->restore_ns) {
        badge->restore_ns = 0;
        moonlightBadgeShow(badge);
    }
    if (!badge->armed || badge->armed_ms == ML_BADGE_STAYS)
        return;

    if (!badge->until_ns)
        badge->until_ns = now_ns + (uint64_t)badge->armed_ms * 1000000u;
    else if (now_ns >= badge->until_ns)
        hide(badge);
}

void moonlightBadgeStop(MoonlightBadgeController *badge)
{
    hide(badge);
    badge->restore_ns = 0;
    moonlightBadgeFree(&badge->shown);
}
