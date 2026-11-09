#include <stdio.h>
#include <string.h>

#include "../ui.h"

static const char KEYS[] = "123456789.0";

static const char *const SCREENS[MOONLIGHT_SCREEN_COUNT] = {
    "splash", "hosts", "addHost", "hostMenu", "connecting", "pairing", "apps", "quitConfirm", "settings",
    "launching", "streaming", "error", "connectionLost", "unpairing", "quitting", "stopped",
};

static const char *const INTENTS[] = {
    "list", "refreshHosts", "removeHost", "unpairHost", "launch", "quitHost", "saveSettings", "pauseInput",
    "resumeInput", "cancelList", "cancelPair", "stopStream", "covers", "pair", "exit",
};

const char *moonlightUiScreenName(MoonlightScreen screen)
{
    return (unsigned)screen < MOONLIGHT_SCREEN_COUNT ? SCREENS[screen] : "unknown";
}

const char *moonlightUiIntentName(MoonlightUiIntentType type)
{
    return (unsigned)type < sizeof(INTENTS) / sizeof(INTENTS[0]) ? INTENTS[type] : "unknown";
}

static void set_text(MoonlightUiText *text, const char *value)
{
    text->set = value != NULL;
    snprintf(text->text, sizeof(text->text), "%s", value ? value : "");
}

static void clear_text(MoonlightUiText *text)
{
    set_text(text, NULL);
}

static void copy_hosts(MoonlightUiModel *model, const MoonlightHost *hosts, uint32_t count)
{
    if (count > MOONLIGHT_UI_MAX_HOSTS)
        count = MOONLIGHT_UI_MAX_HOSTS;
    if (count && hosts != model->hosts)
        memmove(model->hosts, hosts, count * sizeof(*hosts));
    model->host_count = count;
}

static void copy_apps(MoonlightUiModel *model, const MoonlightApp *apps, uint32_t count)
{
    if (count > MOONLIGHT_UI_MAX_APPS)
        count = MOONLIGHT_UI_MAX_APPS;
    if (count && apps != model->apps)
        memmove(model->apps, apps, count * sizeof(*apps));
    model->app_count = count;
}

void moonlightUiInit(MoonlightUiModel *model, const MoonlightHost *hosts, uint32_t host_count,
    const MoonlightSettings *settings, const MoonlightCapabilities *capabilities)
{
    memset(model, 0, sizeof(*model));
    model->screen = MOONLIGHT_SCREEN_SPLASH;
    model->from = MOONLIGHT_SCREEN_HOSTS;
    model->editing = -1;
    copy_hosts(model, hosts, host_count);
    if (settings)
        model->settings = *settings;
    else
        moonlightSettingsDefaults(&model->settings);
    model->capabilities = capabilities ? *capabilities : moonlightCapabilitiesAll();
}

static void changed(MoonlightUiStep *step)
{
    step->changed = true;
}

static MoonlightUiIntent *intent(MoonlightUiStep *step, MoonlightUiIntentType type)
{
    MoonlightUiIntent *added = &step->intents[step->count++];
    *added = (MoonlightUiIntent){.type = type};
    return added;
}

static void intent_host(MoonlightUiStep *step, MoonlightUiIntentType type, const MoonlightUiModel *model)
{
    MoonlightUiIntent *added = intent(step, type);
    added->has_host = model->has_host;
    added->host = model->host;
}

static uint32_t last_page(uint32_t length, uint32_t size)
{
    return length ? (length + size - 1) / size - 1 : 0;
}

static uint32_t min_u32(uint32_t a, uint32_t b)
{
    return a < b ? a : b;
}

static void leave_host(MoonlightUiModel *model)
{
    model->screen = MOONLIGHT_SCREEN_HOSTS;
    model->has_host = false;
    model->app_count = 0;
    model->has_app = false;
    model->app_page = 0;
    model->app_index = 0;
}

