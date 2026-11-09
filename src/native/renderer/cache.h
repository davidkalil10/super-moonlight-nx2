#pragma once

// The pipeline cache file: a validated header, then the driver's cache data. Header-only so the
// shared native Makefile needs no new object. dev repo src/native/renderer/README.md, "Cache".
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ML_CACHE_MAGIC "MLPCACH1"
#define ML_CACHE_VERSION 1u
#define ML_CACHE_MAX_BYTES (8u * 1024u * 1024u)
#define ML_CACHE_PATH_BYTES 256u

typedef struct {
    uint32_t vendor;
    uint32_t device;
    uint32_t driver;
    uint8_t uuid[16];
    uint32_t width;
    uint32_t height;
    uint32_t video_path;
    uint32_t format;
    uint32_t abi;
    uint32_t storage_bytes;
    uint32_t frame_bytes;
    uint32_t frames_offset;
    uint32_t reserved;
    uint64_t shaders;
} MoonlightCacheIdentity;

_Static_assert(sizeof(MoonlightCacheIdentity) == 72, "cache identity has no padding");

typedef struct {
    char magic[8];
    uint32_t version;
    uint32_t header_bytes;
    MoonlightCacheIdentity identity;
    uint64_t data_bytes;
    uint64_t data_hash;
} MoonlightCacheHeader;

_Static_assert(sizeof(MoonlightCacheHeader) == 104, "cache header has no padding");

static inline uint64_t mlHash(uint64_t hash, const void *bytes, size_t size)
{
    const uint8_t *at = bytes;
    for (size_t i = 0; i < size; i++) {
        hash ^= at[i];
        hash *= UINT64_C(0x100000001b3);
    }
    return hash;
}

static inline uint64_t mlHashStart(void)
{
    return UINT64_C(0xcbf29ce484222325);
}

static inline bool mlCachePath(char *out, const char *path, const char *suffix)
{
    const int written = snprintf(out, ML_CACHE_PATH_BYTES, "%s%s", path, suffix);
    return written > 0 && (unsigned)written < ML_CACHE_PATH_BYTES;
}

static inline const char *mlCacheCheckHeader(const MoonlightCacheHeader *header, const MoonlightCacheIdentity *identity)
{
    if (memcmp(header->magic, ML_CACHE_MAGIC, sizeof(header->magic)) != 0)
        return "magic";
    if (header->version != ML_CACHE_VERSION || header->header_bytes != sizeof(*header))
        return "version";
    if (header->identity.shaders != identity->shaders)
        return "shaders";
    if (header->identity.vendor != identity->vendor || header->identity.device != identity->device)
        return "device";
    if (header->identity.driver != identity->driver || memcmp(header->identity.uuid, identity->uuid, 16) != 0)
        return "driver";
    if (memcmp(&header->identity, identity, sizeof(*identity)) != 0)
        return "contract";
    if (header->data_bytes == 0 || header->data_bytes > ML_CACHE_MAX_BYTES - sizeof(*header))
        return "size";
    return NULL;
}

static inline const char *mlCacheRead(const char *path, const MoonlightCacheIdentity *identity, void **data,
    size_t *bytes)
{
    FILE *file = fopen(path, "rb");
    if (!file)
        return "missing";

    MoonlightCacheHeader header;
    const char *reason = NULL;
    if (fread(&header, sizeof(header), 1, file) != 1)
        reason = "truncated";
    if (!reason)
        reason = mlCacheCheckHeader(&header, identity);

    uint8_t *payload = NULL;
    if (!reason) {
        payload = malloc((size_t)header.data_bytes);
        if (!payload)
            reason = "memory";
    }
    if (!reason && fread(payload, 1, (size_t)header.data_bytes, file) != header.data_bytes)
        reason = "truncated";
    if (!reason && fgetc(file) != EOF)
        reason = "trailing";
    if (!reason && mlHash(mlHashStart(), payload, (size_t)header.data_bytes) != header.data_hash)
        reason = "checksum";
    fclose(file);

    if (reason) {
        free(payload);
        return reason;
    }
    *data = payload;
    *bytes = (size_t)header.data_bytes;
    return NULL;
}

// Tries the file, then a complete temporary file left by an interrupted replace, which then
// becomes the file.
static inline const char *mlCacheLoad(const char *path, const MoonlightCacheIdentity *identity, void **data,
    size_t *bytes)
{
    *data = NULL;
    *bytes = 0;
    const char *reason = mlCacheRead(path, identity, data, bytes);
    if (!reason)
        return NULL;

    char temporary[ML_CACHE_PATH_BYTES];
    if (!mlCachePath(temporary, path, ".tmp"))
        return reason;
    if (mlCacheRead(temporary, identity, data, bytes))
        return reason;

    remove(path);
    rename(temporary, path);
    return NULL;
}

static inline const char *mlCacheWrite(const char *path, const MoonlightCacheHeader *header, const void *data)
{
    FILE *file = fopen(path, "wb");
    if (!file)
        return "open";

    bool written = fwrite(header, sizeof(*header), 1, file) == 1;
    written = written && fwrite(data, 1, (size_t)header->data_bytes, file) == header->data_bytes;
    written = written && fflush(file) == 0;
    const bool closed = fclose(file) == 0;
    if (!written || !closed) {
        remove(path);
        return "write";
    }
    return NULL;
}

// Writes path.tmp completely, then replaces path. A failure before the replace keeps the old
// file; an interruption after the old file's removal leaves a complete path.tmp for mlCacheLoad.
static inline const char *mlCacheSave(const char *path, const MoonlightCacheIdentity *identity, const void *data,
    size_t bytes)
{
    if (!bytes || bytes > ML_CACHE_MAX_BYTES - sizeof(MoonlightCacheHeader))
        return "size";

    char temporary[ML_CACHE_PATH_BYTES];
    if (!mlCachePath(temporary, path, ".tmp"))
        return "path";

    MoonlightCacheHeader header = {
        .version = ML_CACHE_VERSION,
        .header_bytes = sizeof(header),
        .identity = *identity,
        .data_bytes = bytes,
        .data_hash = mlHash(mlHashStart(), data, bytes),
    };
    memcpy(header.magic, ML_CACHE_MAGIC, sizeof(header.magic));
    const char *reason = mlCacheWrite(temporary, &header, data);
    if (reason)
        return reason;

    if (rename(temporary, path) == 0)
        return NULL;
    if (remove(path) != 0 && errno != ENOENT)
        return "replace";
    if (rename(temporary, path) != 0)
        return "rename";
    return NULL;
}
