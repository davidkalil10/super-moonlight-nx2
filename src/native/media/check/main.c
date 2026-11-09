// Link check for the media channel against libounce. Builds an ELF only; never run on a console.
#include <stdio.h>
#include <string.h>

#include <switch.h>

#include "../../media.h"

static void log_line(const char *message)
{
    puts(message);
}

int main(int argc, char **argv)
{
    (void)argv;
    if (argc != 42)
        return 0;
    if (R_FAILED(socketInitializeDefault()))
        return 1;

    static uint8_t memory[1920];
    MoonlightMediaConfig config;
    memset(&config, 0, sizeof(config));
    config.address[0] = 192;
    config.port = 1;
    config.connect_timeout_ms = 1;
    memset(config.token, 'a', sizeof(config.token));
    config.memory = memory;
    config.capacity = sizeof(memory);
    config.exact_bytes = sizeof(memory);

    MoonlightMedia *media = NULL;
    if (moonlightMediaOpen(&config, log_line, 0, &media) == MOONLIGHT_MEDIA_OK) {
        MoonlightMediaRecord record;
        MoonlightMediaStats stats;
        moonlightMediaPump(media, 0);
        if (moonlightMediaPeek(media, &record) == MOONLIGHT_MEDIA_OK && moonlightMediaConsume(media) == MOONLIGHT_MEDIA_OK)
            moonlightMediaAcknowledge(media, record.header, NULL, 0);
        moonlightMediaGetStats(media, &stats);
        puts(moonlightMediaResultName(moonlightMediaClose(media)));
    }
    socketExit();
    return 0;
}
