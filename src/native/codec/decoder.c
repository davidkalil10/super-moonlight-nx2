#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "backend.h"

#define DEFAULT_TIMEOUT_MS 5000u

typedef struct {
    uint64_t pts_us;
    uint64_t submitted_ms;
} PendingUnit;

typedef struct {
    uint8_t *data;
    bool held;
    uint32_t token;
} FrameBuffer;

struct MoonlightDecoder {
    VdecBackend backend;
    MoonlightDecoderConfig config;
    MoonlightDecoderLog log;
    uint32_t images[VDEC_SURFACES];
    unsigned queued[VDEC_SURFACES];
    unsigned queued_count;
    VdecOutput arrived[VDEC_SURFACES];
    bool arrived_valid[VDEC_SURFACES];
    PendingUnit pending[MOONLIGHT_DECODER_UNITS];
    unsigned pending_count;
    FrameBuffer frames[MOONLIGHT_DECODER_FRAMES];
    size_t luma_bytes;
    uint32_t generation;
    uint64_t decoded;
    bool failed;
    bool uncertain;
};

static bool retired;

static void report(const MoonlightDecoder *decoder, const char *format, ...)
    __attribute__((format(printf, 2, 3)));

static void report(const MoonlightDecoder *decoder, const char *format, ...)
{
    if (!decoder->log)
        return;

    char message[200];
    va_list args;
    va_start(args, format);
    vsnprintf(message, sizeof(message), format, args);
    va_end(args);
    decoder->log(message);
}

const char *moonlightDecodeResultName(MoonlightDecodeResult result)
{
    static const char *const names[] = {
        "ok", "again", "invalid", "unsupported", "no-memory", "refused",
        "timeout", "uncertain", "failed", "retired",
    };
    if ((unsigned)result >= sizeof(names) / sizeof(names[0]))
        return "unknown";
    return names[result];
}

bool moonlightDecoderRetired(void)
{
    return retired;
}

void vdecDecoderResetRetiredForTests(void)
{
    retired = false;
}

static MoonlightDecodeResult fail(MoonlightDecoder *decoder, const char *stage, VdecStatus status)
{
    static const MoonlightDecodeResult results[] = {
        [VDEC_OK] = MOONLIGHT_DECODE_OK,
        [VDEC_REFUSED] = MOONLIGHT_DECODE_REFUSED,
        [VDEC_INVALID] = MOONLIGHT_DECODE_INVALID,
        [VDEC_NO_MEMORY] = MOONLIGHT_DECODE_NO_MEMORY,
        [VDEC_UNSUPPORTED] = MOONLIGHT_DECODE_UNSUPPORTED,
        [VDEC_MALFORMED] = MOONLIGHT_DECODE_UNCERTAIN,
        [VDEC_UNCERTAIN] = MOONLIGHT_DECODE_UNCERTAIN,
    };

    decoder->failed = true;
    if (status == VDEC_MALFORMED || status == VDEC_UNCERTAIN)
        decoder->uncertain = true;
    report(decoder, "decoder: %s failed (%u) after %llu frames", stage, (unsigned)status,
        (unsigned long long)decoder->decoded);
    return results[status];
}

static bool config_ok(const MoonlightDecoderConfig *config)
{
    if (config->codec != MOONLIGHT_CODEC_AV1)
        return false;

    bool coded = vdecFrameDimensions(config->coded_width, config->coded_height);
    bool display = vdecFrameDimensions(config->display_width, config->display_height);
    if (!coded || !display)
        return false;

    bool cropped = config->display_width <= config->coded_width &&
        config->display_height <= config->coded_height;
    return cropped;
}

static void free_frames(MoonlightDecoder *decoder)
{
    for (unsigned i = 0; i < MOONLIGHT_DECODER_FRAMES; i++) {
        free(decoder->frames[i].data);
        decoder->frames[i].data = NULL;
    }
}

MoonlightDecodeResult vdecDecoderOpenWithBackend(const MoonlightDecoderConfig *config,
    MoonlightDecoderLog log, const VdecBackend *backend, MoonlightDecoder **out)
{
    if (!config || !backend || !out)
        return MOONLIGHT_DECODE_INVALID;
    *out = NULL;
    if (retired)
        return MOONLIGHT_DECODE_RETIRED;
    if (!config_ok(config))
        return MOONLIGHT_DECODE_INVALID;

    MoonlightDecoder *decoder = calloc(1, sizeof(*decoder));
    if (!decoder)
        return MOONLIGHT_DECODE_NO_MEMORY;
    decoder->backend = *backend;
    decoder->config = *config;
    decoder->log = log;
    if (!decoder->config.timeout_ms)
        decoder->config.timeout_ms = DEFAULT_TIMEOUT_MS;

    decoder->luma_bytes = (size_t)config->coded_width * config->coded_height;
    for (unsigned i = 0; i < MOONLIGHT_DECODER_FRAMES; i++) {
        decoder->frames[i].data = malloc(decoder->luma_bytes + decoder->luma_bytes / 2);
        if (!decoder->frames[i].data) {
            free_frames(decoder);
            free(decoder);
            return MOONLIGHT_DECODE_NO_MEMORY;
        }
    }

    VdecOpenParams params = {
        .coded_width = config->coded_width,
        .coded_height = config->coded_height,
        .display_width = config->display_width,
        .display_height = config->display_height,
        .frame_registered = config->frame_registered,
        .permitted_frame_mode = config->permitted_frame_mode,
        .native_image_backing = config->native_image_backing,
    };
    VdecStatus status = backend->open(backend->context, &params, decoder->images);
    if (status != VDEC_OK) {
        MoonlightDecodeResult result = fail(decoder, "open", status);
        if (decoder->uncertain)
            retired = true;
        free_frames(decoder);
        free(decoder);
        return result;
    }

    for (unsigned i = 0; i < VDEC_SURFACES; i++)
        decoder->queued[i] = i;
    decoder->queued_count = VDEC_SURFACES;
    report(decoder, "decoder: open %ux%u (display %ux%u)", config->coded_width,
        config->coded_height, config->display_width, config->display_height);
    *out = decoder;
    return MOONLIGHT_DECODE_OK;
}

