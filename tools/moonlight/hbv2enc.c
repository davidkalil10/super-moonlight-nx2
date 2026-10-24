// HBV2 encoder: RGB24 frames on stdin, HBV2 slots on stdout.
// Format reference: tools/moonlight/hbv2.cjs. Build: tools/moonlight/build-hbv2enc.sh.
//
// Each input record is a 48-byte header (see Request) followed by width x
// height x 3 bytes. Each output record is a 48-byte Result followed by the
// slot (a whole number of 32 KiB exchanges, or nothing when the frame has no
// change). The encoder keeps the exact reconstruction the console will hold,
// so P frames are coded against what the decoder really shows.
#include <emmintrin.h>
#include <math.h>
#include <omp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "hbv2-tables.h"

#define REQUEST_MAGIC 0x49324248u
#define RESULT_MAGIC 0x4f324248u
#define FLAG_KEYFRAME 1u
#define LIMIT ((int)HBV2_COEFFICIENT_LIMIT)
#define MAX_QP ((int)HBV2_MAX_QP)
#define CHROMA_QP_OFFSET 2
#define GLOBAL_CANDIDATES 3
#define COARSE_RANGE 32

typedef struct {
  uint32_t magic, width, height, sequence, flags, budget, cap, qpMin, qpMax, refresh, reserved[2];
} Request;

typedef struct {
  uint32_t magic, sequence, slotBytes, qp, intra, inter, skip, deferred, encodeMicros, keyframe,
      psnrCentidB, reference;
} Result;

typedef struct {
  int w, h;
  uint8_t *p[3];
} Frame;

typedef struct {
  uint32_t *words;
  size_t capacity, bits;
} Bits;

enum { SKIP, INTER, INTRA };

typedef struct {
  int w, h, bx, by, mbs, chunks;
  Frame source, reference, recon;
  int haveReference;
  uint32_t lastSequence;
  int *mvx, *mvy, *previousMvx, *previousMvy;
  uint8_t *forced, *deferred, *mode;
  uint32_t *skipError;
  float *interDct, *intraDct;
  float *gain, *cost;
  uint8_t *quarterSource, *quarterReference;
  int globals, globalX[GLOBAL_CANDIDATES], globalY[GLOBAL_CANDIDATES];
  Bits *chunkBits;
  int refreshCursor, lastQp;
  double lambdaScale;
  uint32_t *slot;
} Encoder;

static float DCT[8][8];

static void fail(const char *message) {
  fprintf(stderr, "hbv2enc: %s\n", message);
  exit(1);
}

static void *allocate(size_t bytes) {
  void *p = calloc(1, bytes);
  if (!p) fail("out of memory");
  return p;
}

static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

static int planeW(const Frame *f, int c) { return c ? f->w / 2 : f->w; }
static int planeH(const Frame *f, int c) { return c ? f->h / 2 : f->h; }

static void frameInit(Frame *f, int w, int h) {
  f->w = w;
  f->h = h;
  f->p[0] = allocate((size_t)w * h);
  f->p[1] = allocate((size_t)w * h / 4);
  f->p[2] = allocate((size_t)w * h / 4);
}

static int stepSize(int qp, int weight) {
  int s = (HBV2_QBASE[qp] * weight + 64) >> 7;
  return s < 1 ? 1 : s;
}

static int ueBits(uint32_t v) { return 2 * (31 - __builtin_clz(v + 1)) + 1; }
static int seBits(int v) { return ueBits(v > 0 ? 2u * v - 1 : (uint32_t)(-2 * v)); }

static void bitsPut(Bits *b, uint32_t value, int count) {
  while (count > 0) {
    size_t at = b->bits >> 5;
    if (at + 2 > b->capacity) {
      size_t grown = b->capacity ? b->capacity * 2 : 1024;
      b->words = realloc(b->words, grown * 4);
      if (!b->words) fail("out of memory");
      memset(b->words + b->capacity, 0, (grown - b->capacity) * 4);
      b->capacity = grown;
    }
    int shift = b->bits & 31, take = 32 - shift < count ? 32 - shift : count;
    uint32_t part = take == 32 ? value : value & ((1u << take) - 1);
    b->words[at] |= part << shift;
    value = take == 32 ? 0 : value >> take;
    b->bits += take;
    count -= take;
  }
}

static void bitsUe(Bits *b, uint32_t v) {
  int zeros = 31 - __builtin_clz(v + 1);
  bitsPut(b, 1u << zeros, zeros + 1);
  bitsPut(b, v + 1 - (1u << zeros), zeros);
}

static void bitsSe(Bits *b, int v) { bitsUe(b, v > 0 ? 2u * v - 1 : (uint32_t)(-2 * v)); }

static void bitsReset(Bits *b) {
  if (b->words) memset(b->words, 0, ((b->bits >> 5) + 1) * 4);
  b->bits = 0;
}

static void idct(const int *in, int *out) {
  int rows[64];
  for (int v = 0; v < 8; v++) {
    const int *c = in + v * 8;
    for (int x = 0; x < 8; x++) {
      int sum = 0;
      for (int u = 0; u < 8; u++) sum += HBV2_IDCT[u * 8 + x] * c[u];
      rows[v * 8 + x] = (sum + 256) >> 9;
    }
  }
  for (int y = 0; y < 8; y++)
    for (int x = 0; x < 8; x++) {
      int sum = 0;
      for (int v = 0; v < 8; v++) sum += HBV2_IDCT[v * 8 + y] * rows[v * 8 + x];
      out[y * 8 + x] = (sum + 16384) >> 15;
    }
}

