#include "sdk_backing.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#if defined(MOONLIGHT_BRIDGE_HOST_TEST)
uint32_t gsvReserveImageMemory(uint8_t type, uint64_t bytes, uint32_t *id);
uint32_t gsvRegisterImageMemory(uint32_t id, uint64_t cpu, uint64_t bytes,
                              uint32_t range, uint64_t offset);
uint32_t gsvReleaseImageMemory(uint32_t id);
#else
#include <switch.h>
#endif

#define SDK_PRIVATE __attribute__((visibility("hidden")))

extern unsigned char moonlight_ouncevk_device[0x66590] SDK_PRIVATE;
bool moonlight_ouncevk_owner_lock(void *owner) SDK_PRIVATE;
void moonlight_ouncevk_owner_unlock(void *owner) SDK_PRIVATE;
void moonlightPlatformLog(const uint8_t *message, size_t bytes);

MoonlightSdkBackingResult __real_moonlightSdkBackingQuery(
    const MoonlightSdkBackingRequest *request, MoonlightSdkBackingReport *report);

typedef struct ImageMemoryId {
    uint32_t value;
} ImageMemoryId;

static bool attempted;

static void record(const char *stage, uint32_t result, uint32_t id)
{
    char line[160];
    int bytes = snprintf(line, sizeof(line), "b1: %s result=0x%x image_memory_id=%u",
                         stage, result, id);
    if (bytes > 0 && (size_t)bytes < sizeof(line))
        moonlightPlatformLog((const uint8_t *)line, (size_t)bytes);
}

static MoonlightSdkBackingResult retain(MoonlightSdkBackingReport *report)
{
    if (report != NULL) {
        memset(&report->info, 0, sizeof(report->info));
        report->result = MOONLIGHT_SDK_BACKING_RETIRED;
    }
    record("RETAINED; no retry/free/clean-close claim", 3, 0);
    return MOONLIGHT_SDK_BACKING_RETIRED;
}

MoonlightSdkBackingResult __wrap_moonlightSdkBackingQuery(
    const MoonlightSdkBackingRequest *request, MoonlightSdkBackingReport *report)
{
    if (attempted)
        return retain(report);
    attempted = true;
    MoonlightSdkBackingResult status = __real_moonlightSdkBackingQuery(request, report);
    if (status != MOONLIGHT_SDK_BACKING_OK)
        return status;
    if (report == NULL || report->result != MOONLIGHT_SDK_BACKING_OK ||
        report->abi_version != MOONLIGHT_SDK_BACKING_ABI_VERSION ||
        report->info.abi_version != MOONLIGHT_SDK_BACKING_ABI_VERSION ||
        report->info.owner_verified != 1 || report->info.requested_size != 65536 ||
        report->info.memory_handle == 0 || report->info.cpu_address == 0)
        return retain(report);

    record("native-image extension active; no decoder or extra GPU/VM", 0, 0);
    if (!moonlight_ouncevk_owner_lock(moonlight_ouncevk_device)) {
        record("owner lock failed", 1, 0);
        return retain(report);
    }

    ImageMemoryId image = {0};
    uint32_t result = gsvReserveImageMemory(3, report->info.requested_size, &image.value);
    record("reserve type=3 bytes=65536", result, image.value);
    bool released = false;
    if (result == 0 && image.value != 0) {
        result = gsvRegisterImageMemory(image.value, report->info.cpu_address,
                                       report->info.requested_size, report->info.memory_handle,
                                       report->info.relative_offset);
        record("register existing range and relative offset", result, image.value);
        if (result == 0) {
            result = gsvReleaseImageMemory(image.value);
            record("release", result, image.value);
            released = result == 0;
        }
    }
    moonlight_ouncevk_owner_unlock(moonlight_ouncevk_device);
    if (!released)
        return retain(report);
    record("PASS; image-memory released before Vulkan free", 0, image.value);
    return status;
}
