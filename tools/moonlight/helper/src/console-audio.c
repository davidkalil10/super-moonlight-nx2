/* Moonlight PCM on the console AudioOut: audio-stream.cjs in process. The
 * same sound-memory allocation, the same verified SDK functions (the table in
 * console-layout.h, each checked with verify-function before its first call),
 * the same buffer ring and pacing, and the same teardown.
 *
 * The Opus callback pushes PCM into a bounded host queue; overflow drops the
 * oldest whole buffers. The feeder thread keeps `queue` console buffers in
 * flight, starting AudioOut once `prime` are queued, and sleeps until the
 * oldest one should have played out. */
#define _GNU_SOURCE
#include "console-layout.h"
#include "helper.h"
#include "host.h"

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define SAMPLE_RATE 48000
#define CHANNELS 2
#define FRAME_BYTES 4
#define SAMPLE_FORMAT_S16 2
#define DESCRIPTOR_COUNT 8
#define SLOT_STRIDE 0x4000u
#define SLOT_BASE 0x10000u
#define PARAM_OFFSET 0x300u
#define DESCRIPTOR_BASE 0x400u
#define DESCRIPTOR_STRIDE 0x40u
#define ALLOCATION_TEMP 0x10000u
#define ALLOCATION_ALIGN 65536u
#define CHUNK_SLACK 65536u

struct in_flight {
  int descriptor;
  double release_at;
};

static struct audio_options options;
static struct bridge_info info;
static char directory[1024];
static struct bridge *bridge;
static pthread_t thread;
static bool running;

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t arrived = PTHREAD_COND_INITIALIZER;
static uint8_t *queue;
static size_t queue_capacity, queue_head, queue_bytes, max_pending, buffer_bytes;
static bool input_ended;
static struct audio_stats stats;

static bool verified[AUDIO_FUNCTION_COUNT];
static uint64_t base;
static uint8_t silence[SLOT_STRIDE];
static uint8_t buffer[SLOT_STRIDE];

static void bump(unsigned *counter) {
  pthread_mutex_lock(&lock);
  (*counter)++;
  pthread_mutex_unlock(&lock);
}

static void drop_oldest(size_t bytes) {
  queue_head = (queue_head + bytes) % queue_capacity;
  queue_bytes -= bytes;
}

static void pull(uint8_t *out, size_t bytes) {
  size_t first = queue_capacity - queue_head < bytes ? queue_capacity - queue_head : bytes;
  memcpy(out, queue + queue_head, first);
  memcpy(out + first, queue, bytes - first);
  drop_oldest(bytes);
}

void console_audio_push(const void *pcm, size_t bytes) {
  pthread_mutex_lock(&lock);
  if (queue && !input_ended) {
    if (bytes > CHUNK_SLACK)
      bytes = CHUNK_SLACK;
    stats.received_bytes += bytes;
    size_t tail = (queue_head + queue_bytes) % queue_capacity;
    size_t first = queue_capacity - tail < bytes ? queue_capacity - tail : bytes;
    memcpy(queue + tail, pcm, first);
    memcpy(queue, (const uint8_t *)pcm + first, bytes - first);
    queue_bytes += bytes;
    if (queue_bytes > max_pending) {
      size_t drop = queue_bytes - max_pending;
      size_t whole = (drop + buffer_bytes - 1) / buffer_bytes * buffer_bytes;
      if (whole > queue_bytes)
        whole = queue_bytes;
      drop_oldest(whole);
      stats.dropped_bytes += whole;
      unsigned buffers = (unsigned)((whole + buffer_bytes / 2) / buffer_bytes);
      stats.overruns += buffers ? buffers : 1;
    }
    pthread_cond_signal(&arrived);
  }
  pthread_mutex_unlock(&lock);
}

static bool fail(const char *message) {
  status("{\"event\":\"error\",\"message\":\"audio: %s\",\"detail\":\"%s\"}", message,
         bridge_error(bridge));
  return false;
}

static bool call(enum audio_function function, const uint64_t *args, int count,
                 uint64_t *result) {
  const struct sdk_function *entry = &audio_functions[function];
  uint64_t address = info.sdk + entry->offset;
  if (!verified[function]) {
    if (!bridge_verify(bridge, address, entry->hex))
      return false;
    verified[function] = true;
  }
  return bridge_call_address(bridge, address, args, count, result);
}

