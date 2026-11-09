// glyph-raster.js's text, legend, letters and measure in C, over the same atlas and with the same
// float steps; fused multiply-adds are off so every rounding matches the JS doubles.
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "glyphs.h"
#include "inflate.h"
#include "uppercase.h"

#if defined(__clang__)
#pragma STDC FP_CONTRACT OFF
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

#define MAX_STRIP_HEIGHT 96
#define KEY_GAP 12
#define ENTRY_GAP 44
#define KERN_REFERENCE_SIZE 1000.0
#define FACE_SORA 0u
#define FALLBACK_KEY 0u
#define LIGATURE_KEY_BASE 0xe000u
#define HEADER_BYTES 16u
#define COMBO_BYTES 24u
#define COMBO_READ_BYTES 20u
#define TABLE_BYTES 12u
#define RING_BYTES 12u
#define GLYPH_BYTES 24u
#define KERN_ENTRY_BYTES 6u
#define ATLAS_VERSION 1u
#define DEFAULT_WEIGHT 600u
#define KEY_WEIGHT 700u
#define LETTERS_WEIGHT 700u
#define ELLIPSIS 0x2026u
#define REPLACEMENT 0xfffdu
#define QUESTION_MARK 0x3fu
#define MAX_INITIALS 2u
#define LETTER_LIGHT 0.32
#define LETTER_SATURATION 0.45

typedef struct {
    uint32_t key;
    uint32_t face;
    uint32_t sequence_length;
    uint64_t sequence_at;
    uint32_t advance;
    int32_t dx;
    int32_t dy;
    uint32_t w;
    uint32_t h;
    uint32_t offset;
} Glyph;

typedef struct {
    uint32_t code;
    uint32_t glyph;
    uint32_t order;
} CharEntry;

typedef struct {
    uint32_t glyph;
    uint32_t units;
    uint32_t first_code;
    uint32_t code_count;
    uint32_t order;
} Ligature;

typedef struct {
    uint64_t pair;
    int64_t kern;
    uint32_t order;
} KernEntry;

typedef struct {
    uint32_t size;
    uint32_t weight;
    int32_t ascent;
    int32_t descent;
    Glyph *glyphs;
    uint32_t glyph_count;
    CharEntry *chars;
    uint32_t char_count;
    Ligature *ligatures;
    uint32_t ligature_count;
    uint32_t *ligature_codes;
    uint32_t fallback;
    KernEntry *kerns;
    uint32_t kern_count;
} Face;

typedef struct {
    uint32_t face;
    uint32_t count;
    uint32_t offset;
} KernTable;

typedef enum {
    TABLE_SKIPPED,
    TABLE_USED,
    TABLE_BROKEN,
} TableStatus;

typedef struct {
    uint32_t w;
    uint32_t h;
    uint32_t offset;
} RingMask;

typedef struct {
    const Glyph *glyph;
    int64_t pen;
} Placed;

typedef struct {
    double x;
    uint32_t first;
    uint32_t count;
} Run;

typedef struct {
    Placed *placed;
    Run *runs;
    uint32_t placed_count;
    uint32_t run_count;
    double length;
} Layout;

typedef struct {
    uint32_t *codes;
    uint32_t count;
} Text;

typedef struct {
    Text text;
    Layout layout;
} Line;

typedef struct {
    uint8_t levels[3];
    uint32_t count;
} Ink;

typedef struct {
    double left;
    double top;
    double right;
    double bottom;
} Box;

struct MoonlightGlyphs {
    uint8_t *atlas;
    size_t size;
    uint32_t combo_count;
    uint32_t table_count;
    uint32_t ring_count;
    uint64_t tables_at;
    uint64_t rings_at;
    Face **faces;
};

static const Ink WHITE = {{255, 0, 0}, 1};
static const Ink LETTER_INK = {{240, 246, 250}, 3};

static bool in_atlas(const MoonlightGlyphs *glyphs, uint64_t at, uint64_t length)
{
    return at <= glyphs->size && length <= glyphs->size - at;
}

static uint32_t read_u8(const MoonlightGlyphs *glyphs, uint64_t at)
{
    return glyphs->atlas[at];
}

static uint32_t read_u16(const MoonlightGlyphs *glyphs, uint64_t at)
{
    return glyphs->atlas[at] | (uint32_t)glyphs->atlas[at + 1] << 8;
}

static int32_t read_i16(const MoonlightGlyphs *glyphs, uint64_t at)
{
    const int32_t value = (int32_t)read_u16(glyphs, at);
    return value >= 0x8000 ? value - 0x10000 : value;
}

static uint32_t read_u32(const MoonlightGlyphs *glyphs, uint64_t at)
{
    return read_u16(glyphs, at) | read_u16(glyphs, at + 2) << 16;
}

static int32_t read_i8(const MoonlightGlyphs *glyphs, uint64_t at)
{
    const int32_t value = (int32_t)read_u8(glyphs, at);
    return value >= 0x80 ? value - 0x100 : value;
}

static void *allocate(size_t count, size_t size)
{
    return calloc(count ? count : 1, size);
}

static double js_round(double value)
{
    const double floored = floor(value);
    return value - floored >= 0.5 ? floored + 1 : floored;
}

static double python_round(double value)
{
    const double rounded = js_round(value);
    const bool half = value - floor(value) == 0.5;
    if (half && fmod(rounded, 2) != 0)
        return rounded - 1;

    return rounded;
}

static double non_negative(double value)
{
    if (isnan(value) || value > 0)
        return value;
    return 0;
}

static bool is_js_space(uint32_t code)
{
    if (code >= 0x09 && code <= 0x0d)
        return true;
    if (code >= 0x2000 && code <= 0x200a)
        return true;

    switch (code) {
    case 0x20:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
    case 0xfeff:
        return true;
    default:
        return false;
    }
}

