#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "../ui.h"
#include "glyphs.h"
#include "page.h"

// The console UI pages of src/streamer/ui/page-composer.js: one layout per model screen.
typedef struct MoonlightComposer MoonlightComposer;

MoonlightComposer *moonlightComposerCreate(MoonlightGlyphs *glyphs, size_t cache_bytes);
void moonlightComposerDestroy(MoonlightComposer *composer);

const char *moonlightComposerPage(MoonlightComposer *composer, const MoonlightUiModel *model,
    const char *settings_error, MoonlightPage *page, bool *has_page);

const char *moonlightComposerRender(MoonlightComposer *composer, const MoonlightUiModel *model,
    const char *settings_error, uint32_t epoch, uint32_t sequence, const MoonlightPagePlacement *resident,
    uint8_t *out, size_t capacity, MoonlightPagePlacement *placed, bool *has_page);

size_t moonlightComposerCachedBytes(const MoonlightComposer *composer);