static bool call1(enum audio_function function, uint64_t arg, uint64_t *result) {
  return call(function, &arg, 1, result);
}

/* The sound-memory allocator writes the block address to a scratch word,
 * which is saved and restored around the call. */
static bool allocate(uint64_t bytes) {
  uint64_t temp = info.scratch + ALLOCATION_TEMP, saved, result;
  if (!bridge_read(bridge, temp, &saved, 8))
    return fail("cannot read scratch");
  uint64_t args[] = {temp, ALLOCATION_ALIGN, bytes};
  bool ok = bridge_call(bridge, SDK_ALLOCATE, args, 3, &result) && result == 0 &&
            bridge_read(bridge, temp, &base, 8);
  if (!bridge_write(bridge, temp, &saved, 8) || !ok)
    return fail("allocation failed");
  if (!base || base % ALLOCATION_ALIGN || base >> 53)
    return fail("invalid allocation");
  return true;
}

static bool open_audio_out(void) {
  static uint8_t zero[65536];
  uint64_t param = base + PARAM_OFFSET, result;
  uint8_t params[8];
  if (!bridge_write(bridge, base, zero, sizeof(zero)) ||
      !call1(AUDIO_INITIALIZE_PARAMETER, param, NULL) || !bridge_read(bridge, param, params, 8))
    return fail("cannot initialize AudioOut parameters");
  uint32_t rate = SAMPLE_RATE;
  uint16_t channels = CHANNELS;
  memcpy(params, &rate, 4);
  memcpy(params + 4, &channels, 2);
  if (!bridge_write(bridge, param, params, 8))
    return fail("cannot write AudioOut parameters");
  uint64_t open_args[] = {base, param};
  if (!call(AUDIO_OPEN_DEFAULT, open_args, 2, &result))
    return fail("OpenDefaultAudioOut failed");
  if (result != 0) {
    status("{\"event\":\"error\",\"message\":\"audio: OpenDefaultAudioOut failed (%llu); "
           "game-audio.js may hold the device\"}",
           (unsigned long long)result);
    return false;
  }
  uint64_t rate_out, channels_out, format;
  if (!call1(AUDIO_SAMPLE_RATE, base, &rate_out) ||
      !call1(AUDIO_CHANNEL_COUNT, base, &channels_out) ||
      !call1(AUDIO_SAMPLE_FORMAT, base, &format) || rate_out != SAMPLE_RATE ||
      channels_out != CHANNELS || format != SAMPLE_FORMAT_S16)
    return fail("unexpected AudioOut format");
  return true;
}

static uint64_t descriptor_address(int i) {
  return base + DESCRIPTOR_BASE + (uint64_t)i * DESCRIPTOR_STRIDE;
}

static uint64_t slot_address(int i) {
  return base + SLOT_BASE + (uint64_t)i * SLOT_STRIDE;
}

/* Free descriptors in the order they became free, like the Set in
 * audio-stream.cjs; buffers in flight in append order. */
static int free_list[DESCRIPTOR_COUNT], free_count;
static bool is_free[DESCRIPTOR_COUNT];
static struct in_flight flight[DESCRIPTOR_COUNT];
static int flight_count;

static void make_free(int i) {
  free_list[free_count++] = i;
  is_free[i] = true;
}

static bool drain(void) {
  for (int i = 0; i < DESCRIPTOR_COUNT; i++) {
    uint64_t address;
    if (!call1(AUDIO_GET_RELEASED, base, &address))
      return fail("GetReleasedAudioOutBuffer failed");
    if (!address)
      break;
    int slot = -1;
    for (int j = 0; j < DESCRIPTOR_COUNT; j++)
      if (descriptor_address(j) == address)
        slot = j;
    if (slot < 0)
      return fail("unknown released descriptor");
    if (!is_free[slot]) {
      make_free(slot);
      if (flight_count)
        memmove(flight, flight + 1, sizeof(flight[0]) * (size_t)--flight_count);
      bump(&stats.released);
    }
  }
  return true;
}

