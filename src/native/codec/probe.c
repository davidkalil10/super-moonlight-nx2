#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <switch.h>

#include "gsv.h"
#include "probe.h"

#define WIDTH 1280u
#define HEIGHT 720u
#define FRAME_BYTES (WIDTH * HEIGHT * 3u / 2u)
#define PTS_US UINT64_C(123456)
#define READY_POLLS 2000u

static bool retained;

typedef struct {
    const char *directory;
    MoonlightDecoderLog log;
    bool uncertain;
} Probe;

static VdecStatus checked(Probe *probe, VdecStatus status)
{
    if (status == VDEC_UNCERTAIN || status == VDEC_MALFORMED)
        probe->uncertain = true;
    return status;
}

static void note(const Probe *probe, const char *format, ...) __attribute__((format(printf, 2, 3)));

static void note(const Probe *probe, const char *format, ...)
{
    char message[240];
    va_list args;
    va_start(args, format);
    vsnprintf(message, sizeof(message), format, args);
    va_end(args);
    probe->log(message);
}

static uint8_t *read_file(const Probe *probe, const char *name, size_t *bytes)
{
    char path[256];
    snprintf(path, sizeof(path), "%s/%s", probe->directory, name);
    FILE *file = fopen(path, "rb");
    if (!file) {
        note(probe, "probe: cannot open %s", path);
        return NULL;
    }

    uint8_t *data = NULL;
    long size = -1;
    if (fseek(file, 0, SEEK_END) == 0)
        size = ftell(file);
    if (size > 0 && size <= 2 * 1024 * 1024 && fseek(file, 0, SEEK_SET) == 0)
        data = malloc((size_t)size);
    if (data && fread(data, 1, (size_t)size, file) != (size_t)size) {
        free(data);
        data = NULL;
    }
    fclose(file);

    if (!data)
        note(probe, "probe: cannot read %s", path);
    *bytes = data ? (size_t)size : 0;
    return data;
}

static void write_file(const Probe *probe, const char *name, const void *data, size_t bytes)
{
    char path[256];
    snprintf(path, sizeof(path), "%s/%s", probe->directory, name);
    FILE *file = fopen(path, "wb");
    bool written = file && fwrite(data, 1, bytes, file) == bytes;
    if (file)
        fclose(file);
    note(probe, "probe: %s %s (%zu bytes)", written ? "wrote" : "cannot write", path, bytes);
}

static void save_evidence(const Probe *probe, void *context, unsigned surface)
{
    VdecGsvEvidence evidence;
    vdecGsvEvidence(context, surface, &evidence);

    char name[64];
    snprintf(name, sizeof(name), "descriptor-%u.bin", evidence.image);
    write_file(probe, name, evidence.descriptor, VDEC_IMAGE_DESCRIPTOR_BYTES);

    armDCacheFlush((void *)evidence.memory, evidence.bytes);
    snprintf(name, sizeof(name), "surface-%u.bin", evidence.image);
    write_file(probe, name, evidence.memory, evidence.bytes);
}

static bool wait_ready(Probe *probe, const VdecBackend *backend, unsigned *surface)
{
    for (unsigned poll = 0; poll < READY_POLLS; poll++) {
        for (unsigned index = 0; index < VDEC_SURFACES; index++) {
            bool ready = false;
            if (checked(probe, backend->ready(backend->context, index, &ready)) != VDEC_OK) {
                note(probe, "probe: fence read failed");
                return false;
            }
            if (ready) {
                note(probe, "probe: surface %u ready after %u polls", index, poll + 1);
                *surface = index;
                return true;
            }
        }
        svcSleepThread(1000000);
    }

    note(probe, "probe: no surface ready after %u ms", READY_POLLS);
    return false;
}

static size_t compare(const uint8_t *decoded, const uint8_t *reference)
{
    size_t mismatches = 0;
    for (size_t i = 0; i < FRAME_BYTES; i++) {
        if (decoded[i] != reference[i])
            mismatches++;
    }
    return mismatches;
}