static bool read_glyph(const MoonlightGlyphs *glyphs, uint64_t at, Glyph *glyph)
{
    if (!in_atlas(glyphs, at, GLYPH_BYTES))
        return false;
    const uint32_t length = read_u8(glyphs, at + 3);
    if (length && !in_atlas(glyphs, at + 4, 2u * length))
        return false;

    glyph->key = read_u16(glyphs, at);
    glyph->face = read_u8(glyphs, at + 2);
    glyph->sequence_length = length;
    glyph->sequence_at = at + 4;
    glyph->advance = read_u16(glyphs, at + 10);
    glyph->dx = read_i16(glyphs, at + 12);
    glyph->dy = read_i16(glyphs, at + 14);
    glyph->w = read_u16(glyphs, at + 16);
    glyph->h = read_u16(glyphs, at + 18);
    glyph->offset = read_u32(glyphs, at + 20);
    return true;
}

static bool is_high_surrogate(uint32_t unit)
{
    return unit >= 0xd800 && unit <= 0xdbff;
}

static bool is_low_surrogate(uint32_t unit)
{
    return unit >= 0xdc00 && unit <= 0xdfff;
}

static uint32_t sequence_codes(const MoonlightGlyphs *glyphs, const Glyph *glyph, uint32_t *codes)
{
    uint32_t count = 0;
    uint32_t i = 0;
    while (i < glyph->sequence_length) {
        const uint32_t unit = read_u16(glyphs, glyph->sequence_at + 2u * i);
        const uint32_t next = i + 1 < glyph->sequence_length ? read_u16(glyphs, glyph->sequence_at + 2u * i + 2) : 0;
        if (is_high_surrogate(unit) && is_low_surrogate(next)) {
            codes[count++] = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
            i += 2;
        } else {
            codes[count++] = unit;
            i++;
        }
    }
    return count;
}

static int compare_order(uint32_t left, uint32_t right)
{
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}

static int compare_chars(const void *left, const void *right)
{
    const CharEntry *a = left;
    const CharEntry *b = right;
    if (a->code != b->code)
        return a->code < b->code ? -1 : 1;
    return compare_order(a->order, b->order);
}

static int compare_ligatures(const void *left, const void *right)
{
    const Ligature *a = left;
    const Ligature *b = right;
    if (a->units != b->units)
        return a->units > b->units ? -1 : 1;
    return compare_order(a->order, b->order);
}

static int compare_kerns(const void *left, const void *right)
{
    const KernEntry *a = left;
    const KernEntry *b = right;
    if (a->pair != b->pair)
        return a->pair < b->pair ? -1 : 1;
    return compare_order(a->order, b->order);
}

static uint32_t keep_last_chars(CharEntry *chars, uint32_t count)
{
    uint32_t kept = 0;
    for (uint32_t i = 0; i < count; i++) {
        const bool last = i + 1 == count || chars[i + 1].code != chars[i].code;
        if (last)
            chars[kept++] = chars[i];
    }
    return kept;
}

static uint32_t keep_last_kerns(KernEntry *kerns, uint32_t count)
{
    uint32_t kept = 0;
    for (uint32_t i = 0; i < count; i++) {
        const bool last = i + 1 == count || kerns[i + 1].pair != kerns[i].pair;
        if (last)
            kerns[kept++] = kerns[i];
    }
    return kept;
}

static void face_free(Face *face)
{
    if (!face)
        return;

    free(face->glyphs);
    free(face->chars);
    free(face->ligatures);
    free(face->ligature_codes);
    free(face->kerns);
    free(face);
}

static void add_char(const MoonlightGlyphs *glyphs, Face *face, uint32_t index)
{
    const Glyph *glyph = &face->glyphs[index];
    uint32_t codes[2];
    if (glyph->sequence_length == 0 || glyph->sequence_length > 2)
        return;
    if (sequence_codes(glyphs, glyph, codes) != 1)
        return;

    CharEntry *entry = &face->chars[face->char_count++];
    entry->code = codes[0];
    entry->glyph = index;
    entry->order = index;
}

static void add_ligature(const MoonlightGlyphs *glyphs, Face *face, uint32_t index, uint32_t *code_count)
{
    const Glyph *glyph = &face->glyphs[index];
    Ligature *ligature = &face->ligatures[face->ligature_count++];
    ligature->glyph = index;
    ligature->units = glyph->sequence_length;
    ligature->first_code = *code_count;
    ligature->code_count = sequence_codes(glyphs, glyph, face->ligature_codes + *code_count);
    ligature->order = index;
    *code_count += ligature->code_count;
}

static bool read_face_glyphs(const MoonlightGlyphs *glyphs, Face *face, uint32_t count, uint32_t records_at)
{
    if (count == 0 || !in_atlas(glyphs, records_at, (uint64_t)count * GLYPH_BYTES))
        return false;

    face->glyphs = allocate(count, sizeof(Glyph));
    face->chars = allocate(count, sizeof(CharEntry));
    face->ligatures = allocate(count, sizeof(Ligature));
    if (!face->glyphs || !face->chars || !face->ligatures)
        return false;

    uint64_t ligature_units = 0;
    for (uint32_t g = 0; g < count; g++) {
        if (!read_glyph(glyphs, records_at + (uint64_t)g * GLYPH_BYTES, &face->glyphs[g]))
            return false;
        if (face->glyphs[g].key >= LIGATURE_KEY_BASE)
            ligature_units += face->glyphs[g].sequence_length;
    }
    face->glyph_count = count;
    face->ligature_codes = allocate((size_t)ligature_units, sizeof(uint32_t));
    if (!face->ligature_codes)
        return false;

    bool has_fallback = false;
    uint32_t code_count = 0;
    for (uint32_t g = 0; g < count; g++) {
        const uint32_t key = face->glyphs[g].key;
        if (key == FALLBACK_KEY) {
            face->fallback = g;
            has_fallback = true;
        } else if (key >= LIGATURE_KEY_BASE) {
            add_ligature(glyphs, face, g, &code_count);
        } else {
            add_char(glyphs, face, g);
        }
    }
    if (!has_fallback)
        return false;

    qsort(face->chars, face->char_count, sizeof(CharEntry), compare_chars);
    face->char_count = keep_last_chars(face->chars, face->char_count);
    qsort(face->ligatures, face->ligature_count, sizeof(Ligature), compare_ligatures);
    return true;
}

