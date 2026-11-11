#include <malloc.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <switch.h>

#define INPUT_MAX (1024u * 1024)
#define WORK_RESTORE_POLLS 1000
#define ACQUISITIONS_NOTED 8

enum {
    STAGE_ROOT = 1,
    STAGE_PREFERENCE,
    STAGE_POOL_SIZE,
    STAGE_POOL_MEMORY,
    STAGE_POOL,
    STAGE_DECODER,
    STAGE_WORK_MEMORY,
    STAGE_INITIALIZE,
    STAGE_REGISTER,
    STAGE_START,
    STAGE_STOP,
    STAGE_WORK_RESTORE,
    STAGE_POOL_CLOSE,
    STAGE_CONFIGURE,
    STAGE_SUBMISSION_EVENT,
};

typedef struct {
    uint32_t image;
    uint32_t width;
    uint32_t height;
    uint32_t crop_width;
    uint32_t crop_height;
    uint32_t end_of_stream;
    int64_t timestamp_ns;
} MoonlightSdkVideoOutput;

typedef struct {
    uint32_t type;
    uint32_t width;
    uint32_t height;
    uint32_t reserved;
    uint64_t pitch[2];
    uint32_t offset[2];
} MoonlightSdkVideoLayout;

static struct {
    ViddecDecoder decoder;
    ViddecImagePool pools[VIDDEC_MAX_IMAGES];
    uint32_t pools_open;
    GsvSync sync;
    Event wake;
    uint32_t wake_slot;
    bool wake_open;
    GsvNativeSync producers[VIDDEC_MAX_IMAGES];
    ViddecOutputProperties properties[VIDDEC_MAX_IMAGES];
    bool acquired[VIDDEC_MAX_IMAGES];
    bool described[VIDDEC_MAX_IMAGES];
    void *backing;
    void *work;
    uint32_t count;
    uint32_t width;
    uint32_t height;
    uint32_t acquisitions;
    Result poll_result;
    bool root;
    bool in_place;
    bool decoder_open;
    bool sync_open;
    bool started;
} video;

/* What a diagnostic session changes for its next open. Zero keeps the stream's choice. */
static struct {
    uint32_t input_format;
    uint32_t output_format;
    uint32_t pool_height;
    uint32_t max_input_bytes;
    bool split_initialize;
} tuning;

void moonlightPlatformLog(const uint8_t *message, size_t bytes);

__attribute__((format(printf, 1, 2))) static void note(const char *format, ...)
{
    char line[160];
    va_list arguments;

    va_start(arguments, format);
    int length = vsnprintf(line, sizeof(line), format, arguments);
    va_end(arguments);
    if (length < 0)
        return;
    if ((size_t)length >= sizeof(line))
        length = sizeof(line) - 1;
    moonlightPlatformLog((const uint8_t *)line, length);
}

static Result fail(uint32_t *stage, uint32_t at, Result result)
{
    *stage = at;
    return result;
}

/* In place, each image is a pool of its own in a slot of the renderer's memory. */
static ViddecImagePool *pool_of(uint32_t slot)
{
    return video.in_place ? &video.pools[slot] : &video.pools[0];
}

static uint32_t image_of(uint32_t slot)
{
    return video.in_place ? viddecImagePoolGetImageId(&video.pools[slot], 0)
                          : viddecImagePoolGetImageId(&video.pools[0], slot);
}

static Result close_pools(void)
{
    Result first = 0;

    while (video.pools_open) {
        Result result = viddecImagePoolClose(&video.pools[--video.pools_open]);
        if (R_SUCCEEDED(first))
            first = result;
    }
    return first;
}