MoonlightDecodeResult moonlightDecoderSubmit(MoonlightDecoder *decoder,
    const uint8_t *data, size_t length, uint64_t pts_us)
{
    if (!decoder || !data || !length || length > MOONLIGHT_DECODER_INPUT_MAX)
        return MOONLIGHT_DECODE_INVALID;
    if (decoder->failed)
        return MOONLIGHT_DECODE_FAILED;
    if (decoder->pending_count == MOONLIGHT_DECODER_UNITS)
        return MOONLIGHT_DECODE_AGAIN;
    for (unsigned i = 0; i < decoder->pending_count; i++) {
        if (decoder->pending[i].pts_us == pts_us)
            return MOONLIGHT_DECODE_INVALID;
    }

    VdecStatus status = decoder->backend.submit(decoder->backend.context, data, (uint32_t)length, pts_us);
    if (status != VDEC_OK)
        return fail(decoder, "submit", status);

    PendingUnit *unit = &decoder->pending[decoder->pending_count++];
    unit->pts_us = pts_us;
    unit->submitted_ms = decoder->backend.now_ms(decoder->backend.context);
    return MOONLIGHT_DECODE_OK;
}

static int free_frame(const MoonlightDecoder *decoder)
{
    for (unsigned i = 0; i < MOONLIGHT_DECODER_FRAMES; i++) {
        if (!decoder->frames[i].held)
            return (int)i;
    }
    return -1;
}

static int surface_of(const MoonlightDecoder *decoder, uint32_t image)
{
    for (unsigned i = 0; i < VDEC_SURFACES; i++) {
        if (decoder->images[i] == image)
            return (int)i;
    }
    return -1;
}

static MoonlightDecodeResult metadata(MoonlightDecoder *decoder, unsigned surface, VdecOutput *out)
{
    if (decoder->arrived_valid[surface]) {
        *out = decoder->arrived[surface];
        decoder->arrived_valid[surface] = false;
        return MOONLIGHT_DECODE_OK;
    }

    for (unsigned reads = 0; reads <= VDEC_SURFACES; reads++) {
        VdecOutput entry;
        VdecStatus status = decoder->backend.output(decoder->backend.context, &entry);
        if (status != VDEC_OK)
            return fail(decoder, "output", status);

        if (entry.end_of_stream && entry.timestamp_ns == 0) {
            report(decoder, "decoder: end of stream without a frame");
            return fail(decoder, "output", VDEC_REFUSED);
        }

        int named = surface_of(decoder, entry.image);
        if (named < 0)
            return fail(decoder, "output names an unknown image", VDEC_MALFORMED);
        if ((unsigned)named == surface) {
            *out = entry;
            return MOONLIGHT_DECODE_OK;
        }
        if (decoder->arrived_valid[named])
            return fail(decoder, "output repeats an image", VDEC_MALFORMED);
        decoder->arrived[named] = entry;
        decoder->arrived_valid[named] = true;
    }
    return fail(decoder, "output never named the ready image", VDEC_MALFORMED);
}

static bool size_ok(const MoonlightDecoder *decoder, const VdecOutput *output)
{
    const MoonlightDecoderConfig *config = &decoder->config;
    bool coded = output->width == config->coded_width && output->height == config->coded_height;
    bool display = output->width == config->display_width && output->height == config->display_height;
    return coded || display;
}

static int matching_unit(const MoonlightDecoder *decoder, uint64_t timestamp_ns)
{
    for (unsigned i = 0; i < decoder->pending_count; i++) {
        if (decoder->pending[i].pts_us * 1000 == timestamp_ns)
            return (int)i;
    }
    return -1;
}

static void retire_units(MoonlightDecoder *decoder, unsigned through)
{
    unsigned keep = decoder->pending_count - (through + 1);
    memmove(decoder->pending, decoder->pending + through + 1, keep * sizeof(decoder->pending[0]));
    decoder->pending_count = keep;
}

