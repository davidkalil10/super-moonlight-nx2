/* Console controller and touch into the Moonlight session: input-feeder.cjs
 * and the stdin handling of input.c in one loop. Once per frame it reads the
 * pad (bytes 0..40) and the touch block (from STATE_TOUCH) of the Moonlight
 * app's state buffer in one bridge read, and sends what changed.
 *
 * The mapping matches controller.cjs and touch.cjs exactly; --dry-input prints
 * the JSON lines input-feeder.cjs would print instead of sending them, so the
 * two can be diffed against the fake console. */
#define _GNU_SOURCE
#include "console-layout.h"
#include "helper.h"
#include "host.h"

#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#define READ_BYTES (STATE_TOUCH + TOUCH_BYTES)
#define SOURCE_CHECK_MS 250
#define ATTRIBUTE_ENDED 0x2u

enum {
  NPAD_A = 1 << 0,
  NPAD_B = 1 << 1,
  NPAD_X = 1 << 2,
  NPAD_Y = 1 << 3,
  NPAD_STICK_L = 1 << 4,
  NPAD_STICK_R = 1 << 5,
  NPAD_L = 1 << 6,
  NPAD_R = 1 << 7,
  NPAD_ZL = 1 << 8,
  NPAD_ZR = 1 << 9,
  NPAD_PLUS = 1 << 10,
  NPAD_MINUS = 1 << 11,
  NPAD_LEFT = 1 << 12,
  NPAD_UP = 1 << 13,
  NPAD_RIGHT = 1 << 14,
  NPAD_DOWN = 1 << 15,
};

struct button {
  uint32_t npad;
  int flag;
};

static const struct button SHARED[] = {
    {NPAD_UP, UP_FLAG},          {NPAD_DOWN, DOWN_FLAG},     {NPAD_LEFT, LEFT_FLAG},
    {NPAD_RIGHT, RIGHT_FLAG},    {NPAD_PLUS, PLAY_FLAG},     {NPAD_MINUS, BACK_FLAG},
    {NPAD_STICK_L, LS_CLK_FLAG}, {NPAD_STICK_R, RS_CLK_FLAG}, {NPAD_L, LB_FLAG},
    {NPAD_R, RB_FLAG},
};

/* Nintendo positions to Xbox positions by default; --labels keeps the names. */
static const struct button POSITION[] = {
    {NPAD_B, A_FLAG}, {NPAD_A, B_FLAG}, {NPAD_Y, X_FLAG}, {NPAD_X, Y_FLAG}};
static const struct button LABELS[] = {
    {NPAD_A, A_FLAG}, {NPAD_B, B_FLAG}, {NPAD_X, X_FLAG}, {NPAD_Y, Y_FLAG}};

struct controller {
  bool connected;
  int buttons;
  uint8_t left_trigger;
  uint8_t right_trigger;
  int16_t left_x;
  int16_t left_y;
  int16_t right_x;
  int16_t right_y;
};

struct point {
  uint32_t id;
  float x;
  float y;
};

struct touch_event {
  uint32_t id;
  uint8_t action;
  float x;
  float y;
};

static struct input_options options;
static struct bridge *bridge;
static char directory[1024];
static pthread_t thread;
static atomic_bool stopping;
static bool started;

static struct controller previous;
static bool have_previous;
static struct point active[TOUCH_MAX_POINTS];
static int active_count;
static int touch_support = -1;

static uint32_t u32(const uint8_t *bytes, size_t offset) {
  uint32_t value;
  memcpy(&value, bytes + offset, 4);
  return value;
}

static int16_t int16(int32_t value) {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : (int16_t)value;
}

static struct controller to_moonlight(const uint8_t *pad) {
  struct controller out = {0};
  if (!(u32(pad, 32) & 1))
    return out;
  uint32_t held = u32(pad, 8);
  const struct button *face = options.labels ? LABELS : POSITION;
  for (int i = 0; i < 4; i++)
    if (held & face[i].npad)
      out.buttons |= face[i].flag;
  for (size_t i = 0; i < sizeof(SHARED) / sizeof(SHARED[0]); i++)
    if (held & SHARED[i].npad)
      out.buttons |= SHARED[i].flag;
  if ((held & NPAD_LEFT) && (held & NPAD_RIGHT))
    out.buttons &= ~(LEFT_FLAG | RIGHT_FLAG);
  if ((held & NPAD_UP) && (held & NPAD_DOWN))
    out.buttons &= ~(UP_FLAG | DOWN_FLAG);
  out.connected = true;
  out.left_trigger = held & NPAD_ZL ? 255 : 0;
  out.right_trigger = held & NPAD_ZR ? 255 : 0;
  out.left_x = int16((int32_t)u32(pad, 16));
  out.left_y = int16((int32_t)u32(pad, 20));
  out.right_x = int16((int32_t)u32(pad, 24));
  out.right_y = int16((int32_t)u32(pad, 28));
  return out;
}

