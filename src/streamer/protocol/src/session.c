/* GameStream session plumbing for hbmoonlight: client keys, reaching and pairing state of
 * the host, app lookup, the stream configuration and the connection listener. */
#include "helper.h"

#include <client.h>
#include <errors.h>

#include <errno.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#define HTTP_PORT 47989
#define CONNECT_TIMEOUT 15

/* Defined by the pinned http.c but not declared in its header. */
void http_cleanup(void);

static atomic_bool started;
static atomic_bool terminated;

static char alarm_message[96] = "{\"event\":\"error\",\"message\":\"timed out\"}\n";

void session_on_alarm(int signal) {
  write(STDERR_FILENO, alarm_message, strlen(alarm_message));
  _exit(3);
}

/* Arms the deadline for one step; its timeout line names the step. Zero seconds disarms. */
void session_deadline(unsigned seconds, const char *stage) {
  alarm(0);
  if (seconds == 0)
    return;
  snprintf(alarm_message, sizeof(alarm_message),
           "{\"event\":\"error\",\"message\":\"timed out\",\"stage\":\"%s\"}\n", stage);
  alarm(seconds);
}

int session_fail(const char *message, const char *detail) {
  char text[512];
  json_string(text, sizeof(text), detail ? detail : "");
  status("{\"event\":\"error\",\"message\":\"%s\",\"detail\":\"%s\"}", message, text);
  return 1;
}

static bool make_directory(char *path) {
  for (char *slash = strchr(path + 1, '/'); slash; slash = strchr(slash + 1, '/')) {
    *slash = 0;
    int result = mkdir(path, 0700);
    *slash = '/';
    if (result != 0 && errno != EEXIST)
      return false;
  }
  return mkdir(path, 0700) == 0 || errno == EEXIST;
}

/* The keys live in moonlight-nx2; until that exists, the old hblauncher/moonlight directory
 * keeps serving the pairing made before the rename. */
static bool key_directory(char *path, size_t size) {
  char base[4096];
  const char *config = getenv("XDG_CONFIG_HOME");
  if (config && *config)
    snprintf(base, sizeof(base), "%s", config);
  else
    snprintf(base, sizeof(base), "%s/.config", getenv("HOME"));

  struct stat info;
  snprintf(path, size, "%s/moonlight-nx2", base);
  if (stat(path, &info) == 0)
    return true;

  char legacy[sizeof(base) + 32];
  snprintf(legacy, sizeof(legacy), "%s/hblauncher/moonlight", base);
  if (stat(legacy, &info) == 0 && S_ISDIR(info.st_mode)) {
    snprintf(path, size, "%s", legacy);
    return true;
  }
  return make_directory(path);
}

bool session_key_directory(char *path, size_t size) {
  return key_directory(path, size);
}

/* gs_init makes a new curl handle each time. The previous one would keep its last HTTPS
 * connection open, and Sunshine answers no other HTTPS request until it closes. */
int session_connect(SERVER_DATA *server, char *host) {
  static bool initialised;
  const char *stage = initialised ? "reconnect" : "connect";
  if (initialised)
    http_cleanup();
  initialised = true;
  char keys[4096];
  if (!key_directory(keys, sizeof(keys)))
    return session_fail("cannot create the key directory", keys);
  fflush(stdout);
  int saved_stdout = dup(STDOUT_FILENO);
  dup2(STDERR_FILENO, STDOUT_FILENO);
  session_deadline(CONNECT_TIMEOUT, stage);
  int result = gs_init(server, host, HTTP_PORT, keys, 0, true);
  session_deadline(0, NULL);
  fflush(stdout);
  dup2(saved_stdout, STDOUT_FILENO);
  close(saved_stdout);
  if (result != GS_OK)
    return session_fail("cannot reach the GameStream host", gs_error ? gs_error : host);
  return 0;
}