// Orthonormal 8x8 DCT; out is in zigzag order.
static void forwardDct(const float *in, float *out) {
  float rows[64], natural[64];
  for (int y = 0; y < 8; y++)
    for (int u = 0; u < 8; u++) {
      float sum = 0;
      for (int x = 0; x < 8; x++) sum += DCT[u][x] * in[y * 8 + x];
      rows[y * 8 + u] = sum;
    }
  for (int v = 0; v < 8; v++)
    for (int u = 0; u < 8; u++) {
      float sum = 0;
      for (int y = 0; y < 8; y++) sum += DCT[v][y] * rows[y * 8 + u];
      natural[v * 8 + u] = sum;
    }
  for (int z = 0; z < 64; z++) out[z] = natural[HBV2_ZIGZAG[z]];
}

static void blockOrigin(int b, int mbx, int mby, int *left, int *top, int *component) {
  if (b < 4) {
    *left = mbx * 16 + (b & 1) * 8;
    *top = mby * 16 + (b >> 1) * 8;
    *component = 0;
  } else {
    *left = mbx * 8;
    *top = mby * 8;
    *component = b - 3;
  }
}

// Same prediction as the decoder: clamped integer luma, bilinear half-pel chroma.
static void predict(const Frame *ref, int component, int left, int top, int mvx, int mvy,
                    int *out) {
  const uint8_t *data = ref->p[component];
  int w = planeW(ref, component), h = planeH(ref, component);
#define AT(x, y) data[clampi(y, 0, h - 1) * w + clampi(x, 0, w - 1)]
  for (int j = 0; j < 8; j++)
    for (int i = 0; i < 8; i++) {
      if (!component) {
        out[j * 8 + i] = AT(left + i + mvx, top + j + mvy);
        continue;
      }
      int x2 = 2 * (left + i) + mvx, y2 = 2 * (top + j) + mvy;
      int ix = x2 >> 1, iy = y2 >> 1, fx = x2 & 1, fy = y2 & 1;
      out[j * 8 + i] = (AT(ix, iy) * (2 - fx) * (2 - fy) + AT(ix + 1, iy) * fx * (2 - fy) +
                        AT(ix, iy + 1) * (2 - fx) * fy + AT(ix + 1, iy + 1) * fx * fy + 2) >>
                       2;
    }
#undef AT
}

static void gather(const Frame *f, int component, int left, int top, int *out) {
  int w = planeW(f, component);
  const uint8_t *data = f->p[component];
  for (int j = 0; j < 8; j++)
    for (int i = 0; i < 8; i++) out[j * 8 + i] = data[(top + j) * w + left + i];
}

static void store(Frame *f, int component, int left, int top, const int *pixels) {
  int w = planeW(f, component);
  uint8_t *data = f->p[component];
  for (int j = 0; j < 8; j++)
    for (int i = 0; i < 8; i++) data[(top + j) * w + left + i] = (uint8_t)pixels[j * 8 + i];
}

static void copyMacroblock(const Frame *from, Frame *to, int mbx, int mby) {
  for (int b = 0; b < 6; b++) {
    int left, top, c;
    blockOrigin(b, mbx, mby, &left, &top, &c);
    int w = planeW(from, c);
    for (int j = 0; j < 8; j++)
      memcpy(to->p[c] + (top + j) * w + left, from->p[c] + (top + j) * w + left, 8);
  }
}

// Quantised block: run/level pairs in zigzag order plus the coefficient-domain
// distortion and the bits of the pairs.
typedef struct {
  int count, dc, bits;
  uint8_t run[64];
  int16_t level[64];
  float distortion;
} Coded;

// Per (intra, qp, zigzag position): step, its reciprocal and the magnitude
// below which the level rounds to zero.
static int STEP[2][HBV2_MAX_QP + 1][64];
static float INVERSE[2][HBV2_MAX_QP + 1][64], ZERO[2][HBV2_MAX_QP + 1][64];
static const float ROUNDING[2] = {1.0f / 6, 1.0f / 3};

static void buildTables(void) {
  for (int intra = 0; intra < 2; intra++)
    for (int qp = 0; qp <= MAX_QP; qp++)
      for (int z = 0; z < 64; z++) {
        int s = stepSize(qp, intra ? HBV2_WEIGHT_INTRA[HBV2_ZIGZAG[z]] : 16);
        STEP[intra][qp][z] = s;
        INVERSE[intra][qp][z] = 1.0f / s;
        ZERO[intra][qp][z] = (1 - ROUNDING[intra]) * s;
      }
}

// c: coefficients in zigzag order.
static void quantise(const float *c, int intra, int qp, Coded *out) {
  float distortion = 0;
  int count = 0, run = 0, bits = 0;
  if (intra) {
    int dc = clampi((int)lrintf(c[0] / 8), 0, 255);
    float d = c[0] - clampi(dc * 8, -LIMIT, LIMIT - 1);
    distortion += d * d;
    out->dc = dc;
  }
  const int *steps = STEP[intra][qp];
  const float *inverse = INVERSE[intra][qp], *zero = ZERO[intra][qp];
  for (int z = intra ? 1 : 0; z < 64; z++) {
    float value = c[z], magnitude = fabsf(value);
    if (magnitude < zero[z]) {
      distortion += value * value;
      run++;
      continue;
    }
    int level = (int)(magnitude * inverse[z] + ROUNDING[intra]);
    if (level > 2047) level = 2047;
    if (!level) {
      distortion += value * value;
      run++;
      continue;
    }
    int dequant = clampi(level * steps[z], -LIMIT, LIMIT - 1);
    float d = magnitude - dequant;
    distortion += d * d;
    out->run[count] = (uint8_t)run;
    out->level[count] = (int16_t)(value < 0 ? -level : level);
    bits += ueBits(run) + ueBits(level - 1) + 1;
    count++;
    run = 0;
  }
  out->count = count;
  out->bits = bits;
  out->distortion = distortion;
}