static bool same(const struct controller *a, const struct controller *b) {
  return a->connected == b->connected && a->buttons == b->buttons &&
         a->left_trigger == b->left_trigger && a->right_trigger == b->right_trigger &&
         a->left_x == b->left_x && a->left_y == b->left_y && a->right_x == b->right_x &&
         a->right_y == b->right_y;
}

/* touch.cjs: clamp to the panel, then round to 4 decimals. */
static float panel_position(int32_t value, int size) {
  double share = (double)value / size;
  share = share < 0 ? 0 : share > 1 ? 1 : share;
  return (float)(round(share * 1e4) / 1e4);
}

static void print_number(char *out, size_t size, float value) {
  snprintf(out, size, "%.4f", value);
  char *end = out + strlen(out) - 1;
  while (*end == '0')
    *end-- = 0;
  if (*end == '.')
    *end = 0;
}

static void send_controller(const struct controller *pad) {
  if (options.dry) {
    printf("{\"type\":\"controller\",\"connected\":%s,\"buttonFlags\":%d,\"leftTrigger\":%d,"
           "\"rightTrigger\":%d,\"leftStickX\":%d,\"leftStickY\":%d,\"rightStickX\":%d,"
           "\"rightStickY\":%d}\n",
           pad->connected ? "true" : "false", pad->buttons, pad->left_trigger,
           pad->right_trigger, pad->left_x, pad->left_y, pad->right_x, pad->right_y);
    fflush(stdout);
    return;
  }
  LiSendMultiControllerEvent(0, 1, pad->buttons, pad->left_trigger, pad->right_trigger,
                             pad->left_x, pad->left_y, pad->right_x, pad->right_y);
}

static const char *action_name(uint8_t action) {
  return action == LI_TOUCH_EVENT_DOWN ? "down" : action == LI_TOUCH_EVENT_UP ? "up" : "move";
}

static void send_touch(const struct touch_event *events, int count) {
  if (!count)
    return;
  if (options.dry) {
    char line[TOUCH_MAX_POINTS * 2 * 96 + 64], x[16], y[16];
    int used = snprintf(line, sizeof(line), "{\"type\":\"touch\",\"events\":[");
    for (int i = 0; i < count; i++) {
      print_number(x, sizeof(x), events[i].x);
      print_number(y, sizeof(y), events[i].y);
      used += snprintf(line + used, sizeof(line) - (size_t)used,
                       "%s{\"id\":%u,\"action\":\"%s\",\"x\":%s,\"y\":%s,\"pressure\":0}",
                       i ? "," : "", events[i].id, action_name(events[i].action), x, y);
    }
    printf("%s]}\n", line);
    fflush(stdout);
    return;
  }
  if (touch_support == -1) {
    touch_support = (LiGetHostFeatureFlags() & LI_FF_PEN_TOUCH_EVENTS) ? 1 : 0;
    status("{\"event\":\"touch\",\"supported\":%s}", touch_support ? "true" : "false");
  }
  for (int i = 0; i < count && touch_support; i++)
    if (LiSendTouchEvent(events[i].action, events[i].id, events[i].x, events[i].y, 0.0f, 0.0f,
                         0.0f, LI_ROT_UNKNOWN) == LI_ERR_UNSUPPORTED) {
      touch_support = 0;
      status("{\"event\":\"touch\",\"supported\":false}");
    }
}

static int find_active(uint32_t id) {
  for (int i = 0; i < active_count; i++)
    if (active[i].id == id)
      return i;
  return -1;
}

static void forget_active(int index) {
  size_t after = (size_t)(active_count - index - 1);
  memmove(&active[index], &active[index + 1], sizeof(active[0]) * after);
  active_count--;
}

