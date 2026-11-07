/* Shared declarations for hbmoonlight, the headless Moonlight client of moonlight-nx2. The raw
 * fd carries the access units, stdout JSON for pair/list, stderr one JSON object per line. */
#pragma once

#include <Limelight.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void status(const char *format, ...) __attribute__((format(printf, 1, 2)));
void json_string(char *out, size_t size, const char *text);

int options_index(const char *command);
const char *option(int argc, char **argv, const char *name, const char *fallback);
bool option_int(int argc, char **argv, const char *name, int fallback, long min, long max,
                int *out);
bool flag(int argc, char **argv, const char *name);

struct stream_codec {
  int format;
  int raw_fd;
};

const char *stream_codec_parse(int argc, char **argv, struct stream_codec *out);

struct stream_launch {
  bool sops;
  bool local_audio;
};

void stream_launch_parse(int argc, char **argv, struct stream_launch *out);

struct video_options {
  int format;
  int raw_fd;
};

struct video_stats {
  unsigned written;
  unsigned failed;
};

void video_configure(const struct video_options *options);
void video_callbacks(DECODER_RENDERER_CALLBACKS *callbacks);
void video_take_stats(struct video_stats *stats);

void audio_configure(int fd);
void audio_callbacks(AUDIO_RENDERER_CALLBACKS *callbacks);
unsigned audio_take_dropped(void);

bool input_handle_line(const char *line);

struct _SERVER_DATA;
void session_on_alarm(int signal);
void session_deadline(unsigned seconds, const char *stage);
int session_fail(const char *message, const char *detail);
int session_connect(struct _SERVER_DATA *server, char *host);
bool session_key_directory(char *path, size_t size);
int session_find_app(struct _SERVER_DATA *server, const char *wanted);
struct _APP_LIST;
struct _APP_LIST *session_host_order(struct _APP_LIST *apps);
void session_configure(STREAM_CONFIGURATION *config, int width, int height, int fps,
                       int bitrate, int formats);
void session_listener(CONNECTION_LISTENER_CALLBACKS *listener);
bool session_started(void);
bool session_terminated(void);
void session_announce_controller(void);
void session_report_rtt(void);
