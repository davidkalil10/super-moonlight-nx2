// Codec probe: one known AV1 frame through the native decoder service, compared with its NV12
// reference. It streams nothing and draws nothing. CLAUDE1-HANDOFF.md, "Console probe".
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include <switch.h>

#include "../probe.h"

#define PROBE_DIRECTORY "sdmc:/switch/moonlight-nx2/codec-native-probe"

static FILE *report;

static void log_line(const char *message)
{
    if (!report)
        return;
    fprintf(report, "%" PRIu64 " %s\n", armTicksToNs(armGetSystemTick()) / 1000000, message);
    fflush(report);
}

static bool open_report(void)
{
    if (mkdir(PROBE_DIRECTORY, 0777) < 0 && errno != EEXIST)
        return false;

    char path[160];
    snprintf(path, sizeof(path), "%s/probe-%016" PRIx64 ".log", PROBE_DIRECTORY, armGetSystemTick());
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0)
        return false;
    report = fdopen(fd, "w");
    if (!report)
        close(fd);
    return report != NULL;
}

int main(void)
{
    if (!open_report())
        return 1;

    log_line("probe: start");
    bool passed = moonlightCodecProbe(PROBE_DIRECTORY, log_line);
    log_line(passed ? "probe: exit pass" : "probe: exit fail");
    if (moonlightCodecProbeRetained()) {
        log_line("probe: retained resources; ending the process, restart required");
        fclose(report);
        svcExitProcess();
    }
    fclose(report);
    return passed ? 0 : 1;
}
