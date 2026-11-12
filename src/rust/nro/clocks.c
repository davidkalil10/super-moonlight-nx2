/*
 * Clock readings while streaming. None of these services is proven inside the hijacked title:
 * every call returns its result for the runtime to log, and a service that does not open is not
 * asked again before the next close. The only change is the CPU boost mode, through the applet
 * session the process already holds.
 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include <switch.h>

enum { CLOCK_CPU, CLOCK_GPU, CLOCK_EMC, CLOCK_NVDEC, CLOCKS };

typedef struct {
    uint32_t mode;
    uint32_t configuration;
    uint32_t hz[CLOCKS];
    Result apm;
    Result clkrst[CLOCKS];
} MoonlightClockReading;

static const PcvModuleId modules[CLOCKS] = {PcvModuleId_CpuBus, PcvModuleId_GPU, PcvModuleId_EMC,
                                            PcvModuleId_NVDEC};

static struct {
    bool apm_tried, clkrst_tried;
    Result apm_opened, clkrst_opened;
    ClkrstSession sessions[CLOCKS];
    Result session_opened[CLOCKS];
} clocks;

static Result open_apm(void)
{
    if (!clocks.apm_tried) {
        clocks.apm_tried = true;
        clocks.apm_opened = apmInitialize();
    }
    return clocks.apm_opened;
}

static Result open_clkrst(void)
{
    if (!clocks.clkrst_tried) {
        clocks.clkrst_tried = true;
        clocks.clkrst_opened = clkrstInitialize();
        for (int clock = 0; clock < CLOCKS; clock++)
            clocks.session_opened[clock] =
                R_SUCCEEDED(clocks.clkrst_opened)
                    ? clkrstOpenSession(&clocks.sessions[clock], modules[clock], 3)
                    : clocks.clkrst_opened;
    }
    return clocks.clkrst_opened;
}

void moonlightClocksRead(MoonlightClockReading *out)
{
    ApmPerformanceMode mode = ApmPerformanceMode_Invalid;

    memset(out, 0, sizeof(*out));
    out->apm = open_apm();
    if (R_SUCCEEDED(out->apm))
        out->apm = apmGetPerformanceMode(&mode);
    out->mode = (uint32_t)mode;
    if (R_SUCCEEDED(out->apm))
        out->apm = apmGetPerformanceConfiguration(mode, &out->configuration);
    open_clkrst();
    for (int clock = 0; clock < CLOCKS; clock++) {
        out->clkrst[clock] = clocks.session_opened[clock];
        if (R_SUCCEEDED(out->clkrst[clock]))
            out->clkrst[clock] = clkrstGetClockRate(&clocks.sessions[clock], &out->hz[clock]);
    }
}

Result moonlightClocksBoost(bool on)
{
    return appletSetCpuBoostMode(on ? ApmCpuBoostMode_FastLoad : ApmCpuBoostMode_Normal);
}

/* Closes every session moonlightClocksRead opened, so none outlives the stream. */
void moonlightClocksClose(void)
{
    if (clocks.clkrst_tried && R_SUCCEEDED(clocks.clkrst_opened)) {
        for (int clock = 0; clock < CLOCKS; clock++)
            if (R_SUCCEEDED(clocks.session_opened[clock]))
                clkrstCloseSession(&clocks.sessions[clock]);
        clkrstExit();
    }
    if (clocks.apm_tried && R_SUCCEEDED(clocks.apm_opened))
        apmExit();
    memset(&clocks, 0, sizeof(clocks));
}
