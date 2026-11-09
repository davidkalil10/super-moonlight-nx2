#pragma once

#include <stdbool.h>

#include "../codec.h"

/*
 * Known-frame probe: decodes DIRECTORY/blue.av1 (1280x720 AV1 Main8), compares it with
 * DIRECTORY/blue.nv12 and writes the service's image descriptor and raw surface beside them.
 */
bool moonlightCodecProbe(const char *directory, MoonlightDecoderLog log);
bool moonlightCodecProbeRetained(void);
