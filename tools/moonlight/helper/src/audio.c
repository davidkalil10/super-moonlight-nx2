/* Audio: decodes the Opus stream to interleaved s16le PCM and writes it to the
 * --audio-fd descriptor. The descriptor is non-blocking; packets the reader
 * cannot take are dropped instead of stalling the receive thread. */
#include "helper.h"

#include <errno.h>
#include <fcntl.h>
#include <opus/opus_multistream.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <unistd.h>

static int output = -1;
static OpusMSDecoder *decoder;
static int channels;
static int frame_samples;
static int16_t *pcm;
static atomic_uint dropped;

static int init(int configuration, const POPUS_MULTISTREAM_CONFIGURATION opus, void *context,
                int flags) {
  int error;
  decoder = opus_multistream_decoder_create(opus->sampleRate, opus->channelCount, opus->streams,
                                            opus->coupledStreams, opus->mapping, &error);
  if (!decoder) {
    status("{\"event\":\"error\",\"message\":\"opus: %s\"}", opus_strerror(error));
    return -1;
  }
  channels = opus->channelCount;
  frame_samples = opus->samplesPerFrame;
  pcm = malloc(sizeof(int16_t) * frame_samples * channels);
  status("{\"event\":\"audio\",\"format\":\"s16le\",\"sampleRate\":%d,\"channels\":%d}",
         opus->sampleRate, channels);
  return 0;
}

static void play(char *data, int length) {
  int samples = opus_multistream_decode(decoder, (unsigned char *)data, length, pcm,
                                        frame_samples, 0);
  if (samples <= 0)
    return;
  size_t bytes = sizeof(int16_t) * samples * channels;
  if (write(output, pcm, bytes) != (ssize_t)bytes)
    atomic_fetch_add(&dropped, 1);
}

static void cleanup(void) {
  opus_multistream_decoder_destroy(decoder);
  decoder = NULL;
  free(pcm);
  pcm = NULL;
}

void audio_configure(int fd) {
  output = fd;
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
}

void audio_callbacks(AUDIO_RENDERER_CALLBACKS *callbacks) {
  LiInitializeAudioCallbacks(callbacks);
  callbacks->init = init;
  callbacks->cleanup = cleanup;
  callbacks->decodeAndPlaySample = play;
  callbacks->capabilities = CAPABILITY_DIRECT_SUBMIT;
}

unsigned audio_take_dropped(void) {
  return atomic_exchange(&dropped, 0);
}
