#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "../ui.h"
#include "composer.h"
#include "page.h"

// The console half of the UI (src/streamer/civ7/console-ui.js) over the renderer's storage:
// shader commands into the model, composed pages into the buffer not shown, the header words.
#define ML_UI_BLOCK 0xc000u
#define ML_UI_MAGIC_WORD (ML_UI_BLOCK + 0u)
#define ML_UI_EPOCH (ML_UI_BLOCK + 4u)
#define ML_UI_SEQUENCE (ML_UI_BLOCK + 8u)
#define ML_UI_PAGE (ML_UI_BLOCK + 12u)
#define ML_UI_APPLIED (ML_UI_BLOCK + 16u)
#define ML_UI_CURSOR (ML_UI_BLOCK + 20u)
#define ML_UI_OVERLAY (ML_UI_BLOCK + 24u)
#define ML_UI_TOUCH_ITEM (ML_UI_BLOCK + 28u)
#define ML_UI_CMD_SEQUENCE (ML_UI_BLOCK + 32u)
#define ML_UI_CMD_OP (ML_UI_BLOCK + 36u)
#define ML_UI_CMD_ITEM (ML_UI_BLOCK + 40u)
#define ML_UI_CMD_VALUE (ML_UI_BLOCK + 44u)
#define ML_UI_CMD_PAGE (ML_UI_BLOCK + 48u)
#define ML_UI_CMD_EPOCH (ML_UI_BLOCK + 52u)
#define ML_UI_SHOWN (ML_UI_BLOCK + 56u)
#define ML_UI_EDIT (ML_UI_BLOCK + 60u)
#define ML_UI_HOST_ACK (ML_UI_BLOCK + 64u)
#define ML_UI_HOST_BUSY (ML_UI_BLOCK + 68u)
#define ML_UI_PROTOCOL_MAGIC 0x49554248u
#define ML_UI_PAGES_OFFSET 40030208u
#define ML_UI_PAGE_BUFFER_BYTES 4194304u
#define ML_UI_APPLY_TIMEOUT_NS UINT64_C(5000000000)
#define ML_UI_MAX_QUEUED 16u

typedef struct {
    uint8_t *storage;
    MoonlightSettingsStore *store;
    MoonlightUiModel model;
    const char *storage_error;
    uint64_t revision;
    uint32_t epoch;
    uint32_t sequence;
    uint32_t applied;
    uint32_t seen;
    bool has_header;
    uint32_t header[4];
    bool has_shown;
    MoonlightScreen shown_screen;
    uint64_t published_at;
    bool stale;
    uint32_t header_rewrites;
    uint32_t apply_timeouts;
    uint32_t intent_count;
    uint32_t dropped_intents;
    MoonlightUiIntent intents[ML_UI_MAX_QUEUED];
    bool composed;
    uint64_t composed_revision;
    MoonlightPagePlacement placed[2];
    bool placed_valid[2];
} MoonlightUiBridge;

void moonlightUiBridgeInit(MoonlightUiBridge *bridge, uint8_t *storage, const MoonlightHost *hosts, uint32_t host_count,
    MoonlightSettingsStore *store, const MoonlightCapabilities *capabilities, uint32_t epoch_hint);
void moonlightUiBridgeDispatch(MoonlightUiBridge *bridge, const MoonlightUiEvent *event);
void moonlightUiBridgePoll(MoonlightUiBridge *bridge, uint64_t now_ns);
const char *moonlightUiBridgeShow(MoonlightUiBridge *bridge, uint32_t sequence, MoonlightScreen screen, uint64_t now_ns);
const char *moonlightUiBridgePublish(MoonlightUiBridge *bridge, MoonlightComposer *composer, uint64_t now_ns,
    bool *published);
uint32_t moonlightUiBridgeNextSequence(const MoonlightUiBridge *bridge);
uint32_t moonlightUiBridgeTakeIntents(MoonlightUiBridge *bridge, MoonlightUiIntent *out, uint32_t capacity);
bool moonlightUiBridgeInteractive(const MoonlightUiBridge *bridge);
bool moonlightUiBridgeAllowInput(const MoonlightUiBridge *bridge);
void moonlightUiBridgeSetBusy(MoonlightUiBridge *bridge, bool busy);
void moonlightUiBridgeClose(MoonlightUiBridge *bridge);
