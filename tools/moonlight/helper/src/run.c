/* The launcher session directory: connection, app report and input source
 * files, read with a minimal key lookup (they are JSON.stringify output). */
#include "host.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

double now_ms(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return time.tv_sec * 1000.0 + time.tv_nsec / 1e6;
}

void sleep_ms(double milliseconds) {
  if (milliseconds <= 0)
    return;
  struct timespec wait = {(time_t)(milliseconds / 1000),
                          (long)((milliseconds - (time_t)(milliseconds / 1000) * 1000) * 1e6)};
  nanosleep(&wait, NULL);
}

char *read_file(const char *path, size_t *size) {
  FILE *file = fopen(path, "rb");
  if (!file)
    return NULL;
  fseek(file, 0, SEEK_END);
  long length = ftell(file);
  rewind(file);
  char *text = length >= 0 ? malloc((size_t)length + 1) : NULL;
  if (text && fread(text, 1, (size_t)length, file) != (size_t)length) {
    free(text);
    text = NULL;
  }
  fclose(file);
  if (!text)
    return NULL;
  text[length] = 0;
  if (size)
    *size = (size_t)length;
  return text;
}

const char *json_find(const char *json, const char *key) {
  char quoted[64];
  snprintf(quoted, sizeof(quoted), "\"%s\"", key);
  for (const char *at = strstr(json, quoted); at; at = strstr(at + 1, quoted)) {
    const char *value = at + strlen(quoted);
    while (*value == ' ' || *value == '\n' || *value == '\t' || *value == '\r')
      value++;
    if (*value != ':')
      continue;
    value++;
    while (*value == ' ' || *value == '\n' || *value == '\t' || *value == '\r')
      value++;
    return value;
  }
  return NULL;
}

bool json_u64(const char *json, const char *key, uint64_t *out) {
  const char *value = json_find(json, key);
  if (!value)
    return false;
  if (*value == '"')
    value++;
  char *end;
  unsigned long long number = strtoull(value, &end, 10);
  if (end == value)
    return false;
  *out = number;
  return true;
}

bool json_text(const char *json, const char *key, char *out, size_t size) {
  const char *value = json_find(json, key);
  if (!value || *value != '"')
    return false;
  const char *end = strchr(++value, '"');
  if (!end || (size_t)(end - value) >= size)
    return false;
  memcpy(out, value, (size_t)(end - value));
  out[end - value] = 0;
  return true;
}

bool run_newest(char *out, size_t size) {
  DIR *runs = opendir("runs");
  if (!runs)
    return false;
  time_t newest = 0;
  struct dirent *entry;
  while ((entry = readdir(runs))) {
    if (strncmp(entry->d_name, "launcher-", 9) != 0)
      continue;
    char path[512];
    struct stat info;
    snprintf(path, sizeof(path), "runs/%s", entry->d_name);
    if (stat(path, &info) == 0 && info.st_mtime >= newest) {
      newest = info.st_mtime;
      snprintf(out, size, "%s", path);
    }
  }
  closedir(runs);
  return newest != 0;
}

/* Newest app-moonlight-*.json report with private storage, by "started". */
bool run_private_storage(const char *directory, uint64_t *mapped, uint64_t *bytes) {
  DIR *dir = opendir(directory);
  if (!dir)
    return false;
  char newest[64] = "";
  bool found = false;
  struct dirent *entry;
  while ((entry = readdir(dir))) {
    size_t length = strlen(entry->d_name);
    if (strncmp(entry->d_name, "app-moonlight-", 14) != 0 || length < 5 ||
        strcmp(entry->d_name + length - 5, ".json") != 0)
      continue;
    char path[1024], started[64];
    snprintf(path, sizeof(path), "%s/%s", directory, entry->d_name);
    char *report = read_file(path, NULL);
    const char *storage = report ? json_find(report, "privateStorage") : NULL;
    uint64_t at, size;
    if (storage && *storage == '{' && json_text(report, "started", started, sizeof(started)) &&
        json_u64(storage, "mapped", &at) && json_u64(storage, "bytes", &size) &&
        strcmp(started, newest) > 0) {
      snprintf(newest, sizeof(newest), "%s", started);
      *mapped = at;
      *bytes = size;
      found = true;
    }
    free(report);
  }
  closedir(dir);
  return found;
}

/* The state buffer of the running app, when that app is Moonlight. */
bool run_input_source(const char *directory, uint64_t *mapped) {
  char path[1024], id[64];
  snprintf(path, sizeof(path), "%s/game-audio-source.json", directory);
  char *source = read_file(path, NULL);
  if (!source)
    return false;
  const char *package = json_find(source, "package");
  bool moonlight = package && json_text(package, "id", id, sizeof(id)) &&
                   strcmp(id, "moonlight") == 0 && json_u64(source, "mapped", mapped);
  free(source);
  return moonlight;
}
