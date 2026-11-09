#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Native console settings: the catalog, rules and save format of src/streamer/ui/settings.js.
// Component docs: moonlight-nx2-dev/src/native/ui/README.md.

#define MOONLIGHT_SETTINGS_VERSION 7u
#define MOONLIGHT_SETTINGS_JSON_BYTES 512u
#define MOONLIGHT_SETTING_TEXT_BYTES 96u
#define MOONLIGHT_STREAM_ARGS_MAX 24u

typedef enum {
    MOONLIGHT_SETTING_SIZE,
    MOONLIGHT_SETTING_FPS,
    MOONLIGHT_SETTING_BITRATE,
    MOONLIGHT_SETTING_CODEC,
    MOONLIGHT_SETTING_HOST_AUDIO,
    MOONLIGHT_SETTING_OPTIMISE,
    MOONLIGHT_SETTING_QUIT_ON_RETURN,
    MOONLIGHT_SETTING_MENU_CHORD,
    MOONLIGHT_SETTING_STREAM_INFO,
    MOONLIGHT_SETTING_FRAME_COUNTER,
    MOONLIGHT_SETTING_COUNT,
} MoonlightSettingId;

typedef enum {
    MOONLIGHT_SIZE_720P,
    MOONLIGHT_SIZE_1080P,
    MOONLIGHT_SIZE_1440P,
    MOONLIGHT_SIZE_2160P,
} MoonlightStreamSize;

typedef enum {
    MOONLIGHT_STREAM_CODEC_H264,
    MOONLIGHT_STREAM_CODEC_AV1,
} MoonlightStreamCodec;

typedef struct {
    uint8_t value[MOONLIGHT_SETTING_COUNT];
    uint32_t fps_before_4k;
} MoonlightSettings;

typedef struct {
    bool h264;
    bool av1;
    bool fps120;
    bool docked_sizes;
} MoonlightCapabilities;

typedef struct {
    const char *id;
    const char *label;
    char value[MOONLIGHT_SETTING_TEXT_BYTES];
    bool adjustable;
    bool greyed;
    bool can_left;
    bool can_right;
} MoonlightSettingRow;

typedef struct {
    uint32_t width;
    uint32_t height;
    uint32_t fps;
    uint32_t bitrate_kbps;
    bool bitrate_auto;
    MoonlightStreamCodec codec;
    bool host_audio;
    bool optimise;
    bool quit_on_return;
    bool menu_chord;
    bool stream_info;
    bool frame_counter;
    bool launchable;
} MoonlightStreamOptions;

typedef struct {
    uint32_t count;
    const char *argv[MOONLIGHT_STREAM_ARGS_MAX];
    char storage[64];
} MoonlightStreamArgs;

MoonlightCapabilities moonlightCapabilitiesAll(void);
bool moonlightCapabilitiesLaunchable(const MoonlightCapabilities *capabilities);

void moonlightSettingsDefaults(MoonlightSettings *settings);
void moonlightSettingsSanitizeJson(const char *text, size_t length, MoonlightSettings *settings);
bool moonlightSettingsAdjust(const MoonlightSettings *settings, MoonlightSettingId id, int direction, bool docked,
    const MoonlightCapabilities *capabilities, MoonlightSettings *out);
void moonlightSettingsInUse(const MoonlightSettings *settings, bool docked, const MoonlightCapabilities *capabilities,
    MoonlightSettings *out);
void moonlightSettingsRows(const MoonlightSettings *settings, bool docked, const MoonlightCapabilities *capabilities,
    MoonlightSettingRow rows[MOONLIGHT_SETTING_COUNT]);
size_t moonlightSettingsToJson(const MoonlightSettings *settings, char *out, size_t size);
void moonlightSettingsStreamArgs(const MoonlightSettings *settings, MoonlightStreamArgs *args);
void moonlightSettingsStreamOptions(const MoonlightSettings *settings, bool docked,
    const MoonlightCapabilities *capabilities, MoonlightStreamOptions *options);
uint32_t moonlightDefaultBitrate(uint32_t width, uint32_t height, uint32_t fps, MoonlightStreamCodec codec);

typedef struct {
    void *context;
    bool (*read)(void *context, const char *name, char *buffer, size_t capacity, size_t *length);
    bool (*write)(void *context, const char *name, const char *bytes, size_t length);
} MoonlightSettingsFiles;