static TableStatus read_table(const MoonlightGlyphs *glyphs, uint32_t index, uint32_t weight, KernTable *table)
{
    const uint64_t at = glyphs->tables_at + (uint64_t)index * TABLE_BYTES;
    if (!in_atlas(glyphs, at, 4))
        return TABLE_BROKEN;
    table->face = read_u16(glyphs, at);
    if (table->face == FACE_SORA && read_u16(glyphs, at + 2) != weight)
        return TABLE_SKIPPED;

    if (!in_atlas(glyphs, at + 4, 8))
        return TABLE_BROKEN;
    table->count = read_u32(glyphs, at + 4);
    table->offset = read_u32(glyphs, at + 8);
    return TABLE_USED;
}

static bool count_kerns(const MoonlightGlyphs *glyphs, const Face *face, uint64_t correction_at, uint64_t *total)
{
    *total = 0;
    for (uint32_t t = 0; t < glyphs->table_count; t++) {
        KernTable table;
        const TableStatus status = read_table(glyphs, t, face->weight, &table);
        if (status == TABLE_BROKEN)
            return false;
        if (status == TABLE_SKIPPED || table.count == 0)
            continue;

        const bool entries_ok = in_atlas(glyphs, table.offset, (uint64_t)table.count * KERN_ENTRY_BYTES);
        const bool corrections_ok = in_atlas(glyphs, correction_at, table.count);
        if (!entries_ok || !corrections_ok)
            return false;
        correction_at += table.count;
        *total += table.count;
    }
    return true;
}

static void add_table_kerns(const MoonlightGlyphs *glyphs, Face *face, const KernTable *table, uint64_t correction_at)
{
    for (uint32_t i = 0; i < table->count; i++) {
        const uint64_t entry = table->offset + (uint64_t)i * KERN_ENTRY_BYTES;
        const double units = read_i16(glyphs, entry + 4);
        const double scaled = js_round(units * face->size / KERN_REFERENCE_SIZE);
        const int64_t kern = (int64_t)scaled + read_i8(glyphs, correction_at + i);
        if (kern == 0)
            continue;

        KernEntry *added = &face->kerns[face->kern_count];
        added->pair = (uint64_t)table->face << 32 | (uint64_t)read_u16(glyphs, entry) << 16 | read_u16(glyphs, entry + 2);
        added->kern = kern;
        added->order = face->kern_count;
        face->kern_count++;
    }
}

static bool read_face_kerns(const MoonlightGlyphs *glyphs, Face *face, uint64_t correction_at)
{
    uint64_t total = 0;
    if (!count_kerns(glyphs, face, correction_at, &total) || total > UINT32_MAX)
        return false;
    face->kerns = allocate((size_t)total, sizeof(KernEntry));
    if (!face->kerns)
        return false;

    for (uint32_t t = 0; t < glyphs->table_count; t++) {
        KernTable table;
        if (read_table(glyphs, t, face->weight, &table) != TABLE_USED)
            continue;
        add_table_kerns(glyphs, face, &table, correction_at);
        correction_at += table.count;
    }

    qsort(face->kerns, face->kern_count, sizeof(KernEntry), compare_kerns);
    face->kern_count = keep_last_kerns(face->kerns, face->kern_count);
    return true;
}

static Face *read_face(const MoonlightGlyphs *glyphs, uint32_t combo)
{
    const uint64_t at = HEADER_BYTES + (uint64_t)combo * COMBO_BYTES;
    if (!in_atlas(glyphs, at, COMBO_READ_BYTES))
        return NULL;
    Face *face = calloc(1, sizeof(Face));
    if (!face)
        return NULL;

    face->size = read_u16(glyphs, at);
    face->weight = read_u16(glyphs, at + 2);
    face->ascent = read_i16(glyphs, at + 4);
    face->descent = read_i16(glyphs, at + 6);
    const uint32_t glyph_count = read_u32(glyphs, at + 8);
    const uint32_t records_at = read_u32(glyphs, at + 12);
    const uint32_t correction_at = read_u32(glyphs, at + 16);

    const bool glyphs_ok = read_face_glyphs(glyphs, face, glyph_count, records_at);
    if (!glyphs_ok || !read_face_kerns(glyphs, face, correction_at)) {
        face_free(face);
        return NULL;
    }
    return face;
}

static const Face *face_at(MoonlightGlyphs *glyphs, uint32_t size, uint32_t weight)
{
    for (uint32_t c = 0; c < glyphs->combo_count; c++) {
        const uint64_t at = HEADER_BYTES + (uint64_t)c * COMBO_BYTES;
        if (!in_atlas(glyphs, at, 2))
            return NULL;
        if (read_u16(glyphs, at) != size)
            continue;
        if (!in_atlas(glyphs, at + 2, 2))
            return NULL;
        if (read_u16(glyphs, at + 2) != weight)
            continue;

        if (!glyphs->faces[c])
            glyphs->faces[c] = read_face(glyphs, c);
        return glyphs->faces[c];
    }
    return NULL;
}

