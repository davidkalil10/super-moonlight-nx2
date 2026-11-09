#include <string.h>

#include "wire.h"

#define HEADER_SPECIAL UINT32_C(0x80000000)
#define HEADER_WORDS_MASK UINT32_C(0x3ff)
#define SPECIAL_ONE_COPY UINT32_C(0x2)
#define SPECIAL_ONE_MOVE UINT32_C(0x20)
#define SEND_BUFFERS_ONE UINT32_C(0x00100000)
#define ADDRESS_LIMIT (UINT64_C(1) << 39)
#define MIB (UINT64_C(1) << 20)

static const struct {
    uint32_t width;
    uint32_t height;
    uint32_t mebibytes;
} av1_workspace[] = {
    {256, 144, 9}, {640, 360, 16}, {854, 480, 22},
    {1280, 720, 40}, {1920, 1080, 78}, {3840, 2160, 272},
};

static void put32(uint8_t *at, uint32_t value)
{
    for (unsigned i = 0; i < 4; i++)
        at[i] = (uint8_t)(value >> (8 * i));
}

static void put64(uint8_t *at, uint64_t value)
{
    put32(at, (uint32_t)value);
    put32(at + 4, (uint32_t)(value >> 32));
}

static uint32_t get32(const uint8_t *at)
{
    return (uint32_t)at[0] | (uint32_t)at[1] << 8 | (uint32_t)at[2] << 16 | (uint32_t)at[3] << 24;
}

static uint64_t get64(const uint8_t *at)
{
    return get32(at) | (uint64_t)get32(at + 4) << 32;
}

static size_t header(uint8_t *out, uint32_t first, uint32_t words)
{
    memset(out, 0, VDEC_MESSAGE_BYTES);
    put32(out, first);
    put32(out + 4, words);
    return 8 + (size_t)(words & HEADER_WORDS_MASK) * 4;
}

static void buffer_descriptor(uint8_t *at, uint64_t address, uint64_t size)
{
    uint32_t packed = (uint32_t)((address >> 36) & 0x7) << 2;
    packed |= (uint32_t)((size >> 32) & 0xf) << 24;
    packed |= (uint32_t)((address >> 32) & 0xf) << 28;

    put32(at, (uint32_t)size);
    put32(at + 4, (uint32_t)address);
    put32(at + 8, packed);
}

bool vdecFrameDimensions(uint32_t width, uint32_t height)
{
    bool bounded = width >= 2 && width <= 3840 && height >= 2 && height <= 2160;
    bool even = width % 2 == 0 && height % 2 == 0;
    return bounded && even;
}

void vdecImagePreference(uint8_t out[64], uint32_t width, uint32_t height)
{
    memset(out, 0, 64);
    put64(out, UINT64_C(0x100000000));
    put32(out + 8, (height - 1) << 16 | (width - 1));
}

uint64_t vdecAv1WorkspaceBytes(uint32_t width, uint32_t height)
{
    const size_t levels = sizeof(av1_workspace) / sizeof(av1_workspace[0]);
    size_t level = 0;
    while (level + 1 < levels) {
        bool fits = width <= av1_workspace[level].width && height <= av1_workspace[level].height;
        if (fits)
            break;
        level++;
    }

    uint64_t bytes = av1_workspace[level].mebibytes * MIB;
    uint64_t proven = 64 * MIB;
    return bytes > proven ? bytes : proven;
}

size_t vdecBuildEmpty(uint8_t *out, uint16_t wire)
{
    return header(out, wire, 0);
}

size_t vdecBuildDecoderContext(uint8_t *out, uint8_t flag, uint64_t version)
{
    size_t bytes = header(out, VDEC_WIRE_ROOT_DECODER_CONTEXT, 3);
    out[8] = flag;
    put64(out + 12, version);
    return bytes;
}

size_t vdecBuildInitialize(uint8_t *out, uint32_t transfer_handle, uint64_t transfer_bytes,
    uint32_t registration)
{
    size_t bytes = header(out, VDEC_WIRE_INITIALIZE, HEADER_SPECIAL | 6);
    put32(out + 8, SPECIAL_ONE_COPY);
    put32(out + 12, transfer_handle);
    put64(out + 16, transfer_bytes);
    put32(out + 24, registration);
    put32(out + 28, 1);
    put32(out + 32, 3);
    put32(out + 36, 1);
    return bytes + 8;
}

VdecWireStatus vdecBuildConfigure(uint8_t *out, size_t *bytes, uint64_t mime_address,
    uint32_t mime_bytes, uint32_t width, uint32_t height)
{
    bool address_ok = mime_address >= 0x1000 && mime_address < ADDRESS_LIMIT;
    bool size_ok = mime_bytes > 0 && mime_bytes <= 64 && vdecFrameDimensions(width, height);
    if (!address_ok || !size_ok)
        return VDEC_WIRE_INVALID;

    *bytes = header(out, SEND_BUFFERS_ONE | VDEC_WIRE_CONFIGURE, 8) + 12;
    buffer_descriptor(out + 8, mime_address, mime_bytes);
    put32(out + 20, width);
    put32(out + 24, height);
    put32(out + 28, 60);
    put32(out + 32, VDEC_INPUT_MAX);
    return VDEC_WIRE_OK;
}

