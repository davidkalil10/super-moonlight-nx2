// Renderer diagnostic: a moving 1080p NV12 pattern through the native renderer for a bounded
// time, with frame pacing in a log. It streams nothing. CLAUDE2-HANDOFF.md, "Live check".
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <switch.h>

#include "../../renderer.h"

#define PATTERN_WIDTH 1920u
#define PATTERN_HEIGHT 1080u
#define PATTERN_SECONDS 20u
#define BOX 160u
#define PATTERN_UPLOAD_WAIT_US 12000u

static FILE *report;

static void log_line(const char *message)
{
    if (!report)
        return;
    fprintf(report, "%" PRIu64 " %s\n", armTicksToNs(armGetSystemTick()) / 1000000, message);
    fflush(report);
}

static void open_report(void)
{
    const char *directory = "sdmc:/switch/moonlight-nx2";
    if (mkdir(directory, 0777) < 0 && errno != EEXIST)
        return;

    char path[160];
    snprintf(path, sizeof(path), "%s/renderer-%016" PRIx64 ".log", directory, armGetSystemTick());
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0)
        return;
    report = fdopen(fd, "w");
    if (!report)
        close(fd);
}

static void logf_line(const char *format, ...) __attribute__((format(printf, 1, 2)));

static void logf_line(const char *format, ...)
{
    char message[256];
    va_list args;
    va_start(args, format);
    vsnprintf(message, sizeof(message), format, args);
    va_end(args);
    log_line(message);
}

static const uint8_t BARS[8][3] = {
    {235, 128, 128}, {219, 16, 138}, {188, 154, 16}, {173, 42, 26},
    {78, 214, 230}, {63, 102, 240}, {32, 240, 118}, {16, 128, 128},
};

static void draw_bars(uint8_t *luma, uint8_t *chroma)
{
    for (uint32_t y = 0; y < PATTERN_HEIGHT; y++) {
        for (uint32_t x = 0; x < PATTERN_WIDTH; x++)
            luma[y * PATTERN_WIDTH + x] = BARS[x * 8 / PATTERN_WIDTH][0];
    }
    for (uint32_t y = 0; y < PATTERN_HEIGHT / 2; y++) {
        for (uint32_t x = 0; x < PATTERN_WIDTH; x += 2) {
            const uint8_t *bar = BARS[x * 8 / PATTERN_WIDTH];
            chroma[y * PATTERN_WIDTH + x] = bar[1];
            chroma[y * PATTERN_WIDTH + x + 1] = bar[2];
        }
    }
}

static void draw_box(uint8_t *luma, uint32_t left, uint8_t value)
{
    const uint32_t top = (PATTERN_HEIGHT - BOX) / 2;
    for (uint32_t y = top; y < top + BOX; y++)
        memset(luma + y * PATTERN_WIDTH + left, value, BOX);
}

static void restore_box(uint8_t *luma, uint32_t left)
{
    const uint32_t top = (PATTERN_HEIGHT - BOX) / 2;
    for (uint32_t y = top; y < top + BOX; y++) {
        for (uint32_t x = left; x < left + BOX; x++)
            luma[y * PATTERN_WIDTH + x] = BARS[x * 8 / PATTERN_WIDTH][0];
    }
}

typedef struct {
    uint64_t frames;
    uint64_t busy;
    uint64_t slowest_ns;
    uint64_t late;
} Pacing;

static void record_interval(Pacing *pacing, uint64_t interval_ns)
{
    if (interval_ns > pacing->slowest_ns)
        pacing->slowest_ns = interval_ns;
    if (interval_ns > UINT64_C(25000000))
        pacing->late++;
}

static void add_window(Pacing *total, const Pacing *window)
{
    total->frames += window->frames;
    total->busy += window->busy;
    total->late += window->late;
    if (window->slowest_ns > total->slowest_ns)
        total->slowest_ns = window->slowest_ns;
}

static uint64_t average_us(const MoonlightTiming *now, const MoonlightTiming *before)
{
    const uint64_t count = now->count - before->count;
    if (!count)
        return 0;
    return (now->total_ns - before->total_ns) / count / 1000;
}

static void log_phases(MoonlightRenderer *renderer, MoonlightRendererInfo *before)
{
    MoonlightRendererInfo now;
    moonlightRendererGetInfo(renderer, &now);
    logf_line("pattern.phases_us: upload=%" PRIu64 " acquire=%" PRIu64 " submit=%" PRIu64 " fence=%" PRIu64
              " present=%" PRIu64,
        average_us(&now.upload, &before->upload), average_us(&now.acquire, &before->acquire),
        average_us(&now.submit, &before->submit), average_us(&now.fence, &before->fence),
        average_us(&now.present, &before->present));
    *before = now;
}

static void log_timing(const char *name, const MoonlightTiming *timing)
{
    const uint64_t average = timing->count ? timing->total_ns / timing->count / 1000 : 0;
    logf_line("renderer.timing.%s: count=%" PRIu64 " avg_us=%" PRIu64 " max_us=%" PRIu64, name, timing->count,
        average, timing->max_ns / 1000);
}