static bool ring_at(const MoonlightGlyphs *glyphs, uint32_t size, RingMask *ring)
{
    for (uint32_t r = 0; r < glyphs->ring_count; r++) {
        const uint64_t at = glyphs->rings_at + (uint64_t)r * RING_BYTES;
        if (!in_atlas(glyphs, at, 2))
            return false;
        if (read_u16(glyphs, at) != size)
            continue;
        if (!in_atlas(glyphs, at, RING_BYTES))
            return false;

        ring->w = read_u16(glyphs, at + 2);
        ring->h = read_u16(glyphs, at + 4);
        ring->offset = read_u32(glyphs, at + 8);
        return true;
    }
    return false;
}

static const Glyph *glyph_for(const Face *face, uint32_t code)
{
    uint32_t low = 0;
    uint32_t high = face->char_count;
    while (low < high) {
        const uint32_t middle = low + (high - low) / 2;
        if (face->chars[middle].code < code)
            low = middle + 1;
        else
            high = middle;
    }

    if (low < face->char_count && face->chars[low].code == code)
        return &face->glyphs[face->chars[low].glyph];
    return &face->glyphs[face->fallback];
}

static int64_t kern_for(const Face *face, uint32_t face_id, uint32_t left, uint32_t right)
{
    const uint64_t pair = (uint64_t)face_id << 32 | (uint64_t)left << 16 | right;
    uint32_t low = 0;
    uint32_t high = face->kern_count;
    while (low < high) {
        const uint32_t middle = low + (high - low) / 2;
        if (face->kerns[middle].pair < pair)
            low = middle + 1;
        else
            high = middle;
    }

    if (low < face->kern_count && face->kerns[low].pair == pair)
        return face->kerns[low].kern;
    return 0;
}

static bool ligature_matches(const Face *face, const Ligature *ligature, const uint32_t *codes, uint32_t available)
{
    if (ligature->code_count == 0 || ligature->code_count > available)
        return false;

    const uint32_t *expected = face->ligature_codes + ligature->first_code;
    for (uint32_t k = 0; k < ligature->code_count; k++) {
        if (codes[k] != expected[k])
            return false;
    }
    return true;
}

static const Glyph *next_glyph(const Face *face, const uint32_t *codes, uint32_t available, uint32_t *used)
{
    const Glyph *glyph = glyph_for(face, codes[0]);
    *used = 1;
    if (glyph->face != FACE_SORA)
        return glyph;

    for (uint32_t l = 0; l < face->ligature_count; l++) {
        const Ligature *ligature = &face->ligatures[l];
        if (!ligature_matches(face, ligature, codes, available))
            continue;

        *used = ligature->code_count;
        return &face->glyphs[ligature->glyph];
    }
    return glyph;
}

static int64_t shape_piece(const Face *face, const uint32_t *codes, uint32_t count, Layout *layout)
{
    int64_t pen = 0;
    const Glyph *previous = NULL;
    uint32_t i = 0;
    while (i < count) {
        uint32_t used = 1;
        const Glyph *glyph = next_glyph(face, codes + i, count - i, &used);
        if (previous)
            pen += kern_for(face, glyph->face, previous->key, glyph->key);

        Placed *placed = &layout->placed[layout->placed_count++];
        placed->glyph = glyph;
        placed->pen = pen;
        pen += glyph->advance;
        previous = glyph;
        i += used;
    }
    return pen;
}

static uint32_t piece_end(const Face *face, const uint32_t *codes, uint32_t count, uint32_t start, bool spaced)
{
    if (spaced)
        return start + 1;

    const uint32_t font = glyph_for(face, codes[start])->face;
    uint32_t end = start + 1;
    while (end < count && glyph_for(face, codes[end])->face == font)
        end++;
    return end;
}

static void layout_text(const Face *face, const uint32_t *codes, uint32_t count, double tracking, Layout *layout)
{
    const bool spaced = tracking != 0 && !isnan(tracking);
    layout->placed_count = 0;
    layout->run_count = 0;

    double x = 0;
    uint32_t start = 0;
    while (start < count) {
        const uint32_t end = piece_end(face, codes, count, start, spaced);
        Run *run = &layout->runs[layout->run_count++];
        run->x = x;
        run->first = layout->placed_count;
        const int64_t length = shape_piece(face, codes + start, end - start, layout);
        run->count = layout->placed_count - run->first;
        x += (double)length / 64 + tracking;
        start = end;
    }
    layout->length = non_negative(x - tracking);
}

static uint32_t shortened(const uint32_t *codes, uint32_t count)
{
    const uint32_t kept = codes[count - 1] == ELLIPSIS ? count - 1 : count;
    if (kept <= 1)
        return 0;

    uint32_t end = kept - 1;
    while (end > 0 && is_js_space(codes[end - 1]))
        end--;
    return end + 1;
}

static void fit_text(const Face *face, Text *text, double tracking, double width, Layout *layout)
{
    while (text->count > 0) {
        layout_text(face, text->codes, text->count, tracking, layout);
        if (!(layout->length > width))
            return;

        const uint32_t count = shortened(text->codes, text->count);
        if (count > 0)
            text->codes[count - 1] = ELLIPSIS;
        text->count = count;
    }
}

static bool layout_create(Layout *layout, uint32_t capacity)
{
    memset(layout, 0, sizeof(*layout));
    layout->placed = allocate(capacity, sizeof(Placed));
    layout->runs = allocate(capacity, sizeof(Run));
    return layout->placed && layout->runs;
}

static void layout_free(Layout *layout)
{
    free(layout->placed);
    free(layout->runs);
    memset(layout, 0, sizeof(*layout));
}

