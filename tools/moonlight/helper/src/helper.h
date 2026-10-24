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

struct mailbox;

struct video_options {
  int width;
  int height;
  bool software;
  bool decode;
  int raw_fd;
  struct mailbox *frames;
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
void audio_configure_sink(void (*sink)(const void *pcm, size_t bytes));
void audio_callbacks(AUDIO_RENDERER_CALLBACKS *callbacks);
unsigned audio_take_dropped(void);

bool input_handle_line(const char *line);

struct _SERVER_DATA;
void session_on_alarm(int signal);
int session_fail(const char *message, const char *detail);
int session_connect(struct _SERVER_DATA *server, char *host);
int session_find_app(struct _SERVER_DATA *server, const char *wanted);
void session_configure(STREAM_CONFIGURATION *config, int width, int height, int fps,
                       int bitrate, int formats);
void session_listener(CONNECTION_LISTENER_CALLBACKS *listener);
bool session_started(void);
bool session_terminated(void);
void session_announce_controller(void);
