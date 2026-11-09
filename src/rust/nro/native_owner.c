#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define SDK_PRIVATE __attribute__((visibility("hidden")))

extern unsigned char moonlight_ouncevk_device[0x66590] SDK_PRIVATE;
bool moonlight_ouncevk_owner_lock(void *owner) SDK_PRIVATE;
void moonlight_ouncevk_owner_unlock(void *owner) SDK_PRIVATE;

void *moonlightNativeOwnerSync(void)
{
    uintptr_t owner = (uintptr_t)moonlight_ouncevk_device;
    uintptr_t self, runtime, runtime_self;
    uint32_t stage, failed, session;
    memcpy(&self, (const void *)owner, sizeof(self));
    memcpy(&runtime, (const void *)(owner + 8), sizeof(runtime));
    if (self != owner || runtime == 0)
        return NULL;
    memcpy(&runtime_self, (const void *)runtime, sizeof(runtime_self));
    memcpy(&stage, (const void *)(runtime + 0x18), sizeof(stage));
    memcpy(&failed, (const void *)(runtime + 0x1c), sizeof(failed));
    memcpy(&session, (const void *)(runtime + 0x418), sizeof(session));
    if (runtime_self != runtime || stage != 12 || failed != 0 ||
        (*(const uint8_t *)(runtime + 0x414) & 1) == 0 || session == 0)
        return NULL;
    return (void *)(runtime + 0x418);
}

uint32_t moonlightNativeOwnerCall(void (*callback)(void *), void *context)
{
    if (callback == NULL || context == NULL)
        return 1;
    uintptr_t owner = (uintptr_t)moonlight_ouncevk_device;
    uintptr_t self, block, token;
    memcpy(&self, (const void *)owner, sizeof(self));
    memcpy(&block, (const void *)(owner + 0x663b8), sizeof(block));
    if (self != owner || block == 0 || (moonlight_ouncevk_device[0x663c0] & 1) == 0)
        return 2;
#ifdef MOONLIGHT_OWNER_HOST_TEST
    extern uintptr_t moonlightTestThreadToken(void);
    token = moonlightTestThreadToken();
#else
    __asm__ volatile("mrs %0, tpidrro_el0" : "=r"(token));
#endif
    if (token == 0 || *(const volatile uintptr_t *)(block + 0x20) == token)
        return 3;
    if (!moonlight_ouncevk_owner_lock((void *)owner))
        return 4;
    callback(context);
    moonlight_ouncevk_owner_unlock((void *)owner);
    return 0;
}
