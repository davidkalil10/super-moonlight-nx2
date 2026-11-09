#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <switch.h>

#include "gsv.h"
#include "untile.h"

#define INPUT_BUFFERS 2u
#define PAGE 0x1000u
#define SURFACE_MAX (UINT64_C(64) << 20)
#define IMAGE_MEMORY_TYPE 3u
#define FRAME_MODE 2u
#define MEMORY_ATTRIBUTE_FLAG 2u
#define PERMISSION_POLLS 100u
#define GPU_ALIGNMENT 0x10000u
#define GPU_EVENT_TIMEOUT_NS UINT64_C(1000000000)
#define GPU_CLIENT_NAME UINT64_C(0x6365647664766c6d)
#define GPU_REQUEST_WORKER 37u
#define GPU_RECEIVE_WORKER 38u

static const char mime_av1[] = "video/av1";

typedef struct {
    uint8_t *memory;
    uint64_t bytes;
    uint32_t memory_id;
    uint32_t gpu_range;
    uint32_t image;
    VdecFence fence;
    bool attribute;
    bool memory_reserved;
    bool gpu_registered;
    bool pool_created;
    uint8_t descriptor[VDEC_IMAGE_DESCRIPTOR_BYTES];
} Surface;

typedef struct {
    MoonlightDecoderLog log;
    GsvSync sync;
    GsvGpu gpu;
    Event gpu_event;
    uint32_t gpu_slot;
    uint8_t gpu_client;
    bool gpu_open;
    bool gpu_event_open;
    bool gpu_client_open;
    bool root;
    bool sync_open;
    bool memory_attribute;
    bool precheck;
    Handle context;
    Handle service;
    TransferMemory work;
    uint8_t *work_memory;
    uint64_t work_bytes;
    bool work_open;
    bool initialized;
    bool started;
    VdecOpenParams params;
    Surface surfaces[VDEC_SURFACES];
    uint8_t *inputs[INPUT_BUFFERS];
    unsigned next_input;
    char *mime;
    uint8_t message[VDEC_MESSAGE_BYTES];
    uint8_t reply[VDEC_MESSAGE_BYTES];
    uint32_t last_result;
    const char *last_stage;
} GsvVdec;

static void report(const GsvVdec *state, const char *format, ...) __attribute__((format(printf, 2, 3)));

static void report(const GsvVdec *state, const char *format, ...)
{
    if (!state->log)
        return;

    char message[200];
    va_list args;
    va_start(args, format);
    vsnprintf(message, sizeof(message), format, args);
    va_end(args);
    state->log(message);
}

static VdecStatus libounce(GsvVdec *state, const char *stage, Result rc)
{
    state->last_stage = stage;
    state->last_result = rc;
    report(state, "vdec: %s 0x%x", stage, rc);
    if (R_SUCCEEDED(rc))
        return VDEC_OK;
    return R_MODULE(rc) == Module_Kernel ? VDEC_UNCERTAIN : VDEC_REFUSED;
}

static VdecStatus exchange(GsvVdec *state, const char *stage, Handle session, size_t bytes,
    uint32_t min_words, bool moved_handle, VdecReply *reply)
{
    uint16_t wire = (uint16_t)(state->message[0] | state->message[1] << 8);
    state->last_stage = stage;

    memcpy(armGetTls(), state->message, bytes);
    Result rc = svcSendSyncRequest(session);
    memcpy(state->reply, armGetTls(), sizeof(state->reply));
    if (R_FAILED(rc)) {
        state->last_result = rc;
        report(state, "vdec: %s kernel 0x%x", stage, rc);
        return VDEC_UNCERTAIN;
    }

    if (vdecParseReply(state->reply, wire, min_words, moved_handle, reply) != VDEC_WIRE_OK) {
        report(state, "vdec: %s malformed reply %08x %08x", stage,
            (unsigned)(state->reply[0] | state->reply[1] << 8 | state->reply[2] << 16 | (unsigned)state->reply[3] << 24),
            (unsigned)(state->reply[4] | state->reply[5] << 8 | state->reply[6] << 16 | (unsigned)state->reply[7] << 24));
        return VDEC_MALFORMED;
    }

    state->last_result = reply->result;
    report(state, "vdec: %s 0x%x", stage, reply->result);
    return reply->result ? VDEC_REFUSED : VDEC_OK;
}

