/* hbmoonlight: headless Moonlight client for the moonlight-nx2 PC host.
 *
 *   hbmoonlight pair HOST [--timeout SECONDS]
 *   hbmoonlight list HOST [--covers DIR]
 *   hbmoonlight unpair HOST
 *   hbmoonlight quit HOST
 *   hbmoonlight stream HOST APP --raw-fd FD [--codec h264|hevc|av1] [--size WxH] [--fps N]
 *                     [--bitrate KBPS] [--audio-fd FD] [--sops] [--local-audio] [--quit]
 *
 * --codec (default h264) is the only format offered to the host; the raw fd receives every
 * access unit in order. Pairing and app control come from moonlight-embedded's libgamestream,
 * the stream itself from moonlight-common-c. Client keys live in
 * $XDG_CONFIG_HOME/moonlight-nx2 (or ~/.config/moonlight-nx2). */
#include "helper.h"

#include <client.h>
#include <errors.h>
#include <http.h>
#include <xml.h>

#include <errno.h>
#include <limits.h>
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

#define UNPAIR_TIMEOUT 15
#define PAIR_TIMEOUT_MAX 600

/* A bad option value is a usage error, as a missing command is. */
static int bad_option(const char *name) {
  session_fail("bad option value", name);
  return 2;
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
  bool bracketed = strchr(host, ':') != NULL;
  char url[320], escaped[1024];
  snprintf(url, sizeof(url), "https://%s%s%s:47990/pin", bracketed ? "[" : "", host,
           bracketed ? "]" : "");
  json_string(escaped, sizeof(escaped), url);
  printf("{\"event\":\"pin\",\"pin\":\"%s\",\"url\":\"%s\",\"timeout\":%d}\n", pin, escaped,
         timeout);
  fflush(stdout);

  session_deadline(timeout, "pair");
  int result = gs_pair(&server, pin);
  session_deadline(0, NULL);
  if (result != GS_OK)
    return session_fail("pairing failed", gs_error);
  printf("{\"event\":\"paired\",\"already\":false}\n");
  return 0;
}

/* Asks the host to forget this client's certificate; the keys stay for other hosts. */
static int unpair(char *host) {
  SERVER_DATA server;
  if (session_connect(&server, host))
    return 1;
  if (!server.paired) {
    printf("{\"event\":\"unpaired\",\"already\":true}\n");
    return 0;
  }

  session_deadline(UNPAIR_TIMEOUT, "unpair");
  int result = gs_unpair(&server);
  session_deadline(0, NULL);
  if (result != GS_OK)
    return session_fail("unpair failed", gs_error);
  printf("{\"event\":\"unpaired\",\"already\":false}\n");
  return 0;
}

static double now_seconds(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return time.tv_sec + time.tv_nsec / 1e9;
}

#define COVER_TIMEOUT 5
/* Covers start only within this many seconds of the first, so a list ends within
 * connect + LIST_TIMEOUT + COVER_BUDGET + COVER_TIMEOUT (README.md, hbmoonlight timeouts). */
#define COVER_BUDGET 10
#define LIST_TIMEOUT 15
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

/* The host's own uniqueid from /serverinfo, which libgamestream reads but does not keep; the
 * UI keys a saved host on it. Empty when the host does not say. */
static void read_server_id(SERVER_DATA *server, const char *client_id, char *out, size_t size) {
  out[0] = 0;
  uuid_t uuid;
  char uuid_text[37];
  uuid_generate_random(uuid);
  uuid_unparse(uuid, uuid_text);
  char url[1024];
  snprintf(url, sizeof(url), "https://%s:%u/serverinfo?uniqueid=%s&uuid=%s",
           server->serverInfo.address, server->httpsPort, client_id, uuid_text);
  PHTTP_DATA data = http_create_data();
  if (!data)
    return;

  char *found = NULL;
  bool answered = http_request(url, data) == GS_OK;
  if (answered && xml_search(data->memory, data->size, "uniqueid", &found) == GS_OK && found)
    json_string(out, size, found);
  free(found);
  http_free_data(data);
}