static uint32_t sequence_need(uint32_t lead, uint32_t *code, uint32_t *lower, uint32_t *upper)
{
    *lower = 0x80;
    *upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) {
        *code = lead & 0x1f;
        return 1;
    }
    if (lead >= 0xe0 && lead <= 0xef) {
        *code = lead & 0x0f;
        *lower = lead == 0xe0 ? 0xa0 : 0x80;
        *upper = lead == 0xed ? 0x9f : 0xbf;
        return 2;
    }
    if (lead >= 0xf0 && lead <= 0xf4) {
        *code = lead & 0x07;
        *lower = lead == 0xf0 ? 0x90 : 0x80;
        *upper = lead == 0xf4 ? 0x8f : 0xbf;
        return 3;
    }
    return 0;
}

static uint32_t next_code(const uint8_t *bytes, size_t length, size_t *at)
{
    const uint32_t lead = bytes[(*at)++];
    if (lead < 0x80)
        return lead;

    uint32_t code = 0;
    uint32_t lower = 0;
    uint32_t upper = 0;
    const uint32_t needed = sequence_need(lead, &code, &lower, &upper);
    uint32_t seen = 0;
    while (seen < needed && *at < length && bytes[*at] >= lower && bytes[*at] <= upper) {
        code = code << 6 | (bytes[(*at)++] & 0x3fu);
        lower = 0x80;
        upper = 0xbf;
        seen++;
    }

    if (needed == 0 || seen < needed)
        return REPLACEMENT;
    return code;
}

static bool text_decode(const char *utf8, Text *text)
{
    memset(text, 0, sizeof(*text));
    const size_t length = strlen(utf8);
    if (length >= UINT32_MAX)
        return false;
    text->codes = allocate(length, sizeof(uint32_t));
    if (!text->codes)
        return false;

    const uint8_t *bytes = (const uint8_t *)utf8;
    size_t at = 0;
    while (at < length)
        text->codes[text->count++] = next_code(bytes, length, &at);
    return true;
}

static void text_free(Text *text)
{
    free(text->codes);
    memset(text, 0, sizeof(*text));
}

static bool line_open(Line *line, const Face *face, const char *utf8, double tracking)
{
    memset(line, 0, sizeof(*line));
    if (!utf8 || !text_decode(utf8, &line->text))
        return false;
    if (!layout_create(&line->layout, line->text.count))
        return false;

    layout_text(face, line->text.codes, line->text.count, tracking, &line->layout);
    return true;
}

static void line_close(Line *line)
{
    text_free(&line->text);
    layout_free(&line->layout);
}

static uint32_t div255(uint32_t value)
{
    const uint32_t biased = value + 128;
    return ((biased >> 8) + biased) >> 8;
}

static uint32_t mask_alpha(const MoonlightGlyphs *glyphs, uint32_t offset, uint32_t index)
{
    int64_t half = index >> 1;
    if (index >= 0x80000000u)
        half = -(int64_t)((UINT64_C(0x100000000) - index + 1) / 2);
    const int64_t position = (int64_t)offset + half;
    if (position < 0 || (uint64_t)position >= glyphs->size)
        return 0;

    const uint32_t packed = glyphs->atlas[position];
    const uint32_t nibble = index & 1u ? packed & 15u : packed >> 4;
    return nibble * 17;
}

static bool span_visible(double start, uint32_t length, uint32_t limit)
{
    if (!isfinite(start))
        return false;
    return start < limit && start + length > 0;
}

static void blend_pixel(MoonlightBitmap *target, size_t at, uint32_t alpha, const Ink *ink)
{
    for (uint32_t c = 0; c < ink->count; c++) {
        const uint32_t mixed = target->bytes[at + c] * (255 - alpha) + ink->levels[c] * alpha;
        target->bytes[at + c] = (uint8_t)div255(mixed);
    }
}

static void blend_mask(const MoonlightGlyphs *glyphs, MoonlightBitmap *target, uint32_t offset, uint32_t w, uint32_t h,
                       double x, double y, const Ink *ink)
{
    if (!span_visible(x, w, target->width) || !span_visible(y, h, target->height))
        return;

    const int64_t left = (int64_t)x;
    const int64_t top = (int64_t)y;
    for (uint32_t row = 0; row < h; row++) {
        const int64_t ty = top + row;
        if (ty < 0 || ty >= target->height)
            continue;

        for (uint32_t col = 0; col < w; col++) {
            const int64_t tx = left + col;
            if (tx < 0 || tx >= target->width)
                continue;
            const uint32_t alpha = mask_alpha(glyphs, offset, row * w + col);
            if (!alpha)
                continue;

            const size_t at = ((size_t)ty * target->width + (size_t)tx) * target->channels;
            blend_pixel(target, at, alpha, ink);
        }
    }
}

static void draw_runs(const MoonlightGlyphs *glyphs, MoonlightBitmap *target, double x, double baseline,
                      const Layout *layout, const Ink *ink)
{
    const double top_line = floor(baseline);
    for (uint32_t r = 0; r < layout->run_count; r++) {
        const Run *run = &layout->runs[r];
        const double start = x + run->x;
        const double whole = trunc(start);
        const double start_pen = floor((start - whole) * 64);

        for (uint32_t p = run->first; p < run->first + run->count; p++) {
            const Glyph *glyph = layout->placed[p].glyph;
            const double column = whole + floor((start_pen + (double)layout->placed[p].pen + 32) / 64);
            blend_mask(glyphs, target, glyph->offset, glyph->w, glyph->h, column + glyph->dx, top_line + glyph->dy, ink);
        }
    }
}

