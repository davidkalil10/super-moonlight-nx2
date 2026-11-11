#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <switch.h>

/* The SDK's own decoder object (video/decoder.h), beside sdk_viddec.c for comparison. */

typedef struct {
    uint32_t image;
    uint32_t width;
    uint32_t height;
    uint32_t crop_width;
    uint32_t crop_height;
    uint32_t end_of_stream;
    int64_t timestamp_ns;
} MoonlightSdkDecoderOutput;

static struct {
    VideoDecoder decoder;
    VideoFrame frames[VIDDEC_MAX_IMAGES];
    bool held[VIDDEC_MAX_IMAGES];
    uint32_t width;
    uint32_t height;
    uint32_t count;
    bool open;
    bool created;
    bool order_reported;
} sdk;

void moonlightPlatformLog(const uint8_t *message, size_t bytes);

static void note(const char *line) { moonlightPlatformLog((const uint8_t *)line, strlen(line)); }

/* Images are numbered from 1 by surface, since the object hands slots and no image ids. */
Result moonlightSdkDecoderOpen(uint32_t width, uint32_t height, uint32_t count, uint32_t *images)
{
    if (sdk.open || count < 2 || count > VIDDEC_MAX_IMAGES)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    memset(&sdk, 0, sizeof(sdk));
    sdk.width = width;
    sdk.height = height;
    sdk.count = count;
    sdk.open = true;
    for (uint32_t surface = 0; surface < count; surface++)
        images[surface] = surface + 1;
    return 0;
}

Result moonlightSdkDecoderStart(uint32_t codec, uint32_t fps, const void *codec_config,
                                size_t codec_config_bytes, uint64_t max_sample_bytes)
{
    const VideoDecoderConfig config = {
        .codec = codec,
        .width = sdk.width,
        .height = sdk.height,
        .image_count = sdk.count,
        .frame_rate = fps,
        .tiling = ViddecTilingMode_PitchLinear,
        .color_policy = sdk.width >= 1920 || sdk.height >= 1080 ? 3 : 1,
        .max_sample_size = max_sample_bytes,
        .codec_config = codec_config,
        .codec_config_size = codec_config_bytes,
    };
    Result result;

    if (!sdk.open || sdk.created)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    note("sdk-decoder: before create");
    result = videoDecoderCreate(&sdk.decoder, &config);
    sdk.created = R_SUCCEEDED(result);
    return result;
}

Result moonlightSdkDecoderSubmit(const void *data, size_t bytes, int64_t timestamp_ns)
{
    return videoDecoderSubmit(&sdk.decoder, data, bytes, timestamp_ns, false, 0);
}

/*
 * The object hands frames in decode order from whichever image it filled, so the next frame
 * goes to the surface asked for, the oldest the core waits on, whatever its slot.
 */
Result moonlightSdkDecoderWait(uint32_t surface, uint64_t timeout_ns, bool *ready)
{
    VideoFrame frame;
    Result result;

    *ready = false;
    if (!sdk.created || surface >= sdk.count)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    if (sdk.held[surface]) {
        *ready = true;
        return 0;
    }
    result = videoDecoderGetFrame(&sdk.decoder, &frame, timeout_ns);
    if (R_VALUE(result) == KERNELRESULT(TimedOut))
        return 0;
    if (R_FAILED(result))
        return result;
    if (!frame.planes[0] || !frame.planes[1]) {
        videoDecoderReleaseFrame(&sdk.decoder, &frame);
        return MAKERESULT(Module_Libnx, LibnxError_ShouldNotHappen);
    }
    if (frame.slot != surface && !sdk.order_reported) {
        sdk.order_reported = true;
        note("sdk-decoder: frames come from other slots than the surfaces");
    }
    sdk.frames[surface] = frame;
    sdk.held[surface] = true;
    *ready = true;
    return 0;
}

Result moonlightSdkDecoderOutput(uint32_t surface, MoonlightSdkDecoderOutput *out)
{
    if (surface >= sdk.count || !sdk.held[surface])
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    const VideoFrame *frame = &sdk.frames[surface];
    *out = (MoonlightSdkDecoderOutput){
        .image = surface + 1,
        .width = frame->width,
        .height = frame->height,
        .crop_width = frame->width,
        .crop_height = frame->height,
        .end_of_stream = frame->end_of_stream,
        .timestamp_ns = frame->timestamp_ns,
    };
    return 0;
}

Result moonlightSdkDecoderRead(uint32_t surface, uint8_t *luma, uint8_t *chroma, size_t pitch,
                               size_t rows, uint32_t *source_pitch)
{
    if (surface >= sdk.count || !sdk.held[surface])
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    const VideoFrame *frame = &sdk.frames[surface];
    *source_pitch = frame->pitches[0];
    if (frame->width > pitch || frame->height > rows || frame->pitches[0] < frame->width ||
        frame->pitches[1] < frame->width)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    if (frame->pitches[0] == pitch && frame->pitches[1] == pitch) {
        memcpy(luma, frame->planes[0], pitch * frame->height);
        memcpy(chroma, frame->planes[1], pitch * (frame->height / 2));
        return 0;
    }
    for (uint32_t row = 0; row < frame->height; row++)
        memcpy(luma + row * pitch, frame->planes[0] + row * frame->pitches[0], frame->width);
    for (uint32_t row = 0; row < frame->height / 2; row++)
        memcpy(chroma + row * pitch, frame->planes[1] + row * frame->pitches[1], frame->width);
    return 0;
}

Result moonlightSdkDecoderRelease(uint32_t surface)
{
    if (surface >= sdk.count || !sdk.held[surface])
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    videoDecoderReleaseFrame(&sdk.decoder, &sdk.frames[surface]);
    sdk.held[surface] = false;
    return 0;
}

void moonlightSdkDecoderClose(void)
{
    if (sdk.created) {
        for (uint32_t surface = 0; surface < sdk.count; surface++)
            if (sdk.held[surface])
                videoDecoderReleaseFrame(&sdk.decoder, &sdk.frames[surface]);
        note("sdk-decoder: before close");
        videoDecoderClose(&sdk.decoder);
    }
    memset(&sdk, 0, sizeof(sdk));
}
