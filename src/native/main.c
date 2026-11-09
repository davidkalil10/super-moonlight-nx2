#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <switch.h>
#include <ouncehen.h>

#include "build-info.h"
#include "native.h"
#include "platform/gsv-frame.h"

_Static_assert(HidNpadButton_A == (UINT64_C(1) << 0), "Unexpected Npad A bit");
_Static_assert(HidNpadButton_ZL == (UINT64_C(1) << 8), "Unexpected Npad ZL bit");
_Static_assert(HidNpadButton_Left == (UINT64_C(1) << 12), "Unexpected Npad Left bit");
_Static_assert(HidNpadButton_Up == (UINT64_C(1) << 13), "Unexpected Npad Up bit");
_Static_assert(HidNpadButton_Right == (UINT64_C(1) << 14), "Unexpected Npad Right bit");
_Static_assert(HidNpadButton_Down == (UINT64_C(1) << 15), "Unexpected Npad Down bit");

static FILE *report_file;
static bool console_active;

void moonlightHideConsole(void)
{
    if (console_active) {
        console_active = false;
        consoleExit(NULL);
    }
}

void moonlightReport(const char *format, ...)
{
    va_list args;
    va_start(args, format);
    va_list copy;
    va_copy(copy, args);
    if (console_active) {
        vprintf(format, args);
        putchar('\n');
    }
    if (report_file) {
        vfprintf(report_file, format, copy);
        fputc('\n', report_file);
        fflush(report_file);
    }
    va_end(copy);
    va_end(args);
    if (console_active)
        consoleUpdate(NULL);
}

static void open_report(void)
{
    const char *directory = "sdmc:/switch/moonlight-nx2";
    if (mkdir(directory, 0777) < 0 && errno != EEXIST) {
        moonlightReport("report: cannot create %s (%d)", directory, errno);
        return;
    }

    char path[160];
    snprintf(path, sizeof(path), "%s/compat-%016" PRIx64 ".log", directory, armGetSystemTick());
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0) {
        moonlightReport("report: cannot create log (%d)", errno);
        return;
    }
    report_file = fdopen(fd, "w");
    if (!report_file)
        close(fd);
    moonlightReport("report: %s", report_file ? path : "cannot open log stream");
}

static void probe_hen(void)
{
    Service ro = {0};
    Result rc = ouncehenGetRoSession(&ro);
    moonlightReport("hen.ro: 0x%08x", rc);
    if (R_FAILED(rc))
        return;

    Service hen = {0};
    rc = ouncehenOpenHomebrewSession(&ro, &hen);
    moonlightReport("hen.session: 0x%08x", rc);
    if (R_FAILED(rc))
        return;

    HenStatus status = {0};
    rc = henGetStatus(&hen, &status);
    moonlightReport("hen.status: 0x%08x", rc);
    serviceClose(&hen);
}

static void probe_sockets(void)
{
    Result rc = socketInitializeDefault();
    moonlightReport("sockets.initialize: 0x%08x", rc);
    if (R_FAILED(rc))
        return;

    const int kinds[] = {SOCK_STREAM, SOCK_DGRAM};
    const char *names[] = {"tcp", "udp"};
    for (unsigned i = 0; i < sizeof(kinds) / sizeof(kinds[0]); i++) {
        int fd = socket(AF_INET, kinds[i], 0);
        if (fd < 0) {
            moonlightReport("sockets.%s: open failed (%d)", names[i], errno);
            continue;
        }
        struct sockaddr_in address = {
            .sin_family = AF_INET,
            .sin_addr.s_addr = htonl(INADDR_ANY),
        };
        if (bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0)
            moonlightReport("sockets.%s: bind failed (%d)", names[i], errno);
        else
            moonlightReport("sockets.%s: open and ephemeral bind passed", names[i]);
        close(fd);
    }
    moonlightReport("sockets.network: packet transfer not tested");
    socketExit();
}

static void probe_audio(void)
{
    Result rc = audoutInitialize();
    moonlightReport("audio.initialize: 0x%08x", rc);
    if (R_FAILED(rc))
        return;

    moonlightReport("audio.format: rate=%u channels=%u", audoutGetSampleRate(), audoutGetChannelCount());
    moonlightReport("audio.playback: not tested");
    audoutExit();
}

int main(void)
{
    if (!consoleInit(NULL))
        return 1;
    console_active = true;

    open_report();
    moonlightReport("Moonlight NX2: native compatibility check");
    moonlightReport("source: %s", MOONLIGHT_SOURCE_REVISION);
    moonlightReport("sdk: %s", MOONLIGHT_SDK_VERSION);
    moonlightReport("Streaming is not implemented in this target.");
    probe_hen();
    probe_sockets();
    probe_audio();
    moonlightReport("vulkan.enumeration: %s", moonlightProbeVulkan() ? "passed" : "failed");
    MoonlightGsvFrameStatus frame_status;
    moonlightGsvFrameGetStatus(&frame_status);
    moonlightReport("gsv.frame: state=%u requested=%" PRIu64 " permitted=%" PRIu64
        " result=0x%08x forwarded=%u cached=%u refused=%u", (unsigned)frame_status.state,
        frame_status.requested_mode, frame_status.permitted_mode, frame_status.result,
        frame_status.forwarded, frame_status.answered_from_cache, frame_status.refused);

    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    PadState pad;
    padInitializeDefault(&pad);
    hidInitializeTouchScreen();
    moonlightReport("Move the sticks, press buttons and touch the screen.");
    moonlightReport("Press + to return to hbmenu.");

    uint64_t last_report = 0;
    while (appletMainLoop()) {
        padUpdate(&pad);
        if (padGetButtonsDown(&pad) & HidNpadButton_Plus)
            break;

        const uint64_t now = armGetSystemTick();
        if (armTicksToNs(now - last_report) >= UINT64_C(1000000000)) {
            const HidAnalogStickState left = padGetStickPos(&pad, 0);
            const HidAnalogStickState right = padGetStickPos(&pad, 1);
            const uint64_t buttons = padGetButtons(&pad);
            const MoonlightPad mapped = moonlightMapPad(padIsConnected(&pad), buttons,
                left.x, left.y, right.x, right.y);
            moonlightReport("pad: connected=%u buttons=0x%04x triggers=%u,%u sticks=%d,%d,%d,%d stop=%u",
                mapped.connected, mapped.buttons, mapped.left_trigger, mapped.right_trigger,
                mapped.left_x, mapped.left_y, mapped.right_x, mapped.right_y, moonlightStopHeld(buttons));

            HidTouchScreenState touch = {0};
            if (hidGetTouchScreenStates(&touch, 1) && touch.count > 0) {
                moonlightReport("touch: count=%d first=%u,%u", touch.count,
                    touch.touches[0].x, touch.touches[0].y);
            }
            last_report = now;
        }
        consoleUpdate(NULL);
    }

    if (report_file)
        fclose(report_file);
    moonlightHideConsole();
    return 0;
}