static bool bitmap_create(MoonlightBitmap *bitmap, uint32_t width, uint32_t height, uint32_t channels)
{
    const size_t row = (size_t)width * channels;
    if (height && row > SIZE_MAX / height)
        return false;

    bitmap->bytes = allocate(row * height, 1);
    if (!bitmap->bytes)
        return false;
    bitmap->width = width;
    bitmap->height = height;
    bitmap->channels = channels;
    return true;
}

static void bitmap_clear(MoonlightBitmap *bitmap)
{
    if (bitmap)
        memset(bitmap, 0, sizeof(*bitmap));
}

static uint32_t style_weight(const MoonlightTextStyle *style)
{
    if (!style || style->weight == 0)
        return DEFAULT_WEIGHT;
    return style->weight;
}

static double style_tracking(const MoonlightTextStyle *style)
{
    return style ? style->tracking : 0;
}

static double aligned_x(MoonlightAlign align, uint32_t width, double length)
{
    if (align == MOONLIGHT_ALIGN_CENTER)
        return ((double)width - length) / 2;
    if (align == MOONLIGHT_ALIGN_RIGHT)
        return (double)width - length;
    return 0;
}

static bool paint_text(const MoonlightGlyphs *glyphs, const Face *face, Text *text, uint32_t width, MoonlightAlign align,
                       double tracking, MoonlightBitmap *out)
{
    const int32_t line_height = face->ascent + face->descent;
    if (line_height < 0)
        return false;
    const uint32_t height = line_height < MAX_STRIP_HEIGHT ? (uint32_t)line_height : MAX_STRIP_HEIGHT;

    Layout layout;
    if (!layout_create(&layout, text->count)) {
        layout_free(&layout);
        return false;
    }
    fit_text(face, text, tracking, width, &layout);
    layout_text(face, text->codes, text->count, tracking, &layout);

    const double x = aligned_x(align, width, layout.length);
    const bool created = bitmap_create(out, width, height, 1);
    if (created)
        draw_runs(glyphs, out, x, face->ascent, &layout, &WHITE);

    layout_free(&layout);
    return created;
}

bool moonlightGlyphsText(MoonlightGlyphs *glyphs, const char *utf8, uint32_t size, uint32_t width, MoonlightAlign align,
                         const MoonlightTextStyle *style, MoonlightBitmap *out)
{
    bitmap_clear(out);
    if (!glyphs || !utf8 || !out)
        return false;
    const Face *face = face_at(glyphs, size, style_weight(style));
    if (!face)
        return false;

    Text text;
    if (!text_decode(utf8, &text)) {
        text_free(&text);
        return false;
    }
    const bool painted = paint_text(glyphs, face, &text, width, align, style_tracking(style), out);

    text_free(&text);
    return painted;
}

bool moonlightGlyphsMeasure(MoonlightGlyphs *glyphs, const char *utf8, uint32_t size, const MoonlightTextStyle *style,
                            double *width)
{
    if (!glyphs || !utf8 || !width)
        return false;
    const Face *face = face_at(glyphs, size, style_weight(style));
    if (!face)
        return false;

    Line line;
    const bool measured = line_open(&line, face, utf8, style_tracking(style));
    if (measured)
        *width = line.layout.length;

    line_close(&line);
    return measured;
}

static bool paint_legend_entry(const MoonlightGlyphs *glyphs, MoonlightBitmap *strip, const Face *face,
                               const Face *key_face, const char *const entry[2], double ring, double baseline,
                               double *x)
{
    Line key;
    Line label;
    const bool key_ok = line_open(&key, key_face, entry[0], 0);
    const bool label_ok = key_ok && line_open(&label, face, entry[1], 0);
    if (!label_ok) {
        line_close(&key);
        if (key_ok)
            line_close(&label);
        return false;
    }

    draw_runs(glyphs, strip, *x + (ring - key.layout.length) / 2, baseline, &key.layout, &WHITE);
    *x += ring + KEY_GAP;
    draw_runs(glyphs, strip, *x, baseline, &label.layout, &WHITE);
    *x += label.layout.length + ENTRY_GAP;

    line_close(&key);
    line_close(&label);
    return true;
}

bool moonlightGlyphsLegend(MoonlightGlyphs *glyphs, const char *const keys[][2], uint32_t count, uint32_t size,
                           uint32_t width, MoonlightBitmap *out)
{
    bitmap_clear(out);
    if (!glyphs || !out || (count && !keys))
        return false;
    const Face *face = face_at(glyphs, size, DEFAULT_WEIGHT);
    const Face *key_face = face ? face_at(glyphs, size, KEY_WEIGHT) : NULL;
    RingMask mask;
    if (!key_face || !ring_at(glyphs, size, &mask))
        return false;

    const double ring = python_round((double)size * 1.55);
    const double line_height = face->ascent + face->descent;
    const double tallest = ring > line_height ? ring : line_height;
    const double height = tallest < MAX_STRIP_HEIGHT ? tallest : MAX_STRIP_HEIGHT;
    const double baseline = (height + face->ascent - face->descent) / 2;
    if (!bitmap_create(out, width, (uint32_t)height, 1))
        return false;

    double x = 0;
    for (uint32_t i = 0; i < count; i++) {
        blend_mask(glyphs, out, mask.offset, mask.w, mask.h, trunc(x), 0, &WHITE);
        if (!paint_legend_entry(glyphs, out, face, key_face, keys[i], ring, baseline, &x)) {
            moonlightBitmapFree(out);
            return false;
        }
    }
    return true;
}

static uint32_t rotate_right(uint32_t value, uint32_t bits)
{
    return value >> bits | value << (32 - bits);
}

static const uint32_t SHA256_ROUNDS[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};

