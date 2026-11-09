#include <string.h>

#include "bridge.h"

#define SAVE_FAILED "Settings write failed"

static uint32_t word(const MoonlightUiBridge *bridge, uint32_t offset)
{
    uint32_t value;
    memcpy(&value, bridge->storage + offset, sizeof(value));
    return value;
}

static void put(MoonlightUiBridge *bridge, uint32_t offset, uint32_t value)
{
    memcpy(bridge->storage + offset, &value, sizeof(value));
}

static uint8_t *page_buffer(const MoonlightUiBridge *bridge, uint32_t slot)
{
    return bridge->storage + ML_UI_PAGES_OFFSET + slot * ML_UI_PAGE_BUFFER_BYTES;
}

static void write_header(MoonlightUiBridge *bridge, const uint32_t words[4])
{
    memcpy(bridge->storage + ML_UI_MAGIC_WORD, words, 4 * sizeof(uint32_t));
}

static bool header_holds(const MoonlightUiBridge *bridge, const uint32_t words[4])
{
    return memcmp(bridge->storage + ML_UI_MAGIC_WORD, words, 4 * sizeof(uint32_t)) == 0;
}

static uint32_t following(uint32_t value)
{
    const uint32_t next = value + 1;
    return next ? next : 1;
}

uint32_t moonlightUiBridgeNextSequence(const MoonlightUiBridge *bridge)
{
    const uint32_t next = following(bridge->sequence);
    const bool on_applied_page = (next & 1) == (bridge->applied & 1) && bridge->applied != 0;
    return on_applied_page ? following(next) : next;
}

static void sync_applied(MoonlightUiBridge *bridge)
{
    if (bridge->has_header)
        bridge->applied = word(bridge, ML_UI_APPLIED);
}

static void save_settings(MoonlightUiBridge *bridge)
{
    if (!bridge->store) {
        bridge->storage_error = NULL;
        return;
    }
    const bool saved = moonlightSettingsSave(bridge->store, &bridge->model.settings);
    bridge->storage_error = saved ? NULL : SAVE_FAILED;
}

static void queue(MoonlightUiBridge *bridge, const MoonlightUiIntent *intent)
{
    if (bridge->intent_count >= ML_UI_MAX_QUEUED) {
        bridge->dropped_intents++;
        return;
    }
    bridge->intents[bridge->intent_count++] = *intent;
}

void moonlightUiBridgeDispatch(MoonlightUiBridge *bridge, const MoonlightUiEvent *event)
{
    const char *before = bridge->storage_error;
    MoonlightUiStep step;
    moonlightUiReduce(&bridge->model, event, &step);
    if (step.changed)
        bridge->revision++;

    for (uint32_t i = 0; i < step.count; i++) {
        const MoonlightUiIntentType type = step.intents[i].type;
        if (type == MOONLIGHT_INTENT_SAVE_SETTINGS)
            save_settings(bridge);
        else if (type != MOONLIGHT_INTENT_PAUSE_INPUT && type != MOONLIGHT_INTENT_RESUME_INPUT)
            queue(bridge, &step.intents[i]);
    }
    if (bridge->storage_error != before)
        bridge->revision++;
    sync_applied(bridge);
}

