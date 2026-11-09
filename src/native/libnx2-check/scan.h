#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Finds MOD0 modules in the current process's memory map. Portable; the caller supplies the map. */

#define CHECK_PERM_R 1u
#define CHECK_PERM_W 2u
#define CHECK_PERM_X 4u
#define CHECK_NAME_MAX 96u

typedef struct {
    uint64_t address;
    uint64_t size;
    uint32_t type;
    uint32_t perm;
} CheckRegion;

typedef bool (*CheckQuery)(void *user, uint64_t address, CheckRegion *out);

typedef struct {
    uint64_t base;
    uint64_t span;
    uint32_t mod0_offset;
    uint32_t text_type;
    char name[CHECK_NAME_MAX];
} CheckModule;

typedef struct {
    CheckQuery query;
    void *user;
    const uint8_t *(*view)(void *user, uint64_t address);
} CheckMemory;

size_t checkFindModules(const CheckMemory *memory, CheckModule *out, size_t capacity);