static int list(char *host, int argc, char **argv) {
  const char *covers = option(argc, argv, "--covers", NULL);
  SERVER_DATA server;
  if (session_connect(&server, host))
    return 1;
  if (!server.paired)
    return session_fail("not paired", "run: hbmoonlight pair HOST");

  char unique_id[64] = "";
  char server_id[256] = "";
  PAPP_LIST apps;
  session_deadline(LIST_TIMEOUT, "applist");
  int result = gs_applist(&server, &apps);
  if (result == GS_OK && read_unique_id(unique_id, sizeof(unique_id)))
    read_server_id(&server, unique_id, server_id, sizeof(server_id));
  session_deadline(0, NULL);
  if (result != GS_OK)
    return session_fail("cannot read the app list", gs_error);
  apps = session_host_order(apps);

  if (covers && (mkdir(covers, 0700) != 0 && errno != EEXIST)) {
    status("{\"event\":\"warning\",\"message\":\"cannot create the cover directory\"}");
    covers = NULL;
  }
  if (covers && !unique_id[0]) {
    status("{\"event\":\"warning\",\"message\":\"no unique id for covers\"}");
    covers = NULL;
  }

  char name[512];
  char cover[4096];
  char escaped[8192];
  double covers_end = now_seconds() + COVER_BUDGET;
  printf("{\"currentGame\":%d", server.currentGame);
  if (server_id[0])
    printf(",\"uniqueid\":\"%s\"", server_id);
  printf(",\"apps\":[");
  for (PAPP_LIST app = apps; app; app = app->next) {
    json_string(name, sizeof(name), app->name);
    printf("%s{\"id\":%d,\"name\":\"%s\"", app == apps ? "" : ",", app->id, name);
    bool in_budget = covers && now_seconds() < covers_end;
    if (in_budget && fetch_cover(&server, unique_id, app->id, covers, cover, sizeof(cover))) {
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

static void report_stats(bool audio) {
  struct video_stats video;
  video_take_stats(&video);
  status("{\"event\":\"stats\",\"written\":%u,\"failed\":%u,\"audioDropped\":%u}",
         video.written, video.failed, audio ? audio_take_dropped() : 0);
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
      session_report_rtt();
      next_report += 1;
    }
  }
  if (interrupted)
    status("{\"event\":\"stopping\",\"reason\":\"signal\"}");
}

static int stream(char *host, const char *app, int argc, char **argv) {
  int width = 1920, height = 1080;
  if (sscanf(option(argc, argv, "--size", "1920x1080"), "%dx%d", &width, &height) != 2 ||
      width <= 0 || height <= 0)
    return session_fail("bad --size", NULL);
  int audio_fd, fps, bitrate;
  if (!option_int(argc, argv, "--audio-fd", -1, 0, INT_MAX, &audio_fd))
    return bad_option("--audio-fd");
  if (!option_int(argc, argv, "--fps", 60, 1, 240, &fps))
    return bad_option("--fps");
  if (!option_int(argc, argv, "--bitrate", 20000, 1, 1000000, &bitrate))
    return bad_option("--bitrate");
  struct stream_codec codec;
  const char *codec_error = stream_codec_parse(argc, argv, &codec);
  if (codec_error)
    return session_fail(codec_error, NULL);
  struct stream_launch launch;
  stream_launch_parse(argc, argv, &launch);

  SERVER_DATA server;
  if (session_connect(&server, host))
    return 1;
  if (!server.paired)
    return session_fail("not paired", "run: hbmoonlight pair HOST");
  int app_id = session_find_app(&server, app);
  if (app_id < 0)
    return session_fail("app not found", app);

  STREAM_CONFIGURATION config;
  session_configure(&config, width, height, fps, bitrate, codec.format);

  int result = gs_start_app(&server, &config, app_id, launch.sops, launch.local_audio, 1);
  if (result != GS_OK)
    return session_fail("cannot start the app", gs_error);

  struct video_options video = {.format = codec.format, .raw_fd = codec.raw_fd};
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
                  "       hbmoonlight unpair HOST\n"
                  "       hbmoonlight quit HOST\n"
                  "       hbmoonlight stream HOST APP --raw-fd FD [--codec h264|hevc|av1]\n"
                  "                         [--size WxH] [--fps N] [--bitrate KBPS] [--audio-fd FD]\n"
                  "                         [--sops] [--local-audio] [--quit]\n");
  return 2;
}

int main(int argc, char **argv) {
  if (argc < 3)
    return usage();
  signal(SIGPIPE, SIG_IGN);
  signal(SIGALRM, session_on_alarm);

  const char *command = argv[1];
  int first = options_index(command);
  if (first > argc)
    return usage();
  int count = argc - first;
  char **options = argv + first;

  if (strcmp(command, "pair") == 0) {
    int timeout;
    if (!option_int(count, options, "--timeout", 120, 1, PAIR_TIMEOUT_MAX, &timeout))
      return bad_option("--timeout");
    return pair(argv[2], timeout);
  }
  if (strcmp(command, "list") == 0)
    return list(argv[2], count, options);
  if (strcmp(command, "unpair") == 0)
    return unpair(argv[2]);
  if (strcmp(command, "quit") == 0)
    return quit(argv[2]);
  if (strcmp(command, "stream") == 0)
    return stream(argv[2], argv[3], count, options);
  return usage();
}