static void open_host(MoonlightUiModel *model, const MoonlightHost *host, uint32_t index, MoonlightUiStep *step)
{
    const MoonlightHost opened = *host;
    model->screen = MOONLIGHT_SCREEN_CONNECTING;
    model->has_host = true;
    model->host = opened;
    model->host_index = index;
    model->host_page = index / MOONLIGHT_UI_HOSTS_PER_PAGE;
    clear_text(&model->pin);
    clear_text(&model->url);
    clear_text(&model->message);
    changed(step);
    intent_host(step, MOONLIGHT_INTENT_LIST, model);
}

static void fail(MoonlightUiModel *model, const char *message, bool back_apps, MoonlightUiStep *step)
{
    model->screen = MOONLIGHT_SCREEN_ERROR;
    set_text(&model->message, message);
    model->back_apps = back_apps;
    clear_text(&model->pin);
    clear_text(&model->url);
    model->overlay = false;
    changed(step);
}

static bool octet_ok(const char *octet, size_t length)
{
    if (length == 0 || length > 3)
        return false;
    if (octet[0] == '0' && length > 1)
        return false;

    unsigned value = 0;
    for (size_t i = 0; i < length; i++) {
        if (octet[i] < '0' || octet[i] > '9')
            return false;
        value = value * 10 + (unsigned)(octet[i] - '0');
    }
    return value <= 255;
}

bool moonlightUiIsAddress(const char *entry)
{
    unsigned octets = 0;
    unsigned first = 0;
    const char *start = entry;
    for (const char *at = entry;; at++) {
        if (*at != '.' && *at != 0)
            continue;
        if (!octet_ok(start, (size_t)(at - start)))
            return false;
        if (octets == 0) {
            for (const char *digit = start; digit < at; digit++)
                first = first * 10 + (unsigned)(*digit - '0');
        }
        octets++;
        if (*at == 0)
            break;
        start = at + 1;
    }
    return octets == 4 && first != 0 && first < 224;
}

static bool host_item(const MoonlightUiModel *model, uint32_t item, uint32_t *index)
{
    if (item < MOONLIGHT_ITEM_HOST || item - MOONLIGHT_ITEM_HOST >= model->host_count)
        return false;
    *index = item - MOONLIGHT_ITEM_HOST;
    return true;
}

static bool app_item(const MoonlightUiModel *model, uint32_t item, uint32_t *index)
{
    if (item < MOONLIGHT_ITEM_APP || item - MOONLIGHT_ITEM_APP >= model->app_count)
        return false;
    *index = item - MOONLIGHT_ITEM_APP;
    return true;
}

static void on_hosts(MoonlightUiModel *model, MoonlightUiOp op, uint32_t item, MoonlightUiStep *step)
{
    uint32_t index = 0;
    const bool on_host = host_item(model, item, &index);
    if (op == MOONLIGHT_OP_A && on_host) {
        open_host(model, &model->hosts[index], index, step);
        return;
    }
    if (op == MOONLIGHT_OP_Y && on_host) {
        model->screen = MOONLIGHT_SCREEN_HOST_MENU;
        model->has_host = true;
        model->host = model->hosts[index];
        model->host_index = index;
        clear_text(&model->message);
        changed(step);
        return;
    }

    const uint32_t last = last_page(model->host_count, MOONLIGHT_UI_HOSTS_PER_PAGE);
    if (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_PREVIOUS) {
        model->host_page = model->host_page ? model->host_page - 1 : 0;
        changed(step);
        return;
    }
    if (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_NEXT) {
        model->host_page = min_u32(last, model->host_page + 1);
        changed(step);
        return;
    }
    if (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_ADD_HOST) {
        model->screen = MOONLIGHT_SCREEN_ADD_HOST;
        model->entry[0] = 0;
        clear_text(&model->message);
        changed(step);
        return;
    }

    const bool find = op == MOONLIGHT_OP_Y || (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_FIND_HOSTS);
    if (find) {
        clear_text(&model->message);
        changed(step);
        intent(step, MOONLIGHT_INTENT_REFRESH_HOSTS);
    }
}