static void dequantise(const Coded *coded, int intra, int qp, int *out) {
  memset(out, 0, 64 * sizeof(int));
  int z = intra ? 1 : 0;
  if (intra) out[0] = clampi(coded->dc * 8, -LIMIT, LIMIT - 1);
  for (int i = 0; i < coded->count; i++) {
    z += coded->run[i];
    out[HBV2_ZIGZAG[z]] = clampi(coded->level[i] * STEP[intra][qp][z], -LIMIT, LIMIT - 1);
    z++;
  }
}

static void writeCoded(Bits *b, const Coded *coded) {
  for (int i = 0; i < coded->count; i++) {
    int level = coded->level[i];
    bitsUe(b, coded->run[i]);
    bitsUe(b, (uint32_t)(abs(level) - 1));
    bitsPut(b, level < 0, 1);
  }
}

static uint32_t sad16(const uint8_t *a, int as, const uint8_t *b, int bs) {
  __m128i sum = _mm_setzero_si128();
  for (int j = 0; j < 16; j++)
    sum = _mm_add_epi64(sum, _mm_sad_epu8(_mm_loadu_si128((const __m128i *)(a + j * as)),
                                          _mm_loadu_si128((const __m128i *)(b + j * bs))));
  return (uint32_t)(_mm_cvtsi128_si32(sum) + _mm_extract_epi16(sum, 4));
}

static uint32_t sad8(const uint8_t *a, int as, const uint8_t *b, int bs) {
  __m128i sum = _mm_setzero_si128();
  for (int j = 0; j < 8; j += 2) {
    __m128i x = _mm_unpacklo_epi64(_mm_loadl_epi64((const __m128i *)(a + j * as)),
                                   _mm_loadl_epi64((const __m128i *)(a + (j + 1) * as)));
    __m128i y = _mm_unpacklo_epi64(_mm_loadl_epi64((const __m128i *)(b + j * bs)),
                                   _mm_loadl_epi64((const __m128i *)(b + (j + 1) * bs)));
    sum = _mm_add_epi64(sum, _mm_sad_epu8(x, y));
  }
  return (uint32_t)(_mm_cvtsi128_si32(sum) + _mm_extract_epi16(sum, 4));
}

static void toPlanes(Encoder *e, const uint8_t *rgb, int height) {
  int w = e->w;
#pragma omp parallel for schedule(static)
  for (int y = 0; y < e->h; y++) {
    const uint8_t *row = rgb + (size_t)(y < height ? y : height - 1) * w * 3;
    for (int x = 0; x < w; x++)
      e->source.p[0][y * w + x] =
          (uint8_t)((19595 * row[x * 3] + 38470 * row[x * 3 + 1] + 7471 * row[x * 3 + 2] + 32768) >>
                    16);
  }
#pragma omp parallel for schedule(static)
  for (int y = 0; y < e->h / 2; y++) {
    const uint8_t *a = rgb + (size_t)(2 * y < height ? 2 * y : height - 1) * w * 3;
    const uint8_t *b = rgb + (size_t)(2 * y + 1 < height ? 2 * y + 1 : height - 1) * w * 3;
    for (int x = 0; x < w / 2; x++) {
      int r = a[6 * x] + a[6 * x + 3] + b[6 * x] + b[6 * x + 3];
      int g = a[6 * x + 1] + a[6 * x + 4] + b[6 * x + 1] + b[6 * x + 4];
      int bl = a[6 * x + 2] + a[6 * x + 5] + b[6 * x + 2] + b[6 * x + 5];
      int cb = ((-11059 * r - 21709 * g + 32768 * bl + 131072) >> 18) + 128;
      int cr = ((32768 * r - 27439 * g - 5329 * bl + 131072) >> 18) + 128;
      e->source.p[1][y * (w / 2) + x] = (uint8_t)clampi(cb, 0, 255);
      e->source.p[2][y * (w / 2) + x] = (uint8_t)clampi(cr, 0, 255);
    }
  }
}

static void quarter(const Frame *f, uint8_t *out) {
  int qw = f->w / 4, qh = f->h / 4;
#pragma omp parallel for schedule(static)
  for (int y = 0; y < qh; y++)
    for (int x = 0; x < qw; x++) {
      int sum = 0;
      for (int j = 0; j < 4; j++)
        for (int i = 0; i < 4; i++) sum += f->p[0][(4 * y + j) * f->w + 4 * x + i];
      out[y * qw + x] = (uint8_t)((sum + 8) >> 4);
    }
}

static int inside(const Encoder *e, int mbx, int mby, int mvx, int mvy) {
  int x = mbx * 16 + mvx, y = mby * 16 + mvy;
  return x >= 0 && y >= 0 && x + 16 <= e->w && y + 16 <= e->h;
}

static uint32_t mbSad(const Encoder *e, int mbx, int mby, int mvx, int mvy) {
  int w = e->w;
  return sad16(e->source.p[0] + mby * 16 * w + mbx * 16, w,
               e->reference.p[0] + (mby * 16 + mvy) * w + mbx * 16 + mvx, w);
}

static int byValue(const void *a, const void *b) {
  int x = *(const int *)a, y = *(const int *)b;
  return (x > y) - (x < y);
}