static bool decode_one(Probe *probe, const VdecBackend *backend, const uint8_t *sample,
    size_t sample_bytes, const uint8_t *reference, const uint32_t images[VDEC_SURFACES])
{
    if (checked(probe, backend->submit(backend->context, sample, (uint32_t)sample_bytes, PTS_US)) != VDEC_OK)
        return false;

    unsigned surface = 0;
    if (!wait_ready(probe, backend, &surface))
        return false;

    VdecOutput output;
    if (checked(probe, backend->output(backend->context, &output)) != VDEC_OK)
        return false;
    note(probe, "probe: output image %u %ux%u display %ux%u color %u ts %llu eos %u",
        output.image, output.width, output.height, output.display_width, output.display_height,
        output.color, (unsigned long long)output.timestamp_ns, output.end_of_stream);
    bool identity_ok = output.image == images[surface] && output.timestamp_ns == PTS_US * 1000;
    bool dimensions_ok = output.width == WIDTH && output.height == HEIGHT &&
        output.display_width == WIDTH && output.display_height == HEIGHT;
    if (!identity_ok || !dimensions_ok || output.end_of_stream) {
        note(probe, "probe: output metadata mismatch; retaining resources");
        probe->uncertain = true;
        return false;
    }

    uint8_t *decoded = malloc(FRAME_BYTES);
    if (!decoded)
        return false;
    memset(decoded, 0xa5, FRAME_BYTES);
    VdecTarget target = {
        .luma = decoded,
        .chroma = decoded + WIDTH * HEIGHT,
        .luma_stride = WIDTH,
        .chroma_stride = WIDTH,
        .width = WIDTH,
        .height = HEIGHT,
    };
    VdecStatus readback = checked(probe, backend->readback(backend->context, surface, &target));
    save_evidence(probe, backend->context, surface);

    bool verified = false;
    if (readback == VDEC_OK) {
        size_t mismatches = compare(decoded, reference);
        write_file(probe, "decoded.nv12", decoded, FRAME_BYTES);
        note(probe, "probe: pixels %s, %zu of %u bytes differ", mismatches ? "MISMATCH" : "VERIFIED",
            mismatches, FRAME_BYTES);
        verified = mismatches == 0;
    }
    if (readback != VDEC_OK)
        note(probe, "probe: readback status %u; raw surface saved for offline layout", (unsigned)readback);
    free(decoded);

    VdecStatus released = checked(probe, backend->release(backend->context, surface));
    note(probe, "probe: release status %u", (unsigned)released);
    return verified && released == VDEC_OK;
}

bool moonlightCodecProbe(const char *directory, MoonlightDecoderLog log)
{
    Probe probe = {.directory = directory, .log = log};
    if (retained) {
        note(&probe, "probe: retained resources; no second run");
        return false;
    }
    size_t sample_bytes = 0;
    size_t reference_bytes = 0;
    uint8_t *sample = read_file(&probe, "blue.av1", &sample_bytes);
    uint8_t *reference = read_file(&probe, "blue.nv12", &reference_bytes);
    bool inputs_ok = sample && reference && sample_bytes <= VDEC_INPUT_MAX && reference_bytes == FRAME_BYTES;
    if (!inputs_ok) {
        note(&probe, "probe: needs blue.av1 and a %u-byte blue.nv12", FRAME_BYTES);
        free(sample);
        free(reference);
        return false;
    }

    VdecBackend backend;
    if (vdecGsvCreate(log, &backend) != VDEC_OK) {
        free(sample);
        free(reference);
        return false;
    }

    VdecOpenParams params = {
        .coded_width = WIDTH,
        .coded_height = HEIGHT,
        .display_width = WIDTH,
        .display_height = HEIGHT,
        .frame_registered = false,
        .native_image_backing = true,
    };
    uint32_t images[VDEC_SURFACES] = {0};
    VdecStatus opened = backend.open(backend.context, &params, images);
    note(&probe, "probe: open status %u", (unsigned)opened);
    if (opened != VDEC_OK) {
        retained = opened == VDEC_UNCERTAIN || opened == VDEC_MALFORMED;
        if (!retained)
            vdecGsvDestroyUnopened(&backend);
        free(sample);
        free(reference);
        return false;
    }

    bool verified = decode_one(&probe, &backend, sample, sample_bytes, reference, images);
    VdecStatus closed = VDEC_UNCERTAIN;
    if (!probe.uncertain)
        closed = backend.close(backend.context);
    note(&probe, "probe: close status %u%s", (unsigned)closed,
        closed == VDEC_OK ? "" : "; media memory kept, restart before another decoder");
    retained = closed != VDEC_OK;

    free(sample);
    free(reference);
    note(&probe, "probe: result %s", verified && closed == VDEC_OK ? "PASS" : "FAIL");
    return verified && closed == VDEC_OK;
}

bool moonlightCodecProbeRetained(void)
{
    return retained;
}
