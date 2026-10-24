/* Video: decodes H.264/HEVC with libavcodec (VAAPI when available), converts to
 * RGB24 at the requested size and publishes the newest frame to a mailbox.
 *
 * By default a writer thread takes frames from an internal mailbox and writes
 * them to stdout; a frame still pending when the next one is decoded is
 * dropped, so a slow reader never builds a queue. With options.frames the
 * caller owns the mailbox and consumes it in process.
 *
 * With a raw fd, every access unit is written in order as Annex B (IDR units
 * start with SPS/PPS, plus VPS for HEVC) and announced as an "au" status line.
 * Decoding is skipped when only the raw output is wanted. */
#include "helper.h"
#include "mailbox.h"

#include <errno.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static struct video_options options;
static AVCodecContext *codec;
static AVBufferRef *device;
static AVPacket *packet;
static AVFrame *frame;
static AVFrame *transfer;
static struct SwsContext *scaler;
static uint8_t *packet_data;
static size_t packet_capacity;

static struct mailbox internal;
static struct mailbox *frames;
static bool writer_running;
static pthread_t writer;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static struct video_stats stats;

static double now_ms(void) {
  struct timespec time;
  clock_gettime(CLOCK_MONOTONIC, &time);
  return time.tv_sec * 1000.0 + time.tv_nsec / 1e6;
}