static Handle root_session(void)
{
    return gsvGetServiceSession()->session;
}

static uint64_t align_up(uint64_t value, uint64_t alignment)
{
    return (value + alignment - 1) & ~(alignment - 1);
}

static VdecStatus open_context(GsvVdec *state)
{
    VdecReply reply;
    size_t bytes = vdecBuildEmpty(state->message, VDEC_WIRE_ROOT_DECODER_PRECHECK);
    VdecStatus status = exchange(state, "root 901 precheck", root_session(), bytes, 0, false, &reply);
    if (status != VDEC_OK)
        return status;
    state->precheck = true;

    bytes = vdecBuildDecoderContext(state->message, 0, VDEC_LIBRARY_VERSION);
    status = exchange(state, "root 906 context", root_session(), bytes, 1, true, &reply);
    if (status != VDEC_OK)
        return status;
    if (!reply.handle)
        return VDEC_MALFORMED;
    state->context = reply.handle;

    bytes = vdecBuildEmpty(state->message, VDEC_WIRE_CONTEXT_CREATE_SERVICE);
    status = exchange(state, "context 1 service", state->context, bytes, 1, true, &reply);
    if (status != VDEC_OK)
        return status;
    if (!reply.handle || reply.handle == state->context)
        return VDEC_MALFORMED;
    state->service = reply.handle;
    return VDEC_OK;
}

static VdecStatus open_sync(GsvVdec *state)
{
    VdecStatus status = libounce(state, "gsv sync open", gsvOpenSync(&state->sync));
    if (status != VDEC_OK)
        return status;
    state->sync_open = true;

    u64 permitted = state->params.permitted_frame_mode;
    if (!state->params.frame_registered) {
        status = libounce(state, "gsv frame register", gsvRegisterFrame(FRAME_MODE, &permitted));
        if (status != VDEC_OK)
            return status;
    }
    state->memory_attribute = (permitted & MEMORY_ATTRIBUTE_FLAG) != 0;
    report(state, "vdec: permitted frame mode 0x%llx (%s)", (unsigned long long)permitted,
           state->params.frame_registered ? "from the process" : "registered here");
    return VDEC_OK;
}

static VdecStatus size_surfaces(GsvVdec *state, const uint8_t preference[64], uint64_t *bytes, uint64_t *alignment)
{
    VdecReply reply;
    size_t length = vdecBuildImagePoolSize(state->message, preference, 1);
    VdecStatus status = exchange(state, "root 991 pool size", root_session(), length, 5, false, &reply);
    if (status != VDEC_OK)
        return status;

    uint64_t size = 0;
    uint64_t align = 0;
    memcpy(&size, reply.data, sizeof(size));
    memcpy(&align, reply.data + 8, sizeof(align));
    report(state, "vdec: surface 0x%llx bytes, alignment 0x%llx", (unsigned long long)size, (unsigned long long)align);

    uint64_t frame = (uint64_t)state->params.coded_width * state->params.coded_height * 3 / 2;
    bool size_ok = size >= frame && size <= SURFACE_MAX;
    bool align_ok = align && (align & (align - 1)) == 0 && align <= SURFACE_MAX;
    if (!size_ok || !align_ok)
        return VDEC_MALFORMED;

    uint64_t minimum = state->params.native_image_backing ? GPU_ALIGNMENT : PAGE;
    *alignment = align < minimum ? minimum : align;
    *bytes = align_up(size, *alignment);
    return VDEC_OK;
}