// Dominant motion among sampled changed macroblocks: a coarse search on
// quarter-resolution luma, a histogram, then a full-resolution refinement.
static void globalMotion(Encoder *e) {
  int qw = e->w / 4, qh = e->h / 4, range = COARSE_RANGE;
  int *votes = allocate(sizeof(int) * e->mbs * 2);
  quarter(&e->source, e->quarterSource);
  quarter(&e->reference, e->quarterReference);
#pragma omp parallel for schedule(dynamic, 4)
  for (int mb = 0; mb < e->mbs; mb++) {
    int mbx = mb % e->bx, mby = mb / e->bx;
    votes[2 * mb] = INT32_MIN;
    if ((mbx & 3) || (mby & 1) || !e->skipError[mb]) continue;
    int qx = mbx * 4 - 2, qy = mby * 4 - 2;
    if (qx < 0 || qy < 0 || qx + 8 > qw || qy + 8 > qh) continue;
    const uint8_t *s = e->quarterSource + qy * qw + qx;
    uint32_t best = sad8(s, qw, e->quarterReference + qy * qw + qx, qw);
    int bestX = 0, bestY = 0;
    for (int pass = 0; pass < 2; pass++) {
      int step = pass ? 1 : 2, reach = pass ? 1 : range, cx = bestX, cy = bestY;
      for (int dy = cy - reach; dy <= cy + reach; dy += step) {
        if (qy + dy < 0 || qy + dy + 8 > qh) continue;
        for (int dx = cx - reach; dx <= cx + reach; dx += step) {
          if (qx + dx < 0 || qx + dx + 8 > qw) continue;
          uint32_t sad = sad8(s, qw, e->quarterReference + (qy + dy) * qw + qx + dx, qw);
          if (sad < best) {
            best = sad;
            bestX = dx;
            bestY = dy;
          }
        }
      }
    }
    if (bestX || bestY) {
      votes[2 * mb] = bestX * 4;
      votes[2 * mb + 1] = bestY * 4;
    }
  }
  int count = 0;
  for (int mb = 0; mb < e->mbs; mb++)
    if (votes[2 * mb] != INT32_MIN)
      votes[count++] =
          (int)((uint32_t)(votes[2 * mb] + 32768) << 16 | (uint32_t)(votes[2 * mb + 1] + 32768));
  qsort(votes, count, sizeof(int), byValue);
  int runs[GLOBAL_CANDIDATES][2] = {{0}};
  for (int start = 0; start < count;) {
    int end = start;
    while (end < count && votes[end] == votes[start]) end++;
    for (int slot = 0; slot < GLOBAL_CANDIDATES; slot++)
      if (end - start > runs[slot][0]) {
        memmove(runs[slot + 1], runs[slot], sizeof(runs[0]) * (GLOBAL_CANDIDATES - 1 - slot));
        runs[slot][0] = end - start;
        runs[slot][1] = votes[start];
        break;
      }
    start = end;
  }
  e->globals = 0;
  for (int pick = 0; pick < GLOBAL_CANDIDATES && runs[pick][0] >= 3; pick++) {
    uint32_t key = (uint32_t)runs[pick][1];
    int coarseX = (int)(key >> 16) - 32768, coarseY = (int)(key & 0xffff) - 32768;
    uint64_t sums[49];
#pragma omp parallel for schedule(static)
    for (int offset = 0; offset < 49; offset++) {
      int x = coarseX + offset % 7 - 3, y = coarseY + offset / 7 - 3;
      uint64_t sum = 0;
      for (int mb = 0; mb < e->mbs; mb += 7) {
        int mbx = mb % e->bx, mby = mb / e->bx;
        if (!e->skipError[mb]) continue;
        sum += inside(e, mbx, mby, x, y) ? mbSad(e, mbx, mby, x, y) : 16 * 16 * 64;
      }
      sums[offset] = sum;
    }
    int best = 24;
    for (int offset = 0; offset < 49; offset++)
      if (sums[offset] < sums[best]) best = offset;
    e->globalX[e->globals] = coarseX + best % 7 - 3;
    e->globalY[e->globals] = coarseY + best / 7 - 3;
    e->globals++;
  }
  free(votes);
}

static uint32_t skipError(const Encoder *e, int mbx, int mby) {
  uint32_t sum = 0;
  for (int b = 0; b < 6; b++) {
    int left, top, c;
    blockOrigin(b, mbx, mby, &left, &top, &c);
    int w = planeW(&e->source, c);
    for (int j = 0; j < 8; j++)
      for (int i = 0; i < 8; i++) {
        int d = e->source.p[c][(top + j) * w + left + i] - e->reference.p[c][(top + j) * w + left + i];
        sum += d * d;
      }
  }
  return sum;
}

static void intraTransform(Encoder *e, int mb) {
  int mbx = mb % e->bx, mby = mb / e->bx, pixels[64];
  float in[64];
  for (int b = 0; b < 6; b++) {
    int left, top, c;
    blockOrigin(b, mbx, mby, &left, &top, &c);
    gather(&e->source, c, left, top, pixels);
    for (int i = 0; i < 64; i++) in[i] = (float)pixels[i];
    forwardDct(in, e->intraDct + ((size_t)mb * 6 + b) * 64);
  }
}

static void interTransform(Encoder *e, int mb) {
  int mbx = mb % e->bx, mby = mb / e->bx, pixels[64], prediction[64];
  float in[64];
  for (int b = 0; b < 6; b++) {
    int left, top, c;
    blockOrigin(b, mbx, mby, &left, &top, &c);
    gather(&e->source, c, left, top, pixels);
    predict(&e->reference, c, left, top, e->mvx[mb], e->mvy[mb], prediction);
    for (int i = 0; i < 64; i++) in[i] = (float)(pixels[i] - prediction[i]);
    forwardDct(in, e->interDct + ((size_t)mb * 6 + b) * 64);
  }
}