static size_t frame_bytes(void) {
  return (size_t)options.width * options.height * 3;
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

static void *write_frames(void *unused) {
  for (;;) {
    const uint8_t *rgb = mailbox_take(frames, NULL);
    if (!rgb)
      return NULL;
    if (!write_all(STDOUT_FILENO, rgb, frame_bytes())) {
      status("{\"event\":\"error\",\"message\":\"frame output closed\"}");
      LiInterruptConnection();
      return NULL;
    }
    pthread_mutex_lock(&lock);
    stats.written++;
    pthread_mutex_unlock(&lock);
  }
}

static void publish(double started) {
  double now = now_ms();
  bool dropped = mailbox_publish(frames, now);
  pthread_mutex_lock(&lock);
  stats.dropped += dropped;
  stats.decoded++;
  stats.decode_ms += now - started;
  pthread_mutex_unlock(&lock);
}

static enum AVPixelFormat pick_vaapi(AVCodecContext *context, const enum AVPixelFormat *formats) {
  for (const enum AVPixelFormat *format = formats; *format != AV_PIX_FMT_NONE; format++)
    if (*format == AV_PIX_FMT_VAAPI)
      return *format;
  return avcodec_default_get_format(context, formats);
}

static bool convert(AVFrame *decoded) {
  AVFrame *source = decoded;
  if (decoded->format == AV_PIX_FMT_VAAPI) {
    av_frame_unref(transfer);
    if (av_hwframe_transfer_data(transfer, decoded, 0) < 0)
      return false;
    source = transfer;
  }
  scaler = sws_getCachedContext(scaler, source->width, source->height, source->format,
                                options.width, options.height, AV_PIX_FMT_RGB24,
                                SWS_BILINEAR, NULL, NULL, NULL);
  if (!scaler)
    return false;

  bool bt601 = source->colorspace == AVCOL_SPC_SMPTE170M || source->colorspace == AVCOL_SPC_BT470BG;
  bool full_range = source->color_range == AVCOL_RANGE_JPEG;
  sws_setColorspaceDetails(scaler, sws_getCoefficients(bt601 ? SWS_CS_ITU601 : SWS_CS_ITU709),
                           full_range, sws_getCoefficients(SWS_CS_DEFAULT), 1, 0, 1 << 16,
                           1 << 16);

  uint8_t *planes[4] = {mailbox_back(frames)};
  int strides[4] = {options.width * 3};
  return sws_scale(scaler, (const uint8_t *const *)source->data, source->linesize, 0,
                   source->height, planes, strides) > 0;
}

static const char *codec_name(int format) {
  if (format & VIDEO_FORMAT_MASK_H265)
    return "hevc";
  if (format & VIDEO_FORMAT_MASK_AV1)
    return "av1";
  return "h264";
}

static uint64_t access_units;

static int setup(int format, int width, int height, int fps, void *context, int flags) {
  access_units = 0;
  if (!options.decode) {
    status("{\"event\":\"video\",\"codec\":\"%s\",\"decode\":false,\"stream\":\"%dx%d@%d\"}",
           codec_name(format), width, height, fps);
    return 0;
  }
  enum AVCodecID id = AV_CODEC_ID_H264;
  if (format & VIDEO_FORMAT_MASK_H265)
    id = AV_CODEC_ID_HEVC;
  else if (format & VIDEO_FORMAT_MASK_AV1)
    id = AV_CODEC_ID_AV1;

  const AVCodec *decoder = avcodec_find_decoder(id);
  codec = decoder ? avcodec_alloc_context3(decoder) : NULL;
  if (!codec) {
    status("{\"event\":\"error\",\"message\":\"no %s decoder\"}", codec_name(format));
    return -1;
  }
  codec->flags |= AV_CODEC_FLAG_LOW_DELAY;

  bool hardware = !options.software &&
                  av_hwdevice_ctx_create(&device, AV_HWDEVICE_TYPE_VAAPI, NULL, NULL, 0) == 0;
  if (hardware) {
    codec->hw_device_ctx = av_buffer_ref(device);
    codec->get_format = pick_vaapi;
  } else {
    codec->thread_type = FF_THREAD_SLICE;
    codec->thread_count = 4;
  }
  if (avcodec_open2(codec, decoder, NULL) < 0) {
    status("{\"event\":\"error\",\"message\":\"cannot open the %s decoder\"}", codec_name(format));
    return -1;
  }

  packet = av_packet_alloc();
  frame = av_frame_alloc();
  transfer = av_frame_alloc();
  if (options.frames) {
    frames = options.frames;
  } else {
    frames = &internal;
    if (!mailbox_init(frames, frame_bytes())) {
      status("{\"event\":\"error\",\"message\":\"out of memory\"}");
      return -1;
    }
    writer_running = pthread_create(&writer, NULL, write_frames, NULL) == 0;
  }

  status("{\"event\":\"video\",\"codec\":\"%s\",\"hardware\":%s,\"stream\":\"%dx%d@%d\","
         "\"output\":\"%dx%d\"}",
         codec_name(format), hardware ? "true" : "false", width, height, fps, options.width,
         options.height);
  return 0;
}

static int submit(PDECODE_UNIT unit) {
  double started = now_ms();
  size_t needed = (size_t)unit->fullLength + AV_INPUT_BUFFER_PADDING_SIZE;
  if (needed > packet_capacity) {
    packet_data = realloc(packet_data, needed);
    packet_capacity = needed;
  }
  size_t offset = 0;
  for (PLENTRY entry = unit->bufferList; entry; entry = entry->next) {
    memcpy(packet_data + offset, entry->data, entry->length);
    offset += entry->length;
  }
  memset(packet_data + offset, 0, AV_INPUT_BUFFER_PADDING_SIZE);

  bool keyframe = unit->frameType == FRAME_TYPE_IDR;
  if (options.raw_fd >= 0) {
    if (!write_all(options.raw_fd, packet_data, offset)) {
      status("{\"event\":\"error\",\"message\":\"raw output closed\"}");
      LiInterruptConnection();
      return DR_OK;
    }
    status("{\"type\":\"au\",\"seq\":%llu,\"frame\":%d,\"bytes\":%zu,\"keyframe\":%s,"
           "\"pts\":%llu}",
           (unsigned long long)access_units++, unit->frameNumber, offset,
           keyframe ? "true" : "false", (unsigned long long)unit->presentationTimeUs);
  }
  if (!options.decode) {
    pthread_mutex_lock(&lock);
    stats.written++;
    pthread_mutex_unlock(&lock);
    return DR_OK;
  }

  packet->data = packet_data;
  packet->size = (int)offset;
  packet->flags = keyframe ? AV_PKT_FLAG_KEY : 0;
  if (avcodec_send_packet(codec, packet) < 0)
    goto failed;

  while (avcodec_receive_frame(codec, frame) == 0) {
    if (!convert(frame))
      goto failed;
    publish(started);
  }
  return DR_OK;

failed:
  pthread_mutex_lock(&lock);
  stats.failed++;
  pthread_mutex_unlock(&lock);
  return DR_NEED_IDR;
}

static void cleanup(void) {
  if (frames == &internal) {
    mailbox_stop(frames);
    if (writer_running)
      pthread_join(writer, NULL);
    writer_running = false;
    mailbox_free(frames);
  }
  frames = NULL;

  avcodec_free_context(&codec);
  av_buffer_unref(&device);
  av_packet_free(&packet);
  av_frame_free(&frame);
  av_frame_free(&transfer);
  sws_freeContext(scaler);
  scaler = NULL;
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
