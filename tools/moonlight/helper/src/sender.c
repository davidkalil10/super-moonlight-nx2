/* Video sender: the HBV2 half of tools/moonlight/live.cjs in process.
 *
 * One encoder thread waits for a free writer, takes the newest frame, encodes
 * it and base64s the slot straight into that writer's request body. `depth`
 * writer threads each own a bridge connection and keep one ring write on the
 * wire, so up to `depth` slots overlap like live.cjs's writes set. A poll
 * thread reads CONTROL.applied every 500 ms; a P frame only applies on the
 * frame it references, so when the console stops advancing for resync_ms
 * while newer slots exist, the next frame is coded as a keyframe (spending
 * the cap budget). */
#include "console-layout.h"
#include "helper.h"
#include "host.h"

#include "../../hbv2-tables.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define MAX_WRITERS 4
#define POLL_MS 500
#define LATENCY_SAMPLES (1 << 20)

struct writer {
  struct bridge *bridge;
  pthread_t thread;
  bool busy;
  bool ready;
  double arrived;
};

static struct sender_options options;
static struct mailbox *frames;
static uint64_t storage;
static struct bridge *poller;
static struct writer writers[MAX_WRITERS];
static pthread_t encoder_thread, poll_thread;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t changed = PTHREAD_COND_INITIALIZER;
static bool stopping;
static atomic_bool failure;
static atomic_bool keyframe;
static atomic_uint_fast32_t sequence;
static struct sender_stats stats;
static float *latencies;
static unsigned latency_count;

static uint64_t slot_address(uint32_t number) {
  return storage + RING_OFFSET + (uint64_t)(number % RING_SLOTS) * RING_SLOT_BYTES;
}

/* First sequence newer than anything applied or still in the ring, so a new
 * sender never collides with an old session (feed.cjs nextSequence). */
static bool next_sequence(uint32_t *next) {
  uint32_t newest, header[2];
  if (!bridge_read(poller, storage + RING_CONTROL_APPLIED, &newest, 4))
    return false;
  for (uint32_t slot = 0; slot < RING_SLOTS; slot++) {
    if (!bridge_read(poller, slot_address(slot), header, sizeof(header)))
      return false;
    if ((header[0] == HBV1_MAGIC || header[0] == HBV2_MAGIC) && header[1] > newest)
      newest = header[1];
  }
  *next = newest + 1;
  return true;
}

static struct writer *idle_writer(void) {
  pthread_mutex_lock(&lock);
  struct writer *found = NULL;
  while (!stopping && !found) {
    for (int i = 0; i < options.depth && !found; i++)
      if (!writers[i].busy)
        found = &writers[i];
    if (!found)
      pthread_cond_wait(&changed, &lock);
  }
  if (found)
    found->busy = true;
  pthread_mutex_unlock(&lock);
  return found;
}

static void release(struct writer *writer) {
  pthread_mutex_lock(&lock);
  writer->busy = false;
  pthread_cond_broadcast(&changed);
  pthread_mutex_unlock(&lock);
}

static void fail(const char *message, const char *detail) {
  status("{\"event\":\"error\",\"message\":\"%s\",\"detail\":\"%s\"}", message, detail);
  atomic_store(&failure, true);
}

static void *encode_frames(void *unused) {
  struct hbv2_encoder *encoder = hbv2_create(options.width, options.height, options.threads);
  if (!encoder) {
    fail("unsupported HBV2 frame size", "");
    return NULL;
  }
  for (;;) {
    struct writer *writer = idle_writer();
    double arrived;
    const uint8_t *rgb = writer ? mailbox_take(frames, &arrived) : NULL;
    if (!rgb)
      break;
    bool key = atomic_load(&keyframe);
    struct hbv2_settings settings = options.settings;
    if (key)
      settings.budget = settings.cap;
    struct hbv2_frame frame;
    hbv2_encode(encoder, rgb, (uint32_t)atomic_load(&sequence) + 1, key, &settings, &frame);

    pthread_mutex_lock(&lock);
    stats.encoded++;
    stats.encode_ms += frame.encode_ms;
    stats.qp += frame.qp;
    if (!frame.slot_bytes)
      stats.unchanged++;
    else {
      stats.bytes += frame.slot_bytes;
      stats.keyframes += frame.keyframe;
    }
    pthread_mutex_unlock(&lock);
    if (!frame.slot_bytes) {
      release(writer);
      continue;
    }
    if (frame.keyframe)
      atomic_store(&keyframe, false);
    atomic_store(&sequence, frame.sequence);
    writer->arrived = arrived;
    if (!bridge_prepare_write(writer->bridge, slot_address(frame.sequence), frame.slot,
                              frame.slot_bytes)) {
      fail("write failed", bridge_error(writer->bridge));
      release(writer);
      break;
    }
    pthread_mutex_lock(&lock);
    writer->ready = true;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
  }
  return NULL;
}

/* The encoder reserves a writer (busy), fills its body and marks it ready;
 * the writer sends it, records the timing and goes idle. A job prepared before
 * a stop is still sent. */
