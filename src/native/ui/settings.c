#include <math.h>
#include <stdio.h>
#include <string.h>

#include "../ui.h"
#include "json.h"

#if defined(__clang__)
#pragma STDC FP_CONTRACT OFF
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

#define CURRENT_DEFAULTS 2u
#define AUTO_BITRATE 0u
#define MAX_VALUES 16u

typedef enum {
    KIND_SIZE,
    KIND_FPS,
    KIND_BITRATE,
    KIND_CODEC,
    KIND_TOGGLE,
} Kind;

typedef struct {
    const char *id;
    const char *label;
    Kind kind;
    uint8_t count;
    uint8_t fallback;
    uint32_t reset_before;
    int8_t former_default;
} Row;

static const char *const SIZES[] = {"1280x720", "1920x1080", "2560x1440", "3840x2160"};
static const uint32_t WIDTHS[] = {1280, 1920, 2560, 3840};
static const uint32_t HEIGHTS[] = {720, 1080, 1440, 2160};
static const char *const SIZE_TEXT[] = {"1280 \xc3\x97 720", "1920 \xc3\x97 1080", "2560 \xc3\x97 1440 (docked)",
    "3840 \xc3\x97 2160 (docked, 60 fps)"};
static const char *const SIZE_SHORT[] = {"", "", "1440p", "4K"};
static const uint32_t RATES[] = {60, 120};
static const char *const CODECS[] = {"h264", "av1"};
static const char *const CODEC_TEXT[] = {"H.264", "AV1"};

static const Row ROWS[MOONLIGHT_SETTING_COUNT] = {
    {"size", "Resolution", KIND_SIZE, 4, MOONLIGHT_SIZE_1080P, 0, -1},
    {"fps", "Frame rate", KIND_FPS, 2, 0, 0, -1},
    {"bitrate", "Bitrate", KIND_BITRATE, 16, 0, 0, 7},
    {"codec", "Codec", KIND_CODEC, 2, MOONLIGHT_STREAM_CODEC_AV1, 4, -1},
    {"hostAudio", "Play audio on the PC", KIND_TOGGLE, 2, 0, 0, -1},
    {"optimise", "Optimise game settings", KIND_TOGGLE, 2, 0, 0, -1},
    {"quitOnReturn", "Quit host app on return", KIND_TOGGLE, 2, 0, 0, -1},
    {"menuChord", "Hold L+R for menu", KIND_TOGGLE, 2, 1, 0, -1},
    {"streamInfo", "Stream info badge", KIND_TOGGLE, 2, 0, 0, -1},
    {"frameCounter", "Frame counter", KIND_TOGGLE, 2, 0, 0, -1},
};

static double bitrate_mbps(uint8_t index)
{
    return 5.0 + (index - 1) * 2.5;
}

static bool docked_size(uint8_t size)
{
    return size == MOONLIGHT_SIZE_1440P || size == MOONLIGHT_SIZE_2160P;
}

MoonlightCapabilities moonlightCapabilitiesAll(void)
{
    return (MoonlightCapabilities){.h264 = true, .av1 = true, .fps120 = true, .docked_sizes = true};
}

bool moonlightCapabilitiesLaunchable(const MoonlightCapabilities *capabilities)
{
    return !capabilities || capabilities->h264 || capabilities->av1;
}

static bool codec_available(const MoonlightCapabilities *caps, uint8_t codec)
{
    return codec == MOONLIGHT_STREAM_CODEC_H264 ? caps->h264 : caps->av1;
}

static const MoonlightCapabilities *capabilities_or_all(const MoonlightCapabilities *capabilities)
{
    static const MoonlightCapabilities all = {true, true, true, true};
    return capabilities ? capabilities : &all;
}

void moonlightSettingsDefaults(MoonlightSettings *settings)
{
    *settings = (MoonlightSettings){0};
    for (unsigned id = 0; id < MOONLIGHT_SETTING_COUNT; id++)
        settings->value[id] = ROWS[id].fallback;
}

