/* In-process HBV2 encoder: tools/moonlight/hbv2enc.c compiled in unchanged, so
 * slots are bit-identical to the hbv2enc process for the same requests. One
 * encoder per thread; every call must come from the thread that created it so
 * OpenMP keeps one worker pool. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

struct hbv2_settings {
  uint32_t budget;
  uint32_t cap;
  uint32_t qp_min;
  uint32_t qp_max;
  uint32_t refresh;
};

struct hbv2_frame {
  uint32_t sequence;
  uint32_t slot_bytes;
  uint32_t qp;
  uint32_t intra, inter, skip, deferred;
  uint32_t keyframe;
  uint32_t reference;
  double encode_ms;
  const uint8_t *slot;
};

struct hbv2_encoder;

struct hbv2_encoder *hbv2_create(int width, int height, int threads);
void hbv2_encode(struct hbv2_encoder *encoder, const uint8_t *rgb, uint32_t sequence,
                 bool keyframe, const struct hbv2_settings *settings, struct hbv2_frame *out);
