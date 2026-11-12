/*
 * Clock readings while streaming. None of these services is proven inside the hijacked title:
 * every call returns its result for the runtime to log, and a service that does not open is not
 * asked again before the next close. The only change is the decoder's clock, which the perf
 * build can raise to its highest rate and give back.
 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include <switch.h>

enum { CLOCK_CPU, CLOCK_GPU, CLOCK_EMC, CLOCK_NVDEC, CLOCK_VIC, CLOCKS };

typedef struct {
    uint32_t mode;
    uint32_t configuration;
    uint32_t hz[CLOCKS];
    Result apm;
    Result clkrst[CLOCKS];
    uint32_t ids[CLOCKS];
} MoonlightClockReading;

/*
 * The module ids of the first console. pcv is not asked for this one's: sm holds a request for
 * a service that is not registered, and the stream hung at the first read when it did.
 */
static const PcvModuleId ids[CLOCKS] = {PcvModuleId_CpuBus, PcvModuleId_GPU, PcvModuleId_EMC,
                                        PcvModuleId_NVDEC, PcvModuleId_VIC};

static struct {
    bool apm_tried, clkrst_tried;
    Result apm_opened, clkrst_opened;
    ClkrstSession sessions[CLOCKS];
    Result session_opened[CLOCKS];
    uint32_t decoder_default_hz;
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
                    ? clkrstOpenSession(&clocks.sessions[clock], ids[clock], 3)
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
        out->ids[clock] = ids[clock];
        out->clkrst[clock] = clocks.session_opened[clock];
        if (R_SUCCEEDED(out->clkrst[clock]))
            out->clkrst[clock] = clkrstGetClockRate(&clocks.sessions[clock], &out->hz[clock]);
    }
}

/* The rates the decoder's clock can take, for the log. */
Result moonlightClocksDecoderRates(uint32_t *rates, int32_t max, int32_t *count, uint32_t *type)
{
    PcvClockRatesListType list = PcvClockRatesListType_Invalid;
    Result result;

    *count = 0;
    *type = 0;
    result = open_clkrst();
    if (R_SUCCEEDED(result))
        result = clocks.session_opened[CLOCK_NVDEC];
    if (R_SUCCEEDED(result))
        result = clkrstGetPossibleClockRates(&clocks.sessions[CLOCK_NVDEC], rates, max, &list,
                                             count);
    *type = (uint32_t)list;
    return result;
}

/*
 * Raises the decoder's clock to the highest rate it lists, or sets back the rate it had
 * before. Writes the rate asked for to `hz`.
 */
Result moonlightClocksDecoderMax(bool on, uint32_t *hz)
{
    ClkrstSession *session = &clocks.sessions[CLOCK_NVDEC];
    uint32_t rates[32];
    int32_t count = 0;
    PcvClockRatesListType list = PcvClockRatesListType_Invalid;
    Result result = open_clkrst();

    *hz = 0;
    if (R_SUCCEEDED(result))
        result = clocks.session_opened[CLOCK_NVDEC];
    if (R_FAILED(result))
        return result;
    if (!on) {
        if (clocks.decoder_default_hz == 0)
            return 0;
        *hz = clocks.decoder_default_hz;
        result = clkrstSetClockRate(session, *hz);
        clocks.decoder_default_hz = 0;
        return result;
    }
    result = clkrstGetPossibleClockRates(session, rates, 32, &list, &count);
    if (R_FAILED(result))
        return result;
    for (int32_t rate = 0; rate < count && rate < 32; rate++)
        if (rates[rate] > *hz)
            *hz = rates[rate];
    if (*hz == 0)
        return MAKERESULT(Module_Libnx, LibnxError_NotFound);
    if (clocks.decoder_default_hz == 0) {
        result = clkrstGetClockRate(session, &clocks.decoder_default_hz);
        if (R_FAILED(result))
            return result;
    }
    return clkrstSetClockRate(session, *hz);
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
