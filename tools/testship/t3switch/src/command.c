#include <stddef.h>
#include <string.h>

#include "command.h"

static int duration(const char *text, unsigned *out)
{
    unsigned value = 0;
    if (!*text)
        return -1;
    for (const char *at = text; *at; at++) {
        if (*at < '0' || *at > '9')
            return -1;
        value = value * 10 + (unsigned)(*at - '0');
        if (value > 30000)
            return -1;
    }
    *out = value;
    return 0;
}

static int hex_digit(char value)
{
    if (value >= '0' && value <= '9')
        return value - '0';
    if (value >= 'a' && value <= 'f')
        return value - 'a' + 10;
    if (value >= 'A' && value <= 'F')
        return value - 'A' + 10;
    return -1;
}

int control_parse(const char *line, struct control_command *command)
{
    *command = (struct control_command){.kind = line[0]};
    const size_t length = strlen(line);
    if ((line[0] == 'S' || line[0] == 'Q') && length == 1)
        return 0;
    if (line[0] == 'W' && length >= 3 && line[1] == ' ')
        return duration(line + 2, &command->milliseconds);
    if ((line[0] != 'K' && line[0] != 'P') || length < 20)
        return -1;
    if (line[1] != ' ' || line[18] != ' ')
        return -1;

    for (size_t i = 0; i < 8; i++) {
        const int high = hex_digit(line[2 + 2 * i]);
        const int low = hex_digit(line[3 + 2 * i]);
        if (high < 0 || low < 0)
            return -1;
        command->report[i] = (uint8_t)((unsigned)high * 16 + (unsigned)low);
    }
    return duration(line + 19, &command->milliseconds);
}
