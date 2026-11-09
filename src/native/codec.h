#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Native video decoder over the console's GSV decoder service.
 * Contract, ownership and errors: moonlight-nx2-dev/src/native/codec/README.md.
 */

#define MOONLIGHT_DECODER_UNITS 2u
#define MOONLIGHT_DECODER_FRAMES 2u
#define MOONLIGHT_DECODER_INPUT_MAX (1024u * 1024u)

typedef struct MoonlightDecoder MoonlightDecoder;

typedef enum {
    MOONLIGHT_DECODE_OK = 0,
    MOONLIGHT_DECODE_AGAIN,
    MOONLIGHT_DECODE_INVALID,
    MOONLIGHT_DECODE_UNSUPPORTED,
    MOONLIGHT_DECODE_NO_MEMORY,
    MOONLIGHT_DECODE_REFUSED,
    MOONLIGHT_DECODE_TIMEOUT,
    MOONLIGHT_DECODE_UNCERTAIN,
    MOONLIGHT_DECODE_FAILED,
    MOONLIGHT_DECODE_RETIRED,
} MoonlightDecodeResult;

typedef enum {
    MOONLIGHT_CODEC_AV1 = 0,
} MoonlightCodec;

typedef struct {
    MoonlightCodec codec;
    uint32_t coded_width;
    uint32_t coded_height;
    uint32_t display_width;
    uint32_t display_height;
    bool bt709;
    bool full_range;
    uint32_t timeout_ms;
    /* Set when the process already registered its frame mode, as OunceVK does; never register twice. */
    bool frame_registered;
    uint64_t permitted_frame_mode;
    bool native_image_backing;
} MoonlightDecoderConfig;

typedef struct {
    const uint8_t *luma;
    const uint8_t *chroma;
    uint32_t luma_stride;
    uint32_t chroma_stride;
    uint32_t coded_width;
    uint32_t coded_height;
    uint32_t display_width;
    uint32_t display_height;
    bool bt709;
    bool full_range;
    uint32_t service_color;
    uint64_t pts_us;
    uint64_t timestamp_ns;
    uint32_t token;
} MoonlightDecodedFrame;

typedef void (*MoonlightDecoderLog)(const char *message);

const char *moonlightDecodeResultName(MoonlightDecodeResult result);

MoonlightDecodeResult moonlightDecoderOpen(const MoonlightDecoderConfig *config,
    MoonlightDecoderLog log, MoonlightDecoder **out);

MoonlightDecodeResult moonlightDecoderSubmit(MoonlightDecoder *decoder,
    const uint8_t *data, size_t length, uint64_t pts_us);

MoonlightDecodeResult moonlightDecoderPoll(MoonlightDecoder *decoder, MoonlightDecodedFrame *frame);

MoonlightDecodeResult moonlightDecoderRelease(MoonlightDecoder *decoder, uint32_t token);

MoonlightDecodeResult moonlightDecoderClose(MoonlightDecoder *decoder);

bool moonlightDecoderRetired(void);
