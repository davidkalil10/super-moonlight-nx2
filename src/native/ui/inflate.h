#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// A bounded zlib stream (RFC 1950 around RFC 1951) inflated into one malloc'd buffer.
bool moonlightInflate(const uint8_t *input, size_t size, size_t limit, uint8_t **output, size_t *output_size);
