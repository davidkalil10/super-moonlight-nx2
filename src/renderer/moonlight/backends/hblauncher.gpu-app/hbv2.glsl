// HBV2 decode on the compute shader; mirrors tools/moonlight/hbv2.js.
// Include after ring.glsl, hbv2-tables.glsl and a coherent std430 buffer
// "memory" with uint words[] bound to the private storage. Call hbv2Step()
// from every invocation of the workgroup.
const uint HBV2_NONE = 0xffffffffu;

struct Hbv2Header {
    uint kind, sequence, reference, width, height, qp, chromaQp, count, trailer;
};

uint hbv2Exchanges(uint payloadBytes) {
    return (payloadBytes >> 15) + ((payloadBytes & 0x7fffu) != 0u ? 1u : 0u);
}

bool hbv2ReadHeader(uint slot, out Hbv2Header h) {
    uint base = RING_BASE + slot * RING_SLOT_WORDS;
    uint magic = memory.words[base], size = memory.words[base + 2u];
    h.kind = 0u;
    h.sequence = memory.words[base + 1u];
    h.width = size & 0xffffu;
    h.height = size >> 16;
    if ((magic != HBV2_MAGIC && magic != HBV1_MAGIC) || h.sequence == 0u) return false;
    if (h.width == 0u || h.height == 0u || h.width % 16u != 0u || h.height % 16u != 0u ||
        h.width > 4096u || h.height > 4096u) return false;
    uint exchanges = hbv2Exchanges(memory.words[base + 3u]);
    if (exchanges == 0u || exchanges * (RING_EXCHANGE_BYTES / 4u) > RING_SLOT_WORDS) return false;
    h.trailer = exchanges * (RING_EXCHANGE_BYTES / 4u) - 1u;
    if (memory.words[base + h.trailer] != h.sequence) return false;
    if (magic == HBV1_MAGIC) {
        h.kind = 1u;
        return true;
    }
    if (h.width > HBV2_MAX_WIDTH || h.height > HBV2_MAX_HEIGHT) return false;
    uint chunks = (h.width / 16u * (h.height / 16u) + HBV2_CHUNK_MBS - 1u) / HBV2_CHUNK_MBS;
    h.count = memory.words[base + 6u];
    h.qp = memory.words[base + 5u] & 0xffu;
    h.chromaQp = (memory.words[base + 5u] >> 8) & 0xffu;
    h.reference = memory.words[base + 4u];
    if (h.count > chunks || HBV2_HEADER_WORDS + h.count > h.trailer) return false;
    if (h.qp > HBV2_MAX_QP || h.chromaQp > HBV2_MAX_QP) return false;
    h.kind = 2u;
    return true;
}

bool hbv2Eligible(Hbv2Header h) {
    uint applied = memory.words[CONTROL_APPLIED];
    if (h.sequence <= applied) return false;
    if (h.kind == 1u || h.reference == 0u) return true;
    return h.reference == applied && memory.words[CONTROL_MODE] == MODE_HBV2 &&
        memory.words[CONTROL_SIZE] == (h.width | (h.height << 16));
}

// The newest independent frame (HBV1 or keyframe) if it is newer than the P
// frame continuing the current one, otherwise that P frame.
uint hbv2Pick() {
    uint independent = HBV2_NONE, independentSequence = 0u;
    uint dependent = HBV2_NONE, dependentSequence = 0u;
    for (uint slot = 0u; slot < RING_SLOTS; slot++) {
        Hbv2Header h;
        if (!hbv2ReadHeader(slot, h) || !hbv2Eligible(h)) continue;
        if (h.kind == 1u || h.reference == 0u) {
            if (h.sequence > independentSequence) {
                independent = slot;
                independentSequence = h.sequence;
            }
        } else if (dependent == HBV2_NONE || h.sequence < dependentSequence) {
            dependent = slot;
            dependentSequence = h.sequence;
        }
    }
    if (independent != HBV2_NONE &&
        (dependent == HBV2_NONE || independentSequence > dependentSequence)) return independent;
    return dependent;
}

// Bit reader over one slot; word indices are clamped to the trailer.
uint readerSlot, readerBase, readerEnd, readerPosition;

uint hbv2Word(uint index) {
    return memory.words[readerSlot + min(readerBase + index, readerEnd)];
}

uint hbv2Peek() {
    uint index = readerPosition >> 5, shift = readerPosition & 31u;
    uint low = hbv2Word(index) >> shift;
    return shift == 0u ? low : low | (hbv2Word(index + 1u) << (32u - shift));
}

