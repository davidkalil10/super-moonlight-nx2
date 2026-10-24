/* Input: one JSON object per stdin line describing the whole controller state,
 * {buttonFlags,leftTrigger,rightTrigger,leftStickX,leftStickY,rightStickX,rightStickY}.
 * Missing fields keep their previous value. Sent as gamepad 0. */
#include "helper.h"

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

bool input_handle_line(const char *line) {
  if (!strchr(line, '{'))
    return false;
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
