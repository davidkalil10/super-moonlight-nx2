#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "composer.h"

#if defined(__clang__)
#pragma STDC FP_CONTRACT OFF
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

#define COLOR_INK 0xfff9fafau
#define COLOR_SOFT 0xffd1d3d6u
#define COLOR_MUTED 0xff9ea2a8u
#define COLOR_GREY 0xff6c7178u
#define COLOR_ACCENT 0xfff8bd38u
#define COLOR_RUNNING 0xffacef86u
#define COLOR_CARD 0xff242529u
#define COLOR_DIM 0xff1d1f23u
#define COLOR_BACKGROUND 0xff17191cu
#define COLOR_CLEAR 0x00000000u

#define SCREEN_WIDTH 1920
#define SIDE 96
#define CONTENT_WIDTH (SCREEN_WIDTH - 2 * SIDE)
#define COVER_WIDTH 240
#define COVER_HEIGHT 135
#define GRID_Y 380
#define GRID_COLUMNS 5
#define GRID_GAP 48
#define GRID_NAME 16
#define GRID_ROW (135 + 16 + 34 + 24)
#define CHIP_Y 64
#define CHIP_HEIGHT 54
#define CHIP_PAD 10
#define CHIP_SIZE 26
#define LEGEND_Y 984
#define LEGEND_SIZE 26
#define LEGEND_HEIGHT 40
#define LEGEND_WIDTH 1200
#define CARD_Y 300
#define CARD_WIDTH 840
#define CARD_HEIGHT 96
#define CARD_GAP_X 48
#define CARD_GAP_Y 32
#define CARD_PAD 32
#define HOST_CARDS_Y 430
#define SETTING_GRID_Y 180
#define SETTING_GRID_GAP_Y 24
#define KEYPAD_Y 430
#define KEYPAD_WIDTH 160
#define KEYPAD_GAP 24
#define LABEL_SIZE 22
#define HEADING_Y 200
#define HEADING_STATUS 340
#define HEADING_KICKER 24
#define HEADING_SIZE 72
#define BUTTON_Y 640
#define BUTTON_WIDTH 400
#define BUTTON_GAP 48
#define PAGER_WIDTH 300
#define RUNNING_WIDTH 112
#define RUNNING_HEIGHT 30
#define NOTE_WIDTH 700
#define OVERLAY_BUTTON 520
#define STRIP_HEIGHT 96
#define KEY_BYTES 512

typedef struct {
    char *key;
    MoonlightBitmap bitmap;
    uint32_t left;
    uint32_t top;
    size_t bytes;
    uint64_t used;
    uint64_t serial;
} Entry;

struct MoonlightComposer {
    MoonlightGlyphs *glyphs;
    size_t budget;
    size_t bytes;
    Entry *entries;
    uint32_t count;
    uint32_t capacity;
    uint64_t clock;
    uint64_t serial;
    MoonlightBitmap *graveyard;
    uint32_t buried;
    uint32_t graveyard_capacity;
};

typedef struct {
    MoonlightComposer *composer;
    MoonlightPage *page;
    const char *error;
} Builder;

typedef struct {
    const char *label;
    uint32_t color;
    uint32_t width;
} Chip;

typedef struct {
    const Chip *chips;
    uint32_t chip_count;
    const char *note;
    const char *const (*keys)[2];
    uint32_t key_count;
    const char *footer;
    uint32_t background;
    uint32_t cursor_home;
    uint32_t flags;
} Frame;

typedef struct {
    uint32_t y;
    uint32_t size;
    uint32_t color;
    double tracking;
} HeadingStyle;

