#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * The PC's TCP media channel (civ7/video-channel.js): token, then 16-byte records, with the
 * console's acknowledgements going back. Contract, ownership and errors:
 * moonlight-nx2-dev/src/native/media/README.md.
 */

#define MOONLIGHT_MEDIA_HEADER_BYTES 16u
#define MOONLIGHT_MEDIA_TOKEN_BYTES 64u
#define MOONLIGHT_MEDIA_PENDING_ACKS 32u
#define MOONLIGHT_MEDIA_OUTBOUND_BYTES 0x2000u
#define MOONLIGHT_MEDIA_HOST_MAX_PAYLOAD (8u * 1024u * 1024u)

typedef enum {
    MOONLIGHT_MEDIA_OK = 0,
    MOONLIGHT_MEDIA_AGAIN,
    MOONLIGHT_MEDIA_INVALID,
    MOONLIGHT_MEDIA_TOO_LARGE,
    MOONLIGHT_MEDIA_NO_MEMORY,
    MOONLIGHT_MEDIA_ENDED,
    MOONLIGHT_MEDIA_TRUNCATED,
    MOONLIGHT_MEDIA_TIMEOUT,
    MOONLIGHT_MEDIA_REFUSED,
    MOONLIGHT_MEDIA_DISCONNECTED,
    MOONLIGHT_MEDIA_FAILED,
} MoonlightMediaResult;

typedef struct {
    uint8_t header[MOONLIGHT_MEDIA_HEADER_BYTES];
    uint32_t length;
    uint32_t sequence;
    uint64_t pts_us;
    const uint8_t *payload;
} MoonlightMediaRecord;

/* Incremental record parser over caller-owned memory. Fields are private to parser.c. */
typedef struct {
    uint8_t *memory;
    size_t capacity;
    uint32_t exact_bytes;
    uint8_t header[MOONLIGHT_MEDIA_HEADER_BYTES];
    size_t header_bytes;
    size_t payload_bytes;
    uint32_t length;
    bool ready;
    bool ended;
    MoonlightMediaResult failure;
} MoonlightMediaParser;

const char *moonlightMediaResultName(MoonlightMediaResult result);

MoonlightMediaResult moonlightMediaParserInit(MoonlightMediaParser *parser, uint8_t *memory, size_t capacity,
                                              uint32_t exact_bytes);
MoonlightMediaResult moonlightMediaParserFeed(MoonlightMediaParser *parser, const uint8_t *data, size_t bytes,
                                              size_t *taken);
MoonlightMediaResult moonlightMediaParserSpace(MoonlightMediaParser *parser, uint8_t **window, size_t *bytes);
MoonlightMediaResult moonlightMediaParserCommit(MoonlightMediaParser *parser, size_t bytes);
MoonlightMediaResult moonlightMediaParserPeek(const MoonlightMediaParser *parser, MoonlightMediaRecord *record);
MoonlightMediaResult moonlightMediaParserConsume(MoonlightMediaParser *parser);
MoonlightMediaResult moonlightMediaParserEnd(MoonlightMediaParser *parser);

typedef enum {
    MOONLIGHT_MEDIA_CONNECTING = 0,
    MOONLIGHT_MEDIA_STREAMING,
    MOONLIGHT_MEDIA_CLOSED,
} MoonlightMediaState;

typedef struct {
    uint8_t address[4];
    uint16_t port;
    uint32_t connect_timeout_ms;
    char token[MOONLIGHT_MEDIA_TOKEN_BYTES];
    uint8_t *memory;
    size_t capacity;
    uint32_t exact_bytes;
    size_t read_budget;
} MoonlightMediaConfig;

typedef struct {
    MoonlightMediaState state;
    uint64_t bytes_received;
    uint64_t bytes_sent;
    uint64_t records;
    uint64_t acknowledgements;
    uint64_t budget_stops;
    uint64_t stalled_pumps;
    uint32_t pending_acks;
    size_t outbound_bytes;
    size_t max_outbound_bytes;
    int last_errno;
} MoonlightMediaStats;

typedef struct MoonlightMedia MoonlightMedia;
typedef void (*MoonlightMediaLog)(const char *message);

MoonlightMediaResult moonlightMediaOpen(const MoonlightMediaConfig *config, MoonlightMediaLog log, uint64_t now_ms,
                                        MoonlightMedia **out);
MoonlightMediaResult moonlightMediaPump(MoonlightMedia *media, uint64_t now_ms);
MoonlightMediaResult moonlightMediaPeek(const MoonlightMedia *media, MoonlightMediaRecord *record);
MoonlightMediaResult moonlightMediaConsume(MoonlightMedia *media);
MoonlightMediaResult moonlightMediaAcknowledge(MoonlightMedia *media, const uint8_t header[MOONLIGHT_MEDIA_HEADER_BYTES],
                                               const uint8_t *extra, size_t extra_bytes);
void moonlightMediaGetStats(const MoonlightMedia *media, MoonlightMediaStats *stats);
MoonlightMediaResult moonlightMediaClose(MoonlightMedia *media);
