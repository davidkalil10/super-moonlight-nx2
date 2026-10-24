/* Shared declarations for hbmoonlight, the headless Moonlight client used by
 * HBLauncher. stdout carries raw frames (or JSON for pair/list), stderr carries
 * one JSON object per line. */
#pragma once

#include <Limelight.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void status(const char *format, ...) __attribute__((format(printf, 1, 2)));
void json_string(char *out, size_t size, const char *text);

struct video_options {
  int width;
  int height;
  bool software;
  bool decode;
  int raw_fd;
};

struct video_stats {
  unsigned decoded;
  unsigned written;
  unsigned dropped;
  unsigned failed;
  double decode_ms;
};

void video_configure(const struct video_options *options);
void video_callbacks(DECODER_RENDERER_CALLBACKS *callbacks);
void video_take_stats(struct video_stats *stats);

void audio_configure(int fd);
void audio_callbacks(AUDIO_RENDERER_CALLBACKS *callbacks);
unsigned audio_take_dropped(void);

bool input_handle_line(const char *line);