static int match_value(const MoonlightJson *json, const MoonlightJsonNode *node, const Row *row)
{
    if (!node)
        return -1;

    switch (row->kind) {
    case KIND_SIZE:
        for (int i = 0; i < 4; i++) {
            if (moonlightJsonStringIs(json, node, SIZES[i]))
                return i;
        }
        return -1;
    case KIND_FPS:
        for (int i = 0; i < 2; i++) {
            if (node->type == ML_JSON_NUMBER && node->number == RATES[i])
                return i;
        }
        return -1;
    case KIND_BITRATE:
        if (moonlightJsonStringIs(json, node, "auto"))
            return AUTO_BITRATE;
        for (int i = 1; i < row->count; i++) {
            if (node->type == ML_JSON_NUMBER && node->number == bitrate_mbps((uint8_t)i))
                return i;
        }
        return -1;
    case KIND_CODEC:
        for (int i = 0; i < 2; i++) {
            if (moonlightJsonStringIs(json, node, CODECS[i]))
                return i;
        }
        return -1;
    case KIND_TOGGLE:
        if (node->type == ML_JSON_FALSE)
            return 0;
        if (node->type == ML_JSON_TRUE)
            return 1;
        return -1;
    }
    return -1;
}

static bool known_rate(double value)
{
    return value == 60 || value == 120;
}

static void clamp_4k(MoonlightSettings *settings, double before)
{
    if (settings->value[MOONLIGHT_SETTING_SIZE] != MOONLIGHT_SIZE_2160P)
        return;

    const uint32_t fps = RATES[settings->value[MOONLIGHT_SETTING_FPS]];
    settings->fps_before_4k = known_rate(before) ? (uint32_t)before : fps;
    settings->value[MOONLIGHT_SETTING_FPS] = 0;
}

void moonlightSettingsSanitizeJson(const char *text, size_t length, MoonlightSettings *settings)
{
    static MoonlightJson json;
    moonlightSettingsDefaults(settings);
    if (!moonlightJsonParse(&json, text, length))
        return;

    const MoonlightJsonNode *root = moonlightJsonRoot(&json);
    if (!root || root->type != ML_JSON_OBJECT)
        return;

    const double version = moonlightJsonToNumber(&json, moonlightJsonMember(&json, root, "version"));
    const bool versioned = isfinite(version) && version == floor(version);
    const bool old_defaults = !versioned || version < CURRENT_DEFAULTS;
    for (unsigned id = 0; id < MOONLIGHT_SETTING_COUNT; id++) {
        const Row *row = &ROWS[id];
        const int value = match_value(&json, moonlightJsonMember(&json, root, row->id), row);
        const bool former = old_defaults && row->former_default >= 0 && value == row->former_default;
        const bool reset = row->reset_before > 0 && (!versioned || version < row->reset_before);
        if (value >= 0 && !former && !reset)
            settings->value[id] = (uint8_t)value;
    }

    clamp_4k(settings, moonlightJsonToNumber(&json, moonlightJsonMember(&json, root, "fpsBefore4k")));
}

static bool offered(const Row *row, uint8_t value, bool docked, const MoonlightCapabilities *caps)
{
    switch (row->kind) {
    case KIND_SIZE:
        return !docked_size(value) || (docked && caps->docked_sizes);
    case KIND_FPS:
        return RATES[value] != 120 || caps->fps120;
    case KIND_CODEC:
        return value == MOONLIGHT_STREAM_CODEC_H264 ? caps->h264 : caps->av1;
    default:
        return true;
    }
}

static bool locked(MoonlightSettingId id, const MoonlightSettings *settings)
{
    return id == MOONLIGHT_SETTING_FPS && settings->value[MOONLIGHT_SETTING_SIZE] == MOONLIGHT_SIZE_2160P;
}

bool moonlightSettingsAdjust(const MoonlightSettings *settings, MoonlightSettingId id, int direction, bool docked,
    const MoonlightCapabilities *capabilities, MoonlightSettings *out)
{
    *out = *settings;
    if ((unsigned)id >= MOONLIGHT_SETTING_COUNT || locked(id, settings) || direction == 0)
        return false;

    const MoonlightCapabilities *caps = capabilities_or_all(capabilities);
    const Row *row = &ROWS[id];
    const int step = direction > 0 ? 1 : -1;
    int index = settings->value[id] + step;
    while (index >= 0 && index < row->count && !offered(row, (uint8_t)index, docked, caps))
        index += step;
    if (index < 0 || index >= row->count)
        return false;

    const bool to_4k = id == MOONLIGHT_SETTING_SIZE && index == MOONLIGHT_SIZE_2160P;
    const bool from_4k = id == MOONLIGHT_SETTING_SIZE && settings->value[id] == MOONLIGHT_SIZE_2160P;
    out->value[id] = (uint8_t)index;
    if (to_4k) {
        out->fps_before_4k = RATES[settings->value[MOONLIGHT_SETTING_FPS]];
        out->value[MOONLIGHT_SETTING_FPS] = 0;
    } else if (from_4k) {
        if (known_rate(settings->fps_before_4k))
            out->value[MOONLIGHT_SETTING_FPS] = settings->fps_before_4k == 120 ? 1 : 0;
        out->fps_before_4k = 0;
    }
    return true;
}

