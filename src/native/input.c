#include <stddef.h>

#include "native.h"

static int16_t stick_value(int32_t value)
{
    if (value < INT16_MIN)
        return INT16_MIN;
    if (value > INT16_MAX)
        return INT16_MAX;
    return (int16_t)value;
}

MoonlightPad moonlightMapPad(bool connected, uint64_t buttons,
    int32_t left_x, int32_t left_y, int32_t right_x, int32_t right_y)
{
    MoonlightPad pad = {.connected = connected};
    if (!connected)
        return pad;

    static const uint16_t flags[] = {
        0x1000, 0x2000, 0x4000, 0x8000, 0x0040, 0x0080, 0x0100, 0x0200,
        0, 0, 0x0010, 0x0020, 0x0004, 0x0001, 0x0008, 0x0002,
    };
    for (size_t bit = 0; bit < sizeof(flags) / sizeof(flags[0]); bit++) {
        if (buttons & (UINT64_C(1) << bit))
            pad.buttons |= flags[bit];
    }

    const uint64_t horizontal = (UINT64_C(1) << 12) | (UINT64_C(1) << 14);
    const uint64_t vertical = (UINT64_C(1) << 13) | (UINT64_C(1) << 15);
    if ((buttons & horizontal) == horizontal)
        pad.buttons &= ~(0x0004 | 0x0008);
    if ((buttons & vertical) == vertical)
        pad.buttons &= ~(0x0001 | 0x0002);

    pad.left_trigger = (buttons & (UINT64_C(1) << 8)) ? UINT8_MAX : 0;
    pad.right_trigger = (buttons & (UINT64_C(1) << 9)) ? UINT8_MAX : 0;
    pad.left_x = stick_value(left_x);
    pad.left_y = stick_value(left_y);
    pad.right_x = stick_value(right_x);
    pad.right_y = stick_value(right_y);
    return pad;
}

bool moonlightStopHeld(uint64_t buttons)
{
    const uint64_t chord = (UINT64_C(3) << 6) | (UINT64_C(3) << 10);
    return (buttons & chord) == chord;
}