typedef enum {
    MOONLIGHT_SETTINGS_LOADED,
    MOONLIGHT_SETTINGS_MIGRATED,
    MOONLIGHT_SETTINGS_DEFAULTS,
} MoonlightSettingsSource;

typedef struct {
    MoonlightSettingsFiles files;
    uint64_t generation;
} MoonlightSettingsStore;

MoonlightSettingsSource moonlightSettingsLoad(MoonlightSettingsStore *store, MoonlightSettings *settings);
bool moonlightSettingsSave(MoonlightSettingsStore *store, const MoonlightSettings *settings);
MoonlightSettingsFiles moonlightSettingsDirectory(const char *directory);

// The console UI state machine of src/streamer/ui/model.js: events in, model and intents out.
// Host work (list, pair, launch, quit) stays with the caller as intents.

#define MOONLIGHT_UI_MAX_HOSTS 64u
#define MOONLIGHT_UI_MAX_APPS 256u
#define MOONLIGHT_UI_MAX_INTENTS 2u
#define MOONLIGHT_UI_NAME_BYTES 128u
#define MOONLIGHT_UI_ADDRESS_BYTES 64u
#define MOONLIGHT_UI_MESSAGE_BYTES 256u
#define MOONLIGHT_UI_ENTRY_MAX 15u
#define MOONLIGHT_UI_APPS_PER_PAGE 10u
#define MOONLIGHT_UI_HOSTS_PER_PAGE 6u

enum {
    MOONLIGHT_ITEM_BACK = 1,
    MOONLIGHT_ITEM_RETRY = 2,
    MOONLIGHT_ITEM_PREVIOUS = 3,
    MOONLIGHT_ITEM_NEXT = 4,
    MOONLIGHT_ITEM_RETURN_TO_APPS = 5,
    MOONLIGHT_ITEM_QUIT_HOST = 6,
    MOONLIGHT_ITEM_CONFIRM_QUIT = 7,
    MOONLIGHT_ITEM_CANCEL = 8,
    MOONLIGHT_ITEM_ADD_HOST = 9,
    MOONLIGHT_ITEM_FIND_HOSTS = 10,
    MOONLIGHT_ITEM_UNPAIR = 11,
    MOONLIGHT_ITEM_REMOVE_HOST = 12,
    MOONLIGHT_ITEM_ERASE = 13,
    MOONLIGHT_ITEM_CONNECT = 14,
    MOONLIGHT_ITEM_HOST = 10000,
    MOONLIGHT_ITEM_APP = 20000,
    MOONLIGHT_ITEM_SETTING = 30000,
    MOONLIGHT_ITEM_KEY = 40000,
};

typedef enum {
    MOONLIGHT_SCREEN_SPLASH,
    MOONLIGHT_SCREEN_HOSTS,
    MOONLIGHT_SCREEN_ADD_HOST,
    MOONLIGHT_SCREEN_HOST_MENU,
    MOONLIGHT_SCREEN_CONNECTING,
    MOONLIGHT_SCREEN_PAIRING,
    MOONLIGHT_SCREEN_APPS,
    MOONLIGHT_SCREEN_QUIT_CONFIRM,
    MOONLIGHT_SCREEN_SETTINGS,
    MOONLIGHT_SCREEN_LAUNCHING,
    MOONLIGHT_SCREEN_STREAMING,
    MOONLIGHT_SCREEN_ERROR,
    MOONLIGHT_SCREEN_CONNECTION_LOST,
    MOONLIGHT_SCREEN_UNPAIRING,
    MOONLIGHT_SCREEN_QUITTING,
    MOONLIGHT_SCREEN_STOPPED,
    MOONLIGHT_SCREEN_COUNT,
} MoonlightScreen;

typedef enum {
    MOONLIGHT_OP_A = 1,
    MOONLIGHT_OP_B = 2,
    MOONLIGHT_OP_X = 3,
    MOONLIGHT_OP_Y = 4,
    MOONLIGHT_OP_ADJUST = 5,
    MOONLIGHT_OP_CHORD = 6,
    MOONLIGHT_OP_EDIT = 7,
} MoonlightUiOp;

typedef struct {
    char name[MOONLIGHT_UI_NAME_BYTES];
    char address[MOONLIGHT_UI_ADDRESS_BYTES];
    char uniqueid[MOONLIGHT_UI_ADDRESS_BYTES];
} MoonlightHost;

typedef struct {
    uint32_t id;
    char name[MOONLIGHT_UI_NAME_BYTES];
} MoonlightApp;

