#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "json.h"

#if defined(__clang__)
#pragma STDC FP_CONTRACT OFF
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

typedef struct {
    MoonlightJson *json;
    const char *text;
    size_t length;
    size_t at;
} Parser;

static bool whitespace(char c)
{
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

static void skip(Parser *p)
{
    while (p->at < p->length && whitespace(p->text[p->at]))
        p->at++;
}

static bool literal(Parser *p, const char *word)
{
    const size_t size = strlen(word);
    if (p->length - p->at < size || memcmp(p->text + p->at, word, size) != 0)
        return false;
    p->at += size;
    return true;
}

static uint16_t new_node(Parser *p, MoonlightJsonType type)
{
    if (p->json->node_count >= ML_JSON_MAX_NODES)
        return ML_JSON_NONE;
    const uint16_t index = (uint16_t)p->json->node_count++;
    p->json->nodes[index] = (MoonlightJsonNode){.type = type, .first = ML_JSON_NONE, .next = ML_JSON_NONE};
    return index;
}

static bool put(Parser *p, const char *bytes, size_t size)
{
    MoonlightJson *json = p->json;
    if (json->strings_used + size > ML_JSON_MAX_TEXT)
        return false;
    memcpy(json->strings + json->strings_used, bytes, size);
    json->strings_used += (uint32_t)size;
    return true;
}

static bool put_code_point(Parser *p, uint32_t code)
{
    char bytes[4];
    size_t size = 0;
    if (code < 0x80) {
        bytes[size++] = (char)code;
    } else if (code < 0x800) {
        bytes[size++] = (char)(0xc0 | (code >> 6));
        bytes[size++] = (char)(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
        bytes[size++] = (char)(0xe0 | (code >> 12));
        bytes[size++] = (char)(0x80 | ((code >> 6) & 0x3f));
        bytes[size++] = (char)(0x80 | (code & 0x3f));
    } else {
        bytes[size++] = (char)(0xf0 | (code >> 18));
        bytes[size++] = (char)(0x80 | ((code >> 12) & 0x3f));
        bytes[size++] = (char)(0x80 | ((code >> 6) & 0x3f));
        bytes[size++] = (char)(0x80 | (code & 0x3f));
    }
    return put(p, bytes, size);
}

static bool hex4(Parser *p, uint32_t *out)
{
    if (p->length - p->at < 4)
        return false;
    uint32_t value = 0;
    for (int i = 0; i < 4; i++) {
        const char c = p->text[p->at++];
        value <<= 4;
        if (c >= '0' && c <= '9')
            value |= (uint32_t)(c - '0');
        else if (c >= 'a' && c <= 'f')
            value |= (uint32_t)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F')
            value |= (uint32_t)(c - 'A' + 10);
        else
            return false;
    }
    *out = value;
    return true;
}

static bool escape(Parser *p)
{
    if (p->at >= p->length)
        return false;
    const char c = p->text[p->at++];
    const char *from = "\"\\/bfnrt";
    const char *to = "\"\\/\b\f\n\r\t";
    const char *found = strchr(from, c);
    if (found && c)
        return put(p, to + (found - from), 1);
    if (c != 'u')
        return false;

    uint32_t code = 0;
    if (!hex4(p, &code))
        return false;
    const bool high = code >= 0xd800 && code < 0xdc00;
    const bool pair = p->length - p->at >= 6 && p->text[p->at] == '\\' && p->text[p->at + 1] == 'u';
    if (high && pair) {
        const size_t mark = p->at;
        uint32_t low = 0;
        p->at += 2;
        if (hex4(p, &low) && low >= 0xdc00 && low < 0xe000)
            return put_code_point(p, 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00));
        p->at = mark;
    }
    return put_code_point(p, code);
}

static bool string(Parser *p, uint32_t *offset, uint32_t *length)
{
    if (p->at >= p->length || p->text[p->at] != '"')
        return false;
    p->at++;
    *offset = p->json->strings_used;
    while (p->at < p->length) {
        const unsigned char c = (unsigned char)p->text[p->at++];
        if (c == '"') {
            *length = p->json->strings_used - *offset;
            return put(p, "", 1);
        }
        if (c < 0x20)
            return false;
        if (c == '\\') {
            if (!escape(p))
                return false;
        } else if (!put(p, (const char *)&c, 1)) {
            return false;
        }
    }
    return false;
}

static bool digits(Parser *p)
{
    const size_t start = p->at;
    while (p->at < p->length && p->text[p->at] >= '0' && p->text[p->at] <= '9')
        p->at++;
    return p->at > start;
}

static bool number(Parser *p, double *out)
{
    const size_t start = p->at;
    if (p->at < p->length && p->text[p->at] == '-')
        p->at++;
    if (p->at < p->length && p->text[p->at] == '0')
        p->at++;
    else if (!digits(p))
        return false;
    if (p->at < p->length && p->text[p->at] == '.') {
        p->at++;
        if (!digits(p))
            return false;
    }
    if (p->at < p->length && (p->text[p->at] == 'e' || p->text[p->at] == 'E')) {
        p->at++;
        if (p->at < p->length && (p->text[p->at] == '+' || p->text[p->at] == '-'))
            p->at++;
        if (!digits(p))
            return false;
    }

    char buffer[64];
    const size_t size = p->at - start;
    if (size >= sizeof(buffer))
        return false;
    memcpy(buffer, p->text + start, size);
    buffer[size] = 0;
    *out = strtod(buffer, NULL);
    return true;
}

static uint16_t value(Parser *p, unsigned depth);

static bool members(Parser *p, uint16_t parent, unsigned depth, bool object)
{
    const char close = object ? '}' : ']';
    skip(p);
    if (p->at < p->length && p->text[p->at] == close) {
        p->at++;
        return true;
    }

    uint16_t last = ML_JSON_NONE;
    for (;;) {
        uint32_t key = 0;
        uint32_t key_length = 0;
        if (object) {
            skip(p);
            if (!string(p, &key, &key_length))
                return false;
            skip(p);
            if (p->at >= p->length || p->text[p->at++] != ':')
                return false;
        }
        const uint16_t child = value(p, depth + 1);
        if (child == ML_JSON_NONE)
            return false;

        MoonlightJsonNode *nodes = p->json->nodes;
        nodes[child].key = key;
        nodes[child].key_length = key_length;
        if (last == ML_JSON_NONE)
            nodes[parent].first = child;
        else
            nodes[last].next = child;
        last = child;
        nodes[parent].count++;

        skip(p);
        if (p->at >= p->length)
            return false;
        const char c = p->text[p->at++];
        if (c == close)
            return true;
        if (c != ',')
            return false;
    }
}

static uint16_t value(Parser *p, unsigned depth)
{
    if (depth > ML_JSON_MAX_DEPTH)
        return ML_JSON_NONE;
    skip(p);
    if (p->at >= p->length)
        return ML_JSON_NONE;

    const size_t start = p->at;
    const char c = p->text[p->at];
    uint16_t node = ML_JSON_NONE;
    if (c == '{' || c == '[') {
        node = new_node(p, c == '{' ? ML_JSON_OBJECT : ML_JSON_ARRAY);
        p->at++;
        if (node == ML_JSON_NONE || !members(p, node, depth, c == '{'))
            return ML_JSON_NONE;
    } else if (c == '"') {
        node = new_node(p, ML_JSON_STRING);
        if (node == ML_JSON_NONE || !string(p, &p->json->nodes[node].text, &p->json->nodes[node].length))
            return ML_JSON_NONE;
    } else if (literal(p, "null")) {
        node = new_node(p, ML_JSON_NULL);
    } else if (literal(p, "true")) {
        node = new_node(p, ML_JSON_TRUE);
    } else if (literal(p, "false")) {
        node = new_node(p, ML_JSON_FALSE);
    } else {
        double parsed = 0;
        if (!number(p, &parsed))
            return ML_JSON_NONE;
        node = new_node(p, ML_JSON_NUMBER);
        if (node != ML_JSON_NONE)
            p->json->nodes[node].number = parsed;
    }

    if (node != ML_JSON_NONE) {
        p->json->nodes[node].start = (uint32_t)start;
        p->json->nodes[node].end = (uint32_t)p->at;
    }
    return node;
}

bool moonlightJsonParse(MoonlightJson *json, const char *text, size_t length)
{
    json->node_count = 0;
    json->strings_used = 0;
    json->source = text;
    if (!text || length > ML_JSON_MAX_TEXT)
        return false;

    Parser p = {json, text, length, 0};
    if (length >= 3 && memcmp(text, "\xef\xbb\xbf", 3) == 0)
        return false;
    if (value(&p, 0) != 0)
        return false;
    skip(&p);
    return p.at == length;
}

const MoonlightJsonNode *moonlightJsonRoot(const MoonlightJson *json)
{
    return json->node_count ? &json->nodes[0] : NULL;
}

const MoonlightJsonNode *moonlightJsonChild(const MoonlightJson *json, const MoonlightJsonNode *node)
{
    if (!node || node->first == ML_JSON_NONE)
        return NULL;
    return &json->nodes[node->first];
}

const MoonlightJsonNode *moonlightJsonNext(const MoonlightJson *json, const MoonlightJsonNode *node)
{
    if (!node || node->next == ML_JSON_NONE)
        return NULL;
    return &json->nodes[node->next];
}

const MoonlightJsonNode *moonlightJsonMember(const MoonlightJson *json, const MoonlightJsonNode *object, const char *key)
{
    if (!object || object->type != ML_JSON_OBJECT)
        return NULL;

    const size_t size = strlen(key);
    const MoonlightJsonNode *found = NULL;
    for (const MoonlightJsonNode *child = moonlightJsonChild(json, object); child; child = moonlightJsonNext(json, child)) {
        if (child->key_length == size && memcmp(json->strings + child->key, key, size) == 0)
            found = child;
    }
    return found;
}

bool moonlightJsonStringIs(const MoonlightJson *json, const MoonlightJsonNode *node, const char *text)
{
    if (!node || node->type != ML_JSON_STRING)
        return false;
    const size_t size = strlen(text);
    return node->length == size && memcmp(json->strings + node->text, text, size) == 0;
}

static bool js_space(const unsigned char *s, size_t length, size_t at, size_t *size)
{
    const unsigned char c = s[at];
    if (c == ' ' || (c >= '\t' && c <= '\r')) {
        *size = 1;
        return true;
    }
    if (c == 0xc2 && at + 1 < length && s[at + 1] == 0xa0) {
        *size = 2;
        return true;
    }
    if (c == 0xef && at + 2 < length && s[at + 1] == 0xbb && s[at + 2] == 0xbf) {
        *size = 3;
        return true;
    }
    const bool e2 = c == 0xe2 && at + 2 < length;
    if (e2 && s[at + 1] == 0x80 && (s[at + 2] == 0xa8 || s[at + 2] == 0xa9 || s[at + 2] <= 0x8a || s[at + 2] == 0xaf)) {
        *size = 3;
        return true;
    }
    if (e2 && s[at + 1] == 0x81 && s[at + 2] == 0x9f) {
        *size = 3;
        return true;
    }
    if (c == 0xe3 && at + 2 < length && s[at + 1] == 0x80 && s[at + 2] == 0x80) {
        *size = 3;
        return true;
    }
    if (c == 0xe1 && at + 2 < length && s[at + 1] == 0x9a && s[at + 2] == 0x80) {
        *size = 3;
        return true;
    }
    return false;
}

static double radix_number(const char *s, size_t length, unsigned base)
{
    if (length == 0)
        return NAN;
    double value = 0;
    for (size_t i = 0; i < length; i++) {
        const char c = s[i];
        unsigned digit = 99;
        if (c >= '0' && c <= '9')
            digit = (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'z')
            digit = (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'Z')
            digit = (unsigned)(c - 'A' + 10);
        if (digit >= base)
            return NAN;
        value = value * base + digit;
    }
    return value;
}

static double decimal_number(const char *s, size_t length)
{
    size_t at = 0;
    if (at < length && (s[at] == '+' || s[at] == '-'))
        at++;
    if (length - at == 8 && memcmp(s + at, "Infinity", 8) == 0)
        return s[0] == '-' ? -INFINITY : INFINITY;

    size_t whole = 0;
    while (at < length && s[at] >= '0' && s[at] <= '9') {
        at++;
        whole++;
    }
    size_t fraction = 0;
    if (at < length && s[at] == '.') {
        at++;
        while (at < length && s[at] >= '0' && s[at] <= '9') {
            at++;
            fraction++;
        }
    }
    if (!whole && !fraction)
        return NAN;
    if (at < length && (s[at] == 'e' || s[at] == 'E')) {
        at++;
        if (at < length && (s[at] == '+' || s[at] == '-'))
            at++;
        size_t exponent = 0;
        while (at < length && s[at] >= '0' && s[at] <= '9') {
            at++;
            exponent++;
        }
        if (!exponent)
            return NAN;
    }
    if (at != length || length >= 512)
        return NAN;

    char buffer[512];
    memcpy(buffer, s, length);
    buffer[length] = 0;
    return strtod(buffer, NULL);
}

static bool space_ends_at(const unsigned char *s, size_t start, size_t end, size_t *size)
{
    for (size_t candidate = 1; candidate <= 3 && candidate <= end - start; candidate++) {
        size_t found = 0;
        if (js_space(s, end, end - candidate, &found) && found == candidate) {
            *size = candidate;
            return true;
        }
    }
    return false;
}

static double string_number(const char *text, size_t length)
{
    const unsigned char *s = (const unsigned char *)text;
    size_t start = 0;
    size_t end = length;
    size_t size = 0;
    while (start < end && js_space(s, end, start, &size))
        start += size;
    while (end > start && space_ends_at(s, start, end, &size))
        end -= size;

    const char *t = text + start;
    const size_t n = end - start;
    if (n == 0)
        return 0;
    if (n > 2 && t[0] == '0' && (t[1] == 'x' || t[1] == 'X'))
        return radix_number(t + 2, n - 2, 16);
    if (n > 2 && t[0] == '0' && (t[1] == 'o' || t[1] == 'O'))
        return radix_number(t + 2, n - 2, 8);
    if (n > 2 && t[0] == '0' && (t[1] == 'b' || t[1] == 'B'))
        return radix_number(t + 2, n - 2, 2);
    return decimal_number(t, n);
}

double moonlightJsonToNumber(const MoonlightJson *json, const MoonlightJsonNode *node)
{
    if (!node)
        return NAN;

    switch (node->type) {
    case ML_JSON_NULL:
    case ML_JSON_FALSE:
        return 0;
    case ML_JSON_TRUE:
        return 1;
    case ML_JSON_NUMBER:
        return node->number;
    case ML_JSON_STRING:
        return string_number(json->strings + node->text, node->length);
    case ML_JSON_ARRAY:
        if (node->count == 0)
            return 0;
        if (node->count > 1)
            return NAN;
        {
            const MoonlightJsonNode *only = moonlightJsonChild(json, node);
            if (only->type == ML_JSON_TRUE || only->type == ML_JSON_FALSE || only->type == ML_JSON_OBJECT)
                return NAN;
            return moonlightJsonToNumber(json, only);
        }
    case ML_JSON_OBJECT:
        return NAN;
    }
    return NAN;
}
