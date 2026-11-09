#include <string.h>

#include "../media.h"

static uint32_t read32(const uint8_t *bytes)
{
    return (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 | (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
}

static uint64_t read64(const uint8_t *bytes)
{
    return (uint64_t)read32(bytes) | (uint64_t)read32(bytes + 4) << 32;
}

const char *moonlightMediaResultName(MoonlightMediaResult result)
{
    switch (result) {
    case MOONLIGHT_MEDIA_OK: return "ok";
    case MOONLIGHT_MEDIA_AGAIN: return "again";
    case MOONLIGHT_MEDIA_INVALID: return "invalid";
    case MOONLIGHT_MEDIA_TOO_LARGE: return "too large";
    case MOONLIGHT_MEDIA_NO_MEMORY: return "no memory";
    case MOONLIGHT_MEDIA_ENDED: return "ended";
    case MOONLIGHT_MEDIA_TRUNCATED: return "truncated";
    case MOONLIGHT_MEDIA_TIMEOUT: return "timeout";
    case MOONLIGHT_MEDIA_REFUSED: return "refused";
    case MOONLIGHT_MEDIA_DISCONNECTED: return "disconnected";
    case MOONLIGHT_MEDIA_FAILED: return "failed";
    }
    return "unknown";
}

MoonlightMediaResult moonlightMediaParserInit(MoonlightMediaParser *parser, uint8_t *memory, size_t capacity,
                                              uint32_t exact_bytes)
{
    if (!parser || !memory || !capacity)
        return MOONLIGHT_MEDIA_INVALID;
    if (exact_bytes > capacity)
        return MOONLIGHT_MEDIA_INVALID;

    memset(parser, 0, sizeof(*parser));
    parser->memory = memory;
    parser->capacity = capacity;
    parser->exact_bytes = exact_bytes;
    return MOONLIGHT_MEDIA_OK;
}

static MoonlightMediaResult check_length(const MoonlightMediaParser *parser, uint32_t length)
{
    if (!length)
        return MOONLIGHT_MEDIA_INVALID;
    if (length > parser->capacity)
        return MOONLIGHT_MEDIA_TOO_LARGE;
    if (parser->exact_bytes && length != parser->exact_bytes)
        return MOONLIGHT_MEDIA_INVALID;
    return MOONLIGHT_MEDIA_OK;
}

MoonlightMediaResult moonlightMediaParserSpace(MoonlightMediaParser *parser, uint8_t **window, size_t *bytes)
{
    if (!parser || !window || !bytes)
        return MOONLIGHT_MEDIA_INVALID;
    *window = NULL;
    *bytes = 0;

    if (parser->failure != MOONLIGHT_MEDIA_OK)
        return parser->failure;
    if (parser->ready)
        return MOONLIGHT_MEDIA_AGAIN;
    if (parser->ended)
        return MOONLIGHT_MEDIA_ENDED;

    if (parser->header_bytes < MOONLIGHT_MEDIA_HEADER_BYTES) {
        *window = parser->header + parser->header_bytes;
        *bytes = MOONLIGHT_MEDIA_HEADER_BYTES - parser->header_bytes;
        return MOONLIGHT_MEDIA_OK;
    }

    *window = parser->memory + parser->payload_bytes;
    *bytes = parser->length - parser->payload_bytes;
    return MOONLIGHT_MEDIA_OK;
}

MoonlightMediaResult moonlightMediaParserCommit(MoonlightMediaParser *parser, size_t bytes)
{
    uint8_t *window;
    size_t space;
    MoonlightMediaResult result = moonlightMediaParserSpace(parser, &window, &space);
    if (result != MOONLIGHT_MEDIA_OK)
        return result;
    if (bytes > space)
        return MOONLIGHT_MEDIA_INVALID;

    if (parser->header_bytes < MOONLIGHT_MEDIA_HEADER_BYTES) {
        parser->header_bytes += bytes;
        if (parser->header_bytes < MOONLIGHT_MEDIA_HEADER_BYTES)
            return MOONLIGHT_MEDIA_OK;

        uint32_t length = read32(parser->header);
        result = check_length(parser, length);
        if (result != MOONLIGHT_MEDIA_OK) {
            parser->failure = result;
            return result;
        }
        parser->length = length;
        return MOONLIGHT_MEDIA_OK;
    }

    parser->payload_bytes += bytes;
    if (parser->payload_bytes == parser->length)
        parser->ready = true;
    return MOONLIGHT_MEDIA_OK;
}

MoonlightMediaResult moonlightMediaParserFeed(MoonlightMediaParser *parser, const uint8_t *data, size_t bytes,
                                              size_t *taken)
{
    if (!parser || !taken || (!data && bytes))
        return MOONLIGHT_MEDIA_INVALID;
    *taken = 0;

    while (*taken < bytes) {
        uint8_t *window;
        size_t space;
        MoonlightMediaResult result = moonlightMediaParserSpace(parser, &window, &space);
        if (result == MOONLIGHT_MEDIA_AGAIN && *taken)
            return MOONLIGHT_MEDIA_OK;
        if (result != MOONLIGHT_MEDIA_OK)
            return result;

        size_t count = bytes - *taken;
        if (count > space)
            count = space;
        memcpy(window, data + *taken, count);
        *taken += count;

        result = moonlightMediaParserCommit(parser, count);
        if (result != MOONLIGHT_MEDIA_OK)
            return result;
    }
    return MOONLIGHT_MEDIA_OK;
}

MoonlightMediaResult moonlightMediaParserPeek(const MoonlightMediaParser *parser, MoonlightMediaRecord *record)
{
    if (!parser || !record)
        return MOONLIGHT_MEDIA_INVALID;
    if (!parser->ready)
        return MOONLIGHT_MEDIA_AGAIN;

    memcpy(record->header, parser->header, sizeof(record->header));
    record->length = parser->length;
    record->sequence = read32(parser->header + 4);
    record->pts_us = read64(parser->header + 8);
    record->payload = parser->memory;
    return MOONLIGHT_MEDIA_OK;
}

MoonlightMediaResult moonlightMediaParserConsume(MoonlightMediaParser *parser)
{
    if (!parser)
        return MOONLIGHT_MEDIA_INVALID;
    if (!parser->ready)
        return MOONLIGHT_MEDIA_AGAIN;

    parser->ready = false;
    parser->header_bytes = 0;
    parser->payload_bytes = 0;
    parser->length = 0;
    return MOONLIGHT_MEDIA_OK;
}

MoonlightMediaResult moonlightMediaParserEnd(MoonlightMediaParser *parser)
{
    if (!parser)
        return MOONLIGHT_MEDIA_INVALID;
    if (parser->failure != MOONLIGHT_MEDIA_OK)
        return parser->failure;

    parser->ended = true;
    if (parser->ready || !parser->header_bytes)
        return MOONLIGHT_MEDIA_ENDED;

    parser->failure = MOONLIGHT_MEDIA_TRUNCATED;
    return MOONLIGHT_MEDIA_TRUNCATED;
}
