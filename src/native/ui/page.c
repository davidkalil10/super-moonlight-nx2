#include <string.h>

#include "page.h"

#define FNV_OFFSET_BASIS 2166136261u
#define FNV_PRIME 16777619u
#define NOT_PLACED UINT32_MAX

typedef struct {
    uint32_t start;
    uint32_t end;
} Range;

typedef struct {
    Range ranges[ML_PAGE_BLOCKS];
    uint32_t count;
} Used;

void moonlightPageInit(MoonlightPage *page)
{
    memset(page, 0, sizeof(*page));
    page->background = 0xff000000u;
}

static uint32_t padded(uint32_t length)
{
    return (length + 3u) & ~3u;
}

static bool in_screen(uint32_t x, uint32_t y, uint32_t w, uint32_t h)
{
    if (!w || !h)
        return false;
    return (uint64_t)x + w <= ML_PAGE_SCREEN_WIDTH && (uint64_t)y + h <= ML_PAGE_SCREEN_HEIGHT;
}

static bool text_fits(const MoonlightPageText *text)
{
    return in_screen(text->x, text->y, text->w, text->h) && text->h <= ML_PAGE_MAX_TEXT_HEIGHT;
}

static bool image_fits(const MoonlightPageImage *image)
{
    const bool small = image->w <= ML_PAGE_MAX_IMAGE_WIDTH && image->h <= ML_PAGE_MAX_IMAGE_HEIGHT;
    return in_screen(image->x, image->y, image->w, image->h) && small;
}

static uint32_t fnv(const uint8_t *bytes, uint32_t start, uint32_t end, uint32_t seed)
{
    uint32_t checksum = seed;
    for (uint32_t at = start; at < end; at += 4) {
        uint32_t word;
        memcpy(&word, bytes + at, sizeof(word));
        checksum = (checksum ^ word) * FNV_PRIME;
    }
    return checksum;
}

uint32_t moonlightPageChecksum(const uint8_t *page)
{
    const uint32_t header = fnv(page, 0, ML_PAGE_CHECKSUM_WORDS * 4u, FNV_OFFSET_BASIS);
    return fnv(page, ML_PAGE_ITEMS_OFFSET, ML_PAGE_BODY_OFFSET, header);
}

static bool item_has(const MoonlightPage *page, uint32_t id, uint32_t *index)
{
    for (uint32_t i = 0; i < page->item_count; i++) {
        if (page->items[i].id == id) {
            *index = i;
            return true;
        }
    }
    return false;
}

static const char *validate(const MoonlightPage *page)
{
    if (!page->epoch)
        return "UI page needs a nonzero epoch";
    if (!page->sequence)
        return "UI page needs a nonzero sequence";
    if (page->item_count > ML_PAGE_MAX_ITEMS)
        return "Too many UI items";
    if (page->text_count > ML_PAGE_MAX_TEXTS)
        return "Too many UI texts";
    if (page->image_count > ML_PAGE_MAX_IMAGES)
        return "Too many UI images";
    if (page->cursor_home >= (page->item_count > 1 ? page->item_count : 1))
        return "UI cursor home is not an item";

    for (uint32_t i = 0; i < page->text_count; i++) {
        const MoonlightPageText *text = &page->texts[i];
        uint32_t index = 0;
        if (!text_fits(text))
            return "UI text rect";
        if (!text->alpha)
            return "UI text strip bytes do not match its size";
        if (text->cursor_item && !item_has(page, text->cursor_item, &index))
            return "UI text follows an item the page lacks";
    }
    for (uint32_t i = 0; i < page->image_count; i++) {
        if (!image_fits(&page->images[i]))
            return "UI image rect";
        if (!page->images[i].rgba)
            return "UI image bytes do not match its size";
    }
    return NULL;
}

typedef struct {
    const uint8_t *block;
    uint64_t identity;
    uint32_t length;
} Block;

static uint64_t identity_of(const uint8_t *block, uint64_t identity)
{
    return identity ? identity : (uint64_t)(uintptr_t)block;
}

static uint32_t collect(const MoonlightPage *page, Block *blocks)
{
    uint32_t count = 0;
    for (uint32_t i = 0; i < page->text_count; i++)
        blocks[count++] = (Block){page->texts[i].alpha, identity_of(page->texts[i].alpha, page->texts[i].identity),
            page->texts[i].w * page->texts[i].h};
    for (uint32_t i = 0; i < page->image_count; i++)
        blocks[count++] = (Block){page->images[i].rgba, identity_of(page->images[i].rgba, page->images[i].identity),
            page->images[i].w * page->images[i].h * 4u};
    return count;
}

static uint32_t placed_offset(const MoonlightPagePlacement *placed, uint64_t identity)
{
    for (uint32_t i = 0; i < placed->count; i++) {
        if (placed->identity[i] == identity)
            return placed->offset[i];
    }
    return NOT_PLACED;
}

static bool overlaps(const Used *used, uint32_t start, uint32_t end)
{
    for (uint32_t i = 0; i < used->count; i++) {
        if (start < used->ranges[i].end && used->ranges[i].start < end)
            return true;
    }
    return false;
}

static void use(Used *used, uint32_t start, uint32_t end)
{
    uint32_t at = used->count++;
    while (at > 0 && used->ranges[at - 1].start > start) {
        used->ranges[at] = used->ranges[at - 1];
        at--;
    }
    used->ranges[at] = (Range){start, end};
}