static void motionSearch(Encoder *e, int mb) {
  int mbx = mb % e->bx, mby = mb / e->bx;
  int candidates[16][2], n = 0;
  candidates[n][0] = 0, candidates[n++][1] = 0;
  candidates[n][0] = e->previousMvx[mb], candidates[n++][1] = e->previousMvy[mb];
  if (mbx > 0) candidates[n][0] = e->previousMvx[mb - 1], candidates[n++][1] = e->previousMvy[mb - 1];
  if (mbx + 1 < e->bx)
    candidates[n][0] = e->previousMvx[mb + 1], candidates[n++][1] = e->previousMvy[mb + 1];
  if (mby > 0)
    candidates[n][0] = e->previousMvx[mb - e->bx], candidates[n++][1] = e->previousMvy[mb - e->bx];
  if (mby + 1 < e->by)
    candidates[n][0] = e->previousMvx[mb + e->bx], candidates[n++][1] = e->previousMvy[mb + e->bx];
  for (int g = 0; g < e->globals; g++)
    candidates[n][0] = e->globalX[g], candidates[n++][1] = e->globalY[g];
  uint32_t best = mbSad(e, mbx, mby, 0, 0);
  int bestX = 0, bestY = 0;
  for (int i = 1; i < n; i++) {
    int x = candidates[i][0], y = candidates[i][1];
    if ((x == bestX && y == bestY) || !inside(e, mbx, mby, x, y)) continue;
    uint32_t sad = mbSad(e, mbx, mby, x, y);
    if (sad < best) best = sad, bestX = x, bestY = y;
  }
  static const int diamond[4][2] = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
  for (int iteration = 0; iteration < 16 && best; iteration++) {
    int moved = 0, centerX = bestX, centerY = bestY;
    for (int d = 0; d < 4; d++) {
      int x = centerX + diamond[d][0], y = centerY + diamond[d][1];
      if (!inside(e, mbx, mby, x, y)) continue;
      uint32_t sad = mbSad(e, mbx, mby, x, y);
      if (sad < best) best = sad, bestX = x, bestY = y, moved = 1;
    }
    if (!moved) break;
  }
  e->mvx[mb] = bestX;
  e->mvy[mb] = bestY;
}

typedef struct {
  int mvx, mvy, dc[3];
} Predictors;

// Chooses the mode of one macroblock at qp (writes nothing). Returns the bits
// and stores the decision, its distortion gain over skip and its cost.
static int decide(Encoder *e, int mb, int qp, int keyframe, Predictors *p) {
  int chromaQp = qp + CHROMA_QP_OFFSET > MAX_QP ? MAX_QP : qp + CHROMA_QP_OFFSET;
  double lambda = e->lambdaScale * stepSize(qp, 16) * stepSize(qp, 16);
  Coded coded;
  int forced = e->forced[mb];
  if (!keyframe && !forced && (e->deferred[mb] || !e->skipError[mb])) {
    e->mode[mb] = SKIP;
    return 1;
  }
  double skipCost = keyframe ? INFINITY : e->skipError[mb] + lambda;
  double interCost = INFINITY, intraCost;
  int interBits = 0, intraBits = 2, dc[3] = {p->dc[0], p->dc[1], p->dc[2]};
  if (!keyframe && !forced) {
    float distortion = 0;
    interBits = 2 + seBits(e->mvx[mb] - p->mvx) + seBits(e->mvy[mb] - p->mvy) + 6;
    for (int b = 0; b < 6; b++) {
      quantise(e->interDct + ((size_t)mb * 6 + b) * 64, 0, b < 4 ? qp : chromaQp, &coded);
      distortion += coded.distortion;
      if (coded.count) interBits += ueBits(coded.count - 1) + coded.bits;
    }
    interCost = distortion + lambda * interBits;
  }
  float distortion = 0;
  for (int b = 0; b < 6; b++) {
    int c = b < 4 ? 0 : b - 3;
    quantise(e->intraDct + ((size_t)mb * 6 + b) * 64, 1, b < 4 ? qp : chromaQp, &coded);
    distortion += coded.distortion;
    intraBits += seBits(coded.dc - dc[c]) + ueBits(coded.count) + coded.bits;
    dc[c] = coded.dc;
  }
  intraCost = distortion + lambda * intraBits;
  if (forced) interCost = skipCost = INFINITY;
  int mode = SKIP, bits = 1;
  double cost = skipCost;
  if (interCost < cost) mode = INTER, bits = interBits, cost = interCost;
  if (intraCost < cost) mode = INTRA, bits = intraBits, cost = intraCost;
  e->mode[mb] = (uint8_t)mode;
  e->gain[mb] = (float)(e->skipError[mb] - (cost - lambda * bits));
  e->cost[mb] = (float)bits;
  if (mode == INTER) p->mvx = e->mvx[mb], p->mvy = e->mvy[mb];
  if (mode == INTRA) memcpy(p->dc, dc, sizeof dc);
  return bits;
}

// Encodes one macroblock as decided: bits into b, exact reconstruction into recon.
static void emit(Encoder *e, int mb, int qp, Bits *b, Predictors *p) {
  int chromaQp = qp + CHROMA_QP_OFFSET > MAX_QP ? MAX_QP : qp + CHROMA_QP_OFFSET;
  int mbx = mb % e->bx, mby = mb / e->bx, coefficients[64], residual[64], prediction[64];
  Coded coded[6];
  if (e->mode[mb] == SKIP) {
    bitsPut(b, 1, 1);
    copyMacroblock(&e->reference, &e->recon, mbx, mby);
    return;
  }
  if (e->mode[mb] == INTER) {
    bitsPut(b, 2, 2);
    bitsSe(b, e->mvx[mb] - p->mvx);
    bitsSe(b, e->mvy[mb] - p->mvy);
    p->mvx = e->mvx[mb];
    p->mvy = e->mvy[mb];
    int cbp = 0;
    for (int k = 0; k < 6; k++) {
      quantise(e->interDct + ((size_t)mb * 6 + k) * 64, 0, k < 4 ? qp : chromaQp, &coded[k]);
      if (coded[k].count) cbp |= 1 << k;
    }
    bitsPut(b, cbp, 6);
    for (int k = 0; k < 6; k++) {
      int left, top, c;
      blockOrigin(k, mbx, mby, &left, &top, &c);
      predict(&e->reference, c, left, top, p->mvx, p->mvy, prediction);
      if (coded[k].count) {
        bitsUe(b, coded[k].count - 1);
        writeCoded(b, &coded[k]);
        dequantise(&coded[k], 0, k < 4 ? qp : chromaQp, coefficients);
        idct(coefficients, residual);
      } else
        memset(residual, 0, sizeof residual);
      for (int i = 0; i < 64; i++) prediction[i] = clampi(prediction[i] + residual[i], 0, 255);
      store(&e->recon, c, left, top, prediction);
    }
    return;
  }
  bitsPut(b, 0, 2);
  for (int k = 0; k < 6; k++) {
    int left, top, c;
    blockOrigin(k, mbx, mby, &left, &top, &c);
    quantise(e->intraDct + ((size_t)mb * 6 + k) * 64, 1, k < 4 ? qp : chromaQp, &coded[k]);
    bitsSe(b, coded[k].dc - p->dc[c]);
    p->dc[c] = coded[k].dc;
    bitsUe(b, coded[k].count);
    writeCoded(b, &coded[k]);
    dequantise(&coded[k], 1, k < 4 ? qp : chromaQp, coefficients);
    idct(coefficients, residual);
    for (int i = 0; i < 64; i++) residual[i] = clampi(residual[i], 0, 255);
    store(&e->recon, c, left, top, residual);
  }
}

