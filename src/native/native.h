#pragma once

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    bool connected;
    uint16_t buttons;
    uint8_t left_trigger;
    uint8_t right_trigger;
    int16_t left_x;
    int16_t left_y;
    int16_t right_x;
    int16_t right_y;
} MoonlightPad;

MoonlightPad moonlightMapPad(bool connected, uint64_t buttons,
    int32_t left_x, int32_t left_y, int32_t right_x, int32_t right_y);
bool moonlightStopHeld(uint64_t buttons);
void moonlightReport(const char *format, ...) __attribute__((format(printf, 1, 2)));
void moonlightHideConsole(void);
bool moonlightProbeVulkan(void);