static int run(MoonlightRenderer *renderer, PadState *pad)
{
    uint8_t *luma = malloc(PATTERN_WIDTH * PATTERN_HEIGHT * 3 / 2);
    if (!luma)
        return 1;
    uint8_t *chroma = luma + PATTERN_WIDTH * PATTERN_HEIGHT;
    draw_bars(luma, chroma);

    MoonlightNv12Frame frame = {
        .luma = luma, .chroma = chroma,
        .luma_stride = PATTERN_WIDTH, .chroma_stride = PATTERN_WIDTH,
        .coded_width = PATTERN_WIDTH, .coded_height = PATTERN_HEIGHT,
        .display_width = PATTERN_WIDTH, .display_height = PATTERN_HEIGHT,
        .matrix = MOONLIGHT_COLOR_BT709,
    };

    const uint64_t start = armGetSystemTick();
    uint64_t last = start;
    uint64_t second = start;
    Pacing total = {0};
    Pacing window = {0};
    MoonlightRendererInfo phases;
    moonlightRendererGetInfo(renderer, &phases);
    uint32_t left = 0;
    int status = 0;

    while (appletMainLoop()) {
        padUpdate(pad);
        if (padGetButtonsDown(pad) & HidNpadButton_Plus)
            break;
        if (armTicksToNs(armGetSystemTick() - start) >= UINT64_C(1000000000) * PATTERN_SECONDS)
            break;

        restore_box(luma, left);
        left = (left + 8) % (PATTERN_WIDTH - BOX);
        draw_box(luma, left, 235);
        frame.timestamp_ns = armTicksToNs(armGetSystemTick());

        MoonlightRenderResult result = moonlightRendererUpload(renderer, &frame, NULL);
        if (result == MOONLIGHT_RENDER_BUSY) {
            window.busy++;
        } else if (result != MOONLIGHT_RENDER_OK) {
            logf_line("pattern.upload: %s", moonlightRenderResultName(result));
            status = 1;
            break;
        }

        result = moonlightRendererPresent(renderer, MOONLIGHT_PRESENT_STREAMING);
        if (result != MOONLIGHT_RENDER_OK && result != MOONLIGHT_RENDER_BUSY) {
            logf_line("pattern.present: %s", moonlightRenderResultName(result));
            status = 1;
            break;
        }

        const uint64_t now = armGetSystemTick();
        record_interval(&window, armTicksToNs(now - last));
        window.frames++;
        last = now;
        if (armTicksToNs(now - second) >= UINT64_C(1000000000)) {
            logf_line("pattern.second: frames=%" PRIu64 " busy=%" PRIu64 " late=%" PRIu64 " slowest_us=%" PRIu64,
                window.frames, window.busy, window.late, window.slowest_ns / 1000);
            log_phases(renderer, &phases);
            add_window(&total, &window);
            window = (Pacing){0};
            second = now;
        }
    }

    if (window.frames || window.busy) {
        logf_line("pattern.partial: frames=%" PRIu64 " busy=%" PRIu64 " late=%" PRIu64 " slowest_us=%" PRIu64,
            window.frames, window.busy, window.late, window.slowest_ns / 1000);
        add_window(&total, &window);
    }
    const uint64_t elapsed_ms = armTicksToNs(armGetSystemTick() - start) / 1000000;
    logf_line("pattern.total: frames=%" PRIu64 " ms=%" PRIu64 " busy=%" PRIu64 " late=%" PRIu64 " slowest_us=%" PRIu64,
        total.frames, elapsed_ms, total.busy, total.late, total.slowest_ns / 1000);
    free(luma);
    return status;
}

static void NX_NORETURN end_process_retained(void)
{
    logf_line("exit: retained renderer, ending the process instead of returning to hbmenu");
    if (report)
        fclose(report);
    svcExitProcess();
}

int main(void)
{
    open_report();
    logf_line("Moonlight NX2 renderer diagnostic (no streaming)");

    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    PadState pad;
    padInitializeDefault(&pad);

    const MoonlightRendererConfig config = {
        .width = PATTERN_WIDTH,
        .height = PATTERN_HEIGHT,
        .pipeline_cache_path = "sdmc:/switch/moonlight-nx2/renderer-pipelines.bin",
        .upload_wait_us = PATTERN_UPLOAD_WAIT_US,
    };
    MoonlightRenderer *renderer = NULL;
    MoonlightRenderResult result = moonlightRendererCreate(&config, log_line, &renderer);
    logf_line("renderer.create: %s", moonlightRenderResultName(result));

    int status = 1;
    if (result == MOONLIGHT_RENDER_OK) {
        MoonlightRendererInfo info;
        moonlightRendererGetInfo(renderer, &info);
        logf_line("renderer.info: %ux%u images=%u format=%u path=%d cache=%d saved=%d startup_us=%" PRIu64
                  " upload_wait_us=%u",
            info.width, info.height, info.swapchain_images, info.surface_format, info.video_path,
            info.pipeline_cache, info.pipeline_cache_saved, info.startup_ns / 1000, PATTERN_UPLOAD_WAIT_US);
        status = run(renderer, &pad);
        moonlightRendererGetInfo(renderer, &info);
        logf_line("renderer.stats: presented=%" PRIu64 " busy=%" PRIu64 " rebuilds=%" PRIu64,
            info.presented, info.busy_uploads, info.swapchain_rebuilds);
        log_timing("upload", &info.upload);
        log_timing("acquire", &info.acquire);
        log_timing("submit", &info.submit);
        log_timing("fence", &info.fence);
        log_timing("present", &info.present);
        log_timing("upload_wait", &info.upload_wait);
        const MoonlightRenderResult closed = moonlightRendererClose(renderer);
        logf_line("renderer.close: %s", moonlightRenderResultName(closed));
        if (closed == MOONLIGHT_RENDER_RETAINED)
            end_process_retained();
        if (closed != MOONLIGHT_RENDER_OK)
            status = 1;
    }

    logf_line("exit: %d", status);
    if (report)
        fclose(report);
    return status;
}
