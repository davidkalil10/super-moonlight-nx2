/* hbv2-encode-check: the hbv2enc stdin/stdout protocol served by the
 * in-process encoder (encoder.c), so tools/moonlight/helper/encode-check.cjs
 * can compare its slots with the hbv2enc process frame by frame. PSNR is
 * reported as 0. */
#include "encoder.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct request {
  uint32_t magic, width, height, sequence, flags, budget, cap, qp_min, qp_max, refresh,
      reserved[2];
};

struct result {
  uint32_t magic, sequence, slot_bytes, qp, intra, inter, skip, deferred, encode_us, keyframe,
      psnr, reference;
};

static bool read_all(void *data, size_t size) {
  return fread(data, 1, size, stdin) == size;
}

int main(int argc, char **argv) {
  int threads = argc > 2 && strcmp(argv[1], "--threads") == 0 ? atoi(argv[2]) : 0;
  struct hbv2_encoder *encoder = NULL;
  uint8_t *rgb = NULL;
  struct request request;
  while (read_all(&request, sizeof(request))) {
    size_t bytes = (size_t)request.width * request.height * 3;
    if (!encoder) {
      encoder = hbv2_create((int)request.width, (int)request.height, threads);
      rgb = malloc(bytes);
      if (!encoder || !rgb)
        return 1;
    }
    if (!read_all(rgb, bytes))
      return 1;
    struct hbv2_settings settings = {request.budget, request.cap, request.qp_min, request.qp_max,
                                     request.refresh};
    struct hbv2_frame frame;
    hbv2_encode(encoder, rgb, request.sequence, request.flags & 1, &settings, &frame);
    struct result result = {0x4f324248u, frame.sequence, frame.slot_bytes, frame.qp,
                            frame.intra, frame.inter, frame.skip, frame.deferred,
                            (uint32_t)(frame.encode_ms * 1000), frame.keyframe, 0,
                            frame.reference};
    fwrite(&result, sizeof(result), 1, stdout);
    fwrite(frame.slot, 1, frame.slot_bytes, stdout);
    fflush(stdout);
  }
  return 0;
}
