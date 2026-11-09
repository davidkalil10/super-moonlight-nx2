#pragma once

#include <stdint.h>

// One code point upper-cased as String.prototype.toUpperCase does it: up to three code points.
#define MOONLIGHT_UPPERCASE_MAX 3u

uint32_t moonlightUppercase(uint32_t code, uint32_t upper[MOONLIGHT_UPPERCASE_MAX]);