static Result open_in_place(const GsvDecodeImagePreference *preference, uint8_t *const *slots,
                            size_t slot_bytes, bool *stuck)
{
    uint64_t bytes = 0;
    uint64_t alignment = 0;
    Result result = viddecGetImagePoolSize(preference, 1, &bytes, &alignment);

    if (R_FAILED(result))
        return result;
    note("sdk-video: in place image bytes=%llu alignment=%llu slot bytes=%zu",
         (unsigned long long)bytes, (unsigned long long)alignment, slot_bytes);
    if (bytes > slot_bytes || alignment == 0)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    for (uint32_t slot = 0; slot < video.count; slot++) {
        if ((uintptr_t)slots[slot] % alignment)
            result = MAKERESULT(Module_Libnx, LibnxError_BadInput);
        else
            result = viddecImagePoolCreate(&video.pools[slot], preference, 1, slots[slot], bytes);
        if (R_FAILED(result)) {
            Result closed = close_pools();
            *stuck = R_FAILED(closed);
            return *stuck ? closed : result;
        }
        video.pools_open++;
    }
    video.in_place = true;
    return 0;
}

static void open_wake(void)
{
    Result result = gsvSyncAllocateSlot(&video.sync, &video.wake_slot);

    if (R_SUCCEEDED(result)) {
        result = gsvSyncCreateEvent(&video.sync, video.wake_slot, &video.wake, false);
        if (R_FAILED(result))
            gsvSyncFreeSlot(&video.sync, video.wake_slot);
    }
    video.wake_open = R_SUCCEEDED(result);
    note("sdk-video: wake event slot=%u result=0x%x", (unsigned)video.wake_slot,
         (unsigned)result);
}

static void close_wake(void)
{
    if (!video.wake_open)
        return;
    gsvSyncDisarmEvent(&video.sync, video.wake_slot);
    eventClose(&video.wake);
    gsvSyncFreeSlot(&video.sync, video.wake_slot);
    video.wake_open = false;
}

void moonlightSdkVideoTune(uint32_t input_format, uint32_t output_format, uint32_t pool_height,
                           uint32_t max_input_bytes, bool split_initialize)
{
    tuning.input_format = input_format;
    tuning.output_format = output_format;
    tuning.pool_height = pool_height;
    tuning.max_input_bytes = max_input_bytes;
    tuning.split_initialize = split_initialize;
}

static uint32_t output_format(void)
{
    return tuning.output_format ? tuning.output_format : ViddecOutputFormat_Nv12;
}

Result moonlightSdkVideoOpen(uint32_t width, uint32_t height, uint32_t count, uint8_t *const *slots,
                             size_t slot_bytes, uint32_t *images, uint32_t *stage,
                             Result *sync_result, Result *place_result)
{
    GsvDecodeImagePreference preference;
    uint64_t bytes = 0;
    uint64_t alignment = 0;
    Result result;

    if (video.root || count == 0 || count > VIDDEC_MAX_IMAGES)
        return fail(stage, STAGE_ROOT, MAKERESULT(Module_Libnx, LibnxError_BadInput));
    memset(&video, 0, sizeof(video));
    note("sdk-video: before root");
    result = viddecInitialize();
    if (R_FAILED(result))
        return fail(stage, STAGE_ROOT, result);
    video.root = true;
    video.count = count;
    video.width = width;
    video.height = height;
    result = viddecMakeImagePreference(&preference, width,
                                       tuning.pool_height ? tuning.pool_height : height,
                                       output_format(), ViddecTilingMode_PitchLinear);
    if (R_FAILED(result))
        return fail(stage, STAGE_PREFERENCE, result);
    bool stuck = false;
    *place_result = slots ? open_in_place(&preference, slots, slot_bytes, &stuck)
                          : MAKERESULT(Module_Libnx, LibnxError_NotFound);
    if (stuck)
        return fail(stage, STAGE_POOL_CLOSE, *place_result);
    if (!video.in_place) {
        result = viddecGetImagePoolSize(&preference, count, &bytes, &alignment);
        if (R_FAILED(result))
            return fail(stage, STAGE_POOL_SIZE, result);
        note("sdk-video: before pool bytes=%llu alignment=%llu", (unsigned long long)bytes,
             (unsigned long long)alignment);
        video.backing = memalign(alignment, bytes);
        if (!video.backing)
            return fail(stage, STAGE_POOL_MEMORY,
                        MAKERESULT(Module_Libnx, LibnxError_OutOfMemory));
        memset(video.backing, 0, bytes);
        result = viddecImagePoolCreate(&video.pools[0], &preference, count, video.backing, bytes);
        if (R_FAILED(result))
            return fail(stage, STAGE_POOL, result);
        video.pools_open = 1;
    }
    note("sdk-video: before decoder session");
    result = viddecOpenDecoder(&video.decoder);
    if (R_FAILED(result))
        return fail(stage, STAGE_DECODER, result);
    video.decoder_open = true;
    for (uint32_t index = 0; index < count; index++)
        images[index] = image_of(index);
    note("sdk-video: before sync session");
    *sync_result = gsvOpenSync(&video.sync);
    video.sync_open = R_SUCCEEDED(*sync_result);
    if (video.sync_open)
        open_wake();
    *stage = 0;
    return 0;
}

