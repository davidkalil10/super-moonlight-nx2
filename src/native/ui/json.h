#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// A bounded JSON reader for settings records: one parse into a fixed node table, no allocation.
#define ML_JSON_MAX_NODES 2048u
#define ML_JSON_MAX_DEPTH 64u
#define ML_JSON_MAX_TEXT 4096u

typedef enum {
    ML_JSON_NULL,
    ML_JSON_FALSE,
    ML_JSON_TRUE,
    ML_JSON_NUMBER,
    ML_JSON_STRING,
    ML_JSON_ARRAY,
    ML_JSON_OBJECT,
} MoonlightJsonType;

typedef struct {
    MoonlightJsonType type;
    double number;
    uint32_t text;
    uint32_t length;
    uint32_t key;
    uint32_t key_length;
    uint32_t start;
    uint32_t end;
    uint16_t first;
    uint16_t next;
    uint16_t count;
} MoonlightJsonNode;

typedef struct {
    MoonlightJsonNode nodes[ML_JSON_MAX_NODES];
    uint32_t node_count;
    char strings[ML_JSON_MAX_TEXT];
    uint32_t strings_used;
    const char *source;
} MoonlightJson;

#define ML_JSON_NONE 0xffffu

bool moonlightJsonParse(MoonlightJson *json, const char *text, size_t length);
const MoonlightJsonNode *moonlightJsonRoot(const MoonlightJson *json);
const MoonlightJsonNode *moonlightJsonMember(const MoonlightJson *json, const MoonlightJsonNode *object, const char *key);
const MoonlightJsonNode *moonlightJsonChild(const MoonlightJson *json, const MoonlightJsonNode *node);
const MoonlightJsonNode *moonlightJsonNext(const MoonlightJson *json, const MoonlightJsonNode *node);
bool moonlightJsonStringIs(const MoonlightJson *json, const MoonlightJsonNode *node, const char *text);
double moonlightJsonToNumber(const MoonlightJson *json, const MoonlightJsonNode *node);
