/* Links tools/moonlight/hbv2enc.c without forking it: the file is included with
 * its main() renamed, and the per-frame step of that main() is repeated here
 * without the stdin/stdout framing, the recon dump and the PSNR pass. */
#define main hbv2enc_main
#include "../../hbv2enc.c"
#undef main

#include "encoder.h"

#include <pthread.h>

struct hbv2_encoder {
  Encoder state;
  int height;
};

static void build_tables(void) {
  for (int k = 0; k < 8; k++)
    for (int x = 0; x < 8; x++)
      DCT[k][x] = (float)((k ? 0.5 : sqrt(0.125)) * cos((2 * x + 1) * k * M_PI / 16));
  buildTables();
}

struct hbv2_encoder *hbv2_create(int width, int height, int threads) {
  static pthread_once_t once = PTHREAD_ONCE_INIT;
  pthread_once(&once, build_tables);
  if (width <= 0 || width % 16 || width > (int)HBV2_MAX_WIDTH || height <= 0 ||
      (height + 15) / 16 * 16 > (int)HBV2_MAX_HEIGHT)
    return NULL;
  if (threads > 0)
    omp_set_num_threads(threads);
  struct hbv2_encoder *encoder = allocate(sizeof(*encoder));
  setup(&encoder->state, width, (height + 15) / 16 * 16);
  encoder->height = height;
  return encoder;
}

void hbv2_encode(struct hbv2_encoder *encoder, const uint8_t *rgb, uint32_t sequence,
                 bool keyframe, const struct hbv2_settings *settings, struct hbv2_frame *out) {
  Request request = {
      .magic = REQUEST_MAGIC,
      .width = (uint32_t)encoder->state.w,
      .height = (uint32_t)encoder->height,
      .sequence = sequence,
      .flags = keyframe ? FLAG_KEYFRAME : 0,
      .budget = settings->budget,
      .cap = settings->cap,
      .qpMin = settings->qp_min,
      .qpMax = settings->qp_max,
      .refresh = settings->refresh,
  };
  Result result = {.magic = RESULT_MAGIC, .sequence = sequence};
  struct timespec started, finished;
  clock_gettime(CLOCK_MONOTONIC, &started);
  toPlanes(&encoder->state, rgb, encoder->height);
  size_t bytes = encode(&encoder->state, &request, &result);
  clock_gettime(CLOCK_MONOTONIC, &finished);

  *out = (struct hbv2_frame){
      .sequence = sequence,
      .slot_bytes = (uint32_t)bytes,
      .qp = result.qp,
      .intra = result.intra,
      .inter = result.inter,
      .skip = result.skip,
      .deferred = result.deferred,
      .keyframe = result.keyframe,
      .reference = result.reference,
      .encode_ms = (finished.tv_sec - started.tv_sec) * 1e3 +
                   (finished.tv_nsec - started.tv_nsec) / 1e6,
      .slot = (const uint8_t *)encoder->state.slot,
  };
}