static VdecStatus open_native_gpu(GsvVdec *state)
{
    VdecStatus status = libounce(state, "gsv gpu open", gsvOpenGpu(&state->gpu));
    if (status != VDEC_OK)
        return status;
    state->gpu_open = true;

    uint32_t last = 0;
    status = libounce(state, "gsv gpu slots", gsvGpuGetSlotRange(&state->gpu, &state->gpu_slot, &last));
    if (status != VDEC_OK)
        return status;
    if (state->gpu_slot > last)
        return VDEC_MALFORMED;

    status = libounce(state, "gsv gpu event",
        gsvGpuCreateSlotEvent(&state->gpu, state->gpu_slot, &state->gpu_event, false));
    if (status != VDEC_OK)
        return status;
    state->gpu_event_open = true;

    VdecReply reply;
    size_t bytes = vdecBuildImageCommand(state->message, GPU_REQUEST_WORKER, state->gpu_slot);
    status = exchange(state, "gsv gpu request worker", state->gpu.main.session, bytes, 1, false, &reply);
    if (status != VDEC_OK)
        return status;
    status = libounce(state, "gsv gpu worker event", eventWait(&state->gpu_event, GPU_EVENT_TIMEOUT_NS));
    if (status != VDEC_OK)
        return VDEC_UNCERTAIN;

    bytes = vdecBuildEmpty(state->message, GPU_RECEIVE_WORKER);
    status = exchange(state, "gsv gpu receive worker", state->gpu.main.session, bytes, 1, true, &reply);
    if (status != VDEC_OK)
        return VDEC_UNCERTAIN;
    if (!reply.handle)
        return VDEC_MALFORMED;
    tipcCreate(&state->gpu.worker, reply.handle);

    status = libounce(state, "gsv gpu client",
        gsvGpuRegisterClient(&state->gpu, GPU_CLIENT_NAME, &state->gpu_client));
    if (status == VDEC_OK)
        state->gpu_client_open = true;
    return status;
}

static VdecStatus create_surface(GsvVdec *state, Surface *surface, const uint8_t preference[64],
    uint64_t bytes, uint64_t alignment)
{
    surface->memory = aligned_alloc(alignment, bytes);
    if (!surface->memory)
        return VDEC_NO_MEMORY;
    surface->bytes = bytes;
    memset(surface->memory, 0, bytes);
    armDCacheFlush(surface->memory, bytes);

    VdecStatus status;
    if (state->memory_attribute || state->params.native_image_backing) {
        status = libounce(state, "surface attribute", svcUnknown80(surface->memory, bytes, 0x20, 0x20));
        if (status != VDEC_OK)
            return status;
        surface->attribute = true;
    }

    if (state->params.native_image_backing) {
        status = libounce(state, "surface gpu range",
            gsvGpuRegisterMemory(&state->gpu, (u64)surface->memory, bytes,
                state->gpu_client, &surface->gpu_range));
        if (status != VDEC_OK)
            return status;
        surface->gpu_registered = true;
        if (!surface->gpu_range)
            return VDEC_MALFORMED;
    }

    status = libounce(state, "surface memory id", gsvReserveImageMemory(IMAGE_MEMORY_TYPE, bytes, &surface->memory_id));
    if (status != VDEC_OK)
        return status;
    surface->memory_reserved = true;

    size_t length;
    if (state->params.native_image_backing) {
        status = libounce(state, "root 423 native image backing",
            gsvRegisterImageMemory(surface->memory_id, (u64)surface->memory, bytes, surface->gpu_range, 0));
    } else {
        VdecReply attach;
        length = vdecBuildImageMemoryAttach(state->message, surface->memory_id, (u64)surface->memory, bytes,
            surface->attribute ? MEMORY_ATTRIBUTE_FLAG : 0);
        status = exchange(state, "root 114 memory attach", root_session(), length, 1, false, &attach);
    }
    if (status != VDEC_OK)
        return status;

    VdecReply reply;
    length = vdecBuildImagePoolCreate(state->message, preference, 1, surface->memory_id);
    status = exchange(state, "root 911 pool create", root_session(), length, 2, false, &reply);
    if (status != VDEC_OK)
        return status;
    memcpy(&surface->image, reply.data, sizeof(surface->image));
    if (!surface->image)
        return VDEC_MALFORMED;
    surface->pool_created = true;
    report(state, "vdec: image %u in memory %u", surface->image, surface->memory_id);
    return VDEC_OK;
}