static void on_add_host(MoonlightUiModel *model, MoonlightUiOp op, uint32_t item, MoonlightUiStep *step)
{
    const bool cancelled = op == MOONLIGHT_OP_B || (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_CANCEL);
    if (cancelled) {
        model->screen = MOONLIGHT_SCREEN_HOSTS;
        model->entry[0] = 0;
        changed(step);
        return;
    }

    const bool erase = op == MOONLIGHT_OP_Y || (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_ERASE);
    const size_t length = strlen(model->entry);
    if (erase) {
        if (length)
            model->entry[length - 1] = 0;
        changed(step);
        return;
    }
    if (op != MOONLIGHT_OP_A)
        return;

    if (item >= MOONLIGHT_ITEM_KEY && item - MOONLIGHT_ITEM_KEY < sizeof(KEYS) - 1) {
        if (length >= MOONLIGHT_UI_ENTRY_MAX)
            return;
        model->entry[length] = KEYS[item - MOONLIGHT_ITEM_KEY];
        model->entry[length + 1] = 0;
        changed(step);
        return;
    }
    if (item != MOONLIGHT_ITEM_CONNECT || !moonlightUiIsAddress(model->entry))
        return;

    MoonlightHost typed = {0};
    snprintf(typed.address, sizeof(typed.address), "%s", model->entry);
    model->entry[0] = 0;
    for (uint32_t i = 0; i < model->host_count; i++) {
        if (!strcmp(model->hosts[i].address, typed.address)) {
            open_host(model, &model->hosts[i], i, step);
            return;
        }
    }
    snprintf(typed.name, sizeof(typed.name), "%s", typed.address);
    open_host(model, &typed, model->host_index, step);
}

static void on_host_menu(MoonlightUiModel *model, MoonlightUiOp op, uint32_t item, MoonlightUiStep *step)
{
    const bool cancelled = op == MOONLIGHT_OP_B || (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_CANCEL);
    if (cancelled || !model->has_host) {
        model->screen = MOONLIGHT_SCREEN_HOSTS;
        model->has_host = false;
        changed(step);
        return;
    }
    if (op != MOONLIGHT_OP_A)
        return;

    if (item == MOONLIGHT_ITEM_UNPAIR) {
        model->screen = MOONLIGHT_SCREEN_UNPAIRING;
        changed(step);
        intent_host(step, MOONLIGHT_INTENT_UNPAIR_HOST, model);
        return;
    }
    if (item != MOONLIGHT_ITEM_REMOVE_HOST)
        return;

    const MoonlightHost removed = model->host;
    uint32_t kept = 0;
    for (uint32_t i = 0; i < model->host_count; i++) {
        if (strcmp(model->hosts[i].address, removed.address) != 0)
            model->hosts[kept++] = model->hosts[i];
    }
    model->host_count = kept;
    model->screen = MOONLIGHT_SCREEN_HOSTS;
    model->has_host = false;
    model->host_index = min_u32(model->host_index, kept ? kept - 1 : 0);
    model->host_page = model->host_index / MOONLIGHT_UI_HOSTS_PER_PAGE;
    model->message.set = true;
    snprintf(model->message.text, sizeof(model->message.text), "Removed %s", removed.name);
    changed(step);
    MoonlightUiIntent *added = intent(step, MOONLIGHT_INTENT_REMOVE_HOST);
    added->has_host = true;
    added->host = removed;
}

static void on_quit_asked(MoonlightUiModel *model, uint32_t item, MoonlightUiStep *step)
{
    uint32_t index = 0;
    const bool hovered = app_item(model, item, &index);
    if (!model->current_game || !hovered || model->apps[index].id != model->current_game)
        return;

    model->screen = MOONLIGHT_SCREEN_QUIT_CONFIRM;
    changed(step);
}

