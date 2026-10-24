/* Shared declarations for hbmoonlight-host, the single-process Moonlight host:
 * Sunshine stream in, HBV2 slots into the console app ring, controller and
 * touch from the console state, PCM to the console AudioOut. */
#pragma once

#include "encoder.h"
#include "mailbox.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

double now_ms(void);
void sleep_ms(double milliseconds);

/* run.c: the launcher session directory (runs/launcher-*) */
char *read_file(const char *path, size_t *size);
const char *json_find(const char *json, const char *key);
bool json_u64(const char *json, const char *key, uint64_t *out);
bool json_text(const char *json, const char *key, char *out, size_t size);
bool run_newest(char *out, size_t size);
bool run_private_storage(const char *directory, uint64_t *mapped, uint64_t *bytes);
bool run_input_source(const char *directory, uint64_t *mapped);

/* bridge.c: the launcher's local HTTP bridge (smilebasic/engine/lib/bridge.cjs) */
struct bridge_info {
  int port;
  char token[128];
  uint64_t scratch;
  uint64_t sdk;
};

struct bridge;

bool bridge_load(struct bridge_info *info, const char *directory);
struct bridge *bridge_open(const struct bridge_info *info, size_t write_capacity,
                           size_t read_capacity);
void bridge_close(struct bridge *bridge);
const char *bridge_error(const struct bridge *bridge);
bool bridge_prepare_write(struct bridge *bridge, uint64_t address, const void *data,
                          size_t size);
bool bridge_send_write(struct bridge *bridge);
bool bridge_write(struct bridge *bridge, uint64_t address, const void *data, size_t size);
bool bridge_read(struct bridge *bridge, uint64_t address, void *out, size_t size);
bool bridge_call(struct bridge *bridge, unsigned offset, const uint64_t *args, int count,
                 uint64_t *result);
bool bridge_call_address(struct bridge *bridge, uint64_t address, const uint64_t *args,
                         int count, uint64_t *result);
bool bridge_verify(struct bridge *bridge, uint64_t address, const char *hex);

/* sender.c: newest frame -> HBV2 slot -> ring write, with keyframe resync */
struct sender_options {
  int width;
  int height;
  int depth;
  int resync_ms;
  int threads;
  struct hbv2_settings settings;
};

struct sender_stats {
  unsigned encoded;
  unsigned written;
  unsigned unchanged;
  unsigned keyframes;
  unsigned resyncs;
  uint64_t bytes;
  double qp;
  double encode_ms;
  double write_ms;
  double latency_ms;
  double latency_max_ms;
  uint32_t applied;
};

bool sender_start(const struct sender_options *options, const struct bridge_info *info,
                  uint64_t storage, struct mailbox *frames);
bool sender_failed(void);
void sender_stop(void);
void sender_take_stats(struct sender_stats *stats);
void sender_latency(double *p50, double *p90, double *p99, double *max, unsigned *count);

/* console-input.c: console pad + touch -> Moonlight gamepad and touch events */
struct input_options {
  int hz;
  bool labels;
  bool dry;
};

bool console_input_start(const struct input_options *options, const struct bridge_info *info,
                         const char *directory);
void console_input_stop(void);
