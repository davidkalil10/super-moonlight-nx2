// A small inflate after the canonical-code decoder of zlib's puff: stored, fixed and dynamic blocks,
// the zlib header and its Adler-32, and no output past the caller's limit.
#include <stdlib.h>
#include <string.h>

#include "inflate.h"

#define MAX_BITS 15
#define MAX_LITERALS 288
#define MAX_DISTANCES 30
#define LENGTH_CODES 29
#define CODE_LENGTH_CODES 19
#define END_OF_BLOCK 256
#define FIRST_CAPACITY 65536u
#define ADLER_MODULUS 65521u

typedef struct {
    const uint8_t *input;
    size_t size;
    size_t at;
    uint32_t bits;
    uint32_t bit_count;
    uint8_t *output;
    size_t length;
    size_t capacity;
    size_t limit;
    bool failed;
} Stream;

typedef struct {
    uint16_t counts[MAX_BITS + 1];
    uint16_t symbols[MAX_LITERALS];
} Huffman;

static const uint16_t LENGTH_BASE[LENGTH_CODES] = {
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
};
static const uint8_t LENGTH_EXTRA[LENGTH_CODES] = {
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
};
static const uint16_t DISTANCE_BASE[MAX_DISTANCES] = {
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
    6145, 8193, 12289, 16385, 24577,
};
static const uint8_t DISTANCE_EXTRA[MAX_DISTANCES] = {
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
};
static const uint8_t CODE_LENGTH_ORDER[CODE_LENGTH_CODES] = {
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
};

static uint32_t take_bits(Stream *stream, uint32_t need)
{
    uint32_t value = stream->bits;
    while (stream->bit_count < need) {
        if (stream->at >= stream->size) {
            stream->failed = true;
            return 0;
        }
        value |= (uint32_t)stream->input[stream->at++] << stream->bit_count;
        stream->bit_count += 8;
    }

    stream->bits = value >> need;
    stream->bit_count -= need;
    return value & ((1u << need) - 1u);
}

static bool reserve(Stream *stream, size_t extra)
{
    if (extra > stream->limit - stream->length)
        return false;
    const size_t needed = stream->length + extra;
    if (needed <= stream->capacity)
        return true;

    size_t capacity = stream->capacity ? stream->capacity : FIRST_CAPACITY;
    while (capacity < needed)
        capacity *= 2;
    if (capacity > stream->limit)
        capacity = stream->limit;

    uint8_t *grown = realloc(stream->output, capacity);
    if (!grown)
        return false;
    stream->output = grown;
    stream->capacity = capacity;
    return true;
}

static bool build_huffman(Huffman *huffman, const uint8_t *lengths, uint32_t count)
{
    memset(huffman->counts, 0, sizeof(huffman->counts));
    for (uint32_t symbol = 0; symbol < count; symbol++)
        huffman->counts[lengths[symbol]]++;

    int32_t left = 1;
    for (uint32_t length = 1; length <= MAX_BITS; length++) {
        left = left * 2 - huffman->counts[length];
        if (left < 0)
            return false;
    }

    uint16_t offsets[MAX_BITS + 1];
    offsets[1] = 0;
    for (uint32_t length = 1; length < MAX_BITS; length++)
        offsets[length + 1] = offsets[length] + huffman->counts[length];
    for (uint32_t symbol = 0; symbol < count; symbol++) {
        if (lengths[symbol])
            huffman->symbols[offsets[lengths[symbol]]++] = (uint16_t)symbol;
    }
    return true;
}

static int32_t decode_symbol(Stream *stream, const Huffman *huffman)
{
    int32_t code = 0;
    int32_t first = 0;
    int32_t index = 0;
    for (uint32_t length = 1; length <= MAX_BITS; length++) {
        code |= (int32_t)take_bits(stream, 1);
        if (stream->failed)
            return -1;

        const int32_t count = huffman->counts[length];
        if (code - first < count)
            return huffman->symbols[index + code - first];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
    }
    return -1;
}

static bool copy_match(Stream *stream, uint32_t length, uint32_t distance)
{
    if (distance > stream->length || !reserve(stream, length))
        return false;

    uint8_t *out = stream->output;
    for (uint32_t i = 0; i < length; i++) {
        out[stream->length] = out[stream->length - distance];
        stream->length++;
    }
    return true;
}

static bool inflate_codes(Stream *stream, const Huffman *literals, const Huffman *distances)
{
    for (;;) {
        const int32_t symbol = decode_symbol(stream, literals);
        if (symbol < 0)
            return false;
        if (symbol == END_OF_BLOCK)
            return true;

        if (symbol < END_OF_BLOCK) {
            if (!reserve(stream, 1))
                return false;
            stream->output[stream->length++] = (uint8_t)symbol;
            continue;
        }

        const int32_t length_code = symbol - END_OF_BLOCK - 1;
        if (length_code >= LENGTH_CODES)
            return false;
        const uint32_t length = LENGTH_BASE[length_code] + take_bits(stream, LENGTH_EXTRA[length_code]);

        const int32_t distance_code = decode_symbol(stream, distances);
        if (distance_code < 0 || distance_code >= MAX_DISTANCES)
            return false;
        const uint32_t distance = DISTANCE_BASE[distance_code] + take_bits(stream, DISTANCE_EXTRA[distance_code]);
        if (stream->failed || !copy_match(stream, length, distance))
            return false;
    }
}

