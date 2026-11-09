#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "../ui.h"
#include "json.h"

#define RECORD_BYTES 4096u
#define MAX_SAFE_INTEGER UINT64_C(9007199254740991)

static const char *const SLOTS[2] = {"settings-0.json", "settings-1.json"};
static const char *const LEGACY = "settings.json";

static uint32_t checksum(uint64_t generation, const char *settings, size_t length)
{
    char prefix[64];
    const int written = snprintf(prefix, sizeof(prefix), "{\"generation\":%" PRIu64 ",\"settings\":", generation);
    uint32_t hash = 2166136261u;
    for (int i = 0; i < written; i++)
        hash = (hash ^ (uint8_t)prefix[i]) * 16777619u;
    for (size_t i = 0; i < length; i++)
        hash = (hash ^ (uint8_t)settings[i]) * 16777619u;
    return (hash ^ (uint8_t)'}') * 16777619u;
}

typedef struct {
    uint64_t generation;
    MoonlightSettings settings;
} Record;

static bool safe_generation(const MoonlightJsonNode *node, uint64_t *out)
{
    if (!node || node->type != ML_JSON_NUMBER)
        return false;

    const double value = node->number;
    const bool whole = value >= 1 && value <= (double)MAX_SAFE_INTEGER && value == (double)(uint64_t)value;
    if (!whole)
        return false;
    *out = (uint64_t)value;
    return true;
}

static bool read_record(const MoonlightSettingsFiles *files, const char *name, Record *record)
{
    static MoonlightJson json;
    static char text[RECORD_BYTES + 1];
    size_t length = 0;
    if (!files->read(files->context, name, text, sizeof(text), &length))
        return false;
    if (length < 1 || length > RECORD_BYTES || !moonlightJsonParse(&json, text, length))
        return false;

    const MoonlightJsonNode *root = moonlightJsonRoot(&json);
    const MoonlightJsonNode *version = moonlightJsonMember(&json, root, "version");
    if (!version || version->type != ML_JSON_NUMBER || version->number != 1)
        return false;

    uint64_t generation = 0;
    if (!safe_generation(moonlightJsonMember(&json, root, "generation"), &generation))
        return false;

    const MoonlightJsonNode *settings = moonlightJsonMember(&json, root, "settings");
    const MoonlightJsonNode *sum = moonlightJsonMember(&json, root, "checksum");
    if (!settings || !sum || sum->type != ML_JSON_NUMBER)
        return false;
    const char *raw = text + settings->start;
    const size_t raw_length = settings->end - settings->start;
    if (sum->number != (double)checksum(generation, raw, raw_length))
        return false;

    record->generation = generation;
    moonlightSettingsSanitizeJson(raw, raw_length, &record->settings);
    return true;
}

static bool read_legacy(const MoonlightSettingsFiles *files, MoonlightSettings *settings)
{
    static char text[RECORD_BYTES + 1];
    size_t length = 0;
    if (!files->read(files->context, LEGACY, text, sizeof(text), &length))
        return false;
    if (length > RECORD_BYTES)
        return false;

    moonlightSettingsSanitizeJson(text, length, settings);
    return true;
}

MoonlightSettingsSource moonlightSettingsLoad(MoonlightSettingsStore *store, MoonlightSettings *settings)
{
    Record records[2];
    bool valid[2];
    for (int slot = 0; slot < 2; slot++)
        valid[slot] = read_record(&store->files, SLOTS[slot], &records[slot]);

    int newest = -1;
    for (int slot = 0; slot < 2; slot++) {
        if (valid[slot] && (newest < 0 || records[slot].generation > records[newest].generation))
            newest = slot;
    }
    if (newest >= 0) {
        store->generation = records[newest].generation;
        *settings = records[newest].settings;
        return MOONLIGHT_SETTINGS_LOADED;
    }

    store->generation = 0;
    if (read_legacy(&store->files, settings))
        return MOONLIGHT_SETTINGS_MIGRATED;
    moonlightSettingsDefaults(settings);
    return MOONLIGHT_SETTINGS_DEFAULTS;
}

bool moonlightSettingsSave(MoonlightSettingsStore *store, const MoonlightSettings *settings)
{
    if (store->generation >= MAX_SAFE_INTEGER)
        return false;

    char raw[MOONLIGHT_SETTINGS_JSON_BYTES];
    MoonlightSettings clean;
    size_t length = moonlightSettingsToJson(settings, raw, sizeof(raw));
    moonlightSettingsSanitizeJson(raw, length, &clean);
    length = moonlightSettingsToJson(&clean, raw, sizeof(raw));
    if (!length)
        return false;

    const uint64_t next = store->generation + 1;
    char record[RECORD_BYTES];
    const int written = snprintf(record, sizeof(record),
        "{\"version\":1,\"generation\":%" PRIu64 ",\"settings\":%s,\"checksum\":%" PRIu32 "}", next, raw,
        checksum(next, raw, length));
    if (written <= 0 || (size_t)written >= sizeof(record))
        return false;
    if (!store->files.write(store->files.context, SLOTS[next & 1], record, (size_t)written))
        return false;

    store->generation = next;
    return true;
}

static bool path_for(const char *directory, const char *name, char *path, size_t size)
{
    const int written = snprintf(path, size, "%s/%s", directory, name);
    return written > 0 && (size_t)written < size;
}

static bool directory_read(void *context, const char *name, char *buffer, size_t capacity, size_t *length)
{
    char path[512];
    if (!path_for(context, name, path, sizeof(path)))
        return false;

    FILE *file = fopen(path, "rb");
    if (!file)
        return false;
    *length = fread(buffer, 1, capacity, file);
    const bool ok = !ferror(file) && *length < capacity;
    fclose(file);
    return ok;
}

static bool directory_write(void *context, const char *name, const char *bytes, size_t length)
{
    char path[512];
    if (!path_for(context, name, path, sizeof(path)))
        return false;
    if (mkdir(context, 0777) != 0 && errno != EEXIST)
        return false;

    FILE *file = fopen(path, "wb");
    if (!file)
        return false;
    bool ok = fwrite(bytes, 1, length, file) == length;
    ok = fflush(file) == 0 && ok;
    ok = fclose(file) == 0 && ok;
    return ok;
}

MoonlightSettingsFiles moonlightSettingsDirectory(const char *directory)
{
    return (MoonlightSettingsFiles){
        .context = (void *)directory,
        .read = directory_read,
        .write = directory_write,
    };
}
