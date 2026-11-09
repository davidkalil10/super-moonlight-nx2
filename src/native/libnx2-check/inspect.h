#pragma once

#include <stddef.h>
#include <stdint.h>

/* The only file that sees libnx2's headers; libnx2 and libounce types never share a unit. */

typedef struct {
    uint32_t read_result;
    uint64_t dynamic_offset;
    uint64_t bss_offset;
    uint64_t bss_size;
    uint32_t symbol_count;
    uint64_t init_address;
} CheckImageSummary;

void checkInspectImage(const void *image, size_t size, uintptr_t load_address,
    const char *const *names, size_t count, uintptr_t *addresses, uint32_t *results,
    CheckImageSummary *summary);
