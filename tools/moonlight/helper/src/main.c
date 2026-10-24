/* hbmoonlight: headless Moonlight client for the HBLauncher PC host.
 *
 *   hbmoonlight pair HOST [--timeout SECONDS]
 *   hbmoonlight list HOST
 *   hbmoonlight stream HOST APP [--size WxH] [--fps N] [--bitrate KBPS]
 *                     [--codec h264|hevc] [--software] [--audio-fd FD] [--quit]
 *                     [--raw-h264-fd FD | --raw-hevc-fd FD] [--rgb]
 *
 * A raw fd receives every access unit in order as Annex B and turns off the
 * RGB24 output unless --rgb is also given.
 *
 * Pairing and app control come from moonlight-embedded's libgamestream, the
 * stream itself from moonlight-common-c. Client keys live in
 * $XDG_CONFIG_HOME/hblauncher/moonlight (or ~/.config/...). */
#include "helper.h"

#include <client.h>
#include <errors.h>

#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted;

static void on_interrupt(int signal) {
  interrupted = 1;
}

static const char *option(int argc, char **argv, const char *name, const char *fallback) {
  for (int i = 0; i + 1 < argc; i++)
    if (strcmp(argv[i], name) == 0)
      return argv[i + 1];
  return fallback;
}

static bool flag(int argc, char **argv, const char *name) {
  for (int i = 0; i < argc; i++)
    if (strcmp(argv[i], name) == 0)
      return true;
  return false;
}

static int pair(char *host, int timeout) {
  SERVER_DATA server;
  if (session_connect(&server, host))
    return 1;
  if (server.paired) {
    printf("{\"event\":\"paired\",\"already\":true}\n");
    return 0;
  }

  unsigned char random[4];
  if (getrandom(random, sizeof(random), 0) != sizeof(random))
    return session_fail("no randomness for the PIN", NULL);
  char pin[5];
  snprintf(pin, sizeof(pin), "%d%d%d%d", random[0] % 10, random[1] % 10, random[2] % 10,
           random[3] % 10);
  printf("{\"event\":\"pin\",\"pin\":\"%s\",\"url\":\"https://%s:47990/pin\",\"timeout\":%d}\n", pin,
         host, timeout);
  fflush(stdout);

  alarm(timeout);
  int result = gs_pair(&server, pin);
  alarm(0);
  if (result != GS_OK)
    return session_fail("pairing failed", gs_error);
  printf("{\"event\":\"paired\",\"already\":false}\n");
  return 0;
}

static int list(char *host) {
  SERVER_DATA server;
  if (session_connect(&server, host))
    return 1;
  if (!server.paired)
    return session_fail("not paired", "run: hbmoonlight pair HOST");
  PAPP_LIST apps;
  if (gs_applist(&server, &apps) != GS_OK)
    return session_fail("cannot read the app list", gs_error);

  char name[512];
  printf("{\"currentGame\":%d,\"apps\":[", server.currentGame);
  for (PAPP_LIST app = apps; app; app = app->next) {
    json_string(name, sizeof(name), app->name);
    printf("%s{\"id\":%d,\"name\":\"%s\"}", app == apps ? "" : ",", app->id, name);
  }
  printf("]}\n");
  return 0;
}

static double now_seconds(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return time.tv_sec + time.tv_nsec / 1e9;
}

static void report_stats(bool audio) {
  struct video_stats video;
  video_take_stats(&video);
  status("{\"event\":\"stats\",\"decoded\":%u,\"written\":%u,\"dropped\":%u,\"failed\":%u,"
         "\"decodeMs\":%.2f,\"audioDropped\":%u}",
         video.decoded, video.written, video.dropped, video.failed,
         video.decoded ? video.decode_ms / video.decoded : 0.0,
         audio ? audio_take_dropped() : 0);
}

static bool read_input(char *line, size_t size, size_t *used) {
  ssize_t count = read(STDIN_FILENO, line + *used, size - 1 - *used);
  if (count < 0)
    return errno == EINTR || errno == EAGAIN;
  if (count == 0)
    return false;
  *used += count;
  line[*used] = 0;
  char *start = line, *newline;
  while ((newline = strchr(start, '\n'))) {
    *newline = 0;
    if (session_started())
      input_handle_line(start);
    start = newline + 1;
  }
  *used = strlen(start);
  memmove(line, start, *used + 1);
  if (*used == size - 1)
    *used = 0;
  return true;
}

