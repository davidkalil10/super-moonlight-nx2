/* Input: one JSON object per stdin line. A line tagged {"type":"touch",...}
 * carries an events array, each {id,action,x,y,pressure} turned into a
 * LiSendTouchEvent call; "request-idr" requests a video keyframe. Other lines
 * (tagged "controller" or untyped, kept
 * for backward compatibility) is the whole controller state sent as gamepad 0.
 * Missing controller fields keep their previous value. */
#include "helper.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct pad {
  long buttons;
  long left_trigger;
  long right_trigger;
  long left_x;
  long left_y;
  long right_x;
  long right_y;
};

static struct pad state;
static int touch_support = -1;

static bool message_type(const char *line, const char *name) {
  const char *at = strstr(line, "\"type\"");
  if (!at || !(at = strchr(at + 6, ':')))
    return false;
  at++;
  while (isspace((unsigned char)*at))
    at++;
  size_t length = strlen(name);
  return *at == '"' && strncmp(at + 1, name, length) == 0 && at[length + 1] == '"';
}

static long field(const char *line, const char *name, long previous, long low, long high) {
  char key[32];
  snprintf(key, sizeof(key), "\"%s\"", name);
  const char *at = strstr(line, key);
  if (!at)
    return previous;
  at = strchr(at + strlen(key), ':');
  if (!at)
    return previous;
  char *end;
  long value = strtol(at + 1, &end, 10);
  if (end == at + 1)
    return previous;
  return value < low ? low : value > high ? high : value;
}

static double real_field(const char *line, const char *name, double previous) {
  char key[32];
  snprintf(key, sizeof(key), "\"%s\"", name);
  const char *at = strstr(line, key);
  if (!at)
    return previous;
  at = strchr(at + strlen(key), ':');
  if (!at)
    return previous;
  char *end;
  double value = strtod(at + 1, &end);
  return end == at + 1 ? previous : value;
}

static bool handle_controller(const char *line) {
  state.buttons = field(line, "buttonFlags", state.buttons, 0, 0x7fffffff);
  state.left_trigger = field(line, "leftTrigger", state.left_trigger, 0, 255);
  state.right_trigger = field(line, "rightTrigger", state.right_trigger, 0, 255);
  state.left_x = field(line, "leftStickX", state.left_x, -32768, 32767);
  state.left_y = field(line, "leftStickY", state.left_y, -32768, 32767);
  state.right_x = field(line, "rightStickX", state.right_x, -32768, 32767);
  state.right_y = field(line, "rightStickY", state.right_y, -32768, 32767);
  return LiSendMultiControllerEvent(0, 1, (int)state.buttons, (unsigned char)state.left_trigger,
                                    (unsigned char)state.right_trigger, (short)state.left_x,
                                    (short)state.left_y, (short)state.right_x,
                                    (short)state.right_y) == 0;
}

static uint8_t touch_action(const char *object) {
  if (strstr(object, "\"down\""))
    return LI_TOUCH_EVENT_DOWN;
  if (strstr(object, "\"up\""))
    return LI_TOUCH_EVENT_UP;
  return LI_TOUCH_EVENT_MOVE;
}

static bool handle_touch(const char *line) {
  if (touch_support == -1) {
    touch_support = (LiGetHostFeatureFlags() & LI_FF_PEN_TOUCH_EVENTS) ? 1 : 0;
    status("{\"event\":\"touch\",\"supported\":%s}", touch_support ? "true" : "false");
  }
  if (!touch_support)
    return true;
  const char *at = strstr(line, "\"events\"");
  if (at)
    at = strchr(at, '[');
  bool ok = true;
  while (at && (at = strchr(at, '{'))) {
    const char *end = strchr(at, '}');
    if (!end)
      break;
    char object[256];
    size_t length = (size_t)(end - at) + 1;
    if (length >= sizeof(object))
      length = sizeof(object) - 1;
    memcpy(object, at, length);
    object[length] = 0;
    int result = LiSendTouchEvent(touch_action(object),
                                  (uint32_t)field(object, "id", 0, 0, 0x7fffffff),
                                  (float)real_field(object, "x", 0),
                                  (float)real_field(object, "y", 0),
                                  (float)real_field(object, "pressure", 0), 0.0f, 0.0f,
                                  LI_ROT_UNKNOWN);
    if (result == LI_ERR_UNSUPPORTED) {
      touch_support = 0;
      status("{\"event\":\"touch\",\"supported\":false}");
      return true;
    }
    if (result != 0)
      ok = false;
    at = end + 1;
  }
  return ok;
}

bool input_handle_line(const char *line) {
  if (!strchr(line, '{'))
    return false;
  if (message_type(line, "request-idr")) {
    LiRequestIdrFrame();
    return true;
  }
  if (message_type(line, "touch"))
    return handle_touch(line);
  return handle_controller(line);
}
