#ifndef MOONLIGHT_T3_COMMAND_H
#define MOONLIGHT_T3_COMMAND_H

#include <stdint.h>

struct control_command {
    char kind;
    uint8_t report[8];
    unsigned milliseconds;
};

int control_parse(const char *line, struct control_command *command);

#endif