static bool append(const uint8_t *pcm) {
  int descriptor = free_list[0];
  uint64_t args[] = {base, descriptor_address(descriptor)}, accepted;
  if (!bridge_write(bridge, slot_address(descriptor), pcm, buffer_bytes))
    return fail("cannot write PCM");
  bump(&stats.written);
  if (!call(AUDIO_APPEND, args, 2, &accepted) || accepted != 1)
    return fail("Append rejected");
  memmove(free_list, free_list + 1, sizeof(free_list[0]) * (size_t)--free_count);
  is_free[descriptor] = false;
  double buffer_ms = buffer_bytes / FRAME_BYTES * 1000.0 / SAMPLE_RATE;
  double playhead = flight_count ? flight[flight_count - 1].release_at : now_ms();
  double start = playhead > now_ms() ? playhead : now_ms();
  flight[flight_count++] = (struct in_flight){descriptor, start + buffer_ms};
  bump(&stats.appended);
  return true;
}

static void wait_ms(double milliseconds) {
  struct timespec until;
  clock_gettime(CLOCK_REALTIME, &until);
  long long nanoseconds = until.tv_nsec + (long long)(milliseconds * 1e6);
  until.tv_sec += nanoseconds / 1000000000LL;
  until.tv_nsec = nanoseconds % 1000000000LL;
  pthread_mutex_lock(&lock);
  if (!input_ended)
    pthread_cond_timedwait(&arrived, &lock, &until);
  pthread_mutex_unlock(&lock);
}

/* The main loop of audio-stream.cjs; false on the first failed console call. */
static bool play(bool *started) {
  double buffer_ms = buffer_bytes / FRAME_BYTES * 1000.0 / SAMPLE_RATE;
  int prime = options.prime < options.queue ? options.prime : options.queue;
  bool underflowing = false;
  for (;;) {
    if (flight_count && !drain())
      return false;
    int cap = *started ? options.queue : prime;
    for (;;) {
      pthread_mutex_lock(&lock);
      bool ready = free_count > 0 && flight_count < cap && queue_bytes >= buffer_bytes;
      if (ready)
        pull(buffer, buffer_bytes);
      pthread_mutex_unlock(&lock);
      if (!ready)
        break;
      if (!append(buffer))
        return false;
    }
    pthread_mutex_lock(&lock);
    bool ended = input_ended;
    size_t pending = queue_bytes;
    bool tail = ended && pending > 0 && pending < buffer_bytes && free_count > 0 &&
                flight_count < options.queue;
    if (tail) {
      memcpy(buffer, silence, buffer_bytes);
      pull(buffer, pending);
      pending = 0;
    }
    pthread_mutex_unlock(&lock);
    if (tail) {
      if (!append(buffer))
        return false;
      bump(&stats.tail);
    }
    if (!*started && (flight_count >= prime || (ended && flight_count > 0))) {
      uint64_t result;
      if (!call1(AUDIO_START, base, &result) || result != 0)
        return fail("StartAudioOut failed");
      *started = true;
    }
    if (flight_count > 0)
      underflowing = false;
    else if (*started && !ended && !underflowing) {
      bump(&stats.underruns);
      underflowing = true;
    }
    if (ended && flight_count == 0 && pending < buffer_bytes)
      return true;

    double wait = buffer_ms / 4;
    if (flight_count) {
      double until = flight[0].release_at - now_ms();
      wait = until < buffer_ms ? until : buffer_ms;
      if (wait < buffer_ms / 8)
        wait = buffer_ms / 8;
      sleep_ms(wait);
    } else {
      wait_ms(wait);
    }
  }
}

