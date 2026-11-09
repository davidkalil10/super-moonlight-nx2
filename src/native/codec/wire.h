#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * TIPC messages of the GSV video decoder route. Names use logical command IDs; the
 * VDEC_WIRE_* values are the words on the wire (logical + 16). Layouts: codec/README.md.
 */

#define VDEC_MESSAGE_BYTES 0x100

enum {
    VDEC_WIRE_ROOT_DECODER_PRECHECK = 917,
    VDEC_WIRE_ROOT_DECODER_FINALIZE = 919,
    VDEC_WIRE_ROOT_DECODER_CONTEXT = 922,
    VDEC_WIRE_ROOT_IMAGE_POOL_CREATE = 927,
    VDEC_WIRE_ROOT_IMAGE_POOL_DESTROY = 928,
    VDEC_WIRE_ROOT_IMAGE_DESCRIPTOR = 977,
    VDEC_WIRE_ROOT_IMAGE_POOL_SIZE = 1007,
    VDEC_WIRE_ROOT_IMAGE_MEMORY_ATTACH = 130,
    VDEC_WIRE_CONTEXT_CREATE_SERVICE = 17,
    VDEC_WIRE_START = 22,
    VDEC_WIRE_CONFIGURE = 117,
    VDEC_WIRE_SUBMIT = 125,
    VDEC_WIRE_FINALIZE = 131,
    VDEC_WIRE_INITIALIZE = 217,
    VDEC_WIRE_STOP = 223,
    VDEC_WIRE_OUTPUT = 229,
    VDEC_WIRE_REGISTER_IMAGE = 327,
    VDEC_WIRE_RELEASE_IMAGE = 330,
};

#define VDEC_LIBRARY_VERSION UINT64_C(0x0000000300030000)
#define VDEC_REGISTRATION_AV1 3u
#define VDEC_INPUT_MAX (1024u * 1024u)
#define VDEC_IMAGE_DESCRIPTOR_BYTES 128u

typedef enum {
    VDEC_WIRE_OK = 0,
    VDEC_WIRE_INVALID,
    VDEC_WIRE_MALFORMED,
} VdecWireStatus;

typedef struct {
    uint32_t counter;
    uint32_t mode;
    uint64_t value;
} VdecFence;

typedef struct {
    uint32_t image;
    uint32_t width;
    uint32_t height;
    uint32_t display_width;
    uint32_t display_height;
    uint32_t color;
    uint64_t timestamp_ns;
    bool end_of_stream;
} VdecOutput;

typedef struct {
    uint32_t result;
    uint32_t handle;
    const uint8_t *data;
    uint32_t words;
} VdecReply;

void vdecImagePreference(uint8_t out[64], uint32_t width, uint32_t height);
bool vdecFrameDimensions(uint32_t width, uint32_t height);
uint64_t vdecAv1WorkspaceBytes(uint32_t width, uint32_t height);

size_t vdecBuildEmpty(uint8_t *out, uint16_t wire);
size_t vdecBuildDecoderContext(uint8_t *out, uint8_t flag, uint64_t version);
size_t vdecBuildInitialize(uint8_t *out, uint32_t transfer_handle, uint64_t transfer_bytes,
    uint32_t registration);
VdecWireStatus vdecBuildConfigure(uint8_t *out, size_t *bytes, uint64_t mime_address,
    uint32_t mime_bytes, uint32_t width, uint32_t height);
VdecWireStatus vdecBuildSubmit(uint8_t *out, size_t *bytes, uint64_t address, uint32_t length,
    uint64_t pts_us, bool end_of_stream);
size_t vdecBuildImageCommand(uint8_t *out, uint16_t wire, uint32_t image);
size_t vdecBuildReleaseImage(uint8_t *out, uint32_t image);
size_t vdecBuildImagePoolSize(uint8_t *out, const uint8_t preference[64], uint32_t count);
size_t vdecBuildImageMemoryAttach(uint8_t *out, uint32_t memory, uint64_t address, uint64_t bytes,
    uint64_t flags);

size_t vdecBuildImagePoolCreate(uint8_t *out, const uint8_t preference[64], uint32_t count,
    uint32_t memory);

VdecWireStatus vdecParseReply(const uint8_t *message, uint16_t wire, uint32_t min_words,
    bool moved_handle, VdecReply *out);
VdecWireStatus vdecParseFence(const VdecReply *reply, VdecFence *out);
VdecWireStatus vdecParseOutput(const VdecReply *reply, VdecOutput *out);
bool vdecFenceReached(const VdecFence *fence, uint64_t counter_value);
