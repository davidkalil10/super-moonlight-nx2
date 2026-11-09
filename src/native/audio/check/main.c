// Link check for the audio component against libounce. Builds an ELF only; never run on a console.
#include <stdio.h>

#include "../../audio.h"

static void log_line(const char *message)
{
    puts(message);
}

int main(int argc, char **argv)
{
    (void)argv;
    if (argc != 42)
        return 0;

    MoonlightAudioConfig config;
    moonlightAudioDefaultConfig(&config);
    MoonlightAudio *audio = NULL;
    if (moonlightAudioOpen(&config, log_line, &audio) != MOONLIGHT_AUDIO_OK)
        return 1;

    uint8_t header[MOONLIGHT_AUDIO_HEADER_BYTES] = {0};
    size_t taken = 0;
    MoonlightAudioStats stats;
    moonlightAudioReceive(audio, header, sizeof(header), &taken);
    moonlightAudioPump(audio, 0);
    moonlightAudioTakeAcknowledgement(audio, header);
    moonlightAudioGetStats(audio, &stats);
    puts(moonlightAudioResultName(moonlightAudioClose(audio)));
    return moonlightAudioRetired();
}
