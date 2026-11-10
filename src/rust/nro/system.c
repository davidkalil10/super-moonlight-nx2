/*
 * Applet focus, idle control and the battery, temperature and network readings.
 * None of these calls is proven inside the hijacked title: each returns the SDK result for the
 * runtime to log, and a service that does not open is not asked again.
 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include <switch.h>

typedef struct {
    bool tried;
    Result opened;
} ServiceState;

static ServiceState psm_service, ts_service, nifm_service, time_service, set_service, setsys_service;
static AppletHookCookie hook;
static bool hooked;
static bool focus_kept;
static volatile bool resumed;

static void on_applet(AppletHookType type, void *param)
{
    (void)param;
    if (type == AppletHookType_OnResume)
        resumed = true;
}

static Result open_once(ServiceState *state, Result (*open)(void))
{
    if (!state->tried) {
        state->tried = true;
        state->opened = open();
    }
    return state->opened;
}

static Result open_nifm(void) { return nifmInitialize(NifmServiceType_User); }
static Result open_time(void) { return timeInitialize(); }
static Result open_set(void) { return setInitialize(); }
static Result open_setsys(void) { return setsysInitialize(); }

uint32_t moonlightSystemAppletType(void) { return (uint32_t)appletGetAppletType(); }

/* Asks for the resume message; its result is independent of the focus mode. */
uint32_t moonlightSystemWatchResume(void)
{
    if (!hooked) {
        appletHook(&hook, on_applet, NULL);
        hooked = true;
    }
    return appletSetRestartMessageEnabled(true);
}

/* Keeps the process running while the HOME menu or another applet has focus. */
uint32_t moonlightSystemKeepRunning(void)
{
    Result result = appletSetFocusHandlingMode(AppletFocusHandlingMode_NoSuspend);
    focus_kept = R_SUCCEEDED(result);
    return result;
}

uint32_t moonlightSystemFocusState(void) { return (uint32_t)appletGetFocusState(); }

bool moonlightSystemTakeResumed(void)
{
    bool value = resumed;
    resumed = false;
    return value;
}

uint32_t moonlightSystemMediaPlayback(bool playing) { return appletSetMediaPlaybackState(playing); }

uint32_t moonlightSystemAutoSleepDisabled(bool disabled)
{
    return appletSetAutoSleepDisabled(disabled);
}

uint32_t moonlightSystemBattery(uint32_t *percent, uint32_t *charger)
{
    Result result = open_once(&psm_service, psmInitialize);
    if (R_FAILED(result))
        return result;
    result = psmGetBatteryChargePercentage(percent);
    if (R_FAILED(result))
        return result;
    PsmChargerType type = PsmChargerType_Unconnected;
    result = psmGetChargerType(&type);
    *charger = (uint32_t)type;
    return result;
}

uint32_t moonlightSystemTemperature(int32_t *celsius)
{
    Result result = open_once(&ts_service, tsInitialize);
    if (R_FAILED(result))
        return result;
    result = tsGetTemperature(TsLocation_External, celsius);
    if (R_FAILED(result))
        result = tsGetTemperature(TsLocation_Internal, celsius);
    return result;
}

uint32_t moonlightSystemNetwork(uint32_t *type, uint32_t *bars, uint32_t *status)
{
    Result result = open_once(&nifm_service, open_nifm);
    if (R_FAILED(result))
        return result;
    NifmInternetConnectionType connection = 0;
    NifmInternetConnectionStatus state = 0;
    result = nifmGetInternetConnectionStatus(&connection, bars, &state);
    *type = (uint32_t)connection;
    *status = (uint32_t)state;
    return result;
}

uint32_t moonlightSystemSubnet(uint8_t address[4], uint8_t mask[4])
{
    Result result = open_once(&nifm_service, open_nifm);
    if (R_FAILED(result))
        return result;
    uint32_t current = 0, subnet = 0, gateway = 0, primary = 0, secondary = 0;
    result = nifmGetCurrentIpConfigInfo(&current, &subnet, &gateway, &primary, &secondary);
    memcpy(address, &current, 4);
    memcpy(mask, &subnet, 4);
    return result;
}

/* The console's local time of day. */
uint32_t moonlightSystemClock(uint32_t *hour, uint32_t *minute)
{
    Result result = open_once(&time_service, open_time);
    if (R_FAILED(result))
        return result;
    u64 now = 0;
    result = timeGetCurrentTime(TimeType_LocalSystemClock, &now);
    if (R_FAILED(result))
        return result;
    TimeCalendarTime calendar;
    TimeCalendarAdditionalInfo info;
    result = timeToCalendarTimeWithMyRule(now, &calendar, &info);
    if (R_FAILED(result))
        return result;
    *hour = calendar.hour;
    *minute = calendar.minute;
    return result;
}

/* The system colour set: 1 for dark, 0 for light. */
uint32_t moonlightSystemColorSet(uint32_t *dark)
{
    Result result = open_once(&setsys_service, open_setsys);
    if (R_FAILED(result))
        return result;
    ColorSetId id = ColorSetId_Dark;
    result = setsysGetColorSetId(&id);
    if (R_SUCCEEDED(result))
        *dark = id == ColorSetId_Dark;
    return result;
}

/* The system language as its LanguageCode, eight characters packed into a u64. */
uint32_t moonlightSystemLanguage(uint64_t *code)
{
    Result result = open_once(&set_service, open_set);
    if (R_FAILED(result))
        return result;
    return setGetSystemLanguage(code);
}

void moonlightSystemStop(void)
{
    if (hooked) {
        appletUnhook(&hook);
        hooked = false;
    }
    if (focus_kept) {
        appletSetFocusHandlingMode(AppletFocusHandlingMode_SuspendHomeSleep);
        focus_kept = false;
    }
    if (psm_service.tried && R_SUCCEEDED(psm_service.opened))
        psmExit();
    if (ts_service.tried && R_SUCCEEDED(ts_service.opened))
        tsExit();
    if (nifm_service.tried && R_SUCCEEDED(nifm_service.opened))
        nifmExit();
    if (time_service.tried && R_SUCCEEDED(time_service.opened))
        timeExit();
    if (set_service.tried && R_SUCCEEDED(set_service.opened))
        setExit();
    if (setsys_service.tried && R_SUCCEEDED(setsys_service.opened))
        setsysExit();
    psm_service = ts_service = nifm_service = (ServiceState){0};
    time_service = set_service = setsys_service = (ServiceState){0};
}