void moonlightUiBridgeInit(MoonlightUiBridge *bridge, uint8_t *storage, const MoonlightHost *hosts, uint32_t host_count,
    MoonlightSettingsStore *store, const MoonlightCapabilities *capabilities, uint32_t epoch_hint)
{
    memset(bridge, 0, sizeof(*bridge));
    bridge->storage = storage;
    bridge->store = store;

    MoonlightSettings settings;
    MoonlightSettingsSource source = MOONLIGHT_SETTINGS_DEFAULTS;
    if (store)
        source = moonlightSettingsLoad(store, &settings);
    else
        moonlightSettingsDefaults(&settings);
    moonlightUiInit(&bridge->model, hosts, host_count, &settings, capabilities);
    if (store && source != MOONLIGHT_SETTINGS_LOADED)
        save_settings(bridge);

    bridge->seen = word(bridge, ML_UI_CMD_SEQUENCE);
    const uint32_t shown_slot = word(bridge, ML_UI_SHOWN) & 1;
    uint32_t shown[2];
    memcpy(shown, page_buffer(bridge, shown_slot), sizeof(shown));
    const uint32_t shown_epoch = shown[0] == ML_PAGE_MAGIC ? shown[1] : 0;
    const uint32_t after_shown = shown_epoch + 1;
    uint32_t epoch = epoch_hint > after_shown ? epoch_hint : after_shown;
    bridge->epoch = epoch ? epoch : 1;
    bridge->sequence = word(bridge, ML_UI_APPLIED);
    bridge->applied = bridge->sequence;

    const uint32_t zero[4] = {0, 0, 0, 0};
    write_header(bridge, zero);
}

const char *moonlightUiBridgeShow(MoonlightUiBridge *bridge, uint32_t sequence, MoonlightScreen screen, uint64_t now_ns)
{
    const uint32_t next = moonlightUiBridgeNextSequence(bridge);
    if (sequence != next)
        return "UI page is not the next page";

    uint32_t page[3];
    memcpy(page, page_buffer(bridge, next & 1), sizeof(page));
    const bool page_ok = page[0] == ML_PAGE_MAGIC && page[1] == bridge->epoch && page[2] == next;
    if (!page_ok)
        return "UI page is not in its buffer";

    const uint32_t words[4] = {ML_UI_PROTOCOL_MAGIC, bridge->epoch, next, next & 1};
    memcpy(bridge->header, words, sizeof(words));
    bridge->has_header = true;
    write_header(bridge, words);
    bridge->sequence = next;
    bridge->shown_screen = screen;
    bridge->has_shown = true;
    bridge->published_at = now_ns;
    bridge->stale = false;
    sync_applied(bridge);
    return NULL;
}

static void watch(MoonlightUiBridge *bridge, uint64_t now_ns)
{
    if (!bridge->has_header || bridge->applied == bridge->sequence)
        return;
    bridge->applied = word(bridge, ML_UI_APPLIED);
    if (bridge->applied == bridge->sequence)
        return;

    if (!header_holds(bridge, bridge->header)) {
        write_header(bridge, bridge->header);
        bridge->header_rewrites++;
    }
    if (!bridge->stale && now_ns - bridge->published_at > ML_UI_APPLY_TIMEOUT_NS) {
        bridge->apply_timeouts++;
        bridge->stale = true;
    }
}

static bool shown_is(const MoonlightUiBridge *bridge, MoonlightScreen screen)
{
    return bridge->model.screen == screen && bridge->has_shown && bridge->shown_screen == screen;
}

static void command(MoonlightUiBridge *bridge, MoonlightUiOp op, uint32_t item, int32_t value)
{
    const MoonlightUiEvent event = {.type = MOONLIGHT_EVENT_COMMAND, .op = op, .item = item, .value = value};
    moonlightUiBridgeDispatch(bridge, &event);
}

static void follow_edit(MoonlightUiBridge *bridge)
{
    if (!shown_is(bridge, MOONLIGHT_SCREEN_SETTINGS))
        return;
    command(bridge, MOONLIGHT_OP_EDIT, word(bridge, ML_UI_EDIT), 0);
}

