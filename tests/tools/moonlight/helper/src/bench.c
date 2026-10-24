/* hbmoonlight-bench: feeds an Annex B H.264/HEVC file through the stream's
 * video path, so decode speed and the newest-frame output can be measured
 * without a GameStream host.
 *
 *   hbmoonlight-bench FILE h264|hevc WxH [--software] [--raw-fd FD] [--rgb]
 *
 * Frames go to stdout exactly as in `hbmoonlight stream`; a summary goes to
 * stderr. */
#include "helper.h"

#include <libavcodec/avcodec.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static bool flag(int argc, char **argv, const char *name) {
  for (int i = 0; i < argc; i++)
    if (strcmp(argv[i], name) == 0)
      return true;
  return false;
}

static const char *option(int argc, char **argv, const char *name, const char *fallback) {
  for (int i = 0; i + 1 < argc; i++)
    if (strcmp(argv[i], name) == 0)
      return argv[i + 1];
  return fallback;
}

static double now_seconds(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return time.tv_sec + time.tv_nsec / 1e9;
}

static void submit(DECODER_RENDERER_CALLBACKS *video, uint8_t *data, int size, int number) {
  LENTRY entry = {.next = NULL, .data = (char *)data, .length = size};
  DECODE_UNIT unit = {.frameNumber = number, .fullLength = size, .bufferList = &entry};
  unit.frameType = (data[4] & 0x1f) == 7 || (data[4] >> 1 & 0x3f) == 32 ? FRAME_TYPE_IDR
                                                                         : FRAME_TYPE_PFRAME;
  video->submitDecodeUnit(&unit);
}

int main(int argc, char **argv) {
  if (argc < 4) {
    fprintf(stderr, "usage: hbmoonlight-bench FILE h264|hevc WxH [--software] [--raw-fd FD]"
                    " [--rgb]\n");
    return 2;
  }
  bool hevc = strcmp(argv[2], "hevc") == 0;
  struct video_options options = {.software = flag(argc, argv, "--software")};
  sscanf(argv[3], "%dx%d", &options.width, &options.height);
  options.raw_fd = atoi(option(argc, argv, "--raw-fd", "-1"));
  options.decode = options.raw_fd < 0 || flag(argc, argv, "--rgb");

  FILE *file = fopen(argv[1], "rb");
  if (!file) {
    perror(argv[1]);
    return 1;
  }
  fseek(file, 0, SEEK_END);
  long size = ftell(file);
  rewind(file);
  uint8_t *data = malloc(size + AV_INPUT_BUFFER_PADDING_SIZE);
  if (fread(data, 1, size, file) != (size_t)size)
    return 1;
  fclose(file);

  AVCodecParserContext *parser = av_parser_init(hevc ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264);
  AVCodecContext *parse_codec =
      avcodec_alloc_context3(avcodec_find_decoder(hevc ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264));

  DECODER_RENDERER_CALLBACKS video;
  video_configure(&options);
  video_callbacks(&video);
  if (video.setup(hevc ? VIDEO_FORMAT_H265 : VIDEO_FORMAT_H264, options.width, options.height,
                  60, NULL, 0) != 0)
    return 1;

  double started = now_seconds();
  int units = 0;
  uint8_t *at = data;
  long left = size;
  while (left > 0) {
    uint8_t *unit;
    int unit_size;
    int used = av_parser_parse2(parser, parse_codec, &unit, &unit_size, at, (int)left,
                                AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0);
    at += used;
    left -= used;
    if (unit_size > 0)
      submit(&video, unit, unit_size, ++units);
  }
  uint8_t *unit;
  int unit_size;
  av_parser_parse2(parser, parse_codec, &unit, &unit_size, NULL, 0, AV_NOPTS_VALUE,
                   AV_NOPTS_VALUE, 0);
  if (unit_size > 0)
    submit(&video, unit, unit_size, ++units);
  double elapsed = now_seconds() - started;

  struct video_stats stats;
  video.cleanup();
  video_take_stats(&stats);
  status("{\"event\":\"bench\",\"units\":%d,\"seconds\":%.3f,\"fps\":%.1f,\"decoded\":%u,"
         "\"written\":%u,\"dropped\":%u,\"failed\":%u,\"decodeMs\":%.2f}",
         units, elapsed, units / elapsed, stats.decoded, stats.written, stats.dropped,
         stats.failed, stats.decoded ? stats.decode_ms / stats.decoded : 0.0);
  av_parser_close(parser);
  avcodec_free_context(&parse_codec);
  free(data);
  return 0;
}