static void add(MoonlightPagePlacement *placed, const Block *block, uint32_t offset)
{
    const uint32_t i = placed->count++;
    placed->block[i] = block->block;
    placed->identity[i] = block->identity;
    placed->offset[i] = offset;
    placed->length[i] = block->length;
}

static bool place(const Block *blocks, uint32_t count, const MoonlightPagePlacement *resident, size_t max_body,
    MoonlightPagePlacement *placed)
{
    Used used = {0};
    *placed = (MoonlightPagePlacement){0};
    for (uint32_t i = 0; resident && i < count; i++) {
        const uint32_t offset = placed_offset(resident, blocks[i].identity);
        if (offset == NOT_PLACED || placed_offset(placed, blocks[i].identity) != NOT_PLACED)
            continue;
        const uint32_t end = offset + padded(blocks[i].length);
        if (overlaps(&used, offset, end))
            continue;
        add(placed, &blocks[i], offset);
        use(&used, offset, end);
    }

    for (uint32_t i = 0; i < count; i++) {
        if (placed_offset(placed, blocks[i].identity) != NOT_PLACED)
            continue;
        const uint32_t length = padded(blocks[i].length);
        uint32_t offset = 0;
        for (uint32_t r = 0; r < used.count; r++) {
            if (offset + length <= used.ranges[r].start)
                break;
            if (used.ranges[r].end > offset)
                offset = used.ranges[r].end;
        }
        add(placed, &blocks[i], offset);
        use(&used, offset, offset + length);
    }

    uint32_t body = 0;
    for (uint32_t r = 0; r < used.count; r++) {
        if (used.ranges[r].end > body)
            body = used.ranges[r].end;
    }
    placed->bytes = ML_PAGE_BODY_OFFSET + (size_t)body;
    return body <= max_body;
}

static void put(uint8_t *out, uint32_t at, const uint32_t *values, uint32_t count)
{
    memcpy(out + at, values, count * sizeof(uint32_t));
}

static void write_tables(const MoonlightPage *page, const MoonlightPagePlacement *placed, uint8_t *out)
{
    for (uint32_t i = 0; i < page->item_count; i++) {
        const MoonlightPageItem *item = &page->items[i];
        const uint32_t row[6] = {item->id, item->x, item->y, item->w, item->h, item->flags};
        put(out, ML_PAGE_ITEMS_OFFSET + i * ML_PAGE_ROW_WORDS * 4u, row, 6);
    }
    for (uint32_t i = 0; i < page->text_count; i++) {
        const MoonlightPageText *text = &page->texts[i];
        uint32_t cursor = 0;
        if (text->cursor_item && item_has(page, text->cursor_item, &cursor))
            cursor++;
        const uint32_t offset = placed_offset(placed, identity_of(text->alpha, text->identity));
        const uint32_t row[7] = {text->x, text->y, text->w, text->h, offset, text->color, cursor};
        put(out, ML_PAGE_TEXTS_OFFSET + i * ML_PAGE_ROW_WORDS * 4u, row, 7);
    }
    for (uint32_t i = 0; i < page->image_count; i++) {
        const MoonlightPageImage *image = &page->images[i];
        const uint32_t offset = placed_offset(placed, identity_of(image->rgba, image->identity));
        const uint32_t row[6] = {image->x, image->y, image->w, image->h, offset, ML_PAGE_FORMAT_RGBA8};
        put(out, ML_PAGE_IMAGES_OFFSET + i * ML_PAGE_ROW_WORDS * 4u, row, 6);
    }
}

static bool item_ids_ok(const MoonlightPage *page)
{
    for (uint32_t i = 0; i < page->item_count; i++) {
        const MoonlightPageItem *item = &page->items[i];
        if (!item->id || !in_screen(item->x, item->y, item->w, item->h))
            return false;
    }
    return true;
}

const char *moonlightPageEncode(const MoonlightPage *page, const MoonlightPagePlacement *resident, uint8_t *out,
    size_t capacity, MoonlightPagePlacement *placed)
{
    const char *error = validate(page);
    if (error)
        return error;
    if (!item_ids_ok(page))
        return "UI item needs a nonzero id or is off screen";
    if (capacity < ML_PAGE_BODY_OFFSET)
        return "UI page body exceeds the page";

    Block blocks[ML_PAGE_BLOCKS];
    const uint32_t count = collect(page, blocks);
    const size_t max_body = capacity - ML_PAGE_BODY_OFFSET;
    const bool over = resident && place(blocks, count, resident, max_body, placed);
    if (!over && !place(blocks, count, NULL, max_body, placed))
        return "UI page body exceeds the page";

    const size_t kept = over ? resident->bytes : ML_PAGE_BODY_OFFSET;
    memset(out, 0, ML_PAGE_BODY_OFFSET);
    if (placed->bytes > kept)
        memset(out + kept, 0, placed->bytes - kept);
    for (uint32_t i = 0; i < placed->count; i++)
        memcpy(out + ML_PAGE_BODY_OFFSET + placed->offset[i], placed->block[i], placed->length[i]);
    write_tables(page, placed, out);

    uint32_t body = (uint32_t)(placed->bytes - ML_PAGE_BODY_OFFSET);
    const uint32_t header[10] = {ML_PAGE_MAGIC, page->epoch, page->sequence, page->flags, page->item_count,
        page->text_count, page->image_count, body, page->background, page->cursor_home};
    put(out, 0, header, 10);
    const uint32_t sum = moonlightPageChecksum(out);
    put(out, ML_PAGE_CHECKSUM_WORDS * 4u, &sum, 1);
    return NULL;
}