/* libgamestream prepends each <App> it parses, so its list is the host's order reversed. */
PAPP_LIST session_host_order(PAPP_LIST apps) {
  PAPP_LIST ordered = NULL;
  while (apps) {
    PAPP_LIST next = apps->next;
    apps->next = ordered;
    ordered = apps;
    apps = next;
  }
  return ordered;
}

int session_find_app(SERVER_DATA *server, const char *wanted) {
  PAPP_LIST apps;
  if (gs_applist(server, &apps) != GS_OK)
    return -1;
  char *end;
  long id = strtol(wanted, &end, 10);
  for (PAPP_LIST app = apps; app; app = app->next)
    if ((*end == 0 && app->id == id) || strcasecmp(app->name, wanted) == 0)
      return app->id;
  return -1;
}

void session_configure(STREAM_CONFIGURATION *config, int width, int height, int fps,
                       int bitrate, int formats) {
  LiInitializeStreamConfiguration(config);
  config->width = width;
  config->height = height;
  config->fps = fps;
  config->bitrate = bitrate;
  config->packetSize = 1392;
  config->streamingRemotely = STREAM_CFG_LOCAL;
  config->audioConfiguration = AUDIO_CONFIGURATION_STEREO;
  config->supportedVideoFormats = formats;
  config->colorSpace = COLORSPACE_REC_709;
  config->colorRange = COLOR_RANGE_LIMITED;
  config->encryptionFlags = ENCFLG_ALL;
}

static void stage_failed(int stage, int error) {
  status("{\"event\":\"error\",\"message\":\"stage failed\",\"stage\":\"%s\",\"code\":%d}",
         LiGetStageName(stage), error);
}

static void connection_started(void) {
  status("{\"event\":\"connected\"}");
  atomic_store(&started, true);
}

static void connection_terminated(int error) {
  status("{\"event\":\"terminated\",\"code\":%d}", error);
  atomic_store(&terminated, true);
}

static void log_message(const char *format, ...) {
  char text[512], escaped[1024];
  va_list args;
  va_start(args, format);
  vsnprintf(text, sizeof(text), format, args);
  va_end(args);
  text[strcspn(text, "\n")] = 0;
  json_string(escaped, sizeof(escaped), text);
  status("{\"event\":\"log\",\"message\":\"%s\"}", escaped);
}

/* Sunshine's loss and latency verdict; the PC adapts Auto bitrate on it. */
static void connection_status(int connection_status) {
  const char *name = connection_status == CONN_STATUS_POOR ? "poor" : "okay";
  status("{\"event\":\"connection-status\",\"status\":\"%s\"}", name);
}

void session_listener(CONNECTION_LISTENER_CALLBACKS *listener) {
  LiInitializeConnectionCallbacks(listener);
  listener->stageFailed = stage_failed;
  listener->connectionStarted = connection_started;
  listener->connectionTerminated = connection_terminated;
  listener->logMessage = log_message;
  listener->connectionStatusUpdate = connection_status;
}

void session_report_rtt(void) {
  uint32_t rtt, variance;
  if (!session_started() || !LiGetEstimatedRttInfo(&rtt, &variance))
    return;
  status("{\"event\":\"rtt\",\"ms\":%u,\"varianceMs\":%u}", rtt, variance);
}

bool session_started(void) {
  return atomic_load(&started);
}

bool session_terminated(void) {
  return atomic_load(&terminated);
}

void session_announce_controller(void) {
  LiSendControllerArrivalEvent(0, 1, LI_CTYPE_XBOX,
                               A_FLAG | B_FLAG | X_FLAG | Y_FLAG | UP_FLAG | DOWN_FLAG |
                                   LEFT_FLAG | RIGHT_FLAG | LB_FLAG | RB_FLAG | PLAY_FLAG |
                                   BACK_FLAG | LS_CLK_FLAG | RS_CLK_FLAG | SPECIAL_FLAG,
                               LI_CCAP_ANALOG_TRIGGERS);
}