uint hbv2Bits(uint count) {
    uint value = count == 0u ? 0u : hbv2Peek() & ((1u << count) - 1u);
    readerPosition += count;
    return value;
}

uint hbv2Ue() {
    uint window = hbv2Peek();
    uint zeros = window == 0u ? 20u : min(uint(findLSB(window)), 20u);
    readerPosition += zeros + 1u;
    return (1u << zeros) - 1u + hbv2Bits(zeros);
}

int hbv2Se() {
    uint code = hbv2Ue();
    return (code & 1u) != 0u ? int((code + 1u) >> 1) : -int(code >> 1);
}

int hbv2Step(uint qp, int weight) {
    return max(1, (HBV2_QBASE[qp] * weight + 64) >> 7);
}

int coefficients[64];
int pixels[64];

void hbv2ReadCoefficients(bool intra, uint qp, inout int predictor) {
    for (uint i = 0u; i < 64u; i++) coefficients[i] = 0;
    uint position = 0u, count;
    int limit = int(HBV2_COEFFICIENT_LIMIT);
    if (intra) {
        predictor += hbv2Se();
        coefficients[0] = clamp(predictor * 8, -limit, limit - 1);
        count = hbv2Ue();
        position = 1u;
    } else {
        count = hbv2Ue() + 1u;
    }
    count = min(count, 64u);
    for (uint i = 0u; i < count; i++) {
        position += hbv2Ue();
        if (position > 63u) break;
        int magnitude = int(hbv2Ue() + 1u);
        int level = hbv2Bits(1u) != 0u ? -magnitude : magnitude;
        uint natural = HBV2_ZIGZAG[position];
        int weight = intra ? HBV2_WEIGHT_INTRA[natural] : 16;
        coefficients[natural] = clamp(level * hbv2Step(qp, weight), -limit, limit - 1);
        position++;
    }
}

// Integer IDCT of coefficients[], added to pixels[] (the prediction).
void hbv2AddIdct() {
    int rows[64];
    for (uint v = 0u; v < 8u; v++)
        for (uint x = 0u; x < 8u; x++) {
            int sum = 0;
            for (uint u = 0u; u < 8u; u++) sum += HBV2_IDCT[u * 8u + x] * coefficients[v * 8u + u];
            rows[v * 8u + x] = (sum + 256) >> 9;
        }
    for (uint y = 0u; y < 8u; y++)
        for (uint x = 0u; x < 8u; x++) {
            int sum = 0;
            for (uint v = 0u; v < 8u; v++) sum += HBV2_IDCT[v * 8u + y] * rows[v * 8u + x];
            pixels[y * 8u + x] = clamp(pixels[y * 8u + x] + ((sum + 16384) >> 15), 0, 255);
        }
}

// Plane geometry inside a frame buffer: byte offset and stride.
uint hbv2PlaneOffset(uint frame, uint component) {
    uint base = FRAMES_OFFSET + frame * FRAME_BYTES;
    return component == 0u ? base : base + FRAME_LUMA_BYTES + (component - 1u) * FRAME_CHROMA_BYTES;
}

uint hbv2Stride(uint component) {
    return component == 0u ? FRAME_STRIDE : FRAME_STRIDE / 2u;
}

int hbv2Byte(uint offset) {
    return int((memory.words[offset >> 2] >> ((offset & 3u) * 8u)) & 255u);
}

// Twelve bytes from any byte offset, as three little-endian words.
uvec3 hbv2Load12(uint offset) {
    uint word = offset >> 2, shift = (offset & 3u) * 8u;
    uvec3 v = uvec3(memory.words[word], memory.words[word + 1u], memory.words[word + 2u]);
    if (shift == 0u) return v;
    uint next = memory.words[word + 3u];
    return uvec3((v.x >> shift) | (v.y << (32u - shift)), (v.y >> shift) | (v.z << (32u - shift)),
                 (v.z >> shift) | (next << (32u - shift)));
}

int hbv2Lane(uvec3 v, int index) {
    return int((v[index >> 2] >> (uint(index & 3) * 8u)) & 255u);
}

