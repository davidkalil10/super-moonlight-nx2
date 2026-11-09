// UI diagnostic: the native hosts, apps and settings pages through the renderer, bridge and composer,
// with two mock PCs, no network and no streaming. CLAUDE2-HANDOFF.md, "UI diagnostic".
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <switch.h>

#include "../../renderer.h"
#include "../bridge.h"
#include "glyphs_bin.h"

#define RUN_SECONDS 60u
#define REPLY_MS 800u
#define INPUT_PAD 0u
#define INPUT_TOUCH 128u

static FILE *report;

static void log_line(const char *message)
{
    if (!report)
        return;
    fprintf(report, "%" PRIu64 " %s\n", armTicksToNs(armGetSystemTick()) / 1000000, message);
    fflush(report);
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

static void open_report(void)
{
    const char *directory = "sdmc:/switch/moonlight-nx2";
    if (mkdir(directory, 0777) < 0 && errno != EEXIST)
        return;

    char path[160];
    snprintf(path, sizeof(path), "%s/ui-%016" PRIx64 ".log", directory, armGetSystemTick());
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0)
        return;
    report = fdopen(fd, "w");
    if (!report)
        close(fd);
}

static uint64_t now_ns(void)
{
    return armTicksToNs(armGetSystemTick());
}

static void write_input(uint8_t *input, PadState *pad, uint64_t sample)
{
    HidNpadCommonState state = {0};
    const HidAnalogStickState left = padGetStickPos(pad, 0);
    const HidAnalogStickState right = padGetStickPos(pad, 1);
    state.sampling_number = sample;
    state.buttons = padGetButtons(pad);
    state.analog_stick_l = left;
    state.analog_stick_r = right;
    state.attributes = padIsConnected(pad) ? HidNpadAttribute_IsConnected : 0;
    memcpy(input + INPUT_PAD, &state, sizeof(state));

    HidTouchScreenState touch = {0};
    hidGetTouchScreenStates(&touch, 1);
    memcpy(input + INPUT_TOUCH, &touch, sizeof(touch));
}

static const MoonlightHost HOSTS[2] = {
    {"Desk", "192.168.8.245", "A1B2"},
    {"Living room", "10.0.0.7", ""},
};

typedef struct {
    MoonlightUiEventType type;
    uint64_t at;
    bool pending;
} Reply;

static void answer(MoonlightUiBridge *bridge, MoonlightUiEventType type)
{
    static MoonlightApp apps[12];
    for (uint32_t i = 0; i < 12; i++) {
        apps[i].id = 100 + i;
        snprintf(apps[i].name, sizeof(apps[i].name), "Game %u", i + 1);
    }
    const MoonlightUiEvent event = {
        .type = type,
        .hosts = HOSTS,
        .host_count = 2,
        .apps = apps,
        .app_count = 12,
        .current_game = 103,
    };
    moonlightUiBridgeDispatch(bridge, &event);
    logf_line("ui.reply: %u", (unsigned)type);
}

static void take_intents(MoonlightUiBridge *bridge, Reply *reply, uint64_t now)
{
    MoonlightUiIntent intents[ML_UI_MAX_QUEUED];
    const uint32_t count = moonlightUiBridgeTakeIntents(bridge, intents, ML_UI_MAX_QUEUED);
    for (uint32_t i = 0; i < count; i++) {
        const MoonlightUiIntentType type = intents[i].type;
        logf_line("ui.intent: %s", moonlightUiIntentName(type));
        if (type == MOONLIGHT_INTENT_LIST)
            *reply = (Reply){MOONLIGHT_EVENT_LISTED, now + (uint64_t)REPLY_MS * 1000000u, true};
        else if (type == MOONLIGHT_INTENT_REFRESH_HOSTS)
            *reply = (Reply){MOONLIGHT_EVENT_HOSTS, now + (uint64_t)REPLY_MS * 1000000u, true};
        else if (type == MOONLIGHT_INTENT_UNPAIR_HOST)
            *reply = (Reply){MOONLIGHT_EVENT_UNPAIRED, now + (uint64_t)REPLY_MS * 1000000u, true};
    }
}

