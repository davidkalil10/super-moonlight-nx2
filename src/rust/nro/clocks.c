/*
 * Clock readings and the clocks a stream asks for. None of these services is proven inside the
 * hijacked title: every call returns its result for the runtime to log, and a service that
 * does not open is not asked again.
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
    uint32_t mm_nvdec_hz;
    Result apm;
    Result clkrst[CLOCKS];
    Result mm;
} MoonlightClockReading;

typedef struct {
    uint32_t mode;
    uint32_t saved_configuration;
    uint32_t configuration;
    uint32_t nvdec_hz;
    Result apm;
    Result nvdec;
} MoonlightClockRequest;

static const PcvModuleId modules[CLOCKS] = {PcvModuleId_CpuBus, PcvModuleId_GPU, PcvModuleId_EMC,
                                            PcvModuleId_NVDEC};

static struct {
    bool apm_tried, clkrst_tried, mm_tried;
    Result apm_opened, clkrst_opened, mm_opened;
    ClkrstSession sessions[CLOCKS];
    Result session_opened[CLOCKS];
    MmuRequest nvdec;
    bool nvdec_requested;
    uint32_t mode;
    uint32_t saved_configuration;
    bool configuration_changed;
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

static Result open_mm(void)
{
    if (!clocks.mm_tried) {
        clocks.mm_tried = true;
        clocks.mm_opened = mmuInitialize();
    }
    return clocks.mm_opened;
}

static uint32_t fastest(ClkrstSession *session, Result *result)
{
    uint32_t rates[32] = {0};
    PcvClockRatesListType type = PcvClockRatesListType_Invalid;
    s32 count = 0;
    uint32_t best = 0;

    *result = clkrstGetPossibleClockRates(session, rates, 32, &type, &count);
    if (R_FAILED(*result))
        return 0;
    for (s32 index = 0; index < count && index < 32; index++)
        if (rates[index] > best)
            best = rates[index];
    return best;
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
    out->mm = clocks.nvdec_requested ? mmuRequestGet(&clocks.nvdec, &out->mm_nvdec_hz)
                                     : MAKERESULT(Module_Libnx, LibnxError_NotInitialized);
}

/*
 * Holds the given performance configuration for the current mode, 0 keeping the current one,
 * and asks mm for the decoder's fastest rate, until moonlightClocksRelease.
 */
void moonlightClocksRequest(uint32_t configuration, MoonlightClockRequest *out)
{
    ApmPerformanceMode mode = ApmPerformanceMode_Invalid;

    memset(out, 0, sizeof(*out));
    out->apm = open_apm();
    if (R_SUCCEEDED(out->apm) && !clocks.configuration_changed) {
        out->apm = apmGetPerformanceMode(&mode);
        if (R_SUCCEEDED(out->apm))
            out->apm = apmGetPerformanceConfiguration(mode, &clocks.saved_configuration);
        if (R_SUCCEEDED(out->apm) && configuration != 0 &&
            clocks.saved_configuration != configuration) {
            out->apm = apmSetPerformanceConfiguration(mode, configuration);
            clocks.configuration_changed = R_SUCCEEDED(out->apm);
        }
        clocks.mode = (uint32_t)mode;
    }
    out->mode = clocks.mode;
    out->saved_configuration = clocks.saved_configuration;
    out->configuration = configuration;

    out->nvdec = open_mm();
    if (R_SUCCEEDED(out->nvdec) && !clocks.nvdec_requested) {
        open_clkrst();
        out->nvdec = clocks.session_opened[CLOCK_NVDEC];
        if (R_SUCCEEDED(out->nvdec))
            out->nvdec_hz = fastest(&clocks.sessions[CLOCK_NVDEC], &out->nvdec);
        if (R_SUCCEEDED(out->nvdec) && out->nvdec_hz == 0)
            out->nvdec = MAKERESULT(Module_Libnx, LibnxError_NotFound);
        if (R_SUCCEEDED(out->nvdec))
            out->nvdec = mmuRequestInitialize(&clocks.nvdec, MmuModuleId_Nvdec, 0, false);
        if (R_SUCCEEDED(out->nvdec)) {
            clocks.nvdec_requested = true;
            out->nvdec = mmuRequestSetAndWait(&clocks.nvdec, out->nvdec_hz, -1);
        }
    }
}

/* Puts back what moonlightClocksRequest changed. */
Result moonlightClocksRelease(void)
{
    Result first = 0;

    if (clocks.configuration_changed) {
        first = apmSetPerformanceConfiguration((ApmPerformanceMode)clocks.mode,
                                               clocks.saved_configuration);
        clocks.configuration_changed = false;
    }
    if (clocks.nvdec_requested) {
        Result result = mmuRequestFinalize(&clocks.nvdec);
        if (R_SUCCEEDED(first))
            first = result;
        clocks.nvdec_requested = false;
    }
    return first;
}