static void on_apps(MoonlightUiModel *model, MoonlightUiOp op, uint32_t item, MoonlightUiStep *step)
{
    if (op == MOONLIGHT_OP_B) {
        leave_host(model);
        changed(step);
        return;
    }
    if (op == MOONLIGHT_OP_Y) {
        on_quit_asked(model, item, step);
        return;
    }
    if (op != MOONLIGHT_OP_A)
        return;

    if (item == MOONLIGHT_ITEM_BACK) {
        leave_host(model);
        changed(step);
        return;
    }
    if (item == MOONLIGHT_ITEM_PREVIOUS) {
        model->app_page = model->app_page ? model->app_page - 1 : 0;
        changed(step);
        return;
    }
    if (item == MOONLIGHT_ITEM_NEXT) {
        model->app_page = min_u32(last_page(model->app_count, MOONLIGHT_UI_APPS_PER_PAGE), model->app_page + 1);
        changed(step);
        return;
    }

    uint32_t index = 0;
    if (!app_item(model, item, &index))
        return;
    const MoonlightApp app = model->apps[index];

    if (model->current_game && app.id != model->current_game) {
        const char *running = "Another app";
        for (uint32_t i = 0; i < model->app_count; i++) {
            if (model->apps[i].id == model->current_game) {
                running = model->apps[i].name;
                break;
            }
        }
        model->message.set = true;
        snprintf(model->message.text, sizeof(model->message.text),
            "%s is still running on the PC; press Y on it to quit it first", running);
        changed(step);
        return;
    }

    if (!moonlightCapabilitiesLaunchable(&model->capabilities)) {
        set_text(&model->message, "This console cannot play a stream yet");
        changed(step);
        return;
    }

    model->screen = MOONLIGHT_SCREEN_LAUNCHING;
    model->has_app = true;
    model->app = app;
    model->app_index = index;
    clear_text(&model->message);
    model->overlay = false;
    changed(step);
    MoonlightUiIntent *added = intent(step, MOONLIGHT_INTENT_LAUNCH);
    added->has_host = model->has_host;
    added->host = model->host;
    added->app = app;
}

static void on_quit_confirm(MoonlightUiModel *model, MoonlightUiOp op, uint32_t item, MoonlightUiStep *step)
{
    if (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_CONFIRM_QUIT) {
        model->screen = MOONLIGHT_SCREEN_QUITTING;
        changed(step);
        intent_host(step, MOONLIGHT_INTENT_QUIT_HOST, model);
        return;
    }

    const bool cancelled = op == MOONLIGHT_OP_B || (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_CANCEL);
    if (cancelled) {
        model->screen = MOONLIGHT_SCREEN_APPS;
        changed(step);
    }
}

static bool setting_item(uint32_t item, MoonlightSettingId *id)
{
    if (item < MOONLIGHT_ITEM_SETTING || item - MOONLIGHT_ITEM_SETTING >= MOONLIGHT_SETTING_COUNT)
        return false;
    *id = (MoonlightSettingId)(item - MOONLIGHT_ITEM_SETTING);
    return true;
}

static void on_edit(MoonlightUiModel *model, uint32_t item, MoonlightUiStep *step)
{
    MoonlightSettingId id = MOONLIGHT_SETTING_COUNT;
    int editing = -1;
    if (setting_item(item, &id)) {
        MoonlightSettingRow rows[MOONLIGHT_SETTING_COUNT];
        moonlightSettingsRows(&model->settings, model->docked, &model->capabilities, rows);
        if (rows[id].adjustable)
            editing = (int)id;
    }
    if (editing == model->editing)
        return;

    model->editing = editing;
    changed(step);
}

static void on_edit_command(MoonlightUiModel *model, MoonlightUiOp op, uint32_t item, int32_t value,
    MoonlightUiStep *step)
{
    MoonlightSettingId id = MOONLIGHT_SETTING_COUNT;
    if (op != MOONLIGHT_OP_ADJUST || !setting_item(item, &id) || (int)id != model->editing)
        return;

    MoonlightSettings adjusted;
    if (!moonlightSettingsAdjust(&model->settings, id, value, model->docked, &model->capabilities, &adjusted))
        return;

    model->settings = adjusted;
    changed(step);
    intent(step, MOONLIGHT_INTENT_SAVE_SETTINGS);
}

static void on_settings(MoonlightUiModel *model, const MoonlightUiEvent *event, MoonlightUiStep *step)
{
    if (event->op == MOONLIGHT_OP_EDIT) {
        on_edit(model, event->item, step);
        return;
    }
    if (model->editing >= 0) {
        on_edit_command(model, event->op, event->item, event->value, step);
        return;
    }

    if (event->op == MOONLIGHT_OP_B) {
        model->screen = model->from;
        changed(step);
    } else if (event->op == MOONLIGHT_OP_Y) {
        moonlightSettingsDefaults(&model->settings);
        changed(step);
        intent(step, MOONLIGHT_INTENT_SAVE_SETTINGS);
    }
}

