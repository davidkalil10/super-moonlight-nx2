#include <string.h>

#include "scan.h"

#define MAX_REGIONS 4096u
#define MOD0_BYTES 28u
#define MOD0_MAGIC 0x30444f4du

static uint32_t get32(const uint8_t *at)
{
    return (uint32_t)at[0] | (uint32_t)at[1] << 8 | (uint32_t)at[2] << 16 | (uint32_t)at[3] << 24;
}

static bool query(const CheckMemory *memory, uint64_t address, CheckRegion *out)
{
    if (!memory->query(memory->user, address, out))
        return false;

    bool covers = out->address <= address && address - out->address < out->size;
    return out->size > 0 && covers;
}

static bool readable(const CheckMemory *memory, uint64_t start, uint64_t end)
{
    uint64_t address = start;
    for (unsigned i = 0; i < MAX_REGIONS && address < end; i++) {
        CheckRegion region;
        if (!query(memory, address, &region) || !(region.perm & CHECK_PERM_R))
            return false;

        uint64_t next = region.address + region.size;
        if (next <= address)
            return false;
        address = next;
    }
    return address >= end;
}

static bool read32(const CheckMemory *memory, uint64_t address, uint32_t *out)
{
    if (address > UINT64_MAX - 4 || !readable(memory, address, address + 4))
        return false;
    *out = get32(memory->view(memory->user, address));
    return true;
}

static void read_name(const CheckMemory *memory, const CheckRegion *text, CheckModule *module)
{
    strcpy(module->name, "?");

    uint64_t rodata = text->address + text->size;
    uint32_t zero = 1;
    uint32_t length = 0;
    if (!read32(memory, rodata, &zero) || !read32(memory, rodata + 4, &length))
        return;
    if (zero != 0 || length == 0 || length >= CHECK_NAME_MAX)
        return;
    if (!readable(memory, rodata + 8, rodata + 8 + length))
        return;

    const uint8_t *name = memory->view(memory->user, rodata + 8);
    for (uint32_t i = 0; i < length && name[i]; i++) {
        if (name[i] < 0x20 || name[i] > 0x7e)
            return;
    }
    memcpy(module->name, name, length);
    module->name[length] = '\0';
}

static bool inspect(const CheckMemory *memory, const CheckRegion *text, CheckModule *out)
{
    uint64_t base = text->address;
    uint32_t mod0_offset = 0;
    if (text->size < 8 || !read32(memory, base + 4, &mod0_offset))
        return false;
    if (mod0_offset % 4 || mod0_offset < 8)
        return false;

    uint64_t mod0 = base + mod0_offset;
    if (!readable(memory, mod0, mod0 + MOD0_BYTES))
        return false;
    const uint8_t *header = memory->view(memory->user, mod0);
    if (get32(header) != MOD0_MAGIC)
        return false;

    int32_t bss_end = (int32_t)get32(header + 12);
    int64_t end_offset = (int64_t)mod0_offset + bss_end;
    if (end_offset <= (int64_t)mod0_offset || !readable(memory, base, base + (uint64_t)end_offset))
        return false;

    memset(out, 0, sizeof(*out));
    out->base = base;
    out->span = (uint64_t)end_offset;
    out->mod0_offset = mod0_offset;
    out->text_type = text->type;
    read_name(memory, text, out);
    return true;
}

size_t checkFindModules(const CheckMemory *memory, CheckModule *out, size_t capacity)
{
    size_t found = 0;
    uint64_t address = 0;

    for (unsigned i = 0; i < MAX_REGIONS && found < capacity; i++) {
        CheckRegion region;
        if (!query(memory, address, &region))
            break;

        bool executable = (region.perm & (CHECK_PERM_R | CHECK_PERM_X)) == (CHECK_PERM_R | CHECK_PERM_X);
        if (executable && inspect(memory, &region, &out[found]))
            found++;

        uint64_t next = region.address + region.size;
        if (next <= address)
            break;
        address = next;
    }
    return found;
}
