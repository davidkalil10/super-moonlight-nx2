/* Command-line lookups, and the codec, raw output and launch flags a stream asks for. Lookups
 * take a command's options only (argv from options_index), never its HOST or APP. */
#include "helper.h"

#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

/* Where the options of COMMAND start: after the command, HOST and, for stream, APP. */
int options_index(const char *command) {
  if (strcmp(command, "stream") == 0)
    return 4;
  return 3;
}

const char *option(int argc, char **argv, const char *name, const char *fallback) {
  for (int i = 0; i + 1 < argc; i++)
    if (strcmp(argv[i], name) == 0)
      return argv[i + 1];
  return fallback;
}

bool flag(int argc, char **argv, const char *name) {
  for (int i = 0; i < argc; i++)
    if (strcmp(argv[i], name) == 0)
      return true;
  return false;
}

static bool parse_int(const char *text, long min, long max, int *out) {
  char *end;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno || end == text || *end)
    return false;
  if (value < min || value > max)
    return false;
  *out = (int)value;
  return true;
}

/* NAME's integer in MIN..MAX, or FALLBACK when NAME is absent. False when NAME has no value or
 * one that is not such an integer. */
bool option_int(int argc, char **argv, const char *name, int fallback, long min, long max,
                int *out) {
  *out = fallback;
  for (int i = 0; i < argc; i++) {
    if (strcmp(argv[i], name) != 0)
      continue;
    if (i + 1 == argc)
      return false;
    return parse_int(argv[i + 1], min, max, out);
  }
  return true;
}

/* The codec offered to the host (h264 unless --codec says otherwise) and the fd that receives
 * its access units, which a stream requires. */
const char *stream_codec_parse(int argc, char **argv, struct stream_codec *out) {
  const char *codec = option(argc, argv, "--codec", "h264");
  const char *fd = option(argc, argv, "--raw-fd", NULL);

  if (strcmp(codec, "h264") == 0)
    out->format = VIDEO_FORMAT_H264;
  else if (strcmp(codec, "hevc") == 0)
    out->format = VIDEO_FORMAT_H265;
  else if (strcmp(codec, "av1") == 0)
    out->format = VIDEO_FORMAT_AV1_MAIN8;
  else
    return "--codec takes h264, hevc or av1";

  if (!fd)
    return "--raw-fd is required";
  if (!parse_int(fd, 0, INT_MAX, &out->raw_fd))
    return "the raw fd must be a non-negative integer";
  return NULL;
}

/* What the launch request asks of the host: SOPS and audio left playing on the PC. */
void stream_launch_parse(int argc, char **argv, struct stream_launch *out) {
  out->sops = flag(argc, argv, "--sops");
  out->local_audio = flag(argc, argv, "--local-audio");
}