static Predictors freshPredictors(void) { return (Predictors){0, 0, {128, 128, 128}}; }

// Frame size in bytes at qp, with the chunk list and header.
static size_t trial(Encoder *e, int qp, int keyframe, int *codedChunks) {
  size_t bits = 0;
  int chunks = 0;
#pragma omp parallel for schedule(dynamic, 4) reduction(+ : bits, chunks)
  for (int chunk = 0; chunk < e->chunks; chunk++) {
    Predictors p = freshPredictors();
    int chunkBits = 0, coded = 0;
    for (int m = 0; m < (int)HBV2_CHUNK_MBS; m++) {
      int mb = chunk * HBV2_CHUNK_MBS + m;
      if (mb >= e->mbs) break;
      chunkBits += decide(e, mb, qp, keyframe, &p);
      coded |= e->mode[mb] != SKIP;
    }
    if (coded) {
      bits += chunkBits;
      chunks++;
    }
  }
  if (codedChunks) *codedChunks = chunks;
  return (HBV2_HEADER_WORDS + chunks + (bits + 31) / 32 + 1) * 4;
}

// Smallest qp in [qpMin, qpMax] whose frame fits the budget (qpMax if none
// does). Gallops from the previous frame's qp, since it rarely moves far.
static int searchQp(Encoder *e, int qpMin, int qpMax, size_t budget, int keyframe) {
  int start = clampi(e->lastQp, qpMin, qpMax), lo, hi;
  if (trial(e, start, keyframe, NULL) <= budget) {
    hi = start;
    lo = qpMin;
    for (int step = 1; hi > qpMin; step *= 2) {
      int probe = hi - step < qpMin ? qpMin : hi - step;
      if (trial(e, probe, keyframe, NULL) > budget) {
        lo = probe + 1;
        break;
      }
      hi = probe;
    }
  } else {
    lo = start + 1;
    hi = qpMax;
    for (int step = 1; lo <= qpMax; step *= 2) {
      int probe = lo + step - 1 > qpMax ? qpMax : lo + step - 1;
      if (trial(e, probe, keyframe, NULL) <= budget) {
        hi = probe;
        break;
      }
      lo = probe + 1;
    }
    if (lo > qpMax) return qpMax;
  }
  while (lo < hi) {
    int mid = (lo + hi) / 2;
    if (trial(e, mid, keyframe, NULL) <= budget)
      hi = mid;
    else
      lo = mid + 1;
  }
  return hi;
}

static size_t exchangeBytes(size_t bytes) {
  return (bytes + HBV2_EXCHANGE_BYTES - 1) / HBV2_EXCHANGE_BYTES * HBV2_EXCHANGE_BYTES;
}

static const Encoder *sortContext;

static int byGain(const void *a, const void *b) {
  const Encoder *e = sortContext;
  int x = *(const int *)a, y = *(const int *)b;
  float gx = e->gain[x] / e->cost[x], gy = e->gain[y] / e->cost[y];
  return gx < gy ? 1 : gx > gy ? -1 : x - y;
}

// Over the cap at the coarsest allowed qp: keep the macroblocks with the most
// distortion removed per bit and defer the rest to later frames.
static void deferToCap(Encoder *e, int qp, size_t cap) {
  int *order = allocate(sizeof(int) * e->mbs), count = 0;
  for (int mb = 0; mb < e->mbs; mb++)
    if (e->mode[mb] != SKIP && !e->forced[mb]) order[count++] = mb;
  sortContext = e;
  qsort(order, count, sizeof(int), byGain);
  for (int keep = count; keep > 0;) {
    keep = keep * 7 / 8;
    for (int i = 0; i < count; i++) e->deferred[order[i]] = i >= keep;
    if (trial(e, qp, 0, NULL) <= cap) break;
  }
  free(order);
}

static double psnr(const Frame *a, const Frame *b) {
  double sum = 0;
  size_t n = (size_t)a->w * a->h;
  for (size_t i = 0; i < n; i++) {
    int d = a->p[0][i] - b->p[0][i];
    sum += d * d;
  }
  return sum ? 10 * log10(255.0 * 255.0 * n / sum) : 99;
}

static void profile(const char *phase) {
  static int enabled = -1;
  static struct timespec last;
  if (enabled < 0) enabled = getenv("HBV2_PROFILE") != NULL;
  if (!enabled) return;
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  if (phase)
    fprintf(stderr, "%s %.2f ms  ", phase,
            (now.tv_sec - last.tv_sec) * 1e3 + (now.tv_nsec - last.tv_nsec) / 1e6);
  last = now;
}

