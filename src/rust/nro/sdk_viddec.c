#include <malloc.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <switch.h>

#define WORK_BYTES (64u * 1024 * 1024)
#define INPUT_MAX (1024u * 1024)
#define SUBMIT_WAIT_NS 50000000ull
#define WORK_RESTORE_POLLS 1000

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
    Result poll_result;
    bool root;
    bool pool_open;
    bool decoder_open;
    bool sync_open;
    bool started;
} video;

static Result fail(uint32_t *stage, uint32_t at, Result result)
{
    *stage = at;
    return result;
}

Result moonlightSdkVideoOpen(uint32_t width, uint32_t height, uint32_t count, uint32_t *images,
                             uint32_t *stage, Result *sync_result)
{
    GsvDecodeImagePreference preference;
    uint64_t bytes = 0;
    uint64_t alignment = 0;
    Result result;

    if (video.root || count == 0 || count > VIDDEC_MAX_IMAGES)
        return fail(stage, STAGE_ROOT, MAKERESULT(Module_Libnx, LibnxError_BadInput));
    memset(&video, 0, sizeof(video));
    result = viddecInitialize();
    if (R_FAILED(result))
        return fail(stage, STAGE_ROOT, result);
    video.root = true;
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
    video.backing = memalign(alignment, bytes);
    if (!video.backing)
        return fail(stage, STAGE_POOL_MEMORY, MAKERESULT(Module_Libnx, LibnxError_OutOfMemory));
    memset(video.backing, 0, bytes);
    result = viddecImagePoolCreate(&video.pool, &preference, count, video.backing, bytes);
    if (R_FAILED(result))
        return fail(stage, STAGE_POOL, result);
    video.pool_open = true;
    result = viddecOpenDecoder(&video.decoder);
    if (R_FAILED(result))
        return fail(stage, STAGE_DECODER, result);
    video.decoder_open = true;
    for (uint32_t index = 0; index < count; index++)
        images[index] = viddecImagePoolGetImageId(&video.pool, index);
    *sync_result = gsvOpenSync(&video.sync);
    video.sync_open = R_SUCCEEDED(*sync_result);
    *stage = 0;
    return 0;
}

Result moonlightSdkVideoStart(uint32_t fps, const void *codec_config, size_t codec_config_bytes,
                              uint32_t *stage)
{
    ViddecDecoderConfig config = {
        .codec = ViddecCodec_H264,
        .input_format = video.width >= 1920 || video.height >= 1080 ? 3 : 1,
        .output_format = ViddecOutputFormat_Nv12,
        .output_mode = 1,
        .width = video.width,
        .height = video.height,
        .frame_rate = fps,
        .max_input_size = INPUT_MAX,
    };
    Result result;

    if (!video.decoder_open || video.started || video.work)
        return fail(stage, STAGE_INITIALIZE, MAKERESULT(Module_Libnx, LibnxError_BadInput));
    video.work = memalign(0x1000, WORK_BYTES);
    if (!video.work)
        return fail(stage, STAGE_WORK_MEMORY, MAKERESULT(Module_Libnx, LibnxError_OutOfMemory));
    result = viddecDecoderInitialize(&video.decoder, &config, video.work, WORK_BYTES, codec_config,
                                     codec_config_bytes);
    if (R_FAILED(result))
        return fail(stage, STAGE_INITIALIZE, result);
    for (uint32_t slot = 0; slot < video.count; slot++) {
        result = viddecDecoderRegisterImage(&video.decoder, slot,
                                            viddecImagePoolGetImageId(&video.pool, slot));
        if (R_FAILED(result))
            return fail(stage, STAGE_REGISTER, result);
    }
    result = viddecDecoderStart(&video.decoder);
    if (R_FAILED(result))
        return fail(stage, STAGE_START, result);
    video.started = true;
    *stage = 0;
    return 0;
}

Result moonlightSdkVideoSubmit(const void *data, size_t bytes, int64_t timestamp_ns)
{
    Result result = viddecDecoderSubmit(&video.decoder, data, bytes, timestamp_ns, false, NULL);

    if (result != VIDDEC_RESULT_SUBMIT_BUSY)
        return result;
    eventWait(&video.decoder.submission_ready, SUBMIT_WAIT_NS);
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
                             MoonlightSdkVideoLayout *layout)
{
    GsvCpuImageDescriptor descriptor;
    Result result;

    if (slot >= video.count || !video.acquired[slot])
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    result = viddecImagePoolReadNv12(&video.pool, slot, luma, pitch, chroma, pitch, &descriptor);
    *layout = (MoonlightSdkVideoLayout){
        .type = descriptor.type,
        .width = descriptor.width_minus_one + 1u,
        .height = descriptor.height_minus_one + 1u,
        .pitch = {descriptor.planes[0].pitch, descriptor.planes[1].pitch},
    };
    return result;
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
        result = viddecDecoderStop(&video.decoder);
        if (R_FAILED(result))
            first = fail(stage, STAGE_STOP, result);
        video.started = false;
    }
    if (video.decoder_open) {
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
    viddecExit();
    video.root = false;
    return first;
}