void hbv2Predict(uint frame, uint component, uint width, uint height, int left, int top, int mvx,
                 int mvy) {
    uint base = hbv2PlaneOffset(frame, component), stride = hbv2Stride(component);
    int w = int(component == 0u ? width : width / 2u) - 1;
    int h = int(component == 0u ? height : height / 2u) - 1;
    if (component == 0u && left + mvx >= 0 && top + mvy >= 0 && left + mvx + 7 <= w &&
        top + mvy + 7 <= h) {
        uint origin = base + uint(top + mvy) * stride + uint(left + mvx);
        for (int j = 0; j < 8; j++) {
            uvec3 row = hbv2Load12(origin + uint(j) * stride);
            for (int i = 0; i < 8; i++) pixels[j * 8 + i] = hbv2Lane(row, i);
        }
        return;
    }
    int ix = left + (mvx >> 1), iy = top + (mvy >> 1), fx = mvx & 1, fy = mvy & 1;
    if (component != 0u && ix >= 0 && iy >= 0 && ix + 8 <= w && iy + 8 <= h) {
        uint origin = base + uint(iy) * stride + uint(ix);
        uvec3 upper = hbv2Load12(origin);
        for (int j = 0; j < 8; j++) {
            uvec3 lower = hbv2Load12(origin + uint(j + 1) * stride);
            for (int i = 0; i < 8; i++)
                pixels[j * 8 + i] = (hbv2Lane(upper, i) * (2 - fx) * (2 - fy) + hbv2Lane(upper, i + 1) * fx * (2 - fy) +
                                     hbv2Lane(lower, i) * (2 - fx) * fy + hbv2Lane(lower, i + 1) * fx * fy + 2) >> 2;
            upper = lower;
        }
        return;
    }
    for (int j = 0; j < 8; j++)
        for (int i = 0; i < 8; i++) {
            if (component == 0u) {
                int x = clamp(left + i + mvx, 0, w), y = clamp(top + j + mvy, 0, h);
                pixels[j * 8 + i] = hbv2Byte(base + uint(y) * stride + uint(x));
                continue;
            }
            int x2 = 2 * (left + i) + mvx, y2 = 2 * (top + j) + mvy;
            int ix = x2 >> 1, iy = y2 >> 1, fx = x2 & 1, fy = y2 & 1;
            uint x0 = uint(clamp(ix, 0, w)), x1 = uint(clamp(ix + 1, 0, w));
            uint r0 = base + uint(clamp(iy, 0, h)) * stride, r1 = base + uint(clamp(iy + 1, 0, h)) * stride;
            pixels[j * 8 + i] = (hbv2Byte(r0 + x0) * (2 - fx) * (2 - fy) + hbv2Byte(r0 + x1) * fx * (2 - fy) +
                                 hbv2Byte(r1 + x0) * (2 - fx) * fy + hbv2Byte(r1 + x1) * fx * fy + 2) >> 2;
        }
}

void hbv2Store(uint frame, uint component, uint left, uint top) {
    uint base = hbv2PlaneOffset(frame, component), stride = hbv2Stride(component);
    for (uint j = 0u; j < 8u; j++) {
        uint word = (base + (top + j) * stride + left) >> 2;
        for (uint k = 0u; k < 2u; k++) {
            uint p = j * 8u + k * 4u;
            memory.words[word + k] = uint(pixels[p]) | (uint(pixels[p + 1u]) << 8) |
                (uint(pixels[p + 2u]) << 16) | (uint(pixels[p + 3u]) << 24);
        }
    }
}

void hbv2BlockOrigin(uint b, uint mbx, uint mby, out uint left, out uint top, out uint component) {
    if (b < 4u) {
        left = mbx * 16u + (b & 1u) * 8u;
        top = mby * 16u + (b >> 1) * 8u;
        component = 0u;
    } else {
        left = mbx * 8u;
        top = mby * 8u;
        component = b - 3u;
    }
}

void hbv2CopyMacroblock(uint from, uint to, uint mbx, uint mby) {
    for (uint component = 0u; component < 3u; component++) {
        uint size = component == 0u ? 16u : 8u, stride = hbv2Stride(component);
        uint source = hbv2PlaneOffset(from, component), target = hbv2PlaneOffset(to, component);
        for (uint j = 0u; j < size; j++) {
            uint at = (mby * size + j) * stride + mbx * size;
            for (uint k = 0u; k < size / 4u; k++)
                memory.words[((target + at) >> 2) + k] = memory.words[((source + at) >> 2) + k];
        }
    }
}

