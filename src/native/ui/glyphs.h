#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Text strips, button legends and letter tiles from the deflated glyph atlas fonts/glyphs.bin,
// byte for byte as src/streamer/ui/glyph-raster.js paints them (src/streamer/ui/CLAUDE.md, Text).
#define MOONLIGHT_GLYPHS_MAX_ATLAS (32u << 20)

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t channels;
    uint8_t *bytes;
} MoonlightBitmap;

typedef enum {
    MOONLIGHT_ALIGN_LEFT,
    MOONLIGHT_ALIGN_CENTER,
    MOONLIGHT_ALIGN_RIGHT,
} MoonlightAlign;

typedef struct {
    uint32_t weight;
    double tracking;
} MoonlightTextStyle;

typedef struct MoonlightGlyphs MoonlightGlyphs;

MoonlightGlyphs *moonlightGlyphsCreate(const uint8_t *atlas, size_t size);
void moonlightGlyphsDestroy(MoonlightGlyphs *glyphs);

bool moonlightGlyphsText(MoonlightGlyphs *glyphs, const char *utf8, uint32_t size, uint32_t width, MoonlightAlign align,
                         const MoonlightTextStyle *style, MoonlightBitmap *out);
bool moonlightGlyphsLegend(MoonlightGlyphs *glyphs, const char *const keys[][2], uint32_t count, uint32_t size,
                           uint32_t width, MoonlightBitmap *out);
bool moonlightGlyphsLetters(MoonlightGlyphs *glyphs, const char *utf8, uint32_t width, uint32_t height,
                            MoonlightBitmap *out);
bool moonlightGlyphsMeasure(MoonlightGlyphs *glyphs, const char *utf8, uint32_t size, const MoonlightTextStyle *style,
                            double *width);

void moonlightBitmapFree(MoonlightBitmap *bitmap);
