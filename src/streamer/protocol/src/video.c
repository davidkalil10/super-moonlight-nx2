/* Video: writes every access unit unchanged and in order to the raw fd (Annex B for H.264/HEVC,
 * OBUs for AV1) and announces each as an "au" status line. The console decodes them. */
#include "helper.h"

#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

static struct video_options options;
static uint8_t *packet_data;
static size_t packet_capacity;
static uint64_t access_units;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static struct video_stats stats;

static double now_ms(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return time.tv_sec * 1000.0 + time.tv_nsec / 1e6;
}

/* Bytes written to fd that the reader has not taken: the send queue of node's socketpair, or
 * what a pipe holds. -1 when neither ioctl answers. */
static int unread_bytes(int fd) {
  int bytes;
  if (ioctl(fd, TIOCOUTQ, &bytes) == 0 || ioctl(fd, FIONREAD, &bytes) == 0)
    return bytes;
  return -1;
}

static bool write_all(int fd, const uint8_t *data, size_t size) {
  while (size > 0) {
    ssize_t written = write(fd, data, size);
    if (written < 0 && errno == EINTR)
      continue;
    if (written <= 0)
      return false;
    data += written;
    size -= written;
  }
  return true;
}

static const char *codec_name(int format) {
  if (format & VIDEO_FORMAT_MASK_H265)
    return "hevc";
  if (format & VIDEO_FORMAT_MASK_AV1)
    return "av1";
  return "h264";
}

static int setup(int format, int width, int height, int fps, void *context, int flags) {
  if (format != options.format) {
    status("{\"event\":\"error\",\"message\":\"negotiated video codec differs from requested codec\","
           "\"requested\":\"%s\",\"received\":\"%s\"}", codec_name(options.format), codec_name(format));
    return -1;
  }

  access_units = 0;
  status("{\"event\":\"video\",\"codec\":\"%s\",\"stream\":\"%dx%d@%d\"}", codec_name(format),
         width, height, fps);
  return 0;
}

/* Joins the unit's buffer list into one contiguous packet; false when memory runs out. */
static bool gather(PDECODE_UNIT unit) {
  size_t needed = (size_t)unit->fullLength;
  if (needed > packet_capacity) {
    uint8_t *grown = realloc(packet_data, needed);
    if (!grown)
      return false;
    packet_data = grown;
    packet_capacity = needed;
  }

  size_t offset = 0;
  for (PLENTRY entry = unit->bufferList; entry; entry = entry->next) {
    memcpy(packet_data + offset, entry->data, entry->length);
    offset += entry->length;
  }
  return true;
}

static int submit(PDECODE_UNIT unit) {
  double queue_ms = (LiGetMicroseconds() - unit->enqueueTimeUs) / 1000.0;
  int queued = LiGetPendingVideoFrames();
  if (!gather(unit)) {
    pthread_mutex_lock(&lock);
    stats.failed++;
    pthread_mutex_unlock(&lock);
    return DR_NEED_IDR;
  }

  size_t bytes = (size_t)unit->fullLength;
  bool keyframe = unit->frameType == FRAME_TYPE_IDR;
  int unread = unread_bytes(options.raw_fd);
  double write_started = now_ms();
  if (!write_all(options.raw_fd, packet_data, bytes)) {
    status("{\"event\":\"error\",\"message\":\"raw output closed\"}");
    LiInterruptConnection();
    return DR_OK;
  }

  double written = now_ms();
  double receive_ms = (LiGetMicroseconds() - unit->receiveTimeUs) / 1000.0;
  uint64_t seq = access_units++;
  status("{\"type\":\"au\",\"seq\":%llu,\"frame\":%d,\"bytes\":%zu,\"keyframe\":%s,"
         "\"pts\":%llu,\"receiveMs\":%.2f,\"queueMs\":%.2f,\"queued\":%d,\"unread\":%d,"
         "\"writeMs\":%.2f,\"hostMs\":%.1f,\"writtenAt\":%.3f}",
         (unsigned long long)seq, unit->frameNumber, bytes, keyframe ? "true" : "false",
         (unsigned long long)unit->presentationTimeUs, receive_ms, queue_ms, queued, unread,
         written - write_started, unit->frameHostProcessingLatency / 10.0, written);
  pthread_mutex_lock(&lock);
  stats.written++;
  pthread_mutex_unlock(&lock);
  return DR_OK;
}

static void cleanup(void) {
  free(packet_data);
  packet_data = NULL;
  packet_capacity = 0;
}

void video_configure(const struct video_options *chosen) {
  options = *chosen;
}

void video_callbacks(DECODER_RENDERER_CALLBACKS *callbacks) {
  LiInitializeVideoCallbacks(callbacks);
  callbacks->setup = setup;
  callbacks->cleanup = cleanup;
  callbacks->submitDecodeUnit = submit;
  callbacks->capabilities = CAPABILITY_SLICES_PER_FRAME(4);
}

void video_take_stats(struct video_stats *out) {
  pthread_mutex_lock(&lock);
  *out = stats;
  memset(&stats, 0, sizeof(stats));
  pthread_mutex_unlock(&lock);
}