static void sha256_block(uint32_t state[8], const uint8_t block[64])
{
    uint32_t w[64];
    for (uint32_t i = 0; i < 16; i++) {
        const uint8_t *at = block + 4 * i;
        w[i] = (uint32_t)at[0] << 24 | (uint32_t)at[1] << 16 | (uint32_t)at[2] << 8 | at[3];
    }
    for (uint32_t i = 16; i < 64; i++) {
        const uint32_t s0 = rotate_right(w[i - 15], 7) ^ rotate_right(w[i - 15], 18) ^ w[i - 15] >> 3;
        const uint32_t s1 = rotate_right(w[i - 2], 17) ^ rotate_right(w[i - 2], 19) ^ w[i - 2] >> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t v[8];
    memcpy(v, state, sizeof(v));
    for (uint32_t i = 0; i < 64; i++) {
        const uint32_t s1 = rotate_right(v[4], 6) ^ rotate_right(v[4], 11) ^ rotate_right(v[4], 25);
        const uint32_t choose = (v[4] & v[5]) ^ (~v[4] & v[6]);
        const uint32_t t1 = v[7] + s1 + choose + SHA256_ROUNDS[i] + w[i];
        const uint32_t s0 = rotate_right(v[0], 2) ^ rotate_right(v[0], 13) ^ rotate_right(v[0], 22);
        const uint32_t majority = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
        memmove(v + 1, v, 7 * sizeof(uint32_t));
        v[4] += t1;
        v[0] = t1 + s0 + majority;
    }
    for (uint32_t i = 0; i < 8; i++)
        state[i] += v[i];
}

static uint32_t sha256_first_word(const uint8_t *bytes, size_t length)
{
    uint32_t state[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    size_t at = 0;
    for (; length - at >= 64; at += 64)
        sha256_block(state, bytes + at);

    uint8_t tail[128] = {0};
    const size_t rest = length - at;
    memcpy(tail, bytes + at, rest);
    tail[rest] = 0x80;
    const size_t tail_length = rest < 56 ? 64 : 128;
    const uint64_t bits = (uint64_t)length * 8;
    for (uint32_t i = 0; i < 8; i++)
        tail[tail_length - 1 - i] = (uint8_t)(bits >> (8 * i));

    sha256_block(state, tail);
    if (tail_length == 128)
        sha256_block(state, tail + 64);
    return state[0];
}

static size_t encode_utf8(uint32_t code, uint8_t *out)
{
    if (code >= 0xd800 && code < 0xe000)
        code = REPLACEMENT;
    if (code < 0x80) {
        out[0] = (uint8_t)code;
        return 1;
    }
    if (code < 0x800) {
        out[0] = (uint8_t)(0xc0 | code >> 6);
        out[1] = (uint8_t)(0x80 | (code & 63));
        return 2;
    }
    if (code < 0x10000) {
        out[0] = (uint8_t)(0xe0 | code >> 12);
        out[1] = (uint8_t)(0x80 | (code >> 6 & 63));
        out[2] = (uint8_t)(0x80 | (code & 63));
        return 3;
    }
    out[0] = (uint8_t)(0xf0 | code >> 18);
    out[1] = (uint8_t)(0x80 | (code >> 12 & 63));
    out[2] = (uint8_t)(0x80 | (code >> 6 & 63));
    out[3] = (uint8_t)(0x80 | (code & 63));
    return 4;
}

static bool name_hue(const uint32_t *codes, uint32_t count, double *hue)
{
    uint8_t *bytes = allocate((size_t)count * 4, 1);
    if (!bytes)
        return false;

    size_t length = 0;
    for (uint32_t i = 0; i < count; i++)
        length += encode_utf8(codes[i], bytes + length);
    const uint32_t word = sha256_first_word(bytes, length);

    free(bytes);
    *hue = (double)(word >> 16) / 65535;
    return true;
}

static double hls_channel(double value, double m1, double m2)
{
    const double h = fmod(fmod(value, 1) + 1, 1);
    if (h < 1.0 / 6)
        return m1 + (m2 - m1) * h * 6;
    if (h < 0.5)
        return m2;
    if (h < 2.0 / 3)
        return m1 + (m2 - m1) * (2.0 / 3 - h) * 6;
    return m1;
}

static void letter_background(double hue, uint8_t rgb[3])
{
    const double light = LETTER_LIGHT;
    const double saturation = LETTER_SATURATION;
    double m2 = light + saturation - light * saturation;
    if (light <= 0.5)
        m2 = light * (1 + saturation);
    const double m1 = 2 * light - m2;

    const double channels[3] = {
        hls_channel(hue + 1.0 / 3, m1, m2),
        hls_channel(hue, m1, m2),
        hls_channel(hue - 1.0 / 3, m1, m2),
    };
    for (uint32_t c = 0; c < 3; c++)
        rgb[c] = (uint8_t)trunc(channels[c] * 255);
}

static void fill_tile(MoonlightBitmap *tile, const uint8_t rgb[3])
{
    const size_t pixels = (size_t)tile->width * tile->height;
    for (size_t i = 0; i < pixels; i++) {
        uint8_t *pixel = tile->bytes + i * 4;
        pixel[0] = rgb[0];
        pixel[1] = rgb[1];
        pixel[2] = rgb[2];
        pixel[3] = 255;
    }
}

static uint32_t trim_name(Text *text, uint32_t *first)
{
    uint32_t start = 0;
    uint32_t end = text->count;
    while (start < end && is_js_space(text->codes[start]))
        start++;
    while (end > start && is_js_space(text->codes[end - 1]))
        end--;

    *first = start;
    return end - start;
}

static uint32_t initials_of(const uint32_t *name, uint32_t length, uint32_t *initials)
{
    uint32_t count = 0;
    uint32_t words = 0;
    for (uint32_t i = 0; i < length && words < MAX_INITIALS; i++) {
        const bool starts_word = !is_js_space(name[i]) && (i == 0 || is_js_space(name[i - 1]));
        if (!starts_word)
            continue;

        count += moonlightUppercase(name[i], initials + count);
        words++;
    }
    return count;
}

static Box text_box(const Layout *layout, const Face *face)
{
    Box box = {0, INFINITY, 0, -INFINITY};
    for (uint32_t r = 0; r < layout->run_count; r++) {
        const Run *run = &layout->runs[r];
        for (uint32_t p = run->first; p < run->first + run->count; p++) {
            const Glyph *glyph = layout->placed[p].glyph;
            if (!glyph->w || !glyph->h)
                continue;

            const double pen = js_round(run->x * 64) + (double)layout->placed[p].pen;
            const double x = floor((pen + 32) / 64) + glyph->dx;
            const double top = (double)face->ascent + glyph->dy;
            box.left = x < box.left ? x : box.left;
            box.top = top < box.top ? top : box.top;
            box.bottom = top + glyph->h > box.bottom ? top + glyph->h : box.bottom;
        }
    }

    box.right = floor(layout->length + 0.5);
    if (box.top == INFINITY) {
        box.top = 0;
        box.bottom = 0;
    }
    return box;
}

static bool paint_initials(const MoonlightGlyphs *glyphs, const Face *face, const uint32_t *initials, uint32_t count,
                           MoonlightBitmap *tile)
{
    Layout layout;
    if (!layout_create(&layout, count)) {
        layout_free(&layout);
        return false;
    }
    layout_text(face, initials, count, 0, &layout);

    const Box box = text_box(&layout, face);
    const double x = ((double)tile->width - (box.right - box.left)) / 2 - box.left;
    const double y = ((double)tile->height - (box.bottom - box.top)) / 2 - box.top;
    draw_runs(glyphs, tile, x, trunc(y) + face->ascent, &layout, &LETTER_INK);

    layout_free(&layout);
    return true;
}

static bool paint_letters(MoonlightGlyphs *glyphs, const uint32_t *name, uint32_t length, uint32_t width,
                          uint32_t height, MoonlightBitmap *out)
{
    double hue = 0;
    if (!name_hue(name, length, &hue))
        return false;
    uint8_t background[3];
    letter_background(hue, background);
    if (!bitmap_create(out, width, height, 4))
        return false;
    fill_tile(out, background);

    uint32_t initials[MAX_INITIALS * MOONLIGHT_UPPERCASE_MAX];
    const uint32_t count = initials_of(name, length, initials);
    const Face *face = face_at(glyphs, height / 2, LETTERS_WEIGHT);
    if (!face || !paint_initials(glyphs, face, initials, count, out)) {
        moonlightBitmapFree(out);
        return false;
    }
    return true;
}

bool moonlightGlyphsLetters(MoonlightGlyphs *glyphs, const char *utf8, uint32_t width, uint32_t height,
                            MoonlightBitmap *out)
{
    bitmap_clear(out);
    if (!glyphs || !utf8 || !out)
        return false;
    Text text;
    if (!text_decode(utf8, &text)) {
        text_free(&text);
        return false;
    }

    static const uint32_t UNNAMED[1] = {QUESTION_MARK};
    uint32_t first = 0;
    const uint32_t length = trim_name(&text, &first);
    const uint32_t *name = length ? text.codes + first : UNNAMED;
    const bool painted = paint_letters(glyphs, name, length ? length : 1, width, height, out);

    text_free(&text);
    return painted;
}

static bool atlas_header_ok(const uint8_t *atlas, size_t size)
{
    if (size < 12)
        return false;

    const bool magic = memcmp(atlas, "HBGA", 4) == 0;
    const uint32_t version = atlas[4] | (uint32_t)atlas[5] << 8;
    return magic && version == ATLAS_VERSION;
}

MoonlightGlyphs *moonlightGlyphsCreate(const uint8_t *atlas, size_t size)
{
    uint8_t *inflated = NULL;
    size_t inflated_size = 0;
    if (!moonlightInflate(atlas, size, MOONLIGHT_GLYPHS_MAX_ATLAS, &inflated, &inflated_size))
        return NULL;
    MoonlightGlyphs *glyphs = calloc(1, sizeof(MoonlightGlyphs));
    if (!glyphs || !atlas_header_ok(inflated, inflated_size)) {
        free(glyphs);
        free(inflated);
        return NULL;
    }

    glyphs->atlas = inflated;
    glyphs->size = inflated_size;
    glyphs->combo_count = read_u16(glyphs, 6);
    glyphs->table_count = read_u16(glyphs, 8);
    glyphs->ring_count = read_u16(glyphs, 10);
    glyphs->tables_at = HEADER_BYTES + (uint64_t)glyphs->combo_count * COMBO_BYTES;
    glyphs->rings_at = glyphs->tables_at + (uint64_t)glyphs->table_count * TABLE_BYTES;
    glyphs->faces = allocate(glyphs->combo_count, sizeof(Face *));
    if (!glyphs->faces) {
        moonlightGlyphsDestroy(glyphs);
        return NULL;
    }
    return glyphs;
}

void moonlightGlyphsDestroy(MoonlightGlyphs *glyphs)
{
    if (!glyphs)
        return;

    if (glyphs->faces) {
        for (uint32_t c = 0; c < glyphs->combo_count; c++)
            face_free(glyphs->faces[c]);
    }
    free(glyphs->faces);
    free(glyphs->atlas);
    free(glyphs);
}

void moonlightBitmapFree(MoonlightBitmap *bitmap)
{
    if (!bitmap)
        return;

    free(bitmap->bytes);
    memset(bitmap, 0, sizeof(*bitmap));
}