/*
 * viddecDecoderInitialize command by command, so a refusal names the one that refused: the
 * decoder is created with its work memory and formats (217), then configured with the size,
 * rate and codec buffer (117), then hands out its submission event (19). The ids below are the
 * wire tags less the 16 tipcDispatch adds.
 */
static Result initialize_split(const ViddecDecoderConfig *config, size_t work_bytes,
                               const void *codec_config, size_t codec_config_bytes,
                               uint32_t *stage)
{
    const struct {
        uint64_t work_bytes;
        uint32_t codec;
        uint32_t input_format;
        uint32_t output_format;
        uint32_t output_mode;
    } create = {work_bytes, config->codec, config->input_format, config->output_format,
                config->output_mode};
    const struct {
        uint32_t width;
        uint32_t height;
        uint32_t frame_rate;
        uint32_t max_input_bytes;
        uint8_t reserved[16];
    } configure = {config->width & 0xffff, config->height & 0xffff, config->frame_rate,
                   (uint32_t)config->max_input_size, {0}};
    TipcService *session = &video.decoder.s;
    TransferMemory memory;
    Handle event = INVALID_HANDLE;
    Result result = tmemCreateFromMemory(&memory, video.work, work_bytes, Perm_None);

    if (R_FAILED(result))
        return fail(stage, STAGE_WORK_MEMORY, result);
    *stage = STAGE_INITIALIZE;
    result = tipcDispatchIn(session, 201, create, .in_num_handles = 1,
                            .in_handles = {memory.handle});
    note("sdk-video: create (217) result=0x%x", (unsigned)result);
    if (R_SUCCEEDED(result)) {
        video.decoder.initialized = true;
        *stage = STAGE_CONFIGURE;
        result = tipcDispatchIn(session, 101, configure,
                                .buffer_attrs = {SfBufferAttr_In | SfBufferAttr_HipcMapAlias},
                                .buffers = {{codec_config, codec_config_bytes}});
        note("sdk-video: configure (117) result=0x%x", (unsigned)result);
        if (R_SUCCEEDED(result)) {
            *stage = STAGE_SUBMISSION_EVENT;
            result = tipcDispatch(session, 3, .out_handle_attrs = {SfOutHandleAttr_HipcCopy},
                                  .out_handles = &event);
        }
        if (R_SUCCEEDED(result)) {
            eventLoadRemote(&video.decoder.submission_ready, event, true);
        } else {
            tipcDispatch(session, 115);
            video.decoder.initialized = false;
        }
    }
    tmemCloseHandle(&memory);
    return result;
}

