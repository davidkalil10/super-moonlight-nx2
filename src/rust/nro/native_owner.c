#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define SDK_PRIVATE __attribute__((visibility("hidden")))

extern unsigned char moonlight_ouncevk_device[0x66590] SDK_PRIVATE;
bool moonlight_ouncevk_owner_lock(void *owner) SDK_PRIVATE;
void moonlight_ouncevk_owner_unlock(void *owner) SDK_PRIVATE;

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
    __asm__ volatile("mrs %0, tpidrro_el0" : "=r"(token));
    if (token == 0 || *(const volatile uintptr_t *)(block + 0x20) == token)
        return 3;
    if (!moonlight_ouncevk_owner_lock((void *)owner))
        return 4;
    callback(context);
    moonlight_ouncevk_owner_unlock((void *)owner);
    return 0;
}
