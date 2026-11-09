#include <string.h>

#include "wire.h"

static uint16_t read16(const uint8_t *bytes)
{
    return (uint16_t)(bytes[0] | bytes[1] << 8);
}

static uint32_t read32(const uint8_t *bytes)
{
    return (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 | (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
}

static void write16(uint8_t *bytes, uint16_t value)
{
    bytes[0] = (uint8_t)value;
    bytes[1] = (uint8_t)(value >> 8);
}

static void write32(uint8_t *bytes, uint32_t value)
{
    for (int i = 0; i < 4; i++)
        bytes[i] = (uint8_t)(value >> (8 * i));
}

static void wipe(uint8_t *bytes, size_t length)
{
    volatile uint8_t *at = bytes;
    for (size_t i = 0; i < length; i++)
        at[i] = 0;
}

const char *moonlightControlResultText(MoonlightControlResult result)
{
    switch (result) {
    case MOONLIGHT_CONTROL_OK: return "ok";
    case MOONLIGHT_CONTROL_BAD_KIND: return "Unknown native control frame kind";
    case MOONLIGHT_CONTROL_BAD_LENGTH: return "Invalid native control payload length";
    case MOONLIGHT_CONTROL_BAD_AUTH: return "Invalid native control authentication frame";
    case MOONLIGHT_CONTROL_BAD_MAGIC: return "Invalid native control magic";
    case MOONLIGHT_CONTROL_BAD_VERSION: return "Unsupported native control version";
    case MOONLIGHT_CONTROL_FEED_AFTER_EOF: return "Native control feed after EOF";
    case MOONLIGHT_CONTROL_TRUNCATED: return "Truncated native control frame";
    case MOONLIGHT_CONTROL_NO_FRAME: return "No native control frame to consume";
    case MOONLIGHT_CONTROL_NO_ROOM: return "Native control output too small";
    case MOONLIGHT_CONTROL_INVALID: return "Invalid native control argument";
    }
    return "unknown";
}

static MoonlightControlResult validate(uint32_t kind, uint32_t id, uint64_t length)
{
    if (kind < MOONLIGHT_CONTROL_AUTH || kind > MOONLIGHT_CONTROL_ERROR)
        return MOONLIGHT_CONTROL_BAD_KIND;
    if (length < 1 || length > MOONLIGHT_CONTROL_MAX_PAYLOAD)
        return MOONLIGHT_CONTROL_BAD_LENGTH;
    if (kind == MOONLIGHT_CONTROL_AUTH && (id != 0 || length != MOONLIGHT_CONTROL_AUTH_BYTES))
        return MOONLIGHT_CONTROL_BAD_AUTH;
    return MOONLIGHT_CONTROL_OK;
}

MoonlightControlResult moonlightControlParserInit(MoonlightControlParser *parser, uint8_t *payload, size_t capacity)
{
    if (!parser || !payload || capacity < MOONLIGHT_CONTROL_MAX_PAYLOAD)
        return MOONLIGHT_CONTROL_INVALID;

    *parser = (MoonlightControlParser){.payload = payload};
    return MOONLIGHT_CONTROL_OK;
}

static MoonlightControlResult fail(MoonlightControlParser *parser, MoonlightControlResult result)
{
    parser->failure = result;
    return result;
}

static MoonlightControlResult accept_header(MoonlightControlParser *parser)
{
    if (read32(parser->header) != MOONLIGHT_CONTROL_MAGIC)
        return fail(parser, MOONLIGHT_CONTROL_BAD_MAGIC);
    if (read16(parser->header + 4) != MOONLIGHT_CONTROL_VERSION)
        return fail(parser, MOONLIGHT_CONTROL_BAD_VERSION);

    parser->kind = read16(parser->header + 6);
    parser->id = read32(parser->header + 8);
    parser->length = read32(parser->header + 12);
    const MoonlightControlResult result = validate(parser->kind, parser->id, parser->length);
    return result == MOONLIGHT_CONTROL_OK ? result : fail(parser, result);
}

MoonlightControlResult moonlightControlFeed(MoonlightControlParser *parser, const uint8_t *bytes, size_t length,
    size_t *taken)
{
    *taken = 0;
    if (parser->failure)
        return parser->failure;
    if (parser->ended)
        return fail(parser, MOONLIGHT_CONTROL_FEED_AFTER_EOF);
    if (parser->ready || !length)
        return MOONLIGHT_CONTROL_OK;

    size_t used = 0;
    if (parser->header_bytes < MOONLIGHT_CONTROL_HEADER_BYTES) {
        const size_t wanted = MOONLIGHT_CONTROL_HEADER_BYTES - parser->header_bytes;
        const size_t count = length < wanted ? length : wanted;
        memcpy(parser->header + parser->header_bytes, bytes, count);
        parser->header_bytes += (uint32_t)count;
        used = count;
        *taken = used;
        if (parser->header_bytes < MOONLIGHT_CONTROL_HEADER_BYTES)
            return MOONLIGHT_CONTROL_OK;
        const MoonlightControlResult result = accept_header(parser);
        if (result != MOONLIGHT_CONTROL_OK)
            return result;
    }

    const size_t wanted = parser->length - parser->payload_bytes;
    const size_t count = length - used < wanted ? length - used : wanted;
    memcpy(parser->payload + parser->payload_bytes, bytes + used, count);
    parser->payload_bytes += (uint32_t)count;
    parser->ready = parser->payload_bytes == parser->length;
    *taken = used + count;
    return MOONLIGHT_CONTROL_OK;
}

MoonlightControlResult moonlightControlPeek(const MoonlightControlParser *parser, MoonlightControlFrame *frame,
    bool *ready)
{
    *ready = false;
    if (parser->failure)
        return parser->failure;
    if (!parser->ready)
        return MOONLIGHT_CONTROL_OK;

    *frame = (MoonlightControlFrame){(MoonlightControlKind)parser->kind, parser->id, parser->payload, parser->length};
    *ready = true;
    return MOONLIGHT_CONTROL_OK;
}

MoonlightControlResult moonlightControlConsume(MoonlightControlParser *parser)
{
    if (parser->failure)
        return parser->failure;
    if (!parser->ready)
        return fail(parser, MOONLIGHT_CONTROL_NO_FRAME);

    wipe(parser->payload, parser->length);
    parser->header_bytes = 0;
    parser->payload_bytes = 0;
    parser->length = 0;
    parser->ready = false;
    return MOONLIGHT_CONTROL_OK;
}

MoonlightControlResult moonlightControlEnd(MoonlightControlParser *parser)
{
    if (parser->failure)
        return parser->failure;
    const bool partial = parser->header_bytes || parser->payload_bytes;
    if (!parser->ready && partial)
        return fail(parser, MOONLIGHT_CONTROL_TRUNCATED);

    parser->ended = true;
    return MOONLIGHT_CONTROL_OK;
}

MoonlightControlResult moonlightControlEncode(uint32_t kind, uint32_t id, const uint8_t *payload, size_t length,
    uint8_t *out, size_t capacity, size_t *written)
{
    *written = 0;
    const MoonlightControlResult result = validate(kind, id, length);
    if (result != MOONLIGHT_CONTROL_OK)
        return result;
    if (!payload || !out || capacity < MOONLIGHT_CONTROL_HEADER_BYTES + length)
        return MOONLIGHT_CONTROL_NO_ROOM;

    write32(out, MOONLIGHT_CONTROL_MAGIC);
    write16(out + 4, MOONLIGHT_CONTROL_VERSION);
    write16(out + 6, (uint16_t)kind);
    write32(out + 8, id);
    write32(out + 12, (uint32_t)length);
    memcpy(out + MOONLIGHT_CONTROL_HEADER_BYTES, payload, length);
    *written = MOONLIGHT_CONTROL_HEADER_BYTES + length;
    return MOONLIGHT_CONTROL_OK;
}