static void consume_command(MoonlightUiBridge *bridge)
{
    const uint32_t sequence = word(bridge, ML_UI_CMD_SEQUENCE);
    if (sequence == bridge->seen)
        return;
    bridge->seen = sequence;
    put(bridge, ML_UI_HOST_ACK, sequence);

    const uint32_t op = word(bridge, ML_UI_CMD_OP);
    const bool known = op >= MOONLIGHT_OP_A && op <= MOONLIGHT_OP_EDIT;
    const bool current = word(bridge, ML_UI_CMD_EPOCH) == word(bridge, ML_UI_EPOCH) &&
                         word(bridge, ML_UI_CMD_PAGE) == word(bridge, ML_UI_SEQUENCE);
    if (!known || !current)
        return;
    if (!bridge->has_shown || bridge->model.screen != bridge->shown_screen)
        return;
    command(bridge, (MoonlightUiOp)op, word(bridge, ML_UI_CMD_ITEM), (int32_t)word(bridge, ML_UI_CMD_VALUE));
}

static void follow_overlay(MoonlightUiBridge *bridge)
{
    const bool page_applied = bridge->has_header && word(bridge, ML_UI_APPLIED) == bridge->sequence;
    if (!shown_is(bridge, MOONLIGHT_SCREEN_STREAMING) || !page_applied || bridge->model.overlay)
        return;
    if (word(bridge, ML_UI_OVERLAY) == 0)
        return;
    command(bridge, MOONLIGHT_OP_CHORD, 0, 0);
}

void moonlightUiBridgePoll(MoonlightUiBridge *bridge, uint64_t now_ns)
{
    watch(bridge, now_ns);
    follow_edit(bridge);
    consume_command(bridge);
    follow_overlay(bridge);
    sync_applied(bridge);
}

const char *moonlightUiBridgePublish(MoonlightUiBridge *bridge, MoonlightComposer *composer, uint64_t now_ns,
    bool *published)
{
    *published = false;
    if (bridge->composed && bridge->composed_revision == bridge->revision)
        return NULL;

    const uint32_t next = moonlightUiBridgeNextSequence(bridge);
    const uint32_t slot = next & 1;
    const MoonlightPagePlacement *resident = bridge->placed_valid[slot] ? &bridge->placed[slot] : NULL;
    MoonlightPagePlacement placed;
    bool has_page = false;
    const char *error = moonlightComposerRender(composer, &bridge->model, bridge->storage_error, bridge->epoch, next,
        resident, page_buffer(bridge, slot), ML_UI_PAGE_BUFFER_BYTES, &placed, &has_page);
    if (error) {
        bridge->placed_valid[slot] = false;
        return error;
    }

    bridge->composed = true;
    bridge->composed_revision = bridge->revision;
    if (!has_page)
        return NULL;

    bridge->placed[slot] = placed;
    bridge->placed_valid[slot] = true;
    error = moonlightUiBridgeShow(bridge, next, bridge->model.screen, now_ns);
    *published = error == NULL;
    return error;
}

uint32_t moonlightUiBridgeTakeIntents(MoonlightUiBridge *bridge, MoonlightUiIntent *out, uint32_t capacity)
{
    const uint32_t count = bridge->intent_count < capacity ? bridge->intent_count : capacity;
    memcpy(out, bridge->intents, count * sizeof(*out));
    memmove(bridge->intents, bridge->intents + count, (bridge->intent_count - count) * sizeof(*out));
    bridge->intent_count -= count;
    return count;
}

bool moonlightUiBridgeInteractive(const MoonlightUiBridge *bridge)
{
    const bool applied = !bridge->has_header || word(bridge, ML_UI_APPLIED) == bridge->sequence;
    return moonlightUiInteractive(&bridge->model, applied);
}

bool moonlightUiBridgeAllowInput(const MoonlightUiBridge *bridge)
{
    return moonlightUiAllowInput(&bridge->model);
}

void moonlightUiBridgeSetBusy(MoonlightUiBridge *bridge, bool busy)
{
    put(bridge, ML_UI_HOST_BUSY, busy ? 1u : 0u);
}

void moonlightUiBridgeClose(MoonlightUiBridge *bridge)
{
    const uint32_t zero[4] = {0, 0, 0, 0};
    write_header(bridge, zero);
    bridge->has_header = false;
}