static void dock_fallback(MoonlightSettings *out, bool docked)
{
    const uint8_t size = out->value[MOONLIGHT_SETTING_SIZE];
    if (docked || !docked_size(size))
        return;

    out->value[MOONLIGHT_SETTING_SIZE] = MOONLIGHT_SIZE_1080P;
    if (size == MOONLIGHT_SIZE_2160P)
        out->value[MOONLIGHT_SETTING_FPS] = 1;
}

static void capability_fallback(MoonlightSettings *out, const MoonlightCapabilities *caps)
{
    if (!caps->fps120)
        out->value[MOONLIGHT_SETTING_FPS] = 0;
    if (out->value[MOONLIGHT_SETTING_CODEC] == MOONLIGHT_STREAM_CODEC_AV1 && !caps->av1 && caps->h264)
        out->value[MOONLIGHT_SETTING_CODEC] = MOONLIGHT_STREAM_CODEC_H264;
    if (out->value[MOONLIGHT_SETTING_CODEC] == MOONLIGHT_STREAM_CODEC_H264 && !caps->h264 && caps->av1)
        out->value[MOONLIGHT_SETTING_CODEC] = MOONLIGHT_STREAM_CODEC_AV1;
}

void moonlightSettingsInUse(const MoonlightSettings *settings, bool docked, const MoonlightCapabilities *capabilities,
    MoonlightSettings *out)
{
    const MoonlightCapabilities *caps = capabilities_or_all(capabilities);
    *out = *settings;
    dock_fallback(out, docked && caps->docked_sizes);
    capability_fallback(out, caps);
}

uint32_t moonlightDefaultBitrate(uint32_t width, uint32_t height, uint32_t fps, MoonlightStreamCodec codec)
{
    static const double TABLE[][2] = {
        {640 * 360, 1}, {854 * 480, 2}, {1280 * 720, 5}, {1920 * 1080, 10}, {2560 * 1440, 20}, {3840 * 2160, 40},
    };
    const double pixels = (double)width * height;
    double factor = TABLE[5][1];
    for (int i = 0; i < 6; i++) {
        if (pixels > TABLE[i][0])
            continue;
        if (i == 0 || pixels == TABLE[i][0]) {
            factor = TABLE[i][1];
        } else {
            const double lower = TABLE[i - 1][0];
            const double base = TABLE[i - 1][1];
            factor = ((pixels - lower) / (TABLE[i][0] - lower)) * (TABLE[i][1] - base) + base;
        }
        break;
    }

    const double linear = fps <= 60 ? (double)fps : sqrt((double)fps / 60) * 60;
    const double rate = linear / 30;
    const double share = codec == MOONLIGHT_STREAM_CODEC_AV1 ? 0.7 : 1;
    return (uint32_t)floor(factor * rate * share + 0.5) * 1000;
}

static void value_text(MoonlightSettingId id, const MoonlightSettings *for_auto, uint8_t value, char *out, size_t size)
{
    switch (ROWS[id].kind) {
    case KIND_SIZE:
        snprintf(out, size, "%s", SIZE_TEXT[value]);
        return;
    case KIND_FPS:
        snprintf(out, size, "%u fps", RATES[value]);
        return;
    case KIND_BITRATE:
        if (value != AUTO_BITRATE) {
            snprintf(out, size, "%g Mbps", bitrate_mbps(value));
            return;
        }
        {
            const uint8_t s = for_auto->value[MOONLIGHT_SETTING_SIZE];
            const uint32_t kbps = moonlightDefaultBitrate(WIDTHS[s], HEIGHTS[s],
                RATES[for_auto->value[MOONLIGHT_SETTING_FPS]], (MoonlightStreamCodec)for_auto->value[MOONLIGHT_SETTING_CODEC]);
            snprintf(out, size, "Auto (%u Mbps)", kbps / 1000);
        }
        return;
    case KIND_CODEC:
        snprintf(out, size, "%s", CODEC_TEXT[value]);
        return;
    case KIND_TOGGLE:
        snprintf(out, size, "%s", value ? "On" : "Off");
        return;
    }
}