static VdecStatus register_surface(GsvVdec *state, Surface *surface)
{
    VdecReply reply;
    size_t bytes = vdecBuildImageCommand(state->message, VDEC_WIRE_REGISTER_IMAGE, surface->image);
    VdecStatus status = exchange(state, "service 311 register", state->service, bytes, 5, false, &reply);
    if (status != VDEC_OK)
        return status;
    if (vdecParseFence(&reply, &surface->fence) != VDEC_WIRE_OK)
        return VDEC_MALFORMED;

    report(state, "vdec: image %u fence %08x/%u/%llu", surface->image, surface->fence.counter,
        surface->fence.mode, (unsigned long long)surface->fence.value);
    return VDEC_OK;
}

static VdecStatus open_service(GsvVdec *state)
{
    state->work_bytes = vdecAv1WorkspaceBytes(state->params.display_width, state->params.display_height);
    state->work_memory = aligned_alloc(PAGE, state->work_bytes);
    if (!state->work_memory)
        return VDEC_NO_MEMORY;

    VdecStatus status = libounce(state, "workspace transfer memory",
        tmemCreateFromMemory(&state->work, state->work_memory, state->work_bytes, Perm_None));
    if (status != VDEC_OK)
        return status;
    state->work_open = true;

    VdecReply reply;
    size_t bytes = vdecBuildInitialize(state->message, state->work.handle, state->work_bytes, VDEC_REGISTRATION_AV1);
    status = exchange(state, "service 201 initialize", state->service, bytes, 1, false, &reply);
    if (status != VDEC_OK)
        return status;
    state->initialized = true;

    state->mime = aligned_alloc(PAGE, PAGE);
    if (!state->mime)
        return VDEC_NO_MEMORY;
    memset(state->mime, 0, PAGE);
    memcpy(state->mime, mime_av1, sizeof(mime_av1));

    if (vdecBuildConfigure(state->message, &bytes, (u64)state->mime, sizeof(mime_av1),
            state->params.coded_width, state->params.coded_height) != VDEC_WIRE_OK)
        return VDEC_INVALID;
    status = exchange(state, "service 101 configure", state->service, bytes, 1, false, &reply);
    if (status != VDEC_OK)
        return status;

    for (unsigned i = 0; i < VDEC_SURFACES; i++) {
        status = register_surface(state, &state->surfaces[i]);
        if (status != VDEC_OK)
            return status;
    }

    bytes = vdecBuildEmpty(state->message, VDEC_WIRE_START);
    status = exchange(state, "service 6 start", state->service, bytes, 1, false, &reply);
    if (status != VDEC_OK)
        return status;
    state->started = true;
    return VDEC_OK;
}

static VdecStatus open_all(GsvVdec *state, uint32_t images[VDEC_SURFACES])
{
    VdecStatus status = libounce(state, "gsv root", gsvInitialize());
    if (status != VDEC_OK)
        return status;
    state->root = true;
    report(state, "vdec: surface backing %s", state->params.native_image_backing ? "native gpu" : "cpu reference");

    status = open_sync(state);
    if (status != VDEC_OK)
        return status;

    if (state->params.native_image_backing) {
        status = open_native_gpu(state);
        if (status != VDEC_OK)
            return status;
    }

    status = open_context(state);
    if (status != VDEC_OK)
        return status;

    uint8_t preference[64];
    vdecImagePreference(preference, state->params.coded_width, state->params.coded_height);
    uint64_t bytes = 0;
    uint64_t alignment = 0;
    status = size_surfaces(state, preference, &bytes, &alignment);
    if (status != VDEC_OK)
        return status;

    for (unsigned i = 0; i < VDEC_SURFACES; i++) {
        status = create_surface(state, &state->surfaces[i], preference, bytes, alignment);
        if (status != VDEC_OK)
            return status;
        images[i] = state->surfaces[i].image;
    }

    for (unsigned i = 0; i < INPUT_BUFFERS; i++) {
        state->inputs[i] = aligned_alloc(PAGE, VDEC_INPUT_MAX);
        if (!state->inputs[i])
            return VDEC_NO_MEMORY;
    }

    return open_service(state);
}

