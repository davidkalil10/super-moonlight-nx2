/*
 * Opus decoding for audio received straight from Sunshine, on the console's hwopus service.
 * One decoder at a time; the runtime opens it per stream and closes it at teardown.
 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include <switch.h>

#define MAX_PACKET_BYTES 1400

static HwopusDecoder decoder;
static bool opened;
static uint8_t input[sizeof(HwopusHeader) + MAX_PACKET_BYTES];

uint32_t moonlightOpusOpen(int32_t rate, int32_t channels, int32_t streams, int32_t coupled,
                           const uint8_t mapping[8])
{
    if (opened)
        return MAKERESULT(Module_Libnx, LibnxError_AlreadyInitialized);
    uint8_t layout[8];
    memcpy(layout, mapping, sizeof(layout));
    Result result = channels <= 2 && streams <= 1
        ? hwopusDecoderInitialize(&decoder, rate, channels)
        : hwopusDecoderMultistreamInitialize(&decoder, rate, channels, streams, coupled, layout);
    opened = R_SUCCEEDED(result);
    return result;
}

uint32_t moonlightOpusDecode(const uint8_t *packet, size_t size, int16_t *pcm, size_t pcm_bytes,
                             int32_t *samples)
{
    if (!opened || size > MAX_PACKET_BYTES)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    HwopusHeader header = { .size = __builtin_bswap32((uint32_t)size), .final_range = 0 };
    memcpy(input, &header, sizeof(header));
    memcpy(input + sizeof(header), packet, size);
    int32_t decoded = 0;
    return hwopusDecodeInterleaved(&decoder, &decoded, samples, input, sizeof(header) + size, pcm,
                                   pcm_bytes);
}

void moonlightOpusClose(void)
{
    if (opened)
        hwopusDecoderExit(&decoder);
    opened = false;
}