static void on_streaming(MoonlightUiModel *model, MoonlightUiOp op, uint32_t item, MoonlightUiStep *step)
{
    const bool chord_enabled = model->settings.value[MOONLIGHT_SETTING_MENU_CHORD] != 0;
    if (op == MOONLIGHT_OP_CHORD && !chord_enabled)
        return;
    if (op == MOONLIGHT_OP_CHORD) {
        model->overlay = true;
        changed(step);
        intent(step, MOONLIGHT_INTENT_PAUSE_INPUT);
        return;
    }
    if (!model->overlay)
        return;

    if (op == MOONLIGHT_OP_B) {
        model->overlay = false;
        changed(step);
        intent(step, MOONLIGHT_INTENT_RESUME_INPUT);
        return;
    }

    const bool return_pressed = op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_RETURN_TO_APPS;
    const bool quit_on_return = return_pressed && model->settings.value[MOONLIGHT_SETTING_QUIT_ON_RETURN];
    if (return_pressed && !quit_on_return) {
        model->screen = MOONLIGHT_SCREEN_CONNECTING;
        model->overlay = false;
        changed(step);
        intent(step, MOONLIGHT_INTENT_STOP_STREAM);
        return;
    }
    if (quit_on_return || (op == MOONLIGHT_OP_A && item == MOONLIGHT_ITEM_QUIT_HOST)) {
        model->screen = MOONLIGHT_SCREEN_QUITTING;
        model->overlay = false;
        changed(step);
        intent(step, MOONLIGHT_INTENT_STOP_STREAM);
        intent_host(step, MOONLIGHT_INTENT_QUIT_HOST, model);
    }
}

static void on_error(MoonlightUiModel *model, MoonlightUiOp op, MoonlightUiStep *step)
{
    if (op != MOONLIGHT_OP_A && op != MOONLIGHT_OP_B)
        return;

    const bool lost = model->screen == MOONLIGHT_SCREEN_CONNECTION_LOST;
    if (!(lost && op == MOONLIGHT_OP_B) && model->back_apps && model->has_host) {
        open_host(model, &model->host, model->host_index, step);
        return;
    }
    model->screen = MOONLIGHT_SCREEN_HOSTS;
    model->has_host = false;
    clear_text(&model->message);
    changed(step);
}

static void on_command(MoonlightUiModel *model, const MoonlightUiEvent *event, MoonlightUiStep *step)
{
    const MoonlightUiOp op = event->op;
    const bool browsing = model->screen == MOONLIGHT_SCREEN_HOSTS || model->screen == MOONLIGHT_SCREEN_APPS;
    if (op == MOONLIGHT_OP_X && browsing) {
        model->from = model->screen;
        model->screen = MOONLIGHT_SCREEN_SETTINGS;
        model->editing = -1;
        changed(step);
        return;
    }

    switch (model->screen) {
    case MOONLIGHT_SCREEN_HOSTS:
        on_hosts(model, op, event->item, step);
        return;
    case MOONLIGHT_SCREEN_ADD_HOST:
        on_add_host(model, op, event->item, step);
        return;
    case MOONLIGHT_SCREEN_HOST_MENU:
        on_host_menu(model, op, event->item, step);
        return;
    case MOONLIGHT_SCREEN_CONNECTING:
        if (op != MOONLIGHT_OP_B)
            return;
        model->screen = MOONLIGHT_SCREEN_HOSTS;
        model->has_host = false;
        changed(step);
        intent(step, MOONLIGHT_INTENT_CANCEL_LIST);
        return;
    case MOONLIGHT_SCREEN_PAIRING:
        if (op != MOONLIGHT_OP_B)
            return;
        model->screen = MOONLIGHT_SCREEN_HOSTS;
        model->has_host = false;
        clear_text(&model->pin);
        clear_text(&model->url);
        changed(step);
        intent(step, MOONLIGHT_INTENT_CANCEL_PAIR);
        return;
    case MOONLIGHT_SCREEN_APPS:
        on_apps(model, op, event->item, step);
        return;
    case MOONLIGHT_SCREEN_QUIT_CONFIRM:
        on_quit_confirm(model, op, event->item, step);
        return;
    case MOONLIGHT_SCREEN_SETTINGS:
        on_settings(model, event, step);
        return;
    case MOONLIGHT_SCREEN_LAUNCHING:
        if (op != MOONLIGHT_OP_B)
            return;
        model->screen = MOONLIGHT_SCREEN_CONNECTING;
        model->has_app = false;
        changed(step);
        intent(step, MOONLIGHT_INTENT_STOP_STREAM);
        return;
    case MOONLIGHT_SCREEN_STREAMING:
        on_streaming(model, op, event->item, step);
        return;
    case MOONLIGHT_SCREEN_ERROR:
    case MOONLIGHT_SCREEN_CONNECTION_LOST:
        on_error(model, op, step);
        return;
    default:
        return;
    }
}