static VdecStatus close_service(GsvVdec *state)
{
    VdecReply reply;
    size_t bytes;
    VdecStatus status;

    if (state->started) {
        bytes = vdecBuildEmpty(state->message, VDEC_WIRE_STOP);
        status = exchange(state, "service 207 stop", state->service, bytes, 1, false, &reply);
        if (status != VDEC_OK)
            return status;
        state->started = false;
    }

    if (state->initialized) {
        bytes = vdecBuildEmpty(state->message, VDEC_WIRE_FINALIZE);
        status = exchange(state, "service 115 finalize", state->service, bytes, 0, false, &reply);
        if (status == VDEC_MALFORMED || status == VDEC_UNCERTAIN)
            return status;
        state->initialized = false;
    }
    return VDEC_OK;
}

static VdecStatus release_surface(GsvVdec *state, Surface *surface)
{
    VdecReply reply;
    VdecStatus status;

    if (surface->pool_created) {
        size_t bytes = vdecBuildImageCommand(state->message, VDEC_WIRE_ROOT_IMAGE_POOL_DESTROY, surface->image);
        status = exchange(state, "root 912 pool destroy", root_session(), bytes, 0, false, &reply);
        if (status != VDEC_OK)
            return status;
        surface->pool_created = false;
    }

    if (surface->memory_reserved) {
        status = libounce(state, "surface memory release", gsvReleaseImageMemory(surface->memory_id));
        if (status != VDEC_OK)
            return status;
        surface->memory_reserved = false;
    }

    if (surface->gpu_registered) {
        status = libounce(state, "surface gpu event reset", eventClear(&state->gpu_event));
        if (status != VDEC_OK)
            return VDEC_UNCERTAIN;
        status = libounce(state, "surface gpu unregister",
            gsvGpuUnregisterMemory(&state->gpu, surface->gpu_range, state->gpu_slot));
        if (status != VDEC_OK)
            return status;
        status = libounce(state, "surface gpu release event", eventWait(&state->gpu_event, GPU_EVENT_TIMEOUT_NS));
        if (status != VDEC_OK)
            return VDEC_UNCERTAIN;
        surface->gpu_registered = false;
    }

    if (surface->attribute) {
        status = libounce(state, "surface attribute reset", svcUnknown80(surface->memory, surface->bytes, 0x20, 0));
        if (status != VDEC_OK)
            return status;
        surface->attribute = false;
    }

    free(surface->memory);
    surface->memory = NULL;
    return VDEC_OK;
}

static VdecStatus release_workspace(GsvVdec *state)
{
    if (!state->work_open) {
        free(state->work_memory);
        state->work_memory = NULL;
        return VDEC_OK;
    }

    VdecStatus status = libounce(state, "workspace handle close", tmemCloseHandle(&state->work));
    if (status != VDEC_OK)
        return status;

    for (unsigned poll = 0; poll < PERMISSION_POLLS; poll++) {
        MemoryInfo info;
        u32 page;
        Result rc = svcQueryMemory(&info, &page, (u64)state->work_memory);
        if (R_SUCCEEDED(rc) && (info.perm & Perm_Rw) == Perm_Rw) {
            state->work_open = false;
            free(state->work_memory);
            state->work_memory = NULL;
            return VDEC_OK;
        }
        svcSleepThread(1000000);
    }

    report(state, "vdec: workspace still donated; memory kept");
    return VDEC_UNCERTAIN;
}

