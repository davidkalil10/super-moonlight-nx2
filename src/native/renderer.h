#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct MoonlightRenderer MoonlightRenderer;

typedef enum {
    MOONLIGHT_RENDER_OK = 0,
    MOONLIGHT_RENDER_BUSY,
    MOONLIGHT_RENDER_INVALID,
    MOONLIGHT_RENDER_UNSUPPORTED,
    MOONLIGHT_RENDER_NO_MEMORY,
    MOONLIGHT_RENDER_DEVICE,
    MOONLIGHT_RENDER_LOST,
    MOONLIGHT_RENDER_RETAINED,
} MoonlightRenderResult;

typedef enum {
    MOONLIGHT_COLOR_BT601 = 0,
    MOONLIGHT_COLOR_BT709 = 1,
} MoonlightColorMatrix;

typedef enum {
    MOONLIGHT_PRESENT_STREAMING = 0,
    MOONLIGHT_PRESENT_INTERACTIVE = 1,
} MoonlightPresentMode;

typedef enum {
    MOONLIGHT_VIDEO_PATH_TEXEL_BUFFER = 0,
    MOONLIGHT_VIDEO_PATH_STORAGE_BUFFER = 1,
} MoonlightVideoPath;

typedef enum {
    MOONLIGHT_CACHE_DISABLED = 0,
    MOONLIGHT_CACHE_MISS,
    MOONLIGHT_CACHE_HIT,
    MOONLIGHT_CACHE_UNAVAILABLE,
} MoonlightCacheState;

typedef struct {
    uint32_t width;
    uint32_t height;
    bool prefer_storage_path;
    const char *pipeline_cache_path;
    uint32_t upload_wait_us;
} MoonlightRendererConfig;

typedef struct {
    uint64_t count;
    uint64_t total_ns;
    uint64_t max_ns;
} MoonlightTiming;

typedef struct {
    const uint8_t *luma;
    const uint8_t *chroma;
    uint32_t luma_stride;
    uint32_t chroma_stride;
    uint32_t coded_width;
    uint32_t coded_height;
    uint32_t crop_left;
    uint32_t crop_top;
    uint32_t display_width;
    uint32_t display_height;
    MoonlightColorMatrix matrix;
    bool full_range;
    uint64_t timestamp_ns;
} MoonlightNv12Frame;

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t swapchain_images;
    uint32_t surface_format;
    MoonlightVideoPath video_path;
    uint64_t presented;
    uint64_t busy_uploads;
    uint64_t swapchain_rebuilds;
    MoonlightCacheState pipeline_cache;
    bool pipeline_cache_saved;
    uint64_t startup_ns;
    MoonlightTiming upload;
    MoonlightTiming acquire;
    MoonlightTiming submit;
    MoonlightTiming fence;
    MoonlightTiming present;
    MoonlightTiming upload_wait;
} MoonlightRendererInfo;

typedef void (*MoonlightRendererLog)(const char *message);

MoonlightRenderResult moonlightRendererCreate(const MoonlightRendererConfig *config,
    MoonlightRendererLog log, MoonlightRenderer **out);

MoonlightRenderResult moonlightRendererUpload(MoonlightRenderer *renderer,
    const MoonlightNv12Frame *frame, uint32_t *slot);

MoonlightRenderResult moonlightRendererPresent(MoonlightRenderer *renderer, MoonlightPresentMode mode);

MoonlightRenderResult moonlightRendererCollect(MoonlightRenderer *renderer, uint64_t timeout_ns);

uint8_t *moonlightRendererStorage(MoonlightRenderer *renderer, size_t *bytes);
uint8_t *moonlightRendererInput(MoonlightRenderer *renderer, size_t *bytes);
void moonlightRendererGetInfo(const MoonlightRenderer *renderer, MoonlightRendererInfo *info);

MoonlightRenderResult moonlightRendererClose(MoonlightRenderer *renderer);
MoonlightRenderer *moonlightRendererRetained(void);
void moonlightRendererDestroy(MoonlightRenderer *renderer);

const char *moonlightRenderResultName(MoonlightRenderResult result);
