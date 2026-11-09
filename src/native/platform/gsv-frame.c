#include <switch.h>

#include "gsv-frame.h"

/* Every reference to gsvRegisterFrame (OunceVK, libounce cpuwin, the codec) reaches
 * __wrap_gsvRegisterFrame. The service is asked once; later calls get that answer or a refusal. */

Result __real_gsvRegisterFrame(u64 mode, u64 *out_permitted_mode);
Result __wrap_gsvRegisterFrame(u64 mode, u64 *out_permitted_mode);

#define CONFLICTING_MODE MAKERESULT(Module_Libnx, LibnxError_BadInput)

static Mutex g_lock;
static MoonlightGsvFrameStatus g_status;

static Result forward(u64 mode, u64 *out_permitted_mode)
{
    u64 permitted = 0;
    Result result = __real_gsvRegisterFrame(mode, &permitted);

    g_status.forwarded++;
    g_status.requested_mode = mode;
    g_status.result = result;

    if (R_FAILED(result)) {
        g_status.state = MOONLIGHT_GSV_FRAME_FAILED;
        return result;
    }

    g_status.state = MOONLIGHT_GSV_FRAME_REGISTERED;
    g_status.permitted_mode = permitted;
    if (out_permitted_mode)
        *out_permitted_mode = permitted;
    return result;
}

static Result answer(u64 mode, u64 *out_permitted_mode)
{
    if (g_status.state == MOONLIGHT_GSV_FRAME_FAILED) {
        g_status.refused++;
        return g_status.result;
    }

    if (mode != g_status.requested_mode) {
        g_status.refused++;
        return CONFLICTING_MODE;
    }

    g_status.answered_from_cache++;
    if (out_permitted_mode)
        *out_permitted_mode = g_status.permitted_mode;
    return 0;
}

Result __wrap_gsvRegisterFrame(u64 mode, u64 *out_permitted_mode)
{
    mutexLock(&g_lock);

    Result result;
    if (g_status.state == MOONLIGHT_GSV_FRAME_UNREGISTERED)
        result = forward(mode, out_permitted_mode);
    else
        result = answer(mode, out_permitted_mode);

    mutexUnlock(&g_lock);
    return result;
}

void moonlightGsvFrameGetStatus(MoonlightGsvFrameStatus *out)
{
    mutexLock(&g_lock);
    *out = g_status;
    mutexUnlock(&g_lock);
}

bool moonlightGsvFrameGetPermittedMode(uint64_t *out_mode)
{
    MoonlightGsvFrameStatus status;
    moonlightGsvFrameGetStatus(&status);

    if (status.state != MOONLIGHT_GSV_FRAME_REGISTERED)
        return false;

    *out_mode = status.permitted_mode;
    return true;
}