static uint64_t fnv64(const uint8_t *bytes, size_t length)
{
    uint64_t hash = UINT64_C(0xcbf29ce484222325);
    for (size_t i = 0; i < length; i++) {
        hash ^= bytes[i];
        hash *= UINT64_C(0x100000001b3);
    }
    return hash;
}

typedef struct {
    MoonlightScreen screen;
    uint32_t item;
    bool known;
} Selection;

static uint32_t selected_item(const MoonlightUiBridge *bridge)
{
    if (!bridge->has_header)
        return 0;
    const uint8_t *storage = bridge->storage;
    const uint8_t *page = storage + ML_UI_PAGES_OFFSET + (bridge->sequence & 1) * ML_UI_PAGE_BUFFER_BYTES;
    uint32_t cursor;
    uint32_t items;
    memcpy(&cursor, storage + ML_UI_CURSOR, sizeof(cursor));
    memcpy(&items, page + 16, sizeof(items));
    if (cursor >= items || items > ML_PAGE_MAX_ITEMS)
        return 0;
    uint32_t id;
    memcpy(&id, page + ML_PAGE_ITEMS_OFFSET + cursor * ML_PAGE_ROW_WORDS * 4, sizeof(id));
    return id;
}

static void log_selection(const MoonlightUiBridge *bridge, Selection *last)
{
    const uint32_t item = selected_item(bridge);
    const MoonlightScreen screen = bridge->model.screen;
    if (last->known && last->screen == screen && last->item == item)
        return;
    *last = (Selection){screen, item, true};
    logf_line("ui.select: screen=%s item=%u", moonlightUiScreenName(screen), item);
}

typedef struct {
    uint32_t publishes;
    uint64_t publish_ns;
    uint64_t publish_max_ns;
    uint32_t interactive;
    uint32_t frames;
} Second;