static void requeue_oldest(MoonlightDecoder *decoder)
{
    unsigned surface = decoder->queued[0];
    memmove(decoder->queued, decoder->queued + 1, (decoder->queued_count - 1) * sizeof(decoder->queued[0]));
    decoder->queued[decoder->queued_count - 1] = surface;
}

MoonlightDecodeResult moonlightDecoderPoll(MoonlightDecoder *decoder, MoonlightDecodedFrame *frame)
{
    if (!decoder || !frame)
        return MOONLIGHT_DECODE_INVALID;
    if (decoder->failed)
        return MOONLIGHT_DECODE_FAILED;
    if (!decoder->pending_count)
        return MOONLIGHT_DECODE_AGAIN;

    int index = free_frame(decoder);
    if (index < 0)
        return MOONLIGHT_DECODE_AGAIN;

    unsigned surface = decoder->queued[0];
    bool ready = false;
    VdecStatus status = decoder->backend.ready(decoder->backend.context, surface, &ready);
    if (status != VDEC_OK)
        return fail(decoder, "fence", status);
    if (!ready) {
        uint64_t waited = decoder->backend.now_ms(decoder->backend.context) - decoder->pending[0].submitted_ms;
        if (waited > decoder->config.timeout_ms) {
            decoder->failed = true;
            report(decoder, "decoder: no frame %llu ms after submit", (unsigned long long)waited);
            return MOONLIGHT_DECODE_TIMEOUT;
        }
        return MOONLIGHT_DECODE_AGAIN;
    }

    VdecOutput output = {0};
    MoonlightDecodeResult result = metadata(decoder, surface, &output);
    if (result != MOONLIGHT_DECODE_OK)
        return result;
    if (!size_ok(decoder, &output))
        return fail(decoder, "frame size changed", VDEC_MALFORMED);
    int unit = matching_unit(decoder, output.timestamp_ns);
    if (unit < 0)
        return fail(decoder, "output timestamp matches no input", VDEC_MALFORMED);

    FrameBuffer *buffer = &decoder->frames[index];
    VdecTarget target = {
        .luma = buffer->data,
        .chroma = buffer->data + decoder->luma_bytes,
        .luma_stride = decoder->config.coded_width,
        .chroma_stride = decoder->config.coded_width,
        .width = decoder->config.coded_width,
        .height = decoder->config.coded_height,
    };
    status = decoder->backend.readback(decoder->backend.context, surface, &target);
    if (status != VDEC_OK)
        return fail(decoder, "readback", status);
    status = decoder->backend.release(decoder->backend.context, surface);
    if (status != VDEC_OK)
        return fail(decoder, "release", status);

    uint64_t pts_us = decoder->pending[unit].pts_us;
    retire_units(decoder, (unsigned)unit);
    requeue_oldest(decoder);
    decoder->generation++;
    buffer->held = true;
    buffer->token = decoder->generation << 4 | (uint32_t)(index + 1);
    decoder->decoded++;

    *frame = (MoonlightDecodedFrame){
        .luma = target.luma,
        .chroma = target.chroma,
        .luma_stride = target.luma_stride,
        .chroma_stride = target.chroma_stride,
        .coded_width = decoder->config.coded_width,
        .coded_height = decoder->config.coded_height,
        .display_width = decoder->config.display_width,
        .display_height = decoder->config.display_height,
        .bt709 = decoder->config.bt709,
        .full_range = decoder->config.full_range,
        .service_color = output.color,
        .pts_us = pts_us,
        .timestamp_ns = output.timestamp_ns,
        .token = buffer->token,
    };
    return MOONLIGHT_DECODE_OK;
}

MoonlightDecodeResult moonlightDecoderRelease(MoonlightDecoder *decoder, uint32_t token)
{
    if (!decoder)
        return MOONLIGHT_DECODE_INVALID;

    unsigned index = (token & 0xf) - 1;
    if (index >= MOONLIGHT_DECODER_FRAMES)
        return MOONLIGHT_DECODE_INVALID;
    FrameBuffer *buffer = &decoder->frames[index];
    if (!buffer->held || buffer->token != token)
        return MOONLIGHT_DECODE_INVALID;

    buffer->held = false;
    return MOONLIGHT_DECODE_OK;
}

MoonlightDecodeResult moonlightDecoderClose(MoonlightDecoder *decoder)
{
    if (!decoder)
        return MOONLIGHT_DECODE_INVALID;

    if (decoder->uncertain) {
        retired = true;
        report(decoder, "decoder: close skipped after an uncertain call; restart the app");
        return MOONLIGHT_DECODE_UNCERTAIN;
    }

    VdecStatus status = decoder->backend.close(decoder->backend.context);
    if (status != VDEC_OK) {
        retired = true;
        decoder->uncertain = status != VDEC_REFUSED;
        report(decoder, "decoder: close failed (%u); media memory kept, restart the app", (unsigned)status);
        return decoder->uncertain ? MOONLIGHT_DECODE_UNCERTAIN : MOONLIGHT_DECODE_REFUSED;
    }

    report(decoder, "decoder: closed after %llu frames", (unsigned long long)decoder->decoded);
    free_frames(decoder);
    free(decoder);
    return MOONLIGHT_DECODE_OK;
}