/* touch.cjs step(): down for new ids, move when a point changed, up for ended
 * points and for ids that vanished, in that order. */
static void step_touch(const uint8_t *touch) {
  struct touch_event events[TOUCH_MAX_POINTS * 2];
  uint32_t seen[TOUCH_MAX_POINTS];
  int count = 0, seen_count = 0;
  uint32_t points = u32(touch, 8);
  if (points > TOUCH_MAX_POINTS)
    points = TOUCH_MAX_POINTS;
  for (uint32_t i = 0; i < points; i++) {
    size_t word = (4 + i * 10) * 4;
    uint32_t attributes = u32(touch, word + 8), id = u32(touch, word + 12);
    float x = panel_position((int32_t)u32(touch, word + 16), TOUCH_PANEL_WIDTH);
    float y = panel_position((int32_t)u32(touch, word + 20), TOUCH_PANEL_HEIGHT);
    int known = find_active(id);
    if (attributes & ATTRIBUTE_ENDED) {
      if (known >= 0) {
        events[count++] = (struct touch_event){id, LI_TOUCH_EVENT_UP, x, y};
        forget_active(known);
      }
      continue;
    }
    seen[seen_count++] = id;
    if (known < 0) {
      events[count++] = (struct touch_event){id, LI_TOUCH_EVENT_DOWN, x, y};
      if (active_count < TOUCH_MAX_POINTS)
        active[active_count++] = (struct point){id, x, y};
    } else if (active[known].x != x || active[known].y != y) {
      events[count++] = (struct touch_event){id, LI_TOUCH_EVENT_MOVE, x, y};
      active[known].x = x;
      active[known].y = y;
    }
  }
  for (int i = 0; i < active_count;) {
    bool present = false;
    for (int j = 0; j < seen_count && !present; j++)
      present = seen[j] == active[i].id;
    if (present) {
      i++;
      continue;
    }
    struct point *gone = &active[i];
    events[count++] = (struct touch_event){gone->id, LI_TOUCH_EVENT_UP, gone->x, gone->y};
    forget_active(i);
  }
  send_touch(events, count);
}

static void release(void) {
  struct touch_event ups[TOUCH_MAX_POINTS];
  for (int i = 0; i < active_count; i++)
    ups[i] = (struct touch_event){active[i].id, LI_TOUCH_EVENT_UP, active[i].x, active[i].y};
  send_touch(ups, active_count);
  active_count = 0;
  struct controller neutral = {0};
  if (have_previous && !same(&previous, &neutral))
    send_controller(&neutral);
  have_previous = false;
}

static void *feed(void *unused) {
  pthread_setname_np(pthread_self(), "console-input");
  uint8_t state[READ_BYTES];
  uint64_t mapped = 0;
  bool moonlight = false;
  double interval = 1000.0 / options.hz, checked = -1e9;
  while (!atomic_load(&stopping)) {
    double started_at = now_ms();
    if (started_at - checked > SOURCE_CHECK_MS) {
      moonlight = run_input_source(directory, &mapped);
      checked = started_at;
    }
    if (moonlight) {
      if (bridge_read(bridge, mapped, state, sizeof(state))) {
        struct controller pad = to_moonlight(state);
        if (!have_previous || !same(&previous, &pad))
          send_controller(&pad);
        previous = pad;
        have_previous = true;
        step_touch(state + STATE_TOUCH);
      } else {
        status("{\"event\":\"error\",\"message\":\"input read failed\",\"detail\":\"%s\"}",
               bridge_error(bridge));
      }
    } else if (have_previous || active_count) {
      release();
    }
    sleep_ms(interval - (now_ms() - started_at));
  }
  release();
  return NULL;
}

bool console_input_start(const struct input_options *chosen, const struct bridge_info *info,
                         const char *run_directory) {
  options = *chosen;
  if (options.hz <= 0)
    options.hz = 60;
  snprintf(directory, sizeof(directory), "%s", run_directory);
  bridge = bridge_open(info, 0, READ_BYTES);
  started = bridge && pthread_create(&thread, NULL, feed, NULL) == 0;
  return started;
}

void console_input_stop(void) {
  if (!started)
    return;
  atomic_store(&stopping, true);
  pthread_join(thread, NULL);
  bridge_close(bridge);
  started = false;
}