typedef struct {
    bool set;
    char text[MOONLIGHT_UI_MESSAGE_BYTES];
} MoonlightUiText;

typedef struct {
    MoonlightScreen screen;
    uint32_t host_count;
    MoonlightHost hosts[MOONLIGHT_UI_MAX_HOSTS];
    bool has_host;
    MoonlightHost host;
    uint32_t app_count;
    MoonlightApp apps[MOONLIGHT_UI_MAX_APPS];
    uint32_t current_game;
    bool has_app;
    MoonlightApp app;
    uint32_t app_page;
    uint32_t app_index;
    uint32_t host_page;
    uint32_t host_index;
    MoonlightUiText pin;
    MoonlightUiText url;
    char entry[MOONLIGHT_UI_ENTRY_MAX + 1];
    MoonlightUiText message;
    bool back_apps;
    MoonlightScreen from;
    bool overlay;
    MoonlightSettings settings;
    bool docked;
    int editing;
    MoonlightCapabilities capabilities;
} MoonlightUiModel;

typedef enum {
    MOONLIGHT_EVENT_COMMAND,
    MOONLIGHT_EVENT_ATTACHED,
    MOONLIGHT_EVENT_NOT_PAIRED,
    MOONLIGHT_EVENT_PAIRED,
    MOONLIGHT_EVENT_STREAM_STARTED,
    MOONLIGHT_EVENT_STREAM_ENDED,
    MOONLIGHT_EVENT_QUIT_DONE,
    MOONLIGHT_EVENT_APP_GONE,
    MOONLIGHT_EVENT_UNPAIRED,
    MOONLIGHT_EVENT_CONNECTION_LOST,
    MOONLIGHT_EVENT_HOSTS,
    MOONLIGHT_EVENT_LISTED,
    MOONLIGHT_EVENT_PIN,
    MOONLIGHT_EVENT_STAGE,
    MOONLIGHT_EVENT_OPERATION_MODE,
    MOONLIGHT_EVENT_FAILED,
} MoonlightUiEventType;

typedef struct {
    MoonlightUiEventType type;
    MoonlightUiOp op;
    uint32_t item;
    int32_t value;
    const MoonlightHost *host;
    const MoonlightHost *hosts;
    uint32_t host_count;
    const MoonlightApp *apps;
    uint32_t app_count;
    uint32_t current_game;
    const char *message;
    const char *pin;
    const char *url;
    bool docked;
    bool back_set;
    bool back_apps;
} MoonlightUiEvent;

typedef enum {
    MOONLIGHT_INTENT_LIST,
    MOONLIGHT_INTENT_REFRESH_HOSTS,
    MOONLIGHT_INTENT_REMOVE_HOST,
    MOONLIGHT_INTENT_UNPAIR_HOST,
    MOONLIGHT_INTENT_LAUNCH,
    MOONLIGHT_INTENT_QUIT_HOST,
    MOONLIGHT_INTENT_SAVE_SETTINGS,
    MOONLIGHT_INTENT_PAUSE_INPUT,
    MOONLIGHT_INTENT_RESUME_INPUT,
    MOONLIGHT_INTENT_CANCEL_LIST,
    MOONLIGHT_INTENT_CANCEL_PAIR,
    MOONLIGHT_INTENT_STOP_STREAM,
    MOONLIGHT_INTENT_COVERS,
    MOONLIGHT_INTENT_PAIR,
    MOONLIGHT_INTENT_EXIT,
} MoonlightUiIntentType;

typedef struct {
    MoonlightUiIntentType type;
    bool has_host;
    MoonlightHost host;
    MoonlightApp app;
} MoonlightUiIntent;

typedef struct {
    bool changed;
    uint32_t count;
    MoonlightUiIntent intents[MOONLIGHT_UI_MAX_INTENTS];
} MoonlightUiStep;

void moonlightUiInit(MoonlightUiModel *model, const MoonlightHost *hosts, uint32_t host_count,
    const MoonlightSettings *settings, const MoonlightCapabilities *capabilities);
void moonlightUiReduce(MoonlightUiModel *model, const MoonlightUiEvent *event, MoonlightUiStep *step);
bool moonlightUiIsAddress(const char *entry);
bool moonlightUiAllowInput(const MoonlightUiModel *model);
bool moonlightUiInteractive(const MoonlightUiModel *model, bool page_applied);
const char *moonlightUiScreenName(MoonlightScreen screen);
const char *moonlightUiIntentName(MoonlightUiIntentType type);