static void run_until_stopped(bool audio) {
  char line[4096];
  size_t used = 0;
  bool input_open = true, announced = false;
  double next_report = now_seconds() + 1;
  struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};

  while (!interrupted && !session_terminated()) {
    if (!announced && session_started()) {
      session_announce_controller();
      announced = true;
    }
    if (input_open && poll(&input, 1, 100) > 0) {
      input_open = read_input(line, sizeof(line), &used);
      if (!input_open)
        status("{\"event\":\"stopping\",\"reason\":\"stdin closed\"}");
    } else if (!input_open) {
      break;
    }
    if (now_seconds() >= next_report) {
      report_stats(audio);
      next_report += 1;
    }
  }
  if (interrupted)
    status("{\"event\":\"stopping\",\"reason\":\"signal\"}");
}

static int stream(int argc, char **argv) {
  char *host = argv[2];
  const char *app = argv[3];
  int width = 1920, height = 1080;
  if (sscanf(option(argc, argv, "--size", "1920x1080"), "%dx%d", &width, &height) != 2 ||
      width <= 0 || height <= 0)
    return session_fail("bad --size", NULL);
  int audio_fd = atoi(option(argc, argv, "--audio-fd", "-1"));
  bool hevc = strcmp(option(argc, argv, "--codec", "h264"), "hevc") == 0;
  int raw_h264 = atoi(option(argc, argv, "--raw-h264-fd", "-1"));
  int raw_hevc = atoi(option(argc, argv, "--raw-hevc-fd", "-1"));
  if (raw_h264 >= 0 && raw_hevc >= 0)
    return session_fail("pass only one of --raw-h264-fd and --raw-hevc-fd", NULL);
  int raw_fd = raw_h264 >= 0 ? raw_h264 : raw_hevc;

  SERVER_DATA server;
  if (session_connect(&server, host))
    return 1;
  if (!server.paired)
    return session_fail("not paired", "run: hbmoonlight pair HOST");
  int app_id = session_find_app(&server, app);
  if (app_id < 0)
    return session_fail("app not found", app);

  int formats = VIDEO_FORMAT_H264 | (hevc ? VIDEO_FORMAT_H265 : 0);
  if (raw_fd >= 0)
    formats = raw_hevc >= 0 ? VIDEO_FORMAT_H265 : VIDEO_FORMAT_H264;
  STREAM_CONFIGURATION config;
  session_configure(&config, width, height, atoi(option(argc, argv, "--fps", "60")),
                    atoi(option(argc, argv, "--bitrate", "20000")), formats);

  int result = gs_start_app(&server, &config, app_id, false, false, 1);
  if (result != GS_OK)
    return session_fail("cannot start the app", gs_error);

  struct video_options video = {.width = width,
                                .height = height,
                                .software = flag(argc, argv, "--software"),
                                .decode = raw_fd < 0 || flag(argc, argv, "--rgb"),
                                .raw_fd = raw_fd};
  video_configure(&video);
  DECODER_RENDERER_CALLBACKS video_callbacks_set;
  video_callbacks(&video_callbacks_set);
  AUDIO_RENDERER_CALLBACKS audio_callbacks_set;
  bool audio = audio_fd >= 0;
  if (audio) {
    audio_configure(audio_fd);
    audio_callbacks(&audio_callbacks_set);
  }
  CONNECTION_LISTENER_CALLBACKS listener;
  session_listener(&listener);

  struct sigaction stop = {.sa_handler = on_interrupt};
  sigaction(SIGINT, &stop, NULL);
  sigaction(SIGTERM, &stop, NULL);
  if (LiStartConnection(&server.serverInfo, &config, &listener, &video_callbacks_set,
                        audio ? &audio_callbacks_set : NULL, NULL, 0, NULL, 0) != 0)
    return session_fail("connection failed", NULL);

  run_until_stopped(audio);
  LiStopConnection();
  if (flag(argc, argv, "--quit"))
    gs_quit_app(&server);
  status("{\"event\":\"stopped\"}");
  return 0;
}

static int usage(void) {
  fprintf(stderr, "usage: hbmoonlight pair HOST [--timeout SECONDS]\n"
                  "       hbmoonlight list HOST\n"
                  "       hbmoonlight stream HOST APP [--size WxH] [--fps N] [--bitrate KBPS]\n"
                  "                         [--codec h264|hevc] [--software] [--audio-fd FD]"
                  " [--quit]\n"
                  "                         [--raw-h264-fd FD | --raw-hevc-fd FD] [--rgb]\n");
  return 2;
}

int main(int argc, char **argv) {
  if (argc < 3)
    return usage();
  signal(SIGPIPE, SIG_IGN);
  signal(SIGALRM, session_on_alarm);

  if (strcmp(argv[1], "pair") == 0)
    return pair(argv[2], atoi(option(argc, argv, "--timeout", "120")));
  if (strcmp(argv[1], "list") == 0)
    return list(argv[2]);
  if (strcmp(argv[1], "stream") == 0 && argc >= 4)
    return stream(argc, argv);
  return usage();
}
