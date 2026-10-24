/* hbmoonlight-host: the Moonlight host in one process. It replaces
 * `live.cjs --moonlight` (hbmoonlight + hbv2enc + input-feeder + audio-stream)
 * and talks to the console only through the launcher's local bridge.
 *
 *   hbmoonlight-host [RUN_DIR] (--moonlight HOST APP | --input FILE)
 *       [--size 1920x1080] [--fps 60] [--bitrate 20000] [--codec h264|hevc]
 *       [--software] [--quit] [--seconds N]
 *       [--budget 96] [--cap 256] (KiB) [--qp-min 4] [--qp-max 40] [--refresh 2]
 *       [--depth 2] [--resync 1000] (ms) [--threads N]
 *
 * RUN_DIR defaults to the newest runs/launcher-* under the current directory.
 * --input plays a file through ffmpeg exactly like live.cjs --input, for
 * offline runs against tools/moonlight/fake-console/bridge.cjs. One JSON stats
 * line per second goes to stdout; events go to stderr. */
#include "console-layout.h"
#include "helper.h"
#include "host.h"

#include <client.h>
#include <errors.h>

#include <curl/curl.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted;
static struct mailbox frames;
static atomic_bool source_ended;
static atomic_uint captured, dropped;

static void on_interrupt(int signal) {
  interrupted = 1;
}

static const char *option(int argc, char **argv, const char *name, const char *fallback) {
  for (int i = 0; i + 1 < argc; i++)
    if (strcmp(argv[i], name) == 0)
      return argv[i + 1];
  return fallback;
}

static int number(int argc, char **argv, const char *name, int fallback) {
  const char *value = option(argc, argv, name, NULL);
  return value ? atoi(value) : fallback;
}

static bool flag(int argc, char **argv, const char *name) {
  for (int i = 0; i < argc; i++)
    if (strcmp(argv[i], name) == 0)
      return true;
  return false;
}

struct file_source {
  pid_t pid;
  int fd;
  size_t frame_bytes;
  pthread_t thread;
};

static struct file_source file;

static bool read_frame(int fd, uint8_t *out, size_t size) {
  while (size > 0) {
    ssize_t got = read(fd, out, size);
    if (got < 0 && errno == EINTR)
      continue;
    if (got <= 0)
      return false;
    out += got;
    size -= (size_t)got;
  }
  return true;
}

static void *read_frames(void *unused) {
  while (read_frame(file.fd, mailbox_back(&frames), file.frame_bytes)) {
    atomic_fetch_add(&captured, 1);
    if (mailbox_publish(&frames, now_ms()))
      atomic_fetch_add(&dropped, 1);
  }
  atomic_store(&source_ended, true);
  return NULL;
}

/* The ffmpeg command of live.cjs --input: paced, looped, scaled RGB24. */
static bool start_file(const char *path, int width, int height, int fps) {
  char filter[96];
  snprintf(filter, sizeof(filter), "scale=%d:%d:flags=area,fps=%d", width, height, fps);
  int pipe_fds[2];
  if (pipe(pipe_fds))
    return false;
  file.pid = fork();
  if (file.pid == 0) {
    dup2(pipe_fds[1], STDOUT_FILENO);
    close(pipe_fds[0]);
    close(pipe_fds[1]);
    execlp("ffmpeg", "ffmpeg", "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1",
           "-i", path, "-vf", filter, "-f", "rawvideo", "-pix_fmt", "rgb24", "-", (char *)NULL);
    _exit(127);
  }
  close(pipe_fds[1]);
  if (file.pid < 0)
    return false;
  file.fd = pipe_fds[0];
  file.frame_bytes = (size_t)width * height * 3;
  return pthread_create(&file.thread, NULL, read_frames, NULL) == 0;
}

static void stop_file(void) {
  kill(file.pid, SIGTERM);
  waitpid(file.pid, NULL, 0);
  pthread_join(file.thread, NULL);
  close(file.fd);
}

