#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Version 1 native control framing, the C peer of src/streamer/native/control-wire.js:
// a 16-byte little-endian header and one payload, parsed into caller-owned memory.
#define MOONLIGHT_CONTROL_MAGIC 0x31434e4du
#define MOONLIGHT_CONTROL_VERSION 1u
#define MOONLIGHT_CONTROL_HEADER_BYTES 16u
#define MOONLIGHT_CONTROL_MAX_PAYLOAD 65536u
#define MOONLIGHT_CONTROL_AUTH_BYTES 64u

typedef enum {
    MOONLIGHT_CONTROL_AUTH = 1,
    MOONLIGHT_CONTROL_ACCEPTED = 2,
    MOONLIGHT_CONTROL_REQUEST = 3,
    MOONLIGHT_CONTROL_EVENT = 4,
    MOONLIGHT_CONTROL_STREAM = 5,
    MOONLIGHT_CONTROL_ERROR = 6,
} MoonlightControlKind;

typedef enum {
    MOONLIGHT_CONTROL_OK = 0,
    MOONLIGHT_CONTROL_BAD_KIND,
    MOONLIGHT_CONTROL_BAD_LENGTH,
    MOONLIGHT_CONTROL_BAD_AUTH,
    MOONLIGHT_CONTROL_BAD_MAGIC,
    MOONLIGHT_CONTROL_BAD_VERSION,
    MOONLIGHT_CONTROL_FEED_AFTER_EOF,
    MOONLIGHT_CONTROL_TRUNCATED,
    MOONLIGHT_CONTROL_NO_FRAME,
    MOONLIGHT_CONTROL_NO_ROOM,
    MOONLIGHT_CONTROL_INVALID,
} MoonlightControlResult;

typedef struct {
    MoonlightControlKind kind;
    uint32_t id;
    const uint8_t *payload;
    uint32_t length;
} MoonlightControlFrame;

typedef struct {
    uint8_t header[MOONLIGHT_CONTROL_HEADER_BYTES];
    uint8_t *payload;
    uint32_t header_bytes;
    uint32_t payload_bytes;
    uint32_t length;
    uint32_t id;
    uint16_t kind;
    bool ready;
    bool ended;
    MoonlightControlResult failure;
} MoonlightControlParser;

MoonlightControlResult moonlightControlParserInit(MoonlightControlParser *parser, uint8_t *payload, size_t capacity);
MoonlightControlResult moonlightControlFeed(MoonlightControlParser *parser, const uint8_t *bytes, size_t length,
    size_t *taken);
MoonlightControlResult moonlightControlPeek(const MoonlightControlParser *parser, MoonlightControlFrame *frame,
    bool *ready);
MoonlightControlResult moonlightControlConsume(MoonlightControlParser *parser);
MoonlightControlResult moonlightControlEnd(MoonlightControlParser *parser);
MoonlightControlResult moonlightControlEncode(uint32_t kind, uint32_t id, const uint8_t *payload, size_t length,
    uint8_t *out, size_t capacity, size_t *written);
const char *moonlightControlResultText(MoonlightControlResult result);