static void on_listed(MoonlightUiModel *model, const MoonlightUiEvent *event, MoonlightUiStep *step)
{
    const MoonlightScreen screen = model->screen;
    const bool waiting = screen == MOONLIGHT_SCREEN_CONNECTING || screen == MOONLIGHT_SCREEN_PAIRING ||
                         screen == MOONLIGHT_SCREEN_QUITTING;
    if (!waiting)
        return;

    copy_apps(model, event->apps, event->app_count);
    model->screen = MOONLIGHT_SCREEN_APPS;
    model->current_game = event->current_game;
    model->app_page = min_u32(model->app_page, last_page(model->app_count, MOONLIGHT_UI_APPS_PER_PAGE));
    clear_text(&model->pin);
    clear_text(&model->url);
    set_text(&model->message, event->message);
    changed(step);
    intent_host(step, MOONLIGHT_INTENT_COVERS, model);
}

static void on_connection_lost(MoonlightUiModel *model, const MoonlightHost *lost, MoonlightUiStep *step)
{
    int index = -1;
    for (uint32_t i = 0; lost && i < model->host_count; i++) {
        if (!strcmp(model->hosts[i].address, lost->address)) {
            index = (int)i;
            break;
        }
    }

    model->screen = MOONLIGHT_SCREEN_CONNECTION_LOST;
    model->has_app = false;
    model->app_count = 0;
    model->overlay = false;
    changed(step);
    if (index < 0) {
        model->has_host = false;
        model->back_apps = false;
        set_text(&model->message, "Connection lost. Select a PC to reconnect.");
        return;
    }

    model->has_host = true;
    model->host = model->hosts[index];
    model->host_index = (uint32_t)index;
    model->host_page = (uint32_t)index / MOONLIGHT_UI_HOSTS_PER_PAGE;
    model->back_apps = true;
    model->message.set = true;
    snprintf(model->message.text, sizeof(model->message.text),
        "The stream from %s was cut off. Press A to reconnect.", model->host.name);
}

static void list_again(MoonlightUiModel *model, MoonlightUiStep *step)
{
    model->screen = MOONLIGHT_SCREEN_CONNECTING;
    model->has_app = false;
    changed(step);
    intent_host(step, MOONLIGHT_INTENT_LIST, model);
}

