#include "helper.h"

#include <assert.h>
#include <stdarg.h>
#include <stdio.h>

static int pads;
static int touches;
static int idrs;
static int buttons;
static short stick_x;
static short stick_y;
static uint32_t pointer;
static uint8_t action;
static float touch_x;
static float touch_y;

void status(const char *format, ...) {}

int LiSendMultiControllerEvent(short controller, short mask, int flags,
                              unsigned char left_trigger, unsigned char right_trigger,
                              short left_x, short left_y, short right_x, short right_y) {
  assert(controller == 0 && mask == 1);
  pads++;
  buttons = flags;
  stick_x = left_x;
  stick_y = left_y;
  return 0;
}

int LiSendTouchEvent(uint8_t type, uint32_t id, float x, float y, float pressure,
                     float major, float minor, uint16_t rotation) {
  assert(rotation == LI_ROT_UNKNOWN);
  touches++;
  pointer = id;
  action = type;
  touch_x = x;
  touch_y = y;
  return 0;
}

uint32_t LiGetHostFeatureFlags(void) {
  return LI_FF_PEN_TOUCH_EVENTS;
}

void LiRequestIdrFrame(void) {
  idrs++;
}

int main(void) {
  assert(input_handle_line("{\"type\":\"controller\",\"buttonFlags\":8192,\"leftStickX\":42}"));
  assert(pads == 1 && buttons == 8192 && stick_x == 42);
  assert(input_handle_line("{ \"type\" : \"request-idr\" }"));
  assert(idrs == 1 && pads == 1 && touches == 0);
  assert(input_handle_line("{\"type\":\"controller\",\"leftStickY\":-900}"));
  assert(pads == 2 && buttons == 8192 && stick_x == 42 && stick_y == -900);
  assert(input_handle_line("{ \"type\" : \"touch\", \"events\":[{\"id\":7,\"action\":\"down\",\"x\":0.25,\"y\":0.5}]}"));
  assert(touches == 1 && action == LI_TOUCH_EVENT_DOWN && pointer == 7);
  assert(touch_x == 0.25f && touch_y == 0.5f && pads == 2);
  assert(input_handle_line("{\"buttonFlags\":0}"));
  assert(pads == 3 && buttons == 0 && stick_x == 42 && stick_y == -900);
  assert(!input_handle_line("invalid"));
  puts("Controller, touch and IDR routing passed");
  return 0;
}
