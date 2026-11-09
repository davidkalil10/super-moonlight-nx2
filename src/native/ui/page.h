#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// The UI page format of src/streamer/ui/page-encode.js, which ui.glsl reads.
#define ML_PAGE_MAGIC 0x47504248u
#define ML_PAGE_HEADER_WORDS 16u
#define ML_PAGE_ROW_WORDS 8u
#define ML_PAGE_MAX_ITEMS 32u
#define ML_PAGE_MAX_TEXTS 48u
#define ML_PAGE_MAX_IMAGES 24u
#define ML_PAGE_ITEMS_OFFSET (ML_PAGE_HEADER_WORDS * 4u)
#define ML_PAGE_TEXTS_OFFSET (ML_PAGE_ITEMS_OFFSET + ML_PAGE_MAX_ITEMS * ML_PAGE_ROW_WORDS * 4u)
#define ML_PAGE_IMAGES_OFFSET (ML_PAGE_TEXTS_OFFSET + ML_PAGE_MAX_TEXTS * ML_PAGE_ROW_WORDS * 4u)
#define ML_PAGE_BODY_OFFSET 0x1000u
#define ML_PAGE_CHECKSUM_WORDS 10u
#define ML_PAGE_SCREEN_WIDTH 1920u
#define ML_PAGE_SCREEN_HEIGHT 1080u
#define ML_PAGE_MAX_TEXT_HEIGHT 96u
#define ML_PAGE_MAX_IMAGE_WIDTH 320u
#define ML_PAGE_MAX_IMAGE_HEIGHT 180u
#define ML_PAGE_FORMAT_RGBA8 1u
#define ML_PAGE_BLOCKS (ML_PAGE_MAX_TEXTS + ML_PAGE_MAX_IMAGES)

enum {
    ML_PAGE_FLAG_OVERLAY = 1,
    ML_PAGE_FLAG_HIDE_CURSOR = 2,
    ML_PAGE_FLAG_NO_CHORD = 4,
};

enum {
    ML_ITEM_FLAG_GREYED = 1,
    ML_ITEM_FLAG_CURRENT = 2,
    ML_ITEM_FLAG_ADJUSTABLE = 4,
    ML_ITEM_FLAG_PENDING = 8,
    ML_ITEM_FLAG_EDITING = 16,
};

typedef struct {
    uint32_t id;
    uint32_t x;
    uint32_t y;
    uint32_t w;
    uint32_t h;
    uint32_t flags;
} MoonlightPageItem;

typedef struct {
    uint32_t x;
    uint32_t y;
    uint32_t w;
    uint32_t h;
    const uint8_t *alpha;
    uint32_t color;
    uint32_t cursor_item;
    uint64_t identity;
} MoonlightPageText;

typedef struct {
    uint32_t x;
    uint32_t y;
    uint32_t w;
    uint32_t h;
    const uint8_t *rgba;
    uint64_t identity;
} MoonlightPageImage;

typedef struct {
    uint32_t epoch;
    uint32_t sequence;
    uint32_t flags;
    uint32_t background;
    uint32_t cursor_home;
    uint32_t item_count;
    uint32_t text_count;
    uint32_t image_count;
    MoonlightPageItem items[ML_PAGE_MAX_ITEMS];
    MoonlightPageText texts[ML_PAGE_MAX_TEXTS];
    MoonlightPageImage images[ML_PAGE_MAX_IMAGES];
} MoonlightPage;

typedef struct {
    uint32_t count;
    const uint8_t *block[ML_PAGE_BLOCKS];
    uint64_t identity[ML_PAGE_BLOCKS];
    uint32_t offset[ML_PAGE_BLOCKS];
    uint32_t length[ML_PAGE_BLOCKS];
    size_t bytes;
} MoonlightPagePlacement;

void moonlightPageInit(MoonlightPage *page);
const char *moonlightPageEncode(const MoonlightPage *page, const MoonlightPagePlacement *resident, uint8_t *out,
    size_t capacity, MoonlightPagePlacement *placed);
uint32_t moonlightPageChecksum(const uint8_t *page);