static void *write_slots(void *context) {
  struct writer *writer = context;
  for (;;) {
    pthread_mutex_lock(&lock);
    while (!stopping && !writer->ready)
      pthread_cond_wait(&changed, &lock);
    bool job = writer->ready;
    writer->ready = false;
    pthread_mutex_unlock(&lock);
    if (!job)
      return NULL;

    double started = now_ms();
    bool ok = bridge_send_write(writer->bridge);
    double finished = now_ms();
    if (!ok)
      fail("write failed", bridge_error(writer->bridge));
    pthread_mutex_lock(&lock);
    if (ok) {
      double latency = finished - writer->arrived;
      stats.written++;
      stats.write_ms += finished - started;
      stats.latency_ms += latency;
      if (latency > stats.latency_max_ms)
        stats.latency_max_ms = latency;
      if (latency_count < LATENCY_SAMPLES)
        latencies[latency_count++] = (float)latency;
    }
    writer->busy = false;
    pthread_cond_broadcast(&changed);
    pthread_mutex_unlock(&lock);
  }
}

static void *poll_applied(void *unused) {
  uint32_t applied = 0;
  double progress_at = now_ms();
  pthread_mutex_lock(&lock);
  while (!stopping) {
    struct timespec until;
    clock_gettime(CLOCK_REALTIME, &until);
    until.tv_nsec += POLL_MS * 1000000L;
    until.tv_sec += until.tv_nsec / 1000000000L;
    until.tv_nsec %= 1000000000L;
    pthread_cond_timedwait(&changed, &lock, &until);
    if (stopping)
      break;
    pthread_mutex_unlock(&lock);

    uint32_t now;
    if (!bridge_read(poller, storage + RING_CONTROL_APPLIED, &now, 4)) {
      status("{\"event\":\"error\",\"message\":\"poll failed\",\"detail\":\"%s\"}",
             bridge_error(poller));
      pthread_mutex_lock(&lock);
      continue;
    }
    bool resync = false;
    if (now != applied)
      progress_at = now_ms();
    else if (atomic_load(&sequence) > applied && now_ms() - progress_at > options.resync_ms) {
      atomic_store(&keyframe, true);
      progress_at = now_ms();
      resync = true;
    }
    applied = now;
    pthread_mutex_lock(&lock);
    stats.applied = applied;
    stats.resyncs += resync;
  }
  pthread_mutex_unlock(&lock);
  return NULL;
}

bool sender_start(const struct sender_options *chosen, const struct bridge_info *info,
                  uint64_t mapped, struct mailbox *source) {
  options = *chosen;
  if (options.depth < 1)
    options.depth = 1;
  if (options.depth > MAX_WRITERS)
    options.depth = MAX_WRITERS;
  frames = source;
  storage = mapped;
  latencies = malloc(sizeof(float) * LATENCY_SAMPLES);
  poller = bridge_open(info, 0, 64);
  if (!latencies || !poller)
    return false;
  uint32_t first;
  if (!next_sequence(&first)) {
    fail("cannot read the ring", bridge_error(poller));
    return false;
  }
  atomic_store(&sequence, first - 1);
  atomic_store(&keyframe, true);
  for (int i = 0; i < options.depth; i++) {
    writers[i].bridge = bridge_open(info, RING_SLOT_BYTES, 64);
    if (!writers[i].bridge || pthread_create(&writers[i].thread, NULL, write_slots, &writers[i]))
      return false;
  }
  return pthread_create(&encoder_thread, NULL, encode_frames, NULL) == 0 &&
         pthread_create(&poll_thread, NULL, poll_applied, NULL) == 0;
}

bool sender_failed(void) {
  return atomic_load(&failure);
}

void sender_stop(void) {
  mailbox_stop(frames);
  pthread_mutex_lock(&lock);
  stopping = true;
  pthread_cond_broadcast(&changed);
  pthread_mutex_unlock(&lock);
  pthread_join(encoder_thread, NULL);
  pthread_join(poll_thread, NULL);
  for (int i = 0; i < options.depth; i++) {
    pthread_join(writers[i].thread, NULL);
    bridge_close(writers[i].bridge);
  }
  bridge_close(poller);
}

void sender_take_stats(struct sender_stats *out) {
  pthread_mutex_lock(&lock);
  *out = stats;
  uint32_t applied = stats.applied;
  memset(&stats, 0, sizeof(stats));
  stats.applied = applied;
  pthread_mutex_unlock(&lock);
}

static int by_value(const void *a, const void *b) {
  float x = *(const float *)a, y = *(const float *)b;
  return (x > y) - (x < y);
}

void sender_latency(double *p50, double *p90, double *p99, double *max, unsigned *count) {
  pthread_mutex_lock(&lock);
  qsort(latencies, latency_count, sizeof(float), by_value);
  unsigned n = latency_count;
  *count = n;
  *p50 = n ? latencies[n / 2] : 0;
  *p90 = n ? latencies[n * 9 / 10] : 0;
  *p99 = n ? latencies[n * 99 / 100] : 0;
  *max = n ? latencies[n - 1] : 0;
  pthread_mutex_unlock(&lock);
}