void hbv2DecodeChunk(uint slot, Hbv2Header h, uint entry, uint target, uint reference, uint count) {
    uint value = memory.words[slot + HBV2_HEADER_WORDS + entry];
    uint chunk = value & ((1u << HBV2_CHUNK_INDEX_BITS) - 1u);
    uint blocksX = h.width / 16u, macroblocks = blocksX * (h.height / 16u);
    if (chunk * HBV2_CHUNK_MBS >= macroblocks) return;
    readerSlot = slot;
    readerBase = HBV2_HEADER_WORDS + h.count;
    readerEnd = h.trailer;
    readerPosition = value >> HBV2_CHUNK_INDEX_BITS;
    int predictors[3] = int[3](128, 128, 128);
    int mvx = 0, mvy = 0;
    for (uint m = 0u; m < HBV2_CHUNK_MBS; m++) {
        uint mb = chunk * HBV2_CHUNK_MBS + m;
        if (mb >= macroblocks) break;
        if (hbv2Bits(1u) != 0u) continue;
        bool inter = hbv2Bits(1u) == 1u && reference != HBV2_NONE;
        uint mbx = mb % blocksX, mby = mb / blocksX, cbp = 0u;
        if (inter) {
            mvx += hbv2Se();
            mvy += hbv2Se();
            cbp = hbv2Bits(6u);
        }
        for (uint b = 0u; b < 6u; b++) {
            uint left, top, component;
            hbv2BlockOrigin(b, mbx, mby, left, top, component);
            uint qp = component != 0u ? h.chromaQp : h.qp;
            if (inter) {
                hbv2Predict(reference, component, h.width, h.height, int(left), int(top), mvx, mvy);
                if (((cbp >> b) & 1u) != 0u) {
                    int unused = 0;
                    hbv2ReadCoefficients(false, qp, unused);
                    hbv2AddIdct();
                }
            } else {
                for (uint i = 0u; i < 64u; i++) pixels[i] = 0;
                hbv2ReadCoefficients(true, qp, predictors[component]);
                hbv2AddIdct();
            }
            hbv2Store(target, component, left, top);
        }
        memory.words[CONTROL_WRITTEN + mb] = count;
    }
}

shared uint hbv2Slot, hbv2Target, hbv2Count;

// One dispatch: apply up to HBV2_CATCH_UP slots in sequence order.
void hbv2Step() {
    uint invocation = gl_LocalInvocationIndex;
    for (uint applied = 0u; applied < HBV2_CATCH_UP; applied++) {
        if (invocation == 0u) {
            hbv2Slot = hbv2Pick();
            if (hbv2Slot != HBV2_NONE) {
                Hbv2Header h;
                hbv2ReadHeader(hbv2Slot, h);
                if (h.kind == 1u) {
                    memory.words[CONTROL_MODE] = MODE_HBV1;
                    memory.words[CONTROL_HBV1_SLOT] = hbv2Slot;
                    memory.words[CONTROL_APPLIED] = h.sequence;
                    hbv2Count = 0u;
                } else {
                    bool continuing = memory.words[CONTROL_MODE] == MODE_HBV2;
                    hbv2Target = continuing ? memory.words[CONTROL_CURRENT] ^ 1u : 0u;
                    hbv2Count = memory.words[CONTROL_APPLY_COUNT] + 1u;
                }
            }
        }
        memoryBarrierShared();
        memoryBarrierBuffer();
        barrier();
        uint slot = hbv2Slot, count = hbv2Count, target = hbv2Target;
        if (slot == HBV2_NONE) break;
        if (count != 0u) {
            Hbv2Header h;
            hbv2ReadHeader(slot, h);
            uint reference = h.reference != 0u ? memory.words[CONTROL_CURRENT] : HBV2_NONE;
            uint macroblocks = h.width / 16u * (h.height / 16u), blocksX = h.width / 16u;
            if (reference != HBV2_NONE)
                for (uint mb = invocation; mb < macroblocks; mb += HBV2_LOCAL_SIZE)
                    if (memory.words[CONTROL_WRITTEN + mb] == count - 1u)
                        hbv2CopyMacroblock(reference, target, mb % blocksX, mb / blocksX);
            memoryBarrierBuffer();
            barrier();
            uint base = RING_BASE + slot * RING_SLOT_WORDS;
            for (uint entry = invocation; entry < h.count; entry += HBV2_LOCAL_SIZE)
                hbv2DecodeChunk(base, h, entry, target, reference, count);
            memoryBarrierBuffer();
            barrier();
            if (invocation == 0u) {
                memory.words[CONTROL_APPLY_COUNT] = count;
                memory.words[CONTROL_CURRENT] = target;
                memory.words[CONTROL_SIZE] = h.width | (h.height << 16);
                memory.words[CONTROL_MODE] = MODE_HBV2;
                memory.words[CONTROL_APPLIED] = h.sequence;
            }
        }
        memoryBarrierBuffer();
        barrier();
    }
}