Result moonlightSdkVideoStart(uint32_t codec, uint32_t fps, size_t work_bytes,
                              const void *codec_config, size_t codec_config_bytes, uint32_t *stage)
{
    ViddecDecoderConfig config = {
        .codec = codec,
        .input_format = video.width >= 1920 || video.height >= 1080 ? 3 : 1,
        .output_format = output_format(),
        .output_mode = 1,
        .width = video.width,
        .height = video.height,
        .frame_rate = fps,
        .max_input_size = tuning.max_input_bytes ? tuning.max_input_bytes : INPUT_MAX,
    };
    Result result;

    if (!video.decoder_open || video.started || video.work || work_bytes < 0x4000 ||
        work_bytes % 0x1000)
        return fail(stage, STAGE_INITIALIZE, MAKERESULT(Module_Libnx, LibnxError_BadInput));
    if (tuning.input_format)
        config.input_format = tuning.input_format;
    note("sdk-video: config codec=%u input_format=%u output_format=%u %ux%u fps=%u max_input=%llu",
         (unsigned)config.codec, (unsigned)config.input_format, (unsigned)config.output_format,
         (unsigned)config.width, (unsigned)config.height, (unsigned)config.frame_rate,
         (unsigned long long)config.max_input_size);
    note("sdk-video: before work memory bytes=%zu", work_bytes);
    video.work = memalign(0x1000, work_bytes);
    if (!video.work)
        return fail(stage, STAGE_WORK_MEMORY, MAKERESULT(Module_Libnx, LibnxError_OutOfMemory));
    note("sdk-video: before initialize work=%p", video.work);
    if (tuning.split_initialize) {
        result = initialize_split(&config, work_bytes, codec_config, codec_config_bytes, stage);
        if (R_FAILED(result))
            return result;
    } else {
        result = viddecDecoderInitialize(&video.decoder, &config, video.work, work_bytes,
                                         codec_config, codec_config_bytes);
        if (R_FAILED(result))
            return fail(stage, STAGE_INITIALIZE, result);
    }
    note("sdk-video: before register");
    for (uint32_t slot = 0; slot < video.count; slot++) {
        result = viddecDecoderRegisterImage(&video.decoder, slot, image_of(slot));
        if (R_FAILED(result))
            return fail(stage, STAGE_REGISTER, result);
    }
    note("sdk-video: before start");
    result = viddecDecoderStart(&video.decoder);
    if (R_FAILED(result))
        return fail(stage, STAGE_START, result);
    video.started = true;
    *stage = 0;
    return 0;
}

/* Sizes one image of every output format in the SDK's table. Nothing is allocated. */
void moonlightSdkVideoNoteFormats(uint32_t width, uint32_t height)
{
    Result result;

    if (video.root)
        return;
    result = viddecInitialize();
    if (R_FAILED(result)) {
        note("sdk-video: formats root result=0x%x", (unsigned)result);
        return;
    }
    for (uint32_t format = ViddecOutputFormat_Rgba; format <= 5; format++) {
        for (uint32_t tiling = ViddecTilingMode_PitchLinear;
             tiling <= ViddecTilingMode_BlockLinear; tiling++) {
            GsvDecodeImagePreference preference;
            uint64_t bytes = 0;
            uint64_t alignment = 0;

            result = viddecMakeImagePreference(&preference, width, height, format, tiling);
            if (R_SUCCEEDED(result))
                result = viddecGetImagePoolSize(&preference, 1, &bytes, &alignment);
            note("sdk-video: format=%u tiling=%u image bytes=%llu alignment=%llu result=0x%x",
                 (unsigned)format, (unsigned)tiling, (unsigned long long)bytes,
                 (unsigned long long)alignment, (unsigned)result);
        }
    }
    viddecExit();
}

Result moonlightSdkVideoSubmit(const void *data, size_t bytes, int64_t timestamp_ns)
{
    return viddecDecoderSubmit(&video.decoder, data, bytes, timestamp_ns, false, NULL);
}