/* moonlight-audio-<ms>.json in the run directory, as audio-stream.cjs saves it. */
static void write_report(const char *error) {
  char path[1200], when[32];
  struct timespec now;
  clock_gettime(CLOCK_REALTIME, &now);
  long long epoch_ms = now.tv_sec * 1000LL + now.tv_nsec / 1000000;
  snprintf(path, sizeof(path), "%s/moonlight-audio-%lld.json", directory, epoch_ms);
  struct tm utc;
  gmtime_r(&now.tv_sec, &utc);
  strftime(when, sizeof(when), "%Y-%m-%dT%H:%M:%S", &utc);
  FILE *file = fopen(path, "w");
  if (!file)
    return;
  fprintf(file,
          "{\n  \"session\": \"%s\",\n  \"completed\": \"%s.%03ldZ\",\n  \"appended\": %u,\n"
          "  \"released\": %u,\n  \"written\": %u,\n  \"underruns\": %u,\n  \"overruns\": %u,\n"
          "  \"droppedBytes\": %llu,\n  \"tail\": %u,\n  \"receivedBytes\": %llu",
          info.session, when, now.tv_nsec / 1000000, stats.appended, stats.released,
          stats.written, stats.underruns, stats.overruns,
          (unsigned long long)stats.dropped_bytes, stats.tail,
          (unsigned long long)stats.received_bytes);
  if (error)
    fprintf(file, ",\n  \"error\": \"%s\"", error);
  fprintf(file, "\n}");
  fclose(file);
  status("{\"event\":\"audio\",\"saved\":\"%s\"}", path);
}

static void *feed(void *unused) {
  pthread_setname_np(pthread_self(), "console-audio");
  const char *error = NULL;
  bool started = false;
  if (!allocate(SLOT_BASE + DESCRIPTOR_COUNT * SLOT_STRIDE) || !open_audio_out()) {
    error = "AudioOut setup failed";
    goto done;
  }
  for (int i = 0; i < DESCRIPTOR_COUNT; i++) {
    uint64_t args[] = {descriptor_address(i), slot_address(i), SLOT_STRIDE, buffer_bytes};
    if (!call(AUDIO_SET_BUFFER_INFO, args, 4, NULL)) {
      fail("SetAudioOutBufferInfo failed");
      error = "AudioOut setup failed";
      goto done;
    }
    make_free(i);
  }
  status("{\"event\":\"audio\",\"message\":\"continuous audio stream ready\"}");

  bool played = play(&started);
  if (started)
    call1(AUDIO_STOP, base, NULL);
  if (!played) {
    error = "AudioOut stream failed";
    goto done;
  }
  uint64_t count = 1;
  if (!call1(AUDIO_FLUSH, base, NULL) || !drain() || !call1(AUDIO_BUFFER_COUNT, base, &count) ||
      count != 0) {
    error = "AudioOut queue did not drain";
    fail(error);
  }
  call1(AUDIO_CLOSE, base, NULL);
done:
  write_report(error);
  status("{\"event\":\"audio\",\"appended\":%u,\"released\":%u,\"underruns\":%u,"
         "\"overruns\":%u,\"tail\":%u}",
         stats.appended, stats.released, stats.underruns, stats.overruns, stats.tail);
  return NULL;
}

bool console_audio_start(const struct audio_options *chosen,
                         const struct bridge_info *bridge_info, const char *run_directory) {
  options = *chosen;
  if (options.buffer_frames <= 0)
    options.buffer_frames = 3840;
  if (options.queue <= 0)
    options.queue = 3;
  if (options.prime <= 0)
    options.prime = 2;
  info = *bridge_info;
  snprintf(directory, sizeof(directory), "%s", run_directory);
  buffer_bytes = (size_t)options.buffer_frames * FRAME_BYTES;
  if (buffer_bytes > SLOT_STRIDE) {
    status("{\"event\":\"error\",\"message\":\"audio: buffer does not fit a slot\"}");
    return false;
  }
  max_pending = (size_t)(options.queue + 2) * buffer_bytes;
  queue_capacity = max_pending + CHUNK_SLACK;
  queue = malloc(queue_capacity);
  bridge = bridge_open(&info, SLOT_BASE, 64);
  running = queue && bridge && pthread_create(&thread, NULL, feed, NULL) == 0;
  return running;
}

void console_audio_end(void) {
  pthread_mutex_lock(&lock);
  input_ended = true;
  pthread_cond_signal(&arrived);
  pthread_mutex_unlock(&lock);
}

void console_audio_stop(void) {
  if (!running)
    return;
  console_audio_end();
  pthread_join(thread, NULL);
  bridge_close(bridge);
  running = false;
}

void console_audio_stats(struct audio_stats *out) {
  pthread_mutex_lock(&lock);
  *out = stats;
  pthread_mutex_unlock(&lock);
}