static void report(bool moonlight) {
  struct sender_stats sent;
  sender_take_stats(&sent);
  unsigned frames_in = atomic_exchange(&captured, 0), busy = atomic_exchange(&dropped, 0);
  double decode_ms = 0;
  if (moonlight) {
    struct video_stats video;
    video_take_stats(&video);
    frames_in = video.decoded;
    busy = video.dropped;
    decode_ms = video.decoded ? video.decode_ms / video.decoded : 0;
  }
  unsigned encoded = sent.encoded ? sent.encoded : 1, written = sent.written ? sent.written : 1;
  printf("{\"captured\":%u,\"encoded\":%u,\"written\":%u,\"droppedBusy\":%u,\"unchanged\":%u,"
         "\"keyframes\":%u,\"resyncs\":%u,\"qp\":%.1f,\"encodeMs\":%.2f,\"applied\":%u,"
         "\"kib\":%llu,\"writeMs\":%.2f,\"latencyMs\":%.2f,\"latencyMaxMs\":%.2f",
         frames_in, sent.encoded, sent.written, busy, sent.unchanged, sent.keyframes, sent.resyncs,
         sent.qp / encoded, sent.encode_ms / encoded, sent.applied,
         (unsigned long long)(sent.bytes / 1024), sent.write_ms / written,
         sent.latency_ms / written, sent.latency_max_ms);
  if (moonlight)
    printf(",\"decodeMs\":%.2f", decode_ms);
  printf("}\n");
  fflush(stdout);
}

static bool find_storage(const char *directory, uint64_t *mapped) {
  uint64_t bytes = 0;
  while (!run_private_storage(directory, mapped, &bytes)) {
    if (interrupted)
      return false;
    status("{\"event\":\"waiting\",\"message\":\"Moonlight app not open on the console\"}");
    sleep_ms(1000);
  }
  if (bytes < RING_MEMORY_BYTES)
    return session_fail("the running Moonlight app predates HBV2; rebuild and reinstall it",
                        directory) == 0;
  return true;
}

static int start_moonlight(int argc, char **argv, SERVER_DATA *server, int width, int height,
                           int fps) {
  char *host = NULL;
  const char *app = NULL;
  for (int i = 0; i + 2 < argc; i++)
    if (strcmp(argv[i], "--moonlight") == 0) {
      host = argv[i + 1];
      app = argv[i + 2];
    }
  if (!host || !app)
    return session_fail("pass --moonlight HOST APP", NULL);
  if (session_connect(server, host))
    return 1;
  if (!server->paired)
    return session_fail("not paired", "run: hbmoonlight pair HOST");
  int app_id = session_find_app(server, app);
  if (app_id < 0)
    return session_fail("app not found", app);

  bool hevc = strcmp(option(argc, argv, "--codec", "h264"), "hevc") == 0;
  static STREAM_CONFIGURATION config;
  session_configure(&config, width, height, fps, number(argc, argv, "--bitrate", 20000),
                    VIDEO_FORMAT_H264 | (hevc ? VIDEO_FORMAT_H265 : 0));
  if (gs_start_app(server, &config, app_id, false, false, 1) != GS_OK)
    return session_fail("cannot start the app", gs_error);

  struct video_options video = {.width = width,
                                .height = height,
                                .software = flag(argc, argv, "--software"),
                                .decode = true,
                                .raw_fd = -1,
                                .frames = &frames};
  video_configure(&video);
  static DECODER_RENDERER_CALLBACKS video_set;
  video_callbacks(&video_set);
  static CONNECTION_LISTENER_CALLBACKS listener;
  session_listener(&listener);
  if (LiStartConnection(&server->serverInfo, &config, &listener, &video_set, NULL, NULL, 0,
                        NULL, 0) != 0)
    return session_fail("connection failed", NULL);
  return 0;
}

static void summarize(void) {
  double p50, p90, p99, max;
  unsigned count;
  sender_latency(&p50, &p90, &p99, &max, &count);
  status("{\"event\":\"summary\",\"written\":%u,\"latencyMs\":{\"p50\":%.2f,\"p90\":%.2f,"
         "\"p99\":%.2f,\"max\":%.2f}}",
         count, p50, p90, p99, max);
}