Result moonlightSdkVideoReady(uint32_t slot, bool *ready)
{
    Result result;

    *ready = false;
    if (!video.started || slot >= video.count)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    if (!video.acquired[slot]) {
        uint32_t next = 0;
        GsvNativeSync producer;
        result = viddecDecoderAcquireImage(&video.decoder, &next, &producer);
        if (R_FAILED(result))
            return result;
        if (next != slot)
            return MAKERESULT(Module_Libnx, LibnxError_ShouldNotHappen);
        if (video.acquisitions < ACQUISITIONS_NOTED) {
            uint32_t words[4];
            memcpy(words, &producer, sizeof(words));
            note("sdk-video: acquired slot=%u producer=%08x %08x %08x %08x", (unsigned)slot,
                 (unsigned)words[0], (unsigned)words[1], (unsigned)words[2], (unsigned)words[3]);
            video.acquisitions++;
        }
        video.producers[slot] = producer;
        video.acquired[slot] = true;
        video.described[slot] = false;
    }
    if (video.sync_open)
        return gsvSyncCheckNative(&video.sync, &video.producers[slot], ready);
    result = viddecDecoderGetOutputProperties(&video.decoder, slot, &video.properties[slot]);
    video.poll_result = result;
    video.described[slot] = R_SUCCEEDED(result);
    *ready = video.described[slot];
    return 0;
}

/*
 * Waits up to timeout_ns for the slot's frame on the wake event, armed on the producer the
 * decoder handed with the image. Without the event it reads the counter at intervals.
 */
Result moonlightSdkVideoWait(uint32_t slot, uint64_t timeout_ns, bool *ready)
{
    Result result = moonlightSdkVideoReady(slot, ready);
    const GsvNativeSync *producer = &video.producers[slot];
    uint32_t complement;
    uint64_t target;

    if (R_FAILED(result) || *ready || timeout_ns == 0 || !video.sync_open)
        return result;
    if (!video.wake_open) {
        result = gsvSyncWaitNative(&video.sync, producer, timeout_ns);
        if (R_FAILED(result) && R_VALUE(result) != KERNELRESULT(TimedOut))
            return result;
        return gsvSyncCheckNative(&video.sync, producer, ready);
    }
    memcpy(&complement, producer->data, sizeof(complement));
    memcpy(&target, producer->data + 8, sizeof(target));
    eventClear(&video.wake);
    result = gsvSyncArmEvent(&video.sync, video.wake_slot, ~complement, target, 0);
    if (R_FAILED(result))
        return result;
    result = gsvSyncCheckNative(&video.sync, producer, ready);
    if (R_SUCCEEDED(result) && !*ready) {
        result = eventWait(&video.wake, timeout_ns);
        if (R_SUCCEEDED(result) || R_VALUE(result) == KERNELRESULT(TimedOut))
            result = gsvSyncCheckNative(&video.sync, producer, ready);
    }
    gsvSyncDisarmEvent(&video.sync, video.wake_slot);
    return result;
}

Result moonlightSdkVideoOutput(uint32_t slot, MoonlightSdkVideoOutput *out)
{
    if (slot >= video.count || !video.acquired[slot])
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    if (!video.described[slot]) {
        Result result =
            viddecDecoderGetOutputProperties(&video.decoder, slot, &video.properties[slot]);
        if (R_FAILED(result))
            return result;
        video.described[slot] = true;
    }
    const ViddecOutputProperties *properties = &video.properties[slot];
    *out = (MoonlightSdkVideoOutput){
        .image = image_of(slot),
        .width = properties->width,
        .height = properties->height,
        .crop_width = properties->crop_width,
        .crop_height = properties->crop_height,
        .end_of_stream = properties->end_of_stream,
        .timestamp_ns = properties->timestamp_ns,
    };
    return 0;
}