static size_t encode(Encoder *e, const Request *r, Result *result) {
  profile(NULL);
  int keyframe = !e->haveReference || (r->flags & FLAG_KEYFRAME);
  int qpMin = clampi(r->qpMin, 0, MAX_QP), qpMax = clampi(r->qpMax, qpMin, MAX_QP);
  size_t cap = r->cap ? r->cap : HBV2_MAX_FRAME_BYTES;
  if (cap > HBV2_MAX_FRAME_BYTES) cap = HBV2_MAX_FRAME_BYTES;
  size_t budget = r->budget && r->budget < cap ? r->budget : cap;
  memset(e->forced, 0, e->mbs);
  memset(e->deferred, 0, e->mbs);
  if (keyframe) {
    budget = cap;
    qpMax = MAX_QP;
#pragma omp parallel for schedule(dynamic, 16)
    for (int mb = 0; mb < e->mbs; mb++) {
      e->skipError[mb] = 1;
      intraTransform(e, mb);
    }
  } else {
#pragma omp parallel for schedule(dynamic, 16)
    for (int mb = 0; mb < e->mbs; mb++)
      e->skipError[mb] = skipError(e, mb % e->bx, mb / e->bx);
    for (uint32_t i = 0; i < r->refresh && e->chunks; i++) {
      int chunk = e->refreshCursor++ % e->chunks;
      for (int m = 0; m < (int)HBV2_CHUNK_MBS; m++)
        if (chunk * (int)HBV2_CHUNK_MBS + m < e->mbs) e->forced[chunk * HBV2_CHUNK_MBS + m] = 1;
    }
    profile("skip");
    globalMotion(e);
    profile("global");
#pragma omp parallel for schedule(dynamic, 8)
    for (int mb = 0; mb < e->mbs; mb++) {
      if (!e->skipError[mb] && !e->forced[mb]) {
        e->mvx[mb] = e->mvy[mb] = 0;
        continue;
      }
      motionSearch(e, mb);
      interTransform(e, mb);
      intraTransform(e, mb);
    }
  }
  profile("analyse");
  int qp = searchQp(e, qpMin, qpMax, budget, keyframe), deferred = 0;
  e->lastQp = qp;
  if (trial(e, qp, keyframe, NULL) > cap && !keyframe) {
    deferToCap(e, qp, cap);
    for (int mb = 0; mb < e->mbs; mb++) deferred += e->deferred[mb];
  }
  int codedChunks = 0;
  trial(e, qp, keyframe, &codedChunks);
  profile("rate");
  int counts[3] = {0, 0, 0};
  for (int mb = 0; mb < e->mbs; mb++) counts[e->mode[mb]]++;
  result->qp = qp;
  result->intra = counts[INTRA];
  result->inter = counts[INTER];
  result->skip = counts[SKIP];
  result->deferred = deferred;
  result->keyframe = keyframe;
  if (!keyframe && !codedChunks) {
    memcpy(e->previousMvx, e->mvx, sizeof(int) * e->mbs);
    memcpy(e->previousMvy, e->mvy, sizeof(int) * e->mbs);
    return 0;
  }
#pragma omp parallel for schedule(dynamic, 4)
  for (int chunk = 0; chunk < e->chunks; chunk++) {
    Predictors p = freshPredictors();
    Bits *b = &e->chunkBits[chunk];
    bitsReset(b);
    for (int m = 0; m < (int)HBV2_CHUNK_MBS; m++) {
      int mb = chunk * HBV2_CHUNK_MBS + m;
      if (mb >= e->mbs) break;
      emit(e, mb, qp, b, &p);
    }
  }
  profile("emit");
  uint32_t *words = e->slot;
  memset(words, 0, HBV2_MAX_FRAME_BYTES);
  int entries = 0;
  for (int chunk = 0; chunk < e->chunks; chunk++) {
    int coded = 0;
    for (int m = 0; m < (int)HBV2_CHUNK_MBS && chunk * (int)HBV2_CHUNK_MBS + m < e->mbs; m++)
      coded |= e->mode[chunk * HBV2_CHUNK_MBS + m] != SKIP;
    if (coded) entries++;
  }
  Bits stream = {words + HBV2_HEADER_WORDS + entries,
                 HBV2_MAX_FRAME_BYTES / 4 - HBV2_HEADER_WORDS - entries - 2, 0};
  int entry = 0;
  for (int chunk = 0; chunk < e->chunks; chunk++) {
    int coded = 0;
    for (int m = 0; m < (int)HBV2_CHUNK_MBS && chunk * (int)HBV2_CHUNK_MBS + m < e->mbs; m++)
      coded |= e->mode[chunk * HBV2_CHUNK_MBS + m] != SKIP;
    if (!coded) continue;
    if (stream.bits >= (1u << (32 - HBV2_CHUNK_INDEX_BITS))) fail("stream offset overflow");
    words[HBV2_HEADER_WORDS + entry++] = (uint32_t)chunk | (uint32_t)(stream.bits << HBV2_CHUNK_INDEX_BITS);
    const Bits *b = &e->chunkBits[chunk];
    size_t full = b->bits >> 5;
    if ((stream.bits + b->bits + 63) / 32 >= stream.capacity) fail("frame exceeds the slot");
    for (size_t i = 0; i < full; i++) bitsPut(&stream, b->words[i], 32);
    if (b->bits & 31) bitsPut(&stream, b->words[full], b->bits & 31);
  }
  profile("assemble");
  if (getenv("HBV2_PROFILE")) fputc('\n', stderr);
  size_t payload = (HBV2_HEADER_WORDS + entries + (stream.bits + 31) / 32 + 1) * 4;
  size_t bytes = exchangeBytes(payload);
  if (bytes > HBV2_MAX_FRAME_BYTES) fail("frame exceeds 256 KiB");
  int chromaQp = qp + CHROMA_QP_OFFSET > MAX_QP ? MAX_QP : qp + CHROMA_QP_OFFSET;
  words[0] = HBV2_MAGIC;
  words[1] = r->sequence;
  words[2] = (uint32_t)e->w | ((uint32_t)e->h << 16);
  words[3] = (uint32_t)payload;
  words[4] = keyframe ? 0 : e->lastSequence;
  words[5] = (uint32_t)qp | ((uint32_t)chromaQp << 8);
  words[6] = (uint32_t)entries;
  words[7] = 0;
  words[bytes / 4 - 1] = r->sequence;
  result->reference = words[4];
  Frame swap = e->reference;
  e->reference = e->recon;
  e->recon = swap;
  e->haveReference = 1;
  e->lastSequence = r->sequence;
  memcpy(e->previousMvx, e->mvx, sizeof(int) * e->mbs);
  memcpy(e->previousMvy, e->mvy, sizeof(int) * e->mbs);
  return bytes;
}