static bool inflate_stored(Stream *stream)
{
    stream->bits = 0;
    stream->bit_count = 0;
    if (stream->size - stream->at < 4)
        return false;

    const uint8_t *header = stream->input + stream->at;
    const uint32_t length = header[0] | (uint32_t)header[1] << 8;
    const uint32_t complement = header[2] | (uint32_t)header[3] << 8;
    stream->at += 4;
    if (length != (~complement & 0xffffu))
        return false;
    if (stream->size - stream->at < length || !reserve(stream, length))
        return false;

    memcpy(stream->output + stream->length, stream->input + stream->at, length);
    stream->at += length;
    stream->length += length;
    return true;
}

static bool inflate_fixed(Stream *stream)
{
    uint8_t lengths[MAX_LITERALS];
    for (uint32_t symbol = 0; symbol < MAX_LITERALS; symbol++) {
        if (symbol < 144)
            lengths[symbol] = 8;
        else if (symbol < 256)
            lengths[symbol] = 9;
        else if (symbol < 280)
            lengths[symbol] = 7;
        else
            lengths[symbol] = 8;
    }

    Huffman literals;
    Huffman distances;
    build_huffman(&literals, lengths, MAX_LITERALS);
    memset(lengths, 5, MAX_DISTANCES);
    build_huffman(&distances, lengths, MAX_DISTANCES);
    return inflate_codes(stream, &literals, &distances);
}

static bool read_code_lengths(Stream *stream, uint8_t *lengths, uint32_t total)
{
    const uint32_t code_count = take_bits(stream, 4) + 4;
    uint8_t code_lengths[CODE_LENGTH_CODES] = {0};
    for (uint32_t i = 0; i < code_count; i++)
        code_lengths[CODE_LENGTH_ORDER[i]] = (uint8_t)take_bits(stream, 3);

    Huffman codes;
    if (stream->failed || !build_huffman(&codes, code_lengths, CODE_LENGTH_CODES))
        return false;

    uint32_t at = 0;
    while (at < total) {
        const int32_t symbol = decode_symbol(stream, &codes);
        if (symbol < 0)
            return false;
        if (symbol < 16) {
            lengths[at++] = (uint8_t)symbol;
            continue;
        }

        uint8_t repeated = 0;
        uint32_t repeat = 0;
        if (symbol == 16) {
            if (at == 0)
                return false;
            repeated = lengths[at - 1];
            repeat = 3 + take_bits(stream, 2);
        } else if (symbol == 17) {
            repeat = 3 + take_bits(stream, 3);
        } else {
            repeat = 11 + take_bits(stream, 7);
        }
        if (stream->failed || repeat > total - at)
            return false;
        memset(lengths + at, repeated, repeat);
        at += repeat;
    }
    return true;
}

static bool inflate_dynamic(Stream *stream)
{
    const uint32_t literal_count = take_bits(stream, 5) + 257;
    const uint32_t distance_count = take_bits(stream, 5) + 1;
    if (stream->failed || literal_count > 286 || distance_count > MAX_DISTANCES)
        return false;

    uint8_t lengths[MAX_LITERALS + MAX_DISTANCES];
    if (!read_code_lengths(stream, lengths, literal_count + distance_count))
        return false;
    if (lengths[END_OF_BLOCK] == 0)
        return false;

    Huffman literals;
    Huffman distances;
    if (!build_huffman(&literals, lengths, literal_count))
        return false;
    if (!build_huffman(&distances, lengths + literal_count, distance_count))
        return false;
    return inflate_codes(stream, &literals, &distances);
}

static bool inflate_blocks(Stream *stream)
{
    bool last = false;
    while (!last) {
        last = take_bits(stream, 1) == 1;
        const uint32_t type = take_bits(stream, 2);
        if (stream->failed)
            return false;

        bool inflated = false;
        if (type == 0)
            inflated = inflate_stored(stream);
        else if (type == 1)
            inflated = inflate_fixed(stream);
        else if (type == 2)
            inflated = inflate_dynamic(stream);
        if (!inflated)
            return false;
    }
    return true;
}

static uint32_t adler32(const uint8_t *bytes, size_t length)
{
    uint32_t low = 1;
    uint32_t high = 0;
    for (size_t i = 0; i < length; i++) {
        low = (low + bytes[i]) % ADLER_MODULUS;
        high = (high + low) % ADLER_MODULUS;
    }
    return high << 16 | low;
}

static bool zlib_header_ok(const uint8_t *input, size_t size)
{
    if (size < 2)
        return false;

    const uint32_t method = input[0] & 15u;
    const uint32_t window = input[0] >> 4;
    const bool preset_dictionary = (input[1] & 0x20u) != 0;
    const bool checked = ((uint32_t)input[0] << 8 | input[1]) % 31 == 0;
    return method == 8 && window <= 7 && !preset_dictionary && checked;
}

static bool adler_matches(Stream *stream)
{
    stream->bits = 0;
    stream->bit_count = 0;
    if (stream->size - stream->at < 4)
        return false;

    const uint8_t *trailer = stream->input + stream->at;
    const uint32_t expected = (uint32_t)trailer[0] << 24 | (uint32_t)trailer[1] << 16 | (uint32_t)trailer[2] << 8 |
                              trailer[3];
    return adler32(stream->output, stream->length) == expected;
}

bool moonlightInflate(const uint8_t *input, size_t size, size_t limit, uint8_t **output, size_t *output_size)
{
    *output = NULL;
    *output_size = 0;
    if (!input || !zlib_header_ok(input, size))
        return false;

    Stream stream = {.input = input, .size = size, .at = 2, .limit = limit};
    const bool inflated = inflate_blocks(&stream) && reserve(&stream, 1) && adler_matches(&stream);
    if (!inflated) {
        free(stream.output);
        return false;
    }

    uint8_t *exact = realloc(stream.output, stream.length ? stream.length : 1);
    *output = exact ? exact : stream.output;
    *output_size = stream.length;
    return true;
}