static Result describe(uint32_t slot, GsvCpuImageDescriptor *descriptor,
                       MoonlightSdkVideoLayout *layout)
{
    Result result = gsvGetCpuImageDescriptor(image_of(slot), descriptor);

    if (R_FAILED(result))
        return result;
    *layout = (MoonlightSdkVideoLayout){
        .type = descriptor->type,
        .width = descriptor->width_minus_one + 1u,
        .height = descriptor->height_minus_one + 1u,
        .pitch = {descriptor->planes[0].pitch, descriptor->planes[1].pitch},
        .offset = {descriptor->planes[0].offset, descriptor->planes[1].offset},
    };
    return 0;
}

/* Where a slot's image sits in its pool's backing, for a frame read in place. */
Result moonlightSdkVideoLayout(uint32_t slot, MoonlightSdkVideoLayout *layout)
{
    GsvCpuImageDescriptor descriptor = {0};

    *layout = (MoonlightSdkVideoLayout){0};
    if (slot >= video.count || !video.pools_open)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    return describe(slot, &descriptor, layout);
}

bool moonlightSdkVideoInPlace(void) { return video.in_place; }

Result moonlightSdkVideoRead(uint32_t slot, uint8_t *luma, uint8_t *chroma, size_t pitch,
                             size_t rows, MoonlightSdkVideoLayout *layout)
{
    GsvCpuImageDescriptor descriptor = {0};
    Result result;

    *layout = (MoonlightSdkVideoLayout){0};
    if (slot >= video.count || !video.acquired[slot])
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    result = describe(slot, &descriptor, layout);
    if (R_FAILED(result))
        return result;
    if (layout->width > pitch || layout->height > rows)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    return viddecCopyImageNv12(&descriptor, pool_of(slot)->backing, pool_of(slot)->backing_size,
                               luma, pitch, chroma, pitch);
}

Result moonlightSdkVideoRelease(uint32_t slot)
{
    static const GsvNativeSync unused;

    if (slot >= video.count || !video.acquired[slot])
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    video.acquired[slot] = false;
    video.described[slot] = false;
    return viddecDecoderReleaseImage(&video.decoder, slot, &unused);
}

Result moonlightSdkVideoPollResult(void) { return video.poll_result; }

static bool work_restored(void)
{
    for (int poll = 0; poll < WORK_RESTORE_POLLS; poll++) {
        MemoryInfo info;
        u32 page = 0;
        if (R_SUCCEEDED(svcQueryMemory(&info, &page, (u64)video.work)) &&
            (info.perm & Perm_Rw) == Perm_Rw)
            return true;
        svcSleepThread(1000000);
    }
    return false;
}

Result moonlightSdkVideoClose(uint32_t *stage)
{
    Result first = 0;
    Result result;

    *stage = 0;
    if (!video.root)
        return 0;
    if (video.started) {
        note("sdk-video: before stop");
        result = viddecDecoderStop(&video.decoder);
        if (R_FAILED(result))
            first = fail(stage, STAGE_STOP, result);
        video.started = false;
    }
    if (video.decoder_open) {
        note("sdk-video: before decoder close");
        viddecDecoderClose(&video.decoder);
        video.decoder_open = false;
    }
    if (video.work) {
        if (work_restored())
            free(video.work);
        else if (R_SUCCEEDED(first))
            first = fail(stage, STAGE_WORK_RESTORE, MAKERESULT(Module_Libnx, LibnxError_NotFound));
        video.work = NULL;
    }
    if (video.pools_open)
        note("sdk-video: before pool close");
    while (video.pools_open) {
        result = viddecImagePoolClose(&video.pools[--video.pools_open]);
        if (R_FAILED(result)) {
            if (R_SUCCEEDED(first))
                first = fail(stage, STAGE_POOL_CLOSE, result);
            video.backing = NULL;
        }
    }
    video.in_place = false;
    free(video.backing);
    video.backing = NULL;
    close_wake();
    if (video.sync_open)
        gsvSyncClose(&video.sync);
    video.sync_open = false;
    note("sdk-video: before root exit");
    viddecExit();
    video.root = false;
    return first;
}
