/* hbmoonlight: headless Moonlight client for the HBLauncher PC host.
 *
 *   hbmoonlight pair HOST [--timeout SECONDS]
 *   hbmoonlight list HOST [--covers DIR]
 *   hbmoonlight quit HOST
 *   hbmoonlight stream HOST APP [--size WxH] [--fps N] [--bitrate KBPS]
 *                     [--codec h264|hevc] [--software] [--audio-fd FD] [--quit]
 *                     [--raw-h264-fd FD | --raw-hevc-fd FD] [--rgb]
 *
 * A raw fd receives every access unit in order as Annex B and turns off the
 * RGB24 output unless --rgb is also given. HBL_PROBE_PATCH=x,y,w,h turns on
 * the loopback latency probe on the raw output (see video.c).
 *
 * Pairing and app control come from moonlight-embedded's libgamestream, the
 * stream itself from moonlight-common-c. Client keys live in
 * $XDG_CONFIG_HOME/hblauncher/moonlight (or ~/.config/...). */
#include "helper.h"

#include <client.h>
#include <errors.h>
#include <http.h>

#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <uuid/uuid.h>
#include <time.h>
#include <unistd.h>

/* JSON status lines on stderr, serialized because callbacks run on several
 * moonlight-common-c threads. */
static pthread_mutex_t status_lock = PTHREAD_MUTEX_INITIALIZER;

void status(const char *format, ...) {
  va_list args;
  va_start(args, format);
  pthread_mutex_lock(&status_lock);
  vfprintf(stderr, format, args);
  fputc('\n', stderr);
  fflush(stderr);
  pthread_mutex_unlock(&status_lock);
  va_end(args);
}

void json_string(char *out, size_t size, const char *text) {
  size_t used = 0;
  for (; *text && used + 7 < size; text++) {
    unsigned char c = (unsigned char)*text;
    if (c == '"' || c == '\\')
      used += snprintf(out + used, size - used, "\\%c", c);
    else if (c < 0x20)
      used += snprintf(out + used, size - used, "\\u%04x", c);
    else
      out[used++] = c;
  }
  out[used] = 0;
}

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

  session_deadline(timeout, "pair");
  int result = gs_pair(&server, pin);
  session_deadline(0, NULL);
  if (result != GS_OK)
    return session_fail("pairing failed", gs_error);
  printf("{\"event\":\"paired\",\"already\":false}\n");
  return 0;
}

#define COVER_TIMEOUT 5
#define COVER_MAX_BYTES (4 * 1024 * 1024)
#define COVER_MAX_SIDE 4096
#define QUIT_TIMEOUT 30

/* A PNG the rasteriser can take: signature, an IHDR first, sane dimensions, bounded size. */
static bool cover_ok(const char *bytes, size_t size) {
  static const unsigned char signature[8] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'};
  if (size < 33 || size > COVER_MAX_BYTES || memcmp(bytes, signature, 8) != 0)
    return false;
  if (memcmp(bytes + 12, "IHDR", 4) != 0)
    return false;
  const unsigned char *ihdr = (const unsigned char *)bytes + 16;
  uint32_t width = (uint32_t)ihdr[0] << 24 | ihdr[1] << 16 | ihdr[2] << 8 | ihdr[3];
  uint32_t height = (uint32_t)ihdr[4] << 24 | ihdr[5] << 16 | ihdr[6] << 8 | ihdr[7];
  return width > 0 && height > 0 && width <= COVER_MAX_SIDE && height <= COVER_MAX_SIDE;
}

static bool read_unique_id(char *out, size_t size) {
  char path[4096];
  if (!session_key_directory(path, sizeof(path)))
    return false;
  strncat(path, "/uniqueid.dat", sizeof(path) - strlen(path) - 1);
  FILE *file = fopen(path, "r");
  if (!file)
    return false;
  size_t got = fread(out, 1, size - 1, file);
  fclose(file);
  out[got] = 0;
  return got > 0;
}

/* Box art through /appasset, as Moonlight Qt fetches it, into PATH. */
static bool download_cover(SERVER_DATA *server, const char *unique_id, int app_id,
                           const char *path) {
  uuid_t uuid;
  char uuid_text[37];
  uuid_generate_random(uuid);
  uuid_unparse(uuid, uuid_text);
  char url[1024];
  snprintf(url, sizeof(url),
           "https://%s:%u/appasset?uniqueid=%s&uuid=%s&appid=%d&AssetType=2&AssetIdx=0",
           server->serverInfo.address, server->httpsPort, unique_id, uuid_text, app_id);
  PHTTP_DATA data = http_create_data();
  if (!data)
    return false;
  bool saved = false;
  if (http_request(url, data) == GS_OK && cover_ok(data->memory, data->size)) {
    char partial[4200];
    snprintf(partial, sizeof(partial), "%s.part", path);
    FILE *file = fopen(partial, "wb");
    if (file) {
      saved = fwrite(data->memory, 1, data->size, file) == data->size;
      saved = fclose(file) == 0 && saved;
      saved = saved && rename(partial, path) == 0;
      if (!saved)
        unlink(partial);
    }
  }
  http_free_data(data);
  return saved;
}