static void on_service(MoonlightUiModel *model, const MoonlightUiEvent *event, MoonlightUiStep *step)
{
    const MoonlightScreen screen = model->screen;
    switch (event->type) {
    case MOONLIGHT_EVENT_ATTACHED:
        if (screen == MOONLIGHT_SCREEN_CONNECTION_LOST)
            return;
        model->screen = MOONLIGHT_SCREEN_HOSTS;
        changed(step);
        return;
    case MOONLIGHT_EVENT_CONNECTION_LOST:
        on_connection_lost(model, event->host, step);
        return;
    case MOONLIGHT_EVENT_HOSTS:
        copy_hosts(model, event->hosts, event->host_count);
        model->host_page = min_u32(model->host_page, last_page(model->host_count, MOONLIGHT_UI_HOSTS_PER_PAGE));
        changed(step);
        return;
    case MOONLIGHT_EVENT_LISTED:
        on_listed(model, event, step);
        return;
    case MOONLIGHT_EVENT_NOT_PAIRED:
        if (screen != MOONLIGHT_SCREEN_CONNECTING)
            return;
        model->screen = MOONLIGHT_SCREEN_PAIRING;
        clear_text(&model->pin);
        clear_text(&model->url);
        changed(step);
        intent_host(step, MOONLIGHT_INTENT_PAIR, model);
        return;
    case MOONLIGHT_EVENT_PIN:
        if (screen != MOONLIGHT_SCREEN_PAIRING)
            return;
        set_text(&model->pin, event->pin);
        set_text(&model->url, event->url);
        changed(step);
        return;
    case MOONLIGHT_EVENT_PAIRED:
        if (screen != MOONLIGHT_SCREEN_PAIRING)
            return;
        model->screen = MOONLIGHT_SCREEN_CONNECTING;
        clear_text(&model->pin);
        clear_text(&model->url);
        changed(step);
        intent_host(step, MOONLIGHT_INTENT_LIST, model);
        return;
    case MOONLIGHT_EVENT_STREAM_STARTED:
        if (screen != MOONLIGHT_SCREEN_LAUNCHING)
            return;
        model->screen = MOONLIGHT_SCREEN_STREAMING;
        model->overlay = false;
        changed(step);
        return;
    case MOONLIGHT_EVENT_STAGE:
        if (screen != MOONLIGHT_SCREEN_LAUNCHING)
            return;
        set_text(&model->message, event->message);
        changed(step);
        return;
    case MOONLIGHT_EVENT_STREAM_ENDED: {
        const bool active = screen == MOONLIGHT_SCREEN_LAUNCHING || screen == MOONLIGHT_SCREEN_STREAMING ||
                            screen == MOONLIGHT_SCREEN_CONNECTING;
        if (!active)
            return;
        model->overlay = false;
        list_again(model, step);
        return;
    }
    case MOONLIGHT_EVENT_UNPAIRED:
        if (screen != MOONLIGHT_SCREEN_UNPAIRING)
            return;
        model->screen = MOONLIGHT_SCREEN_HOSTS;
        model->message.set = true;
        snprintf(model->message.text, sizeof(model->message.text), "Unpaired %s",
            model->has_host ? model->host.name : "undefined");
        model->has_host = false;
        changed(step);
        return;
    case MOONLIGHT_EVENT_QUIT_DONE:
        if (screen != MOONLIGHT_SCREEN_QUITTING)
            return;
        list_again(model, step);
        return;
    case MOONLIGHT_EVENT_FAILED: {
        const bool idle = screen == MOONLIGHT_SCREEN_HOSTS || screen == MOONLIGHT_SCREEN_ADD_HOST ||
                          screen == MOONLIGHT_SCREEN_HOST_MENU || screen == MOONLIGHT_SCREEN_SETTINGS;
        if (idle)
            return;
        fail(model, event->message, event->back_set ? event->back_apps : model->has_host, step);
        return;
    }
    case MOONLIGHT_EVENT_APP_GONE:
        model->screen = MOONLIGHT_SCREEN_STOPPED;
        changed(step);
        intent(step, MOONLIGHT_INTENT_EXIT);
        return;
    case MOONLIGHT_EVENT_OPERATION_MODE:
        if (event->docked == model->docked)
            return;
        model->docked = event->docked;
        changed(step);
        return;
    default:
        return;
    }
}

void moonlightUiReduce(MoonlightUiModel *model, const MoonlightUiEvent *event, MoonlightUiStep *step)
{
    *step = (MoonlightUiStep){0};
    if (event->type == MOONLIGHT_EVENT_COMMAND)
        on_command(model, event, step);
    else
        on_service(model, event, step);
}

bool moonlightUiAllowInput(const MoonlightUiModel *model)
{
    return model->screen == MOONLIGHT_SCREEN_STREAMING && !model->overlay;
}

bool moonlightUiInteractive(const MoonlightUiModel *model, bool page_applied)
{
    const bool quiet = model->screen == MOONLIGHT_SCREEN_STREAMING && !model->overlay;
    return !quiet || !page_applied;
}
