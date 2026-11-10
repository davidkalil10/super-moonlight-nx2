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
} MoonlightSdkVideoLayout;

static struct {
    ViddecDecoder decoder;
    ViddecImagePool pool;
    GsvSync sync;
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
    bool creator_open;
    bool pool_open;
    bool decoder_open;
    bool sync_open;
    bool started;
} video;

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

/*
 * viddecInitialize with the creator's resolution flag, which it always clears. The creator
 * lands in the session viddecOpenDecoder reads.
 */
static Result root_open(bool resolution_unlimited)
{
    Result result = gsvInitialize();

    if (R_FAILED(result))
        return result;
    video.root = true;
    result = gsvCheckVideoDecoderAccess();
    if (R_SUCCEEDED(result))
        result = gsvOpenVideoDecoderCreator(resolution_unlimited, VIDDEC_LIBRARY_VERSION,
                                            viddecGetServiceSession());
    video.creator_open = R_SUCCEEDED(result);
    return result;
}

static void root_close(void)
{
    if (video.creator_open) {
        tipcClose(viddecGetServiceSession());
        gsvReleaseVideoDecoderAccess();
        video.creator_open = false;
    }
    gsvExit();
    video.root = false;
}

Result moonlightSdkVideoOpen(uint32_t width, uint32_t height, uint32_t count,
                             bool resolution_unlimited, uint32_t *images, uint32_t *stage,
                             Result *sync_result)
{
    GsvDecodeImagePreference preference;
    uint64_t bytes = 0;
    uint64_t alignment = 0;
    Result result;

    if (video.root || count == 0 || count > VIDDEC_MAX_IMAGES)
        return fail(stage, STAGE_ROOT, MAKERESULT(Module_Libnx, LibnxError_BadInput));
    memset(&video, 0, sizeof(video));
    note("sdk-video: before root resolution_unlimited=%d", resolution_unlimited);
    result = root_open(resolution_unlimited);
    if (R_FAILED(result))
        return fail(stage, STAGE_ROOT, result);
    video.count = count;
    video.width = width;
    video.height = height;
    result = viddecMakeImagePreference(&preference, width, height, ViddecOutputFormat_Nv12,
                                       ViddecTilingMode_PitchLinear);
    if (R_FAILED(result))
        return fail(stage, STAGE_PREFERENCE, result);
    result = viddecGetImagePoolSize(&preference, count, &bytes, &alignment);
    if (R_FAILED(result))
        return fail(stage, STAGE_POOL_SIZE, result);
    note("sdk-video: before pool bytes=%llu alignment=%llu", (unsigned long long)bytes,
         (unsigned long long)alignment);
    video.backing = memalign(alignment, bytes);
    if (!video.backing)
        return fail(stage, STAGE_POOL_MEMORY, MAKERESULT(Module_Libnx, LibnxError_OutOfMemory));
    memset(video.backing, 0, bytes);
    result = viddecImagePoolCreate(&video.pool, &preference, count, video.backing, bytes);
    if (R_FAILED(result))
        return fail(stage, STAGE_POOL, result);
    video.pool_open = true;
    note("sdk-video: before decoder session");
    result = viddecOpenDecoder(&video.decoder);
    if (R_FAILED(result))
        return fail(stage, STAGE_DECODER, result);
    video.decoder_open = true;
    for (uint32_t index = 0; index < count; index++)
        images[index] = viddecImagePoolGetImageId(&video.pool, index);
    note("sdk-video: before sync session");
    *sync_result = gsvOpenSync(&video.sync);
    video.sync_open = R_SUCCEEDED(*sync_result);
    *stage = 0;
    return 0;
}

Result moonlightSdkVideoStart(uint32_t codec, uint32_t fps, size_t work_bytes,
                              const void *codec_config, size_t codec_config_bytes, uint32_t *stage)
{
    ViddecDecoderConfig config = {
        .codec = codec,
        .input_format = video.width >= 1920 || video.height >= 1080 ? 3 : 1,
        .output_format = ViddecOutputFormat_Nv12,
        .output_mode = 1,
        .width = video.width,
        .height = video.height,
        .frame_rate = fps,
        .max_input_size = INPUT_MAX,
    };
    Result result;

    if (!video.decoder_open || video.started || video.work || work_bytes < 0x4000 ||
        work_bytes % 0x1000)
        return fail(stage, STAGE_INITIALIZE, MAKERESULT(Module_Libnx, LibnxError_BadInput));
    note("sdk-video: before work memory bytes=%zu", work_bytes);
    video.work = memalign(0x1000, work_bytes);
    if (!video.work)
        return fail(stage, STAGE_WORK_MEMORY, MAKERESULT(Module_Libnx, LibnxError_OutOfMemory));
    note("sdk-video: before initialize work=%p", video.work);
    result = viddecDecoderInitialize(&video.decoder, &config, video.work, work_bytes, codec_config,
                                     codec_config_bytes);
    if (R_FAILED(result))
        return fail(stage, STAGE_INITIALIZE, result);
    note("sdk-video: before register");
    for (uint32_t slot = 0; slot < video.count; slot++) {
        result = viddecDecoderRegisterImage(&video.decoder, slot,
                                            viddecImagePoolGetImageId(&video.pool, slot));
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
        .image = viddecImagePoolGetImageId(&video.pool, slot),
        .width = properties->width,
        .height = properties->height,
        .crop_width = properties->crop_width,
        .crop_height = properties->crop_height,
        .end_of_stream = properties->end_of_stream,
        .timestamp_ns = properties->timestamp_ns,
    };
    return 0;
}

Result moonlightSdkVideoRead(uint32_t slot, uint8_t *luma, uint8_t *chroma, size_t pitch,
                             size_t rows, MoonlightSdkVideoLayout *layout)
{
    GsvCpuImageDescriptor descriptor = {0};
    Result result;

    *layout = (MoonlightSdkVideoLayout){0};
    if (slot >= video.count || !video.acquired[slot])
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    result = gsvGetCpuImageDescriptor(viddecImagePoolGetImageId(&video.pool, slot), &descriptor);
    if (R_FAILED(result))
        return result;
    *layout = (MoonlightSdkVideoLayout){
        .type = descriptor.type,
        .width = descriptor.width_minus_one + 1u,
        .height = descriptor.height_minus_one + 1u,
        .pitch = {descriptor.planes[0].pitch, descriptor.planes[1].pitch},
    };
    if (layout->width > pitch || layout->height > rows)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    return viddecCopyImageNv12(&descriptor, video.pool.backing, video.pool.backing_size, luma,
                               pitch, chroma, pitch);
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
    if (video.pool_open) {
        note("sdk-video: before pool close");
        result = viddecImagePoolClose(&video.pool);
        if (R_FAILED(result)) {
            if (R_SUCCEEDED(first))
                first = fail(stage, STAGE_POOL_CLOSE, result);
            video.backing = NULL;
        }
        video.pool_open = false;
    }
    free(video.backing);
    video.backing = NULL;
    if (video.sync_open)
        gsvSyncClose(&video.sync);
    video.sync_open = false;
    note("sdk-video: before root exit");
    root_close();
    return first;
}