/* One cover, cached under DIRECTORY by host and app id. The fetch runs in a forked child
 * under a plain alarm, since libcurl keeps going through EINTR and the pinned http.c sets no
 * timeout of its own: a slow /appasset costs COVER_TIMEOUT seconds and that cover, never the
 * list. */
/* A cached cover counts only if its header still reads as a PNG the rasteriser takes. */
static bool cached_cover_ok(const char *path) {
  char head[64];
  FILE *file = fopen(path, "rb");
  if (!file)
    return false;
  size_t got = fread(head, 1, sizeof(head), file);
  fclose(file);
  return cover_ok(head, got);
}

static bool fetch_cover(SERVER_DATA *server, const char *unique_id, int app_id,
                        const char *directory, char *path, size_t size) {
  char host[256];
  snprintf(host, sizeof(host), "%s", server->serverInfo.address);
  for (char *c = host; *c; c++)
    if (*c == '/' || *c == '\\')
      *c = '_';
  if (snprintf(path, size, "%s/%s-%d.png", directory, host, app_id) >= (int)size)
    return false;
  if (cached_cover_ok(path))
    return true;
  fflush(stdout);
  pid_t child = fork();
  if (child < 0)
    return false;
  if (child == 0) {
    signal(SIGALRM, SIG_DFL);
    alarm(COVER_TIMEOUT);
    _exit(download_cover(server, unique_id, app_id, path) ? 0 : 1);
  }
  int result;
  if (waitpid(child, &result, 0) < 0)
    return false;
  return WIFEXITED(result) && WEXITSTATUS(result) == 0;
}

static int list(int argc, char **argv) {
  char *host = argv[2];
  const char *covers = option(argc, argv, "--covers", NULL);
  SERVER_DATA server;
  if (session_connect(&server, host))
    return 1;
  if (!server.paired)
    return session_fail("not paired", "run: hbmoonlight pair HOST");
  PAPP_LIST apps;
  if (gs_applist(&server, &apps) != GS_OK)
    return session_fail("cannot read the app list", gs_error);
  apps = session_host_order(apps);

  char unique_id[64];
  if (covers && (mkdir(covers, 0700) != 0 && errno != EEXIST)) {
    status("{\"event\":\"warning\",\"message\":\"cannot create the cover directory\"}");
    covers = NULL;
  }
  if (covers && !read_unique_id(unique_id, sizeof(unique_id))) {
    status("{\"event\":\"warning\",\"message\":\"no unique id for covers\"}");
    covers = NULL;
  }

  char name[512];
  char cover[4096];
  char escaped[8192];
  printf("{\"currentGame\":%d,\"apps\":[", server.currentGame);
  for (PAPP_LIST app = apps; app; app = app->next) {
    json_string(name, sizeof(name), app->name);
    printf("%s{\"id\":%d,\"name\":\"%s\"", app == apps ? "" : ",", app->id, name);
    if (covers && fetch_cover(&server, unique_id, app->id, covers, cover, sizeof(cover))) {
      json_string(escaped, sizeof(escaped), cover);
      printf(",\"cover\":\"%s\"", escaped);
    }
    printf("}");
  }
  printf("]}\n");
  return 0;
}

/* Quits the host app with /cancel, then reads the host again so the caller gets the state the
 * host reports rather than the request's own answer. Sunshine answers /cancel only once the
 * session is torn down and the display restored, which can take a while. */
static int quit(char *host) {
  SERVER_DATA server;
  if (session_connect(&server, host))
    return 1;
  if (!server.paired)
    return session_fail("not paired", "run: hbmoonlight pair HOST");
  if (server.currentGame == 0) {
    printf("{\"event\":\"quit\",\"cancelled\":false,\"already\":true,\"currentGame\":0}\n");
    return 0;
  }
  session_deadline(QUIT_TIMEOUT, "cancel");
  int result = gs_quit_app(&server);
  session_deadline(0, NULL);
  if (result != GS_OK)
    return session_fail("quit failed", gs_error);
  SERVER_DATA after;
  int current = session_connect(&after, host) == 0 ? after.currentGame : -1;
  printf("{\"event\":\"quit\",\"cancelled\":true,\"already\":false,\"currentGame\":%d}\n", current);
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
  if (video.probed)
    status("{\"event\":\"probe-stats\",\"probed\":%u,\"meanMs\":%.2f,\"maxMs\":%.2f}",
           video.probed, video.probe_ms / video.probed, video.probe_max_ms);
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
  const char *patch = getenv("HBL_PROBE_PATCH");
  video.probing = raw_fd >= 0 && patch &&
                  sscanf(patch, "%d,%d,%d,%d", &video.probe[0], &video.probe[1],
                         &video.probe[2], &video.probe[3]) == 4;
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
                  "       hbmoonlight list HOST [--covers DIR]\n"
                  "       hbmoonlight quit HOST\n"
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
    return list(argc, argv);
  if (strcmp(argv[1], "quit") == 0)
    return quit(argv[2]);
  if (strcmp(argv[1], "stream") == 0 && argc >= 4)
    return stream(argc, argv);
  return usage();
}