static void setup(Encoder *e, int w, int h) {
  memset(e, 0, sizeof *e);
  e->w = w;
  e->h = h;
  e->bx = w / 16;
  e->by = h / 16;
  e->mbs = e->bx * e->by;
  e->chunks = (e->mbs + HBV2_CHUNK_MBS - 1) / HBV2_CHUNK_MBS;
  frameInit(&e->source, w, h);
  frameInit(&e->reference, w, h);
  frameInit(&e->recon, w, h);
  e->mvx = allocate(sizeof(int) * e->mbs);
  e->mvy = allocate(sizeof(int) * e->mbs);
  e->previousMvx = allocate(sizeof(int) * e->mbs);
  e->previousMvy = allocate(sizeof(int) * e->mbs);
  e->forced = allocate(e->mbs);
  e->deferred = allocate(e->mbs);
  e->mode = allocate(e->mbs);
  e->skipError = allocate(sizeof(uint32_t) * e->mbs);
  e->gain = allocate(sizeof(float) * e->mbs);
  e->cost = allocate(sizeof(float) * e->mbs);
  e->interDct = allocate(sizeof(float) * 6 * 64 * e->mbs);
  e->intraDct = allocate(sizeof(float) * 6 * 64 * e->mbs);
  e->quarterSource = allocate((size_t)w * h / 16);
  e->quarterReference = allocate((size_t)w * h / 16);
  e->chunkBits = allocate(sizeof(Bits) * e->chunks);
  e->slot = allocate(HBV2_MAX_FRAME_BYTES);
  const char *scale = getenv("HBV2_LAMBDA");
  e->lambdaScale = scale ? atof(scale) : 0.12;
}

static int readAll(void *p, size_t n) {
  size_t done = 0;
  while (done < n) {
    size_t got = fread((char *)p + done, 1, n - done, stdin);
    if (!got) return done == 0 ? 0 : -1;
    done += got;
  }
  return 1;
}

int main(int argc, char **argv) {
  const char *reconPath = NULL;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--threads") && i + 1 < argc)
      omp_set_num_threads(atoi(argv[++i]));
    else if (!strcmp(argv[i], "--recon") && i + 1 < argc)
      reconPath = argv[++i];
    else {
      fprintf(stderr, "Usage: hbv2enc [--threads N] [--recon FILE] < frames > slots\n");
      return 2;
    }
  }
  for (int k = 0; k < 8; k++)
    for (int x = 0; x < 8; x++)
      DCT[k][x] = (float)((k ? 0.5 : sqrt(0.125)) * cos((2 * x + 1) * k * M_PI / 16));
  buildTables();
  FILE *recon = reconPath ? fopen(reconPath, "wb") : NULL;
  if (reconPath && !recon) fail("cannot open the recon file");
  Encoder e;
  int ready = 0;
  uint8_t *rgb = NULL;
  size_t rgbBytes = 0;
  Request r;
  for (;;) {
    int got = readAll(&r, sizeof r);
    if (!got) break;
    if (got < 0 || r.magic != REQUEST_MAGIC) fail("bad request header");
    if (!r.width || r.width % 16 || r.width > HBV2_MAX_WIDTH || !r.height ||
        (r.height + 15) / 16 * 16 > HBV2_MAX_HEIGHT)
      fail("unsupported frame size");
    int codedHeight = (int)(r.height + 15) / 16 * 16;
    size_t need = (size_t)r.width * r.height * 3;
    if (need > rgbBytes) {
      free(rgb);
      rgb = allocate(need);
      rgbBytes = need;
    }
    if (readAll(rgb, need) != 1) fail("truncated frame");
    if (!ready || e.w != (int)r.width || e.h != codedHeight) {
      if (ready) fail("frame size changed; restart the encoder");
      setup(&e, (int)r.width, codedHeight);
      ready = 1;
    }
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    toPlanes(&e, rgb, (int)r.height);
    Result result = {.magic = RESULT_MAGIC, .sequence = r.sequence};
    size_t bytes = encode(&e, &r, &result);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    result.slotBytes = (uint32_t)bytes;
    result.encodeMicros =
        (uint32_t)((t1.tv_sec - t0.tv_sec) * 1000000 + (t1.tv_nsec - t0.tv_nsec) / 1000);
    result.psnrCentidB = (uint32_t)(psnr(&e.source, &e.reference) * 100);
    if (recon && bytes) {
      for (int c = 0; c < 3; c++)
        fwrite(e.reference.p[c], 1, (size_t)planeW(&e.reference, c) * planeH(&e.reference, c),
               recon);
      fflush(recon);
    }
    if (fwrite(&result, sizeof result, 1, stdout) != 1 ||
        (bytes && fwrite(e.slot, 1, bytes, stdout) != bytes))
      fail("write failed");
    fflush(stdout);
  }
  if (recon) fclose(recon);
  return 0;
}