static VdecStatus close_all(GsvVdec *state)
{
    VdecStatus status = close_service(state);
    if (status != VDEC_OK)
        return status;

    for (unsigned i = VDEC_SURFACES; i-- > 0;) {
        status = release_surface(state, &state->surfaces[i]);
        if (status != VDEC_OK)
            return status;
    }

    if (state->service) {
        status = libounce(state, "service handle close", svcCloseHandle(state->service));
        if (status != VDEC_OK)
            return status;
        state->service = 0;
    }

    status = release_workspace(state);
    if (status != VDEC_OK)
        return status;

    if (state->context) {
        status = libounce(state, "context handle close", svcCloseHandle(state->context));
        if (status != VDEC_OK)
            return status;
        state->context = 0;
    }

    if (state->precheck) {
        VdecReply reply;
        size_t bytes = vdecBuildEmpty(state->message, VDEC_WIRE_ROOT_DECODER_FINALIZE);
        status = exchange(state, "root 903 finalize", root_session(), bytes, 0, false, &reply);
        if (status != VDEC_OK)
            return status;
        state->precheck = false;
    }

    if (state->gpu_client_open) {
        status = libounce(state, "gsv gpu client release", gsvGpuReleaseClient(&state->gpu, state->gpu_client));
        if (status != VDEC_OK)
            return status;
        state->gpu_client_open = false;
    }
    if (state->gpu_open) {
        gsvGpuClose(&state->gpu);
        state->gpu_open = false;
    }
    if (state->gpu_event_open) {
        eventClose(&state->gpu_event);
        state->gpu_event_open = false;
    }
    if (state->sync_open) {
        gsvSyncClose(&state->sync);
        state->sync_open = false;
    }
    if (state->root) {
        gsvExit();
        state->root = false;
    }

    for (unsigned i = 0; i < INPUT_BUFFERS; i++) {
        free(state->inputs[i]);
        state->inputs[i] = NULL;
    }
    free(state->mime);
    state->mime = NULL;
    return VDEC_OK;
}

static VdecStatus backend_open(void *context, const VdecOpenParams *params, uint32_t images[VDEC_SURFACES])
{
    GsvVdec *state = context;
    state->params = *params;

    VdecStatus status = open_all(state, images);
    if (status == VDEC_OK)
        return VDEC_OK;
    if (status == VDEC_MALFORMED || status == VDEC_UNCERTAIN)
        return status;

    VdecStatus cleanup = close_all(state);
    if (cleanup != VDEC_OK) {
        report(state, "vdec: cleanup after a failed open stopped at %s", state->last_stage);
        return VDEC_UNCERTAIN;
    }
    return status;
}

static VdecStatus backend_submit(void *context, const uint8_t *data, uint32_t length, uint64_t pts_us)
{
    GsvVdec *state = context;
    if (length > VDEC_INPUT_MAX)
        return VDEC_INVALID;

    uint8_t *input = state->inputs[state->next_input];
    state->next_input = (state->next_input + 1) % INPUT_BUFFERS;
    memcpy(input, data, length);

    size_t bytes = 0;
    if (vdecBuildSubmit(state->message, &bytes, (u64)input, length, pts_us, false) != VDEC_WIRE_OK)
        return VDEC_INVALID;

    VdecReply reply;
    return exchange(state, "service 109 submit", state->service, bytes, 1, false, &reply);
}

static VdecStatus backend_ready(void *context, unsigned surface, bool *ready)
{
    GsvVdec *state = context;
    const VdecFence *fence = &state->surfaces[surface].fence;

    u64 value = 0;
    u8 mode = 0;
    Result rc = gsvSyncReadCounter(&state->sync, fence->counter, &value, &mode);
    if (R_FAILED(rc)) {
        state->last_stage = "sync counter";
        state->last_result = rc;
        return VDEC_REFUSED;
    }

    *ready = vdecFenceReached(fence, value);
    return VDEC_OK;
}

static VdecStatus backend_output(void *context, VdecOutput *out)
{
    GsvVdec *state = context;
    VdecReply reply;
    size_t bytes = vdecBuildEmpty(state->message, VDEC_WIRE_OUTPUT);
    VdecStatus status = exchange(state, "service 213 output", state->service, bytes, 11, false, &reply);
    if (status != VDEC_OK)
        return status;
    return vdecParseOutput(&reply, out) == VDEC_WIRE_OK ? VDEC_OK : VDEC_MALFORMED;
}