VdecWireStatus vdecBuildSubmit(uint8_t *out, size_t *bytes, uint64_t address, uint32_t length,
    uint64_t pts_us, bool end_of_stream)
{
    bool address_ok = address >= 0x1000 && address < ADDRESS_LIMIT;
    bool length_ok = length <= VDEC_INPUT_MAX && (length > 0 || end_of_stream);
    if (!address_ok || !length_ok)
        return VDEC_WIRE_INVALID;

    *bytes = header(out, SEND_BUFFERS_ONE | VDEC_WIRE_SUBMIT, 3) + 12;
    buffer_descriptor(out + 8, address, length);
    put64(out + 20, pts_us);
    out[28] = end_of_stream ? 1 : 0;
    return VDEC_WIRE_OK;
}

size_t vdecBuildImageCommand(uint8_t *out, uint16_t wire, uint32_t image)
{
    uint32_t words = wire == VDEC_WIRE_REGISTER_IMAGE ? 4 : 1;
    size_t bytes = header(out, wire, words);
    put32(out + 8, image);
    return bytes;
}

size_t vdecBuildReleaseImage(uint8_t *out, uint32_t image)
{
    size_t bytes = header(out, VDEC_WIRE_RELEASE_IMAGE, 8);
    put32(out + 8, image);
    return bytes;
}

size_t vdecBuildImagePoolSize(uint8_t *out, const uint8_t preference[64], uint32_t count)
{
    size_t bytes = header(out, VDEC_WIRE_ROOT_IMAGE_POOL_SIZE, 17);
    memcpy(out + 8, preference, 64);
    put32(out + 72, count);
    return bytes;
}

size_t vdecBuildImageMemoryAttach(uint8_t *out, uint32_t memory, uint64_t address, uint64_t bytes,
    uint64_t flags)
{
    size_t length = header(out, VDEC_WIRE_ROOT_IMAGE_MEMORY_ATTACH, 9);
    put32(out + 8, memory);
    put64(out + 12, address);
    put64(out + 20, bytes);
    put64(out + 28, flags);
    return length;
}

size_t vdecBuildImagePoolCreate(uint8_t *out, const uint8_t preference[64], uint32_t count,
    uint32_t memory)
{
    size_t bytes = header(out, VDEC_WIRE_ROOT_IMAGE_POOL_CREATE, 18);
    memcpy(out + 8, preference, 64);
    put32(out + 72, count);
    put32(out + 76, memory);
    return bytes;
}

VdecWireStatus vdecParseReply(const uint8_t *message, uint16_t wire, uint32_t min_words,
    bool moved_handle, VdecReply *out)
{
    uint32_t first = get32(message);
    uint32_t second = get32(message + 4);
    uint32_t words = second & HEADER_WORDS_MASK;
    bool special = (second & HEADER_SPECIAL) != 0;

    bool type_ok = (first & 0xffff) == wire && (first >> 16) == 0;
    bool shape_ok = special == moved_handle && words >= min_words && words <= 60;
    if (!type_ok || !shape_ok)
        return VDEC_WIRE_MALFORMED;

    memset(out, 0, sizeof(*out));
    if (!moved_handle && words == 0)
        return VDEC_WIRE_OK;
    if (!moved_handle) {
        out->result = get32(message + 8);
        out->data = message + 12;
        out->words = words;
        return VDEC_WIRE_OK;
    }

    if (get32(message + 8) != SPECIAL_ONE_MOVE)
        return VDEC_WIRE_MALFORMED;

    out->handle = get32(message + 12);
    out->result = get32(message + 16);
    out->data = message + 20;
    out->words = words;
    return VDEC_WIRE_OK;
}

VdecWireStatus vdecParseFence(const VdecReply *reply, VdecFence *out)
{
    if (reply->words < 5)
        return VDEC_WIRE_MALFORMED;

    out->counter = get32(reply->data);
    out->mode = get32(reply->data + 4);
    out->value = get64(reply->data + 8);
    if (out->mode > 1)
        return VDEC_WIRE_MALFORMED;
    return VDEC_WIRE_OK;
}

VdecWireStatus vdecParseOutput(const VdecReply *reply, VdecOutput *out)
{
    if (reply->words < 11)
        return VDEC_WIRE_MALFORMED;

    const uint8_t *data = reply->data;
    out->image = get32(data);
    out->width = get32(data + 4);
    out->height = get32(data + 8);
    out->display_width = get32(data + 12);
    out->display_height = get32(data + 16);
    out->color = get32(data + 20);
    out->timestamp_ns = get64(data + 24);
    out->end_of_stream = (data[32] & 1) != 0;
    return VDEC_WIRE_OK;
}

bool vdecFenceReached(const VdecFence *fence, uint64_t counter_value)
{
    if (counter_value == UINT64_MAX)
        return false;

    if (fence->mode == 1)
        return counter_value >= fence->value;

    uint32_t distance = (uint32_t)counter_value - (uint32_t)fence->value;
    return (int32_t)distance >= 0;
}