static void row_text(MoonlightSettingId id, const MoonlightSettings *settings, bool docked,
    const MoonlightCapabilities *caps, char *out, size_t size)
{
    MoonlightSettings used;
    moonlightSettingsInUse(settings, docked, caps, &used);
    const uint8_t saved = settings->value[id];
    const bool no_codec = id == MOONLIGHT_SETTING_CODEC && !codec_available(caps, used.value[id]);
    if (no_codec) {
        char codec[40];
        value_text(id, settings, saved, codec, sizeof(codec));
        snprintf(out, size, "%s unavailable", codec);
        return;
    }
    if (used.value[id] == saved) {
        value_text(id, &used, saved, out, size);
        return;
    }

    MoonlightSettings by_dock = *settings;
    dock_fallback(&by_dock, docked);
    const bool dock_only = by_dock.value[id] != saved && !docked;
    char in_use[40];
    char short_text[40];
    value_text(id, &used, used.value[id], in_use, sizeof(in_use));
    if (id == MOONLIGHT_SETTING_SIZE)
        snprintf(short_text, sizeof(short_text), "%s", SIZE_SHORT[saved]);
    else
        value_text(id, settings, saved, short_text, sizeof(short_text));
    snprintf(out, size, "%s \xc2\xb7 %s %s", in_use, short_text, dock_only ? "when docked" : "unavailable");
}

void moonlightSettingsRows(const MoonlightSettings *settings, bool docked, const MoonlightCapabilities *capabilities,
    MoonlightSettingRow rows[MOONLIGHT_SETTING_COUNT])
{
    const MoonlightCapabilities *caps = capabilities_or_all(capabilities);
    for (unsigned i = 0; i < MOONLIGHT_SETTING_COUNT; i++) {
        const MoonlightSettingId id = (MoonlightSettingId)i;
        MoonlightSettings left;
        MoonlightSettings right;
        moonlightSettingsAdjust(settings, id, -1, docked, caps, &left);
        moonlightSettingsAdjust(settings, id, 1, docked, caps, &right);

        rows[i] = (MoonlightSettingRow){
            .id = ROWS[i].id,
            .label = ROWS[i].label,
            .adjustable = !locked(id, settings),
            .greyed = false,
            .can_left = left.value[i] != settings->value[i],
            .can_right = right.value[i] != settings->value[i],
        };
        row_text(id, settings, docked, caps, rows[i].value, sizeof(rows[i].value));
    }
}

static size_t append(char *out, size_t size, size_t used, const char *format, const char *a, const char *b)
{
    if (used >= size)
        return used;
    const int written = snprintf(out + used, size - used, format, a, b);
    return written < 0 ? size : used + (size_t)written;
}

size_t moonlightSettingsToJson(const MoonlightSettings *settings, char *out, size_t size)
{
    char number[32];
    snprintf(number, sizeof(number), "%u", MOONLIGHT_SETTINGS_VERSION);
    size_t used = append(out, size, 0, "{\"%s\":%s", "version", number);
    for (unsigned id = 0; id < MOONLIGHT_SETTING_COUNT; id++) {
        const uint8_t value = settings->value[id];
        char text[32];
        switch (ROWS[id].kind) {
        case KIND_SIZE:
            snprintf(text, sizeof(text), "\"%s\"", SIZES[value]);
            break;
        case KIND_FPS:
            snprintf(text, sizeof(text), "%u", RATES[value]);
            break;
        case KIND_BITRATE:
            if (value == AUTO_BITRATE)
                snprintf(text, sizeof(text), "\"auto\"");
            else
                snprintf(text, sizeof(text), "%g", bitrate_mbps(value));
            break;
        case KIND_CODEC:
            snprintf(text, sizeof(text), "\"%s\"", CODECS[value]);
            break;
        case KIND_TOGGLE:
            snprintf(text, sizeof(text), "%s", value ? "true" : "false");
            break;
        }
        used = append(out, size, used, ",\"%s\":%s", ROWS[id].id, text);
    }
    if (settings->fps_before_4k) {
        snprintf(number, sizeof(number), "%u", settings->fps_before_4k);
        used = append(out, size, used, ",\"%s\":%s", "fpsBefore4k", number);
    }
    used = append(out, size, used, "}%s%s", "", "");
    return used < size ? used : 0;
}