static const char *const KEY_LABELS[] = {"1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "Erase"};

MoonlightComposer *moonlightComposerCreate(MoonlightGlyphs *glyphs, size_t cache_bytes)
{
    MoonlightComposer *composer = calloc(1, sizeof(*composer));
    if (!composer)
        return NULL;

    composer->glyphs = glyphs;
    composer->budget = cache_bytes ? cache_bytes : 8u * 1024u * 1024u;
    return composer;
}

static void bury(MoonlightComposer *composer, MoonlightBitmap *bitmap)
{
    if (composer->buried == composer->graveyard_capacity) {
        const uint32_t capacity = composer->graveyard_capacity ? composer->graveyard_capacity * 2 : 32;
        MoonlightBitmap *grown = realloc(composer->graveyard, capacity * sizeof(*grown));
        if (!grown) {
            moonlightBitmapFree(bitmap);
            return;
        }
        composer->graveyard = grown;
        composer->graveyard_capacity = capacity;
    }
    composer->graveyard[composer->buried++] = *bitmap;
}

static void empty_graveyard(MoonlightComposer *composer)
{
    while (composer->buried)
        moonlightBitmapFree(&composer->graveyard[--composer->buried]);
}

static void drop(MoonlightComposer *composer, uint32_t index, bool now)
{
    Entry *entry = &composer->entries[index];
    composer->bytes -= entry->bytes;
    free(entry->key);
    if (now)
        moonlightBitmapFree(&entry->bitmap);
    else
        bury(composer, &entry->bitmap);
    composer->entries[index] = composer->entries[--composer->count];
}

void moonlightComposerDestroy(MoonlightComposer *composer)
{
    if (!composer)
        return;

    while (composer->count)
        drop(composer, composer->count - 1, true);
    empty_graveyard(composer);
    free(composer->graveyard);
    free(composer->entries);
    free(composer);
}

size_t moonlightComposerCachedBytes(const MoonlightComposer *composer)
{
    return composer->bytes;
}

static void evict(MoonlightComposer *composer)
{
    while (composer->bytes > composer->budget && composer->count > 1) {
        uint32_t oldest = 0;
        for (uint32_t i = 1; i < composer->count; i++) {
            if (composer->entries[i].used < composer->entries[oldest].used)
                oldest = i;
        }
        drop(composer, oldest, false);
    }
}

static Entry *find_serial(MoonlightComposer *composer, uint64_t serial)
{
    for (uint32_t i = 0; i < composer->count; i++) {
        if (composer->entries[i].serial == serial)
            return &composer->entries[i];
    }
    return NULL;
}

static Entry *lookup(MoonlightComposer *composer, const char *key)
{
    for (uint32_t i = 0; i < composer->count; i++) {
        if (!strcmp(composer->entries[i].key, key)) {
            composer->entries[i].used = ++composer->clock;
            return &composer->entries[i];
        }
    }
    return NULL;
}

static Entry *store_sized(MoonlightComposer *composer, const char *key, MoonlightBitmap bitmap, uint32_t left,
    uint32_t top, size_t bytes)
{
    if (composer->count == composer->capacity) {
        const uint32_t capacity = composer->capacity ? composer->capacity * 2 : 64;
        Entry *grown = realloc(composer->entries, capacity * sizeof(*grown));
        if (!grown)
            return NULL;
        composer->entries = grown;
        composer->capacity = capacity;
    }

    char *copy = malloc(strlen(key) + 1);
    if (!copy)
        return NULL;
    strcpy(copy, key);

    Entry *entry = &composer->entries[composer->count++];
    const uint64_t serial = ++composer->serial;
    *entry = (Entry){copy, bitmap, left, top, bytes, ++composer->clock, serial};
    composer->bytes += bytes;
    evict(composer);
    return find_serial(composer, serial);
}

static Entry *store(MoonlightComposer *composer, const char *key, MoonlightBitmap bitmap, uint32_t left, uint32_t top)
{
    return store_sized(composer, key, bitmap, left, top, (size_t)bitmap.width * bitmap.height);
}

static bool inked(const MoonlightBitmap *bitmap, int32_t column)
{
    for (uint32_t row = 0; row < bitmap->height; row++) {
        if (bitmap->bytes[row * bitmap->width + (uint32_t)column])
            return true;
    }
    return false;
}

static void ink_run(const MoonlightBitmap *bitmap, int32_t from, int32_t step, int32_t *first, int32_t *last)
{
    int32_t column = from;
    const int32_t width = (int32_t)bitmap->width;
    while (column >= 0 && column < width && !inked(bitmap, column))
        column += step;

    *first = column;
    *last = column - step;
    while (column >= 0 && column < width && inked(bitmap, column)) {
        *last = column;
        column += step;
    }
}

static void clear_run(MoonlightBitmap *bitmap, int32_t from, int32_t step)
{
    int32_t first = 0;
    int32_t last = 0;
    ink_run(bitmap, from, step, &first, &last);
    for (int32_t column = first; column != last + step; column += step) {
        if (column < 0 || column >= (int32_t)bitmap->width)
            break;
        for (uint32_t row = 0; row < bitmap->height; row++)
            bitmap->bytes[row * bitmap->width + (uint32_t)column] = 0;
    }
}

static bool trim(MoonlightBitmap *bitmap, uint32_t *left_out, uint32_t *top_out)
{
    const uint32_t width = bitmap->width;
    const uint32_t height = bitmap->height;
    int64_t top = height;
    int64_t bottom = -1;
    int64_t left = width;
    int64_t right = -1;
    for (uint32_t row = 0; row < height; row++) {
        for (uint32_t column = 0; column < width; column++) {
            if (!bitmap->bytes[row * width + column])
                continue;
            if (row < top) top = row;
            if (row > bottom) bottom = row;
            if (column < left) left = column;
            if (column > right) right = column;
        }
    }

    MoonlightBitmap cut = {0};
    if (bottom < 0) {
        cut = (MoonlightBitmap){.width = 1, .height = 1, .channels = 1, .bytes = calloc(1, 1)};
        *left_out = 0;
        *top_out = 0;
    } else {
        top = top > 0 ? top - 1 : 0;
        left = left > 0 ? left - 1 : 0;
        const int64_t cut_right = right + 1 < width - 1 ? right + 1 : width - 1;
        const int64_t cut_bottom = bottom + 1 < height - 1 ? bottom + 1 : height - 1;
        cut.width = (uint32_t)(cut_right - left + 1);
        cut.height = (uint32_t)(cut_bottom - top + 1);
        cut.channels = 1;
        cut.bytes = malloc((size_t)cut.width * cut.height);
        for (uint32_t row = 0; cut.bytes && row < cut.height; row++)
            memcpy(cut.bytes + row * cut.width, bitmap->bytes + ((uint32_t)top + row) * width + (uint32_t)left, cut.width);
        *left_out = (uint32_t)left;
        *top_out = (uint32_t)top;
    }

    moonlightBitmapFree(bitmap);
    if (!cut.bytes)
        return false;
    *bitmap = cut;
    return true;
}

static void add_text(Builder *b, uint32_t x, uint32_t y, uint32_t color, const Entry *entry, uint32_t cursor_item)
{
    MoonlightPage *page = b->page;
    if (!entry) {
        b->error = b->error ? b->error : "UI strip could not be painted";
        return;
    }
    if (page->text_count >= ML_PAGE_MAX_TEXTS) {
        b->error = "UI page over the item or text limit";
        return;
    }

    page->texts[page->text_count++] = (MoonlightPageText){
        .x = x + entry->left,
        .y = y + entry->top,
        .w = entry->bitmap.width,
        .h = entry->bitmap.height,
        .alpha = entry->bitmap.bytes,
        .color = color,
        .cursor_item = cursor_item,
        .identity = entry->serial,
    };
}

static const Entry *painted_text(Builder *b, const char *label, uint32_t size, uint32_t width, MoonlightAlign align,
    uint32_t weight, double tracking)
{
    char key[KEY_BYTES];
    snprintf(key, sizeof(key), "t\x1f%s\x1f%u\x1f%u\x1f%d\x1f%u\x1f%.17g", label, size, width, align, weight, tracking);
    const Entry *cached = lookup(b->composer, key);
    if (cached)
        return cached;

    const MoonlightTextStyle style = {weight, tracking};
    MoonlightBitmap bitmap = {0};
    uint32_t left = 0;
    uint32_t top = 0;
    if (!moonlightGlyphsText(b->composer->glyphs, label, size, width, align, &style, &bitmap))
        return NULL;
    if (!trim(&bitmap, &left, &top))
        return NULL;
    return store(b->composer, key, bitmap, left, top);
}

static void text(Builder *b, uint32_t x, uint32_t y, const char *label, uint32_t size, uint32_t width, uint32_t color,
    MoonlightAlign align, uint32_t weight, double tracking, uint32_t cursor_item)
{
    add_text(b, x, y, color, painted_text(b, label, size, width, align, weight, tracking), cursor_item);
}

static void plain(Builder *b, uint32_t x, uint32_t y, const char *label, uint32_t size, uint32_t width, uint32_t color,
    MoonlightAlign align)
{
    text(b, x, y, label, size, width, color, align, 600, 0, 0);
}

static void stepper(Builder *b, uint32_t x, uint32_t y, const char *value, uint32_t size, uint32_t width,
    bool can_left, bool can_right)
{
    char key[KEY_BYTES];
    snprintf(key, sizeof(key), "v\x1f%s\x1f%u\x1f%u\x1f%d\x1f%d", value, size, width, can_left, can_right);
    const Entry *entry = lookup(b->composer, key);
    if (!entry) {
        char label[MOONLIGHT_SETTING_TEXT_BYTES + 16];
        snprintf(label, sizeof(label), "\xe2\x80\xb9   %s   \xe2\x80\xba", value);
        const MoonlightTextStyle style = {700, 0};
        MoonlightBitmap bitmap = {0};
        uint32_t left = 0;
        uint32_t top = 0;
        bool ok = moonlightGlyphsText(b->composer->glyphs, label, size, width, MOONLIGHT_ALIGN_CENTER, &style, &bitmap);
        if (ok && !can_left)
            clear_run(&bitmap, 0, 1);
        if (ok && !can_right)
            clear_run(&bitmap, (int32_t)bitmap.width - 1, -1);
        ok = ok && trim(&bitmap, &left, &top);
        entry = ok ? store(b->composer, key, bitmap, left, top) : NULL;
    }
    add_text(b, x, y, COLOR_INK, entry, 0);
}

static void solid(Builder *b, uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t color)
{
    char key[64];
    snprintf(key, sizeof(key), "s\x1f%u\x1f%u", w, h);
    const Entry *entry = lookup(b->composer, key);
    if (!entry) {
        MoonlightBitmap fill = {.width = w, .height = h, .channels = 1, .bytes = malloc((size_t)w * h)};
        if (fill.bytes) {
            memset(fill.bytes, 255, (size_t)w * h);
            entry = store(b->composer, key, fill, 0, 0);
        }
    }
    add_text(b, x, y, color, entry, 0);
}

static void legend_key(char *key, size_t size, const char *prefix, const char *const (*keys)[2], uint32_t count)
{
    size_t used = (size_t)snprintf(key, size, "%s", prefix);
    for (uint32_t i = 0; i < count && used < size; i++)
        used += (size_t)snprintf(key + used, size - used, "\x1f%s\x1e%s", keys[i][0], keys[i][1]);
}

static void legend(Builder *b, uint32_t x, uint32_t y, const char *const (*keys)[2], uint32_t count)
{
    char key[KEY_BYTES];
    legend_key(key, sizeof(key), "l", keys, count);
    const Entry *entry = lookup(b->composer, key);
    if (!entry) {
        MoonlightBitmap bitmap = {0};
        uint32_t left = 0;
        uint32_t top = 0;
        const bool ok = moonlightGlyphsLegend(b->composer->glyphs, keys, count, LEGEND_SIZE, LEGEND_WIDTH, &bitmap) &&
                        trim(&bitmap, &left, &top);
        entry = ok ? store(b->composer, key, bitmap, left, top) : NULL;
    }
    add_text(b, x, y, COLOR_SOFT, entry, 0);
}

static bool tail_bitmap(MoonlightGlyphs *glyphs, const char *const (*head)[2], uint32_t head_count,
    const char *const (*tail)[2], uint32_t tail_count, MoonlightBitmap *out, uint32_t *left, uint32_t *top)
{
    const char *all[8][2];
    for (uint32_t i = 0; i < head_count; i++) {
        all[i][0] = head[i][0];
        all[i][1] = head[i][1];
    }
    for (uint32_t i = 0; i < tail_count; i++) {
        all[head_count + i][0] = tail[i][0];
        all[head_count + i][1] = tail[i][1];
    }

    MoonlightBitmap whole = {0};
    MoonlightBitmap first = {0};
    bool ok = moonlightGlyphsLegend(glyphs, (const char *const (*)[2])all, head_count + tail_count, LEGEND_SIZE,
        LEGEND_WIDTH, &whole);
    ok = ok && moonlightGlyphsLegend(glyphs, head, head_count, LEGEND_SIZE, LEGEND_WIDTH, &first);
    int32_t run_first = 0;
    int32_t run_last = 0;
    if (ok)
        ink_run(&first, (int32_t)first.width - 1, -1, &run_first, &run_last);
    moonlightBitmapFree(&first);
    if (!ok || run_first < 0) {
        moonlightBitmapFree(&whole);
        return false;
    }

    const uint32_t from = (uint32_t)run_first + 1;
    MoonlightBitmap cut = {.width = whole.width - from, .height = whole.height, .channels = 1,
        .bytes = malloc((size_t)(whole.width - from) * whole.height)};
    for (uint32_t row = 0; cut.bytes && row < whole.height; row++)
        memcpy(cut.bytes + row * cut.width, whole.bytes + row * whole.width + from, cut.width);
    moonlightBitmapFree(&whole);
    if (!cut.bytes || !trim(&cut, left, top))
        return false;
    *left += from;
    *out = cut;
    return true;
}

static void legend_tail(Builder *b, uint32_t x, uint32_t y, const char *const (*head)[2], uint32_t head_count,
    const char *const (*tail)[2], uint32_t tail_count, uint32_t cursor_item)
{
    char key[KEY_BYTES];
    char tail_key[KEY_BYTES];
    legend_key(key, sizeof(key), "lt", head, head_count);
    legend_key(tail_key, sizeof(tail_key), "\x1d", tail, tail_count);
    strncat(key, tail_key, sizeof(key) - strlen(key) - 1);
    const Entry *entry = lookup(b->composer, key);
    if (!entry) {
        MoonlightBitmap bitmap = {0};
        uint32_t left = 0;
        uint32_t top = 0;
        if (tail_bitmap(b->composer->glyphs, head, head_count, tail, tail_count, &bitmap, &left, &top))
            entry = store(b->composer, key, bitmap, left, top);
    }
    add_text(b, x, y, COLOR_SOFT, entry, cursor_item);
}

static void item(Builder *b, uint32_t id, uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t flags)
{
    MoonlightPage *page = b->page;
    if (page->item_count >= ML_PAGE_MAX_ITEMS) {
        b->error = "UI page over the item or text limit";
        return;
    }
    page->items[page->item_count++] = (MoonlightPageItem){id, x, y, w, h, flags};
}

static void image(Builder *b, uint32_t x, uint32_t y, const Entry *tile)
{
    MoonlightPage *page = b->page;
    if (page->image_count >= ML_PAGE_MAX_IMAGES) {
        b->error = "UI page over the image limit";
        return;
    }
    page->images[page->image_count++] = (MoonlightPageImage){
        .x = x,
        .y = y,
        .w = tile->bitmap.width,
        .h = tile->bitmap.height,
        .rgba = tile->bitmap.bytes,
        .identity = tile->serial,
    };
}

static bool filled(const char *text)
{
    return text && text[0];
}

static void horizon(Builder *b, const Frame *frame)
{
    MoonlightPage *page = b->page;
    page->background = frame->background;
    page->cursor_home = frame->cursor_home;
    page->flags = frame->flags;

    uint32_t x = SIDE;
    for (uint32_t i = 0; i < frame->chip_count; i++) {
        const Chip *chip = &frame->chips[i];
        if (!filled(chip->label))
            continue;
        solid(b, x, CHIP_Y, chip->width, CHIP_HEIGHT, COLOR_CARD);
        plain(b, x, CHIP_Y + CHIP_PAD, chip->label, CHIP_SIZE, chip->width, chip->color, MOONLIGHT_ALIGN_CENTER);
        x += chip->width + 16;
    }

    const uint32_t note_x = SCREEN_WIDTH - SIDE - NOTE_WIDTH;
    if (filled(frame->note))
        plain(b, note_x, CHIP_Y + CHIP_PAD, frame->note, 26, NOTE_WIDTH, COLOR_MUTED, MOONLIGHT_ALIGN_RIGHT);
    if (frame->key_count)
        legend(b, SIDE, LEGEND_Y, frame->keys, frame->key_count);
    if (filled(frame->footer))
        text(b, note_x, LEGEND_Y + 5, frame->footer, 24, NOTE_WIDTH, COLOR_GREY, MOONLIGHT_ALIGN_RIGHT, 500, 0, 0);
}

static const char *host_name(const MoonlightUiModel *model)
{
    return model->has_host ? model->host.name : NULL;
}

static uint32_t host_chips(const MoonlightUiModel *model, Chip chips[2])
{
    chips[0] = (Chip){host_name(model), COLOR_INK, 300};
    chips[1] = (Chip){model->has_host ? model->host.address : NULL, COLOR_MUTED, 300};
    return 2;
}

static void upper(const char *text, char *out, size_t size)
{
    size_t i = 0;
    for (; text[i] && i + 1 < size; i++)
        out[i] = (char)toupper((unsigned char)text[i]);
    out[i] = 0;
}

static HeadingStyle heading_style(uint32_t y)
{
    return (HeadingStyle){y, HEADING_SIZE, COLOR_INK, 0};
}

static void heading(Builder *b, const char *kicker, const char *title, const char *line, const HeadingStyle *style)
{
    char upper_kicker[MOONLIGHT_UI_MESSAGE_BYTES];
    upper(kicker, upper_kicker, sizeof(upper_kicker));
    text(b, SIDE, style->y, upper_kicker, HEADING_KICKER, CONTENT_WIDTH, COLOR_ACCENT, MOONLIGHT_ALIGN_LEFT, 600,
        HEADING_KICKER * 0.1, 0);
    text(b, SIDE, style->y + 44, title, style->size, CONTENT_WIDTH, style->color, MOONLIGHT_ALIGN_LEFT, 700,
        style->tracking, 0);
    if (filled(line))
        text(b, SIDE, style->y + 148, line, 28, CONTENT_WIDTH, COLOR_MUTED, MOONLIGHT_ALIGN_LEFT, 500, 0, 0);
}

static void panel(Builder *b, uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t color)
{
    for (uint32_t top = 0; top < h; top += STRIP_HEIGHT)
        solid(b, x, y + top, w, h - top < STRIP_HEIGHT ? h - top : STRIP_HEIGHT, color);
}

static void button(Builder *b, uint32_t id, uint32_t x, uint32_t y, uint32_t width, const char *label, bool greyed)
{
    item(b, id, x, y, width, CARD_HEIGHT, greyed ? ML_ITEM_FLAG_GREYED : 0);
    solid(b, x, y, width, CARD_HEIGHT, greyed ? COLOR_DIM : COLOR_CARD);
    text(b, x, y + 28, label, 32, width, greyed ? COLOR_GREY : COLOR_INK, MOONLIGHT_ALIGN_CENTER, 700, 0, 0);
}

static void pager(Builder *b, uint32_t y, uint32_t at, uint32_t pages)
{
    const uint32_t x = SCREEN_WIDTH - SIDE - 2 * PAGER_WIDTH - BUTTON_GAP;
    const uint32_t next_x = x + PAGER_WIDTH + BUTTON_GAP;
    button(b, MOONLIGHT_ITEM_PREVIOUS, x, y, PAGER_WIDTH, "\xe2\x80\xb9  Previous", at == 0);
    button(b, MOONLIGHT_ITEM_NEXT, next_x, y, PAGER_WIDTH, "Next  \xe2\x80\xba", at + 1 >= pages);
}

static uint32_t page_count(uint32_t length, uint32_t size)
{
    const uint32_t pages = (length + size - 1) / size;
    return pages ? pages : 1;
}

static uint32_t shown_count(uint32_t length, uint32_t start, uint32_t size)
{
    if (start >= length)
        return 0;
    return length - start < size ? length - start : size;
}

static uint32_t home_slot(uint32_t index, uint32_t start, uint32_t shown)
{
    if (index < start || index - start >= shown)
        return 0;
    return index - start;
}

static void card_at(uint32_t i, uint32_t top, uint32_t gap_y, uint32_t *x, uint32_t *y)
{
    *x = SIDE + (i % 2) * (CARD_WIDTH + CARD_GAP_X);
    *y = top + (i / 2) * (CARD_HEIGHT + gap_y);
}

static void count_text(char *out, size_t size, uint32_t n, const char *one, const char *many)
{
    snprintf(out, size, "%u %s", n, n == 1 ? one : many);
}

static void status(Builder *b, const MoonlightUiModel *model, const char *kicker, const char *title,
    const char *line, const char *const (*keys)[2], uint32_t key_count)
{
    Chip chips[2];
    const Frame frame = {.chips = chips, .chip_count = host_chips(model, chips), .keys = keys,
        .key_count = key_count, .background = COLOR_BACKGROUND, .flags = ML_PAGE_FLAG_HIDE_CURSOR};
    horizon(b, &frame);
    const HeadingStyle style = heading_style(HEADING_STATUS);
    heading(b, kicker, title, line, &style);
}

static void hosts_page(Builder *b, const MoonlightUiModel *model)
{
    static const char *const keys[][2] = {{"A", "Open"}, {"X", "Settings"}, {"Y", "PC options"}};
    const uint32_t pages = page_count(model->host_count, MOONLIGHT_UI_HOSTS_PER_PAGE);
    const uint32_t start = model->host_page * MOONLIGHT_UI_HOSTS_PER_PAGE;
    const uint32_t shown = shown_count(model->host_count, start, MOONLIGHT_UI_HOSTS_PER_PAGE);
    char note[64] = "";
    if (pages > 1)
        snprintf(note, sizeof(note), "Page %u of %u", model->host_page + 1, pages);
    const Chip chips[1] = {{"Moonlight", COLOR_INK, 240}};
    const Frame frame = {.chips = chips, .chip_count = 1, .note = note, .keys = keys, .key_count = 3,
        .background = COLOR_BACKGROUND, .cursor_home = home_slot(model->host_index, start, shown)};
    horizon(b, &frame);

    char line[MOONLIGHT_UI_MESSAGE_BYTES];
    const HeadingStyle style = heading_style(HEADING_Y);
    if (!shown) {
        snprintf(line, sizeof(line), "%s",
            model->message.set ? model->message.text : "Add one by its address, or find PCs on this network");
        heading(b, "No PCs yet", "Add a PC", line, &style);
    } else {
        if (model->message.set)
            snprintf(line, sizeof(line), "%s", model->message.text);
        else
            snprintf(line, sizeof(line), "%u %s saved", model->host_count, model->host_count == 1 ? "PC" : "PCs");
        heading(b, "Moonlight", "Choose a PC", line, &style);
    }

    const uint32_t inner = CARD_WIDTH - 2 * CARD_PAD;
    for (uint32_t i = 0; i < shown; i++) {
        const MoonlightHost *host = &model->hosts[start + i];
        uint32_t x = 0;
        uint32_t y = 0;
        card_at(i, HOST_CARDS_Y, CARD_GAP_Y, &x, &y);
        item(b, MOONLIGHT_ITEM_HOST + start + i, x, y, CARD_WIDTH, CARD_HEIGHT, 0);
        solid(b, x, y, CARD_WIDTH, CARD_HEIGHT, COLOR_CARD);
        text(b, x + CARD_PAD, y + 12, host->name, 36, inner, COLOR_INK, MOONLIGHT_ALIGN_LEFT, 700, 0, 0);
        text(b, x + CARD_PAD, y + 60, host->address, 24, inner, COLOR_MUTED, MOONLIGHT_ALIGN_LEFT, 500, 0, 0);
    }

    const uint32_t buttons_y = HOST_CARDS_Y + 3 * (CARD_HEIGHT + CARD_GAP_Y);
    button(b, MOONLIGHT_ITEM_ADD_HOST, SIDE, buttons_y, PAGER_WIDTH, "+  Add PC", false);
    button(b, MOONLIGHT_ITEM_FIND_HOSTS, SIDE + PAGER_WIDTH + BUTTON_GAP, buttons_y, PAGER_WIDTH, "Find PCs", false);
    if (pages > 1)
        pager(b, buttons_y, model->host_page, pages);
}

static void add_host_page(Builder *b, const MoonlightUiModel *model)
{
    static const char *const keys[][2] = {{"A", "Type"}, {"Y", "Erase"}, {"B", "Cancel"}};
    const Chip chips[2] = {{"Moonlight", COLOR_INK, 240}, {"Add PC", COLOR_MUTED, 180}};
    const Frame frame = {.chips = chips, .chip_count = 2, .keys = keys, .key_count = 3,
        .background = COLOR_BACKGROUND};
    horizon(b, &frame);

    HeadingStyle style = heading_style(HEADING_Y);
    style.color = model->entry[0] ? COLOR_INK : COLOR_GREY;
    heading(b, "Add a PC", model->entry[0] ? model->entry : "_",
        "The IP address of the PC running Sunshine, as 192.168.1.20", &style);

    for (uint32_t i = 0; i < 12; i++) {
        const uint32_t x = SIDE + (i % 3) * (KEYPAD_WIDTH + KEYPAD_GAP);
        const uint32_t y = KEYPAD_Y + (i / 3) * (CARD_HEIGHT + KEYPAD_GAP);
        const uint32_t id = i < 11 ? MOONLIGHT_ITEM_KEY + i : MOONLIGHT_ITEM_ERASE;
        button(b, id, x, y, KEYPAD_WIDTH, KEY_LABELS[i], false);
    }

    const uint32_t actions_x = SIDE + 3 * (KEYPAD_WIDTH + KEYPAD_GAP) + BUTTON_GAP;
    const bool ready = moonlightUiIsAddress(model->entry);
    button(b, MOONLIGHT_ITEM_CONNECT, actions_x, KEYPAD_Y, BUTTON_WIDTH, "Connect", !ready);
    button(b, MOONLIGHT_ITEM_CANCEL, actions_x, KEYPAD_Y + CARD_HEIGHT + KEYPAD_GAP, BUTTON_WIDTH, "Cancel", false);
}

static void host_menu_page(Builder *b, const MoonlightUiModel *model)
{
    static const char *const keys[][2] = {{"A", "Choose"}, {"B", "Back"}};
    Chip chips[2];
    const Frame frame = {.chips = chips, .chip_count = host_chips(model, chips), .keys = keys, .key_count = 2,
        .background = COLOR_BACKGROUND, .cursor_home = 2};
    horizon(b, &frame);
    const HeadingStyle style = heading_style(HEADING_STATUS);
    heading(b, "PC options", model->has_host ? model->host.name : "PC",
        "Unpair makes the PC forget this console; Remove only drops it from this list", &style);

    const uint32_t width = 360;
    button(b, MOONLIGHT_ITEM_UNPAIR, SIDE, BUTTON_Y, width, "Unpair", false);
    button(b, MOONLIGHT_ITEM_REMOVE_HOST, SIDE + width + BUTTON_GAP, BUTTON_Y, width, "Remove PC", false);
    button(b, MOONLIGHT_ITEM_CANCEL, SIDE + 2 * (width + BUTTON_GAP), BUTTON_Y, width, "Cancel", false);
}

static const Entry *cover_tile(Builder *b, const MoonlightApp *app)
{
    char key[KEY_BYTES];
    snprintf(key, sizeof(key), "c\x1f%s", app->name);
    const Entry *entry = lookup(b->composer, key);
    if (entry)
        return entry;

    MoonlightBitmap tile = {0};
    if (!moonlightGlyphsLetters(b->composer->glyphs, app->name, COVER_WIDTH, COVER_HEIGHT, &tile))
        return NULL;
    return store_sized(b->composer, key, tile, 0, 0, (size_t)tile.width * tile.height * 4);
}

static void stream_shape(const MoonlightUiModel *model, char *out, size_t size)
{
    MoonlightSettings used;
    MoonlightSettingRow rows[MOONLIGHT_SETTING_COUNT];
    moonlightSettingsInUse(&model->settings, model->docked, &model->capabilities, &used);
    moonlightSettingsRows(&used, model->docked, &model->capabilities, rows);
    snprintf(out, size, "%s \xc2\xb7 %s \xc2\xb7 %s", rows[MOONLIGHT_SETTING_SIZE].value,
        rows[MOONLIGHT_SETTING_FPS].value, rows[MOONLIGHT_SETTING_BITRATE].value);
}

static void join(char *out, size_t size, const char *part)
{
    if (!filled(part))
        return;
    const size_t used = strlen(out);
    snprintf(out + used, size - used, "%s%s", used ? " \xc2\xb7 " : "", part);
}

static void apps_page(Builder *b, const MoonlightUiModel *model)
{
    static const char *const keys[][2] = {{"A", "Launch"}, {"B", "PCs"}, {"X", "Settings"}};
    static const char *const quit[][2] = {{"Y", "Quit host app"}};
    const uint32_t pages = page_count(model->app_count, MOONLIGHT_UI_APPS_PER_PAGE);
    const uint32_t start = model->app_page * MOONLIGHT_UI_APPS_PER_PAGE;
    const uint32_t shown = shown_count(model->app_count, start, MOONLIGHT_UI_APPS_PER_PAGE);
    char shape[3 * MOONLIGHT_SETTING_TEXT_BYTES + 16];
    stream_shape(model, shape, sizeof(shape));

    Chip chips[2];
    const Frame frame = {.chips = chips, .chip_count = host_chips(model, chips), .note = shape, .keys = keys,
        .key_count = 3, .background = COLOR_BACKGROUND, .cursor_home = home_slot(model->app_index, start, shown)};
    horizon(b, &frame);
    for (uint32_t i = 0; i < shown; i++) {
        const bool running = model->current_game && model->apps[start + i].id == model->current_game;
        if (running) {
            legend_tail(b, SIDE, LEGEND_Y, keys, 3, quit, 1, MOONLIGHT_ITEM_APP + start + i);
            break;
        }
    }

    char line[2 * MOONLIGHT_UI_MESSAGE_BYTES] = "";
    char part[64];
    join(line, sizeof(line), model->message.set ? model->message.text : NULL);
    count_text(part, sizeof(part), model->app_count, "app", "apps");
    join(line, sizeof(line), part);
    part[0] = 0;
    if (pages > 1)
        snprintf(part, sizeof(part), "page %u of %u", model->app_page + 1, pages);
    join(line, sizeof(line), part);
    join(line, sizeof(line), "Press A to launch");
    const HeadingStyle style = heading_style(150);
    heading(b, "Apps", model->has_host ? model->host.name : "Moonlight", line, &style);

    const uint32_t left = (SCREEN_WIDTH - GRID_COLUMNS * COVER_WIDTH - (GRID_COLUMNS - 1) * GRID_GAP) / 2;
    for (uint32_t i = 0; i < shown; i++) {
        const MoonlightApp *app = &model->apps[start + i];
        const uint32_t x = left + (i % GRID_COLUMNS) * (COVER_WIDTH + GRID_GAP);
        const uint32_t y = GRID_Y + (i / GRID_COLUMNS) * GRID_ROW;
        const bool current = app->id == model->current_game;

        item(b, MOONLIGHT_ITEM_APP + start + i, x, y, COVER_WIDTH, COVER_HEIGHT, current ? ML_ITEM_FLAG_CURRENT : 0);
        const Entry *tile = cover_tile(b, app);
        if (tile)
            image(b, x, y, tile);
        else
            b->error = "UI cover could not be painted";

        if (current) {
            solid(b, x + 8, y + 8, RUNNING_WIDTH, RUNNING_HEIGHT, COLOR_RUNNING);
            text(b, x + 8, y + 13, "RUNNING", 18, RUNNING_WIDTH, COLOR_BACKGROUND, MOONLIGHT_ALIGN_CENTER, 700, 1.2, 0);
        }
        plain(b, x, y + COVER_HEIGHT + GRID_NAME, app->name, 26, COVER_WIDTH, current ? COLOR_RUNNING : COLOR_INK,
            MOONLIGHT_ALIGN_CENTER);
    }

    const uint32_t buttons_y = GRID_Y + 2 * GRID_ROW + 8;
    button(b, MOONLIGHT_ITEM_BACK, SIDE, buttons_y, PAGER_WIDTH, "\xe2\x80\xb9  PCs", false);
    if (pages > 1)
        pager(b, buttons_y, model->app_page, pages);
}

static void pairing_page(Builder *b, const MoonlightUiModel *model)
{
    static const char *const keys[][2] = {{"B", "Cancel"}};
    Chip chips[2];
    const Frame frame = {.chips = chips, .chip_count = host_chips(model, chips), .keys = keys, .key_count = 1,
        .background = COLOR_BACKGROUND, .flags = ML_PAGE_FLAG_HIDE_CURSOR};
    horizon(b, &frame);

    HeadingStyle style = heading_style(HEADING_STATUS);
    if (!model->pin.set || !model->pin.text[0]) {
        style.size = 56;
        heading(b, "Pairing", "Waiting for a PIN\xe2\x80\xa6", "The PC is starting the pairing", &style);
        return;
    }

    style.color = COLOR_ACCENT;
    style.tracking = HEADING_SIZE * 0.2;
    heading(b, "Pairing", model->pin.text, "Enter this PIN in Sunshine on the PC", &style);
    if (model->url.set && model->url.text[0])
        text(b, SIDE, HEADING_STATUS + 196, model->url.text, 26, CONTENT_WIDTH, COLOR_GREY, MOONLIGHT_ALIGN_LEFT, 500,
            0, 0);
}

static void setting_card(Builder *b, const MoonlightSettingRow *row, uint32_t i, bool editing)
{
    uint32_t x = 0;
    uint32_t y = 0;
    card_at(i, SETTING_GRID_Y, SETTING_GRID_GAP_Y, &x, &y);
    const uint32_t inner = CARD_WIDTH - 2 * CARD_PAD;
    const uint32_t left = x + CARD_PAD;
    uint32_t flags = 0;
    if (row->adjustable)
        flags |= ML_ITEM_FLAG_ADJUSTABLE;
    if (row->adjustable && editing)
        flags |= ML_ITEM_FLAG_EDITING;
    if (row->greyed)
        flags |= ML_ITEM_FLAG_GREYED;

    item(b, MOONLIGHT_ITEM_SETTING + i, x, y, CARD_WIDTH, CARD_HEIGHT, flags);
    solid(b, x, y, CARD_WIDTH, CARD_HEIGHT, row->greyed ? COLOR_DIM : COLOR_CARD);
    char label[MOONLIGHT_SETTING_TEXT_BYTES];
    upper(row->label, label, sizeof(label));
    text(b, left, y + 12, label, LABEL_SIZE, inner, row->greyed ? COLOR_GREY : COLOR_MUTED, MOONLIGHT_ALIGN_LEFT, 600,
        LABEL_SIZE * 0.08, 0);

    if (row->greyed) {
        plain(b, left, y + 46, "Not available yet", 28, inner, COLOR_GREY, MOONLIGHT_ALIGN_LEFT);
        return;
    }
    if (!row->adjustable) {
        text(b, left, y + 40, row->value, 40, inner, COLOR_INK, MOONLIGHT_ALIGN_CENTER, 700, 0, 0);
        return;
    }
    stepper(b, left, y + 40, row->value, 40, inner, editing && row->can_left, editing && row->can_right);
}

static void settings_page(Builder *b, const MoonlightUiModel *model, const char *settings_error)
{
    static const char *const editing_keys[][2] = {{"\xe2\x97\x82\xe2\x96\xb8", "Change"}, {"A", "Done"}, {"B", "Done"}};
    static const char *const browsing_keys[][2] = {{"A", "Edit"}, {"B", "Back"}, {"Y", "Reset"}};
    MoonlightSettingRow rows[MOONLIGHT_SETTING_COUNT];
    moonlightSettingsRows(&model->settings, model->docked, &model->capabilities, rows);
    const bool editing = model->editing >= 0 && rows[model->editing].adjustable;

    char note[MOONLIGHT_UI_MESSAGE_BYTES + 40];
    if (filled(settings_error))
        snprintf(note, sizeof(note), "Settings could not be saved: %s", settings_error);
    else
        snprintf(note, sizeof(note), "Applies to the next launch");
    const Chip chips[2] = {{host_name(model), COLOR_INK, 300}, {"Settings", COLOR_MUTED, 180}};
    const Frame frame = {.chips = chips, .chip_count = 2, .note = note, .keys = editing ? editing_keys : browsing_keys,
        .key_count = 3, .background = COLOR_BACKGROUND};
    horizon(b, &frame);

    for (uint32_t i = 0; i < MOONLIGHT_SETTING_COUNT; i++)
        setting_card(b, &rows[i], i, (int)i == model->editing);
    if (!model->docked) {
        text(b, SCREEN_WIDTH - SIDE - NOTE_WIDTH, LEGEND_Y + 5, "1440p and 4K are only available when docked", 24,
            NOTE_WIDTH, COLOR_MUTED, MOONLIGHT_ALIGN_RIGHT, 500, 0, MOONLIGHT_ITEM_SETTING + MOONLIGHT_SETTING_SIZE);
    }
}

static void quit_confirm_page(Builder *b, const MoonlightUiModel *model)
{
    static const char *const keys[][2] = {{"A", "Choose"}, {"B", "Back"}};
    Chip chips[2];
    const Frame frame = {.chips = chips, .chip_count = host_chips(model, chips), .keys = keys, .key_count = 2,
        .background = COLOR_BACKGROUND, .cursor_home = 1};
    horizon(b, &frame);

    const char *running = "the running app";
    for (uint32_t i = 0; i < model->app_count; i++) {
        if (model->apps[i].id == model->current_game) {
            running = model->apps[i].name;
            break;
        }
    }
    char title[MOONLIGHT_UI_NAME_BYTES + 8];
    snprintf(title, sizeof(title), "Quit %s?", running);
    const HeadingStyle style = heading_style(HEADING_STATUS);
    heading(b, "Quit host app", title, "The stream ends and the app closes on the PC", &style);

    button(b, MOONLIGHT_ITEM_CONFIRM_QUIT, SIDE, BUTTON_Y, BUTTON_WIDTH, "Quit", false);
    button(b, MOONLIGHT_ITEM_CANCEL, SIDE + BUTTON_WIDTH + BUTTON_GAP, BUTTON_Y, BUTTON_WIDTH, "Cancel", false);
}

static void overlay_page(Builder *b, const MoonlightUiModel *model)
{
    static const char *const keys[][2] = {{"A", "Choose"}, {"B", "Hide"}};
    const bool chord = model->settings.value[MOONLIGHT_SETTING_MENU_CHORD] != 0;
    const Frame frame = {.background = COLOR_CLEAR,
        .flags = ML_PAGE_FLAG_OVERLAY | (chord ? 0u : (uint32_t)ML_PAGE_FLAG_NO_CHORD)};
    horizon(b, &frame);

    const uint32_t width = 2 * OVERLAY_BUTTON + BUTTON_GAP;
    const uint32_t top = HEADING_STATUS - 40;
    const uint32_t bottom = BUTTON_Y + CARD_HEIGHT + 40;
    panel(b, SIDE - 40, top, width + 80, bottom - top, COLOR_BACKGROUND);
    panel(b, SIDE - 40, LEGEND_Y - 16, 440, LEGEND_HEIGHT + 32, COLOR_BACKGROUND);
    legend(b, SIDE, LEGEND_Y, keys, 2);

    const HeadingStyle style = heading_style(HEADING_STATUS);
    heading(b, "Streaming", model->has_app ? model->app.name : "Moonlight", host_name(model), &style);
    button(b, MOONLIGHT_ITEM_RETURN_TO_APPS, SIDE, BUTTON_Y, OVERLAY_BUTTON, "Return to apps", false);
    button(b, MOONLIGHT_ITEM_QUIT_HOST, SIDE + OVERLAY_BUTTON + BUTTON_GAP, BUTTON_Y, OVERLAY_BUTTON, "Quit host app",
        false);
}

static void error_page(Builder *b, const MoonlightUiModel *model)
{
    static const char *const reconnect[][2] = {{"A", "Reconnect"}, {"B", "PCs"}};
    static const char *const back[][2] = {{"A", "Back"}};
    const bool lost = model->screen == MOONLIGHT_SCREEN_CONNECTION_LOST;
    const bool can_reconnect = lost && model->has_host;
    Chip chips[2];
    const Frame frame = {.chips = chips, .chip_count = host_chips(model, chips), .keys = can_reconnect ? reconnect : back,
        .key_count = can_reconnect ? 2 : 1, .background = COLOR_BACKGROUND};
    horizon(b, &frame);

    HeadingStyle style = heading_style(HEADING_STATUS);
    style.size = 48;
    heading(b, lost ? "Connection lost" : "Something went wrong",
        model->message.set ? model->message.text : "Something went wrong", NULL, &style);
    button(b, MOONLIGHT_ITEM_BACK, SIDE, BUTTON_Y, BUTTON_WIDTH, can_reconnect ? "Reconnect" : "Back", false);
}

static bool compose(Builder *b, const MoonlightUiModel *model, const char *settings_error)
{
    static const char *const cancel[][2] = {{"B", "Cancel"}};
    const char *host = model->has_host ? model->host.name : "";
    switch (model->screen) {
    case MOONLIGHT_SCREEN_HOSTS:
        hosts_page(b, model);
        return true;
    case MOONLIGHT_SCREEN_ADD_HOST:
        add_host_page(b, model);
        return true;
    case MOONLIGHT_SCREEN_HOST_MENU:
        host_menu_page(b, model);
        return true;
    case MOONLIGHT_SCREEN_UNPAIRING:
        status(b, model, "Unpairing", host, "Asking the PC to forget this console\xe2\x80\xa6", NULL, 0);
        return true;
    case MOONLIGHT_SCREEN_CONNECTING:
        status(b, model, "Connecting", host, model->has_host ? model->host.address : NULL, cancel, 1);
        return true;
    case MOONLIGHT_SCREEN_PAIRING:
        pairing_page(b, model);
        return true;
    case MOONLIGHT_SCREEN_APPS:
        apps_page(b, model);
        return true;
    case MOONLIGHT_SCREEN_QUIT_CONFIRM:
        quit_confirm_page(b, model);
        return true;
    case MOONLIGHT_SCREEN_SETTINGS:
        settings_page(b, model, settings_error);
        return true;
    case MOONLIGHT_SCREEN_LAUNCHING:
        status(b, model, "Launching", model->has_app ? model->app.name : "",
            model->message.set ? model->message.text : "Starting the stream\xe2\x80\xa6", cancel, 1);
        return true;
    case MOONLIGHT_SCREEN_STREAMING:
        overlay_page(b, model);
        return true;
    case MOONLIGHT_SCREEN_QUITTING:
        status(b, model, "Quitting", host, "Closing the app on the PC\xe2\x80\xa6", NULL, 0);
        return true;
    case MOONLIGHT_SCREEN_CONNECTION_LOST:
    case MOONLIGHT_SCREEN_ERROR:
        error_page(b, model);
        return true;
    default:
        return false;
    }
}

const char *moonlightComposerPage(MoonlightComposer *composer, const MoonlightUiModel *model,
    const char *settings_error, MoonlightPage *page, bool *has_page)
{
    empty_graveyard(composer);
    moonlightPageInit(page);
    Builder b = {composer, page, NULL};
    *has_page = compose(&b, model, settings_error);
    return b.error;
}

const char *moonlightComposerRender(MoonlightComposer *composer, const MoonlightUiModel *model,
    const char *settings_error, uint32_t epoch, uint32_t sequence, const MoonlightPagePlacement *resident,
    uint8_t *out, size_t capacity, MoonlightPagePlacement *placed, bool *has_page)
{
    static MoonlightPage page;
    const char *error = moonlightComposerPage(composer, model, settings_error, &page, has_page);
    if (error || !*has_page)
        return error;

    page.epoch = epoch;
    page.sequence = sequence;
    return moonlightPageEncode(&page, resident, out, capacity, placed);
}