static VdecStatus backend_readback(void *context, unsigned index, const VdecTarget *target)
{
    GsvVdec *state = context;
    Surface *surface = &state->surfaces[index];

    VdecReply reply;
    size_t bytes = vdecBuildImageCommand(state->message, VDEC_WIRE_ROOT_IMAGE_DESCRIPTOR, surface->image);
    VdecStatus status = exchange(state, "root 961 descriptor", root_session(), bytes, 33, false, &reply);
    if (status != VDEC_OK)
        return status;
    memcpy(surface->descriptor, reply.data, sizeof(surface->descriptor));

    VdecImageLayout layout;
    if (vdecParseImageDescriptor(surface->descriptor, &layout) != VDEC_UNTILE_OK) {
        report(state, "vdec: image kind 0x%x has no proven readback", surface->descriptor[0]);
        return VDEC_UNSUPPORTED;
    }

    armDCacheFlush(surface->memory, surface->bytes);
    VdecUntileStatus luma = vdecCopyPlane(surface->memory, surface->bytes, &layout.luma,
        target->width, target->height, target->luma, target->luma_stride);
    VdecUntileStatus chroma = vdecCopyPlane(surface->memory, surface->bytes, &layout.chroma,
        target->width, target->height / 2, target->chroma, target->chroma_stride);
    return luma == VDEC_UNTILE_OK && chroma == VDEC_UNTILE_OK ? VDEC_OK : VDEC_MALFORMED;
}

static VdecStatus backend_release(void *context, unsigned index)
{
    GsvVdec *state = context;
    Surface *surface = &state->surfaces[index];

    VdecReply reply;
    size_t bytes = vdecBuildReleaseImage(state->message, surface->image);
    VdecStatus status = exchange(state, "service 314 release", state->service, bytes, 5, false, &reply);
    if (status != VDEC_OK)
        return status;
    return vdecParseFence(&reply, &surface->fence) == VDEC_WIRE_OK ? VDEC_OK : VDEC_MALFORMED;
}

static VdecStatus backend_close(void *context)
{
    GsvVdec *state = context;
    VdecStatus status = close_all(state);
    if (status != VDEC_OK) {
        report(state, "vdec: close stopped at %s (0x%x)", state->last_stage, state->last_result);
        return status;
    }

    free(state);
    return VDEC_OK;
}

static uint64_t backend_now_ms(void *context)
{
    (void)context;
    return armTicksToNs(armGetSystemTick()) / 1000000;
}

VdecStatus vdecGsvCreate(MoonlightDecoderLog log, VdecBackend *out)
{
    GsvVdec *state = calloc(1, sizeof(*state));
    if (!state)
        return VDEC_NO_MEMORY;
    state->log = log;

    *out = (VdecBackend){
        .context = state,
        .open = backend_open,
        .submit = backend_submit,
        .ready = backend_ready,
        .output = backend_output,
        .readback = backend_readback,
        .release = backend_release,
        .close = backend_close,
        .now_ms = backend_now_ms,
    };
    return VDEC_OK;
}

void vdecGsvDestroyUnopened(VdecBackend *backend)
{
    free(backend->context);
    backend->context = NULL;
}

void vdecGsvEvidence(void *context, unsigned surface, VdecGsvEvidence *out)
{
    const GsvVdec *state = context;
    const Surface *entry = &state->surfaces[surface];
    *out = (VdecGsvEvidence){
        .descriptor = entry->descriptor,
        .memory = entry->memory,
        .bytes = entry->bytes,
        .image = entry->image,
        .last_result = state->last_result,
        .last_stage = state->last_stage,
    };
}

MoonlightDecodeResult moonlightDecoderOpen(const MoonlightDecoderConfig *config,
    MoonlightDecoderLog log, MoonlightDecoder **out)
{
    VdecBackend backend;
    if (vdecGsvCreate(log, &backend) != VDEC_OK)
        return MOONLIGHT_DECODE_NO_MEMORY;

    MoonlightDecodeResult result = vdecDecoderOpenWithBackend(config, log, &backend, out);
    if (result != MOONLIGHT_DECODE_OK && !moonlightDecoderRetired())
        vdecGsvDestroyUnopened(&backend);
    return result;
}