static void add_arg(MoonlightStreamArgs *args, const char *value)
{
    if (args->count < MOONLIGHT_STREAM_ARGS_MAX)
        args->argv[args->count++] = value;
}

static const char *store_arg(MoonlightStreamArgs *args, size_t *used, const char *format, unsigned value)
{
    char *at = args->storage + *used;
    const int written = snprintf(at, sizeof(args->storage) - *used, format, value);
    *used += (size_t)written + 1;
    return at;
}

void moonlightSettingsStreamArgs(const MoonlightSettings *settings, MoonlightStreamArgs *args)
{
    char json[MOONLIGHT_SETTINGS_JSON_BYTES];
    MoonlightSettings s;
    const size_t length = moonlightSettingsToJson(settings, json, sizeof(json));
    moonlightSettingsSanitizeJson(json, length, &s);

    *args = (MoonlightStreamArgs){0};
    size_t used = 0;
    const uint8_t bitrate = s.value[MOONLIGHT_SETTING_BITRATE];
    add_arg(args, "--codec");
    add_arg(args, CODECS[s.value[MOONLIGHT_SETTING_CODEC]]);
    add_arg(args, "--size");
    add_arg(args, SIZES[s.value[MOONLIGHT_SETTING_SIZE]]);
    add_arg(args, "--fps");
    add_arg(args, store_arg(args, &used, "%u", RATES[s.value[MOONLIGHT_SETTING_FPS]]));
    add_arg(args, "--bitrate");
    if (bitrate == AUTO_BITRATE)
        add_arg(args, "auto");
    else
        add_arg(args, store_arg(args, &used, "%u", (unsigned)lround(bitrate_mbps(bitrate) * 1000)));
    add_arg(args, "--staggered");
    add_arg(args, "--socket-audio");
    if (s.value[MOONLIGHT_SETTING_SIZE] == MOONLIGHT_SIZE_2160P) {
        add_arg(args, "--undocked-fps");
        add_arg(args, "120");
    }

    if (s.value[MOONLIGHT_SETTING_HOST_AUDIO])
        add_arg(args, "--local-audio");
    if (s.value[MOONLIGHT_SETTING_OPTIMISE])
        add_arg(args, "--sops");
    if (!s.value[MOONLIGHT_SETTING_MENU_CHORD])
        add_arg(args, "--no-menu-chord");
    if (s.value[MOONLIGHT_SETTING_STREAM_INFO])
        add_arg(args, "--stream-info");
    if (s.value[MOONLIGHT_SETTING_FRAME_COUNTER])
        add_arg(args, "--frame-counter");
}

void moonlightSettingsStreamOptions(const MoonlightSettings *settings, bool docked,
    const MoonlightCapabilities *capabilities, MoonlightStreamOptions *options)
{
    MoonlightSettings used;
    moonlightSettingsInUse(settings, docked, capabilities, &used);
    const uint8_t size = used.value[MOONLIGHT_SETTING_SIZE];
    const uint8_t bitrate = used.value[MOONLIGHT_SETTING_BITRATE];
    const MoonlightStreamCodec codec = (MoonlightStreamCodec)used.value[MOONLIGHT_SETTING_CODEC];
    const uint32_t fps = RATES[used.value[MOONLIGHT_SETTING_FPS]];

    *options = (MoonlightStreamOptions){
        .width = WIDTHS[size],
        .height = HEIGHTS[size],
        .fps = fps,
        .bitrate_auto = bitrate == AUTO_BITRATE,
        .codec = codec,
        .host_audio = used.value[MOONLIGHT_SETTING_HOST_AUDIO],
        .optimise = used.value[MOONLIGHT_SETTING_OPTIMISE],
        .quit_on_return = used.value[MOONLIGHT_SETTING_QUIT_ON_RETURN],
        .menu_chord = used.value[MOONLIGHT_SETTING_MENU_CHORD],
        .stream_info = used.value[MOONLIGHT_SETTING_STREAM_INFO],
        .frame_counter = used.value[MOONLIGHT_SETTING_FRAME_COUNTER],
    };
    options->launchable = codec_available(capabilities_or_all(capabilities), codec);
    if (bitrate == AUTO_BITRATE)
        options->bitrate_kbps = moonlightDefaultBitrate(options->width, options->height, fps, codec);
    else
        options->bitrate_kbps = (uint32_t)lround(bitrate_mbps(bitrate) * 1000);
}
