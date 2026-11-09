#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t kind;
    uint32_t request_id;
    uint32_t payload_bytes;
} MoonlightRustControlHeader;

typedef enum {
    MOONLIGHT_RUST_OK = 0,
    MOONLIGHT_RUST_BAD_KIND = 1,
    MOONLIGHT_RUST_BAD_LENGTH = 2,
    MOONLIGHT_RUST_BAD_AUTH = 3,
    MOONLIGHT_RUST_BAD_MAGIC = 4,
    MOONLIGHT_RUST_BAD_VERSION = 5,
    MOONLIGHT_RUST_INVALID = 10,
    MOONLIGHT_RUST_NO_MEMORY = 11,
    MOONLIGHT_RUST_BAD_ALIGNMENT = 12,
} MoonlightRustResult;

uint32_t moonlightRustReadControlHeader(const uint8_t *bytes, size_t length, MoonlightRustControlHeader *out);
#ifdef MOONLIGHT_RUST_ALLOCATOR_PROOF
uint32_t moonlightRustCheckAllocation(uint32_t seed, uint64_t *out);
#endif