/* libgomp reads OMP_WAIT_POLICY when it loads, so it is set by re-executing.
 * Spinning workers starve the decoder and the bridge (see hbv2-encoder.cjs). */
static void passive_openmp(char **argv) {
  if (getenv("OMP_WAIT_POLICY"))
    return;
  setenv("OMP_WAIT_POLICY", "passive", 1);
  execv("/proc/self/exe", argv);
}

int main(int argc, char **argv) {
  passive_openmp(argv);
  signal(SIGPIPE, SIG_IGN);
  signal(SIGALRM, session_on_alarm);
  struct sigaction stop = {.sa_handler = on_interrupt};
  sigaction(SIGINT, &stop, NULL);
  sigaction(SIGTERM, &stop, NULL);
  curl_global_init(CURL_GLOBAL_DEFAULT);

  bool moonlight = flag(argc, argv, "--moonlight");
  const char *input = option(argc, argv, "--input", NULL);
  if (moonlight == (input != NULL)) {
    fprintf(stderr, "usage: hbmoonlight-host [RUN_DIR] (--moonlight HOST APP | --input FILE)"
                    " [options]; see the header of tools/moonlight/helper/src/host.c\n");
    return 2;
  }
  char directory[1024];
  if (argc > 1 && strncmp(argv[1], "--", 2) != 0)
    snprintf(directory, sizeof(directory), "%s", argv[1]);
  else if (!run_newest(directory, sizeof(directory)))
    return session_fail("no launcher session in runs/", NULL);
  status("{\"event\":\"session\",\"directory\":\"%s\"}", directory);

  int width = 1920, height = 1080;
  if (sscanf(option(argc, argv, "--size", "1920x1080"), "%dx%d", &width, &height) != 2)
    return session_fail("bad --size", NULL);
  int fps = number(argc, argv, "--fps", 60);

  struct bridge_info bridge;
  if (!bridge_load(&bridge, directory))
    return session_fail("cannot read connection.json", directory);
  uint64_t storage;
  if (!find_storage(directory, &storage))
    return 1;
  if (!mailbox_init(&frames, (size_t)width * height * 3))
    return session_fail("out of memory", NULL);

  struct sender_options sender = {
      .width = width,
      .height = height,
      .depth = number(argc, argv, "--depth", 2),
      .resync_ms = number(argc, argv, "--resync", 1000),
      .threads = number(argc, argv, "--threads", 0),
      .settings = {.budget = (uint32_t)number(argc, argv, "--budget", 96) * 1024,
                   .cap = (uint32_t)number(argc, argv, "--cap", 256) * 1024,
                   .qp_min = (uint32_t)number(argc, argv, "--qp-min", 4),
                   .qp_max = (uint32_t)number(argc, argv, "--qp-max", 40),
                   .refresh = (uint32_t)number(argc, argv, "--refresh", 2)},
  };
  if (!sender_start(&sender, &bridge, storage, &frames))
    return session_fail("cannot start the sender", NULL);

  SERVER_DATA server;
  if (moonlight ? start_moonlight(argc, argv, &server, width, height, fps)
                : !start_file(input, width, height, fps)) {
    sender_stop();
    return 1;
  }

  double seconds = number(argc, argv, "--seconds", 0), started = now_ms(),
         next_report = started + 1000;
  bool announced = false;
  while (!interrupted && !sender_failed() && !atomic_load(&source_ended) &&
         !(moonlight && session_terminated()) &&
         !(seconds > 0 && now_ms() - started >= seconds * 1000)) {
    if (moonlight && !announced && session_started()) {
      session_announce_controller();
      announced = true;
    }
    sleep_ms(50);
    if (now_ms() >= next_report) {
      report(moonlight);
      next_report += 1000;
    }
  }
  status("{\"event\":\"stopping\"}");
  if (moonlight)
    LiStopConnection();
  else
    stop_file();
  sender_stop();
  summarize();
  if (moonlight && flag(argc, argv, "--quit"))
    gs_quit_app(&server);
  status("{\"event\":\"stopped\"}");
  return sender_failed() ? 1 : 0;
}