static int run(MoonlightRenderer *renderer, MoonlightComposer *composer, MoonlightUiBridge *bridge, PadState *pad)
{
    uint8_t *input = moonlightRendererInput(renderer, NULL);
    const uint64_t start = now_ns();
    uint64_t second_start = start;
    uint64_t sample = 0;
    Second second = {0};
    Reply reply = {0};
    Selection selection = {0};
    int status = 0;

    while (appletMainLoop()) {
        padUpdate(pad);
        if (padGetButtonsDown(pad) & HidNpadButton_Plus)
            break;
        const uint64_t now = now_ns();
        if (now - start >= (uint64_t)RUN_SECONDS * 1000000000u)
            break;

        write_input(input, pad, ++sample);
        moonlightUiBridgePoll(bridge, now);
        if (reply.pending && now >= reply.at) {
            reply.pending = false;
            answer(bridge, reply.type);
        }
        take_intents(bridge, &reply, now);
        moonlightUiBridgeSetBusy(bridge, reply.pending);

        bool published = false;
        const uint64_t before = now_ns();
        const char *error = moonlightUiBridgePublish(bridge, composer, now, &published);
        const uint64_t spent = now_ns() - before;
        if (error)
            logf_line("ui.publish: %s", error);
        if (published) {
            second.publishes++;
            second.publish_ns += spent;
            if (spent > second.publish_max_ns)
                second.publish_max_ns = spent;
            logf_line("ui.page: %s sequence=%u bytes=%zu us=%" PRIu64, moonlightUiScreenName(bridge->model.screen),
                bridge->sequence, bridge->placed[bridge->sequence & 1].bytes, spent / 1000);
        }

        log_selection(bridge, &selection);
        const bool interactive = moonlightUiBridgeInteractive(bridge);
        second.interactive += interactive;
        second.frames++;
        const MoonlightRenderResult result = moonlightRendererPresent(renderer,
            interactive ? MOONLIGHT_PRESENT_INTERACTIVE : MOONLIGHT_PRESENT_STREAMING);
        if (result != MOONLIGHT_RENDER_OK && result != MOONLIGHT_RENDER_BUSY) {
            logf_line("ui.present: %s", moonlightRenderResultName(result));
            status = 1;
            break;
        }

        if (now - second_start >= 1000000000u) {
            logf_line("ui.second: frames=%u interactive=%u publishes=%u publish_avg_us=%" PRIu64
                      " publish_max_us=%" PRIu64 " screen=%s applied=%u ack=%u cached=%zu",
                second.frames, second.interactive, second.publishes,
                second.publishes ? second.publish_ns / second.publishes / 1000 : 0, second.publish_max_ns / 1000,
                moonlightUiScreenName(bridge->model.screen), bridge->applied,
                bridge->seen, moonlightComposerCachedBytes(composer));
            second = (Second){0};
            second_start = now;
        }
    }

    logf_line("ui.total: ms=%" PRIu64 " header_rewrites=%u apply_timeouts=%u dropped_intents=%u",
        (now_ns() - start) / 1000000, bridge->header_rewrites, bridge->apply_timeouts, bridge->dropped_intents);
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
    logf_line("Moonlight NX2 UI diagnostic (mock PCs, no network, no streaming)");
    logf_line("ui.atlas: bytes=%u fnv64=%016llx", (unsigned)glyphs_bin_size,
        (unsigned long long)fnv64(glyphs_bin, glyphs_bin_size));

    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    PadState pad;
    padInitializeDefault(&pad);
    hidInitializeTouchScreen();

    const MoonlightRendererConfig config = {
        .width = 1920,
        .height = 1080,
        .pipeline_cache_path = "sdmc:/switch/moonlight-nx2/renderer-pipelines.bin",
    };
    MoonlightRenderer *renderer = NULL;
    MoonlightRenderResult result = moonlightRendererCreate(&config, log_line, &renderer);
    logf_line("renderer.create: %s", moonlightRenderResultName(result));
    if (result != MOONLIGHT_RENDER_OK) {
        if (report)
            fclose(report);
        return 1;
    }

    const uint64_t glyphs_started = now_ns();
    MoonlightGlyphs *glyphs = moonlightGlyphsCreate(glyphs_bin, glyphs_bin_size);
    MoonlightComposer *composer = glyphs ? moonlightComposerCreate(glyphs, 0) : NULL;
    logf_line("ui.glyphs: %s us=%" PRIu64, composer ? "ok" : "failed", (now_ns() - glyphs_started) / 1000);

    int status = 1;
    if (composer) {
        static MoonlightUiBridge bridge;
        static MoonlightSettingsStore store;
        const MoonlightCapabilities none = {0};
        store.files = moonlightSettingsDirectory("sdmc:/switch/moonlight-nx2/ui-diagnostic");
        moonlightUiBridgeInit(&bridge, moonlightRendererStorage(renderer, NULL), HOSTS, 2, &store, &none,
            (uint32_t)(armGetSystemTick() >> 20) | 1u);
        logf_line("ui.init: epoch=%u settings_error=%s", bridge.epoch, bridge.storage_error ? bridge.storage_error : "none");
        const MoonlightUiEvent attached = {.type = MOONLIGHT_EVENT_ATTACHED};
        moonlightUiBridgeDispatch(&bridge, &attached);
        status = run(renderer, composer, &bridge, &pad);
        moonlightUiBridgeClose(&bridge);
    }

    moonlightComposerDestroy(composer);
    moonlightGlyphsDestroy(glyphs);
    const MoonlightRenderResult closed = moonlightRendererClose(renderer);
    logf_line("renderer.close: %s", moonlightRenderResultName(closed));
    if (closed == MOONLIGHT_RENDER_RETAINED)
        end_process_retained();
    if (closed != MOONLIGHT_RENDER_OK)
        status = 1;

    logf_line("exit: %d", status);
    if (report)
        fclose(report);
    return status;
}
