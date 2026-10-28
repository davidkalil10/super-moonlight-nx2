/**
 * Reads whether an H.264 stream can reorder its output, for --output-lag 0: the decoder has no
 * reorder queue (lag0-re.md Q2). A truncated SPS throws rather than pass as reorder-free.
 */

const NAL_TYPE_MASK = 0x1f;
const NAL_SPS = 7;
const NAL_SLICE = 1;
const NAL_IDR_SLICE = 5;
/** Profiles whose SPS carries chroma format, bit depth and scaling lists (7.3.2.1.1). */
const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];
/** With constraint_set3_flag these infer max_num_reorder_frames 0 without a VUI (E.2.1). */
const INTRA_PROFILES = [44, 86, 100, 110, 122, 244];
const CONSTRAINT_SET3 = 0x10;
const EXTENDED_SAR = 255;
const CHROMA_444 = 3;
/** pic_order_cnt_type 2 ties output order to decode order. */
const POC_DECODE_ORDER = 2;
/** slice_type modulo 5 of a B slice (7.4.3). */
const B_SLICE = 1;
const SLICE_TYPES = 5;
const MAX_EXP_GOLOMB_ZEROS = 31;
/** Enough RBSP for first_mb_in_slice and slice_type. */
const SLICE_HEADER_BYTES = 16;

/**
 * The RBSP of a NAL unit without its header byte: every 0x03 after two zero bytes dropped.
 * @param {Uint8Array} nal
 * @param {number} [limit] Stop after this many RBSP bytes.
 * @returns {Uint8Array}
 */
function rbsp(nal, limit = Infinity) {
  const out = [];
  let zeros = 0;
  for (let at = 1; at < nal.length && out.length < limit; at++) {
    if (zeros >= 2 && nal[at] === 3) {
      zeros = 0;
      continue;
    }
    zeros = nal[at] ? 0 : zeros + 1;
    out.push(nal[at]);
  }
  return Uint8Array.from(out);
}

/**
 * An MSB-first bit reader with the Exp-Golomb codes of 9.1.
 * @param {Uint8Array} bytes
 * @param {string} what Names the structure in the truncation error.
 */
function bitReader(bytes, what) {
  let bit = 0;
  /** @param {number} count */
  const u = count => {
    let value = 0;
    for (let index = 0; index < count; index++, bit++) {
      if (bit >= bytes.length * 8) throw Error(`Truncated H.264 ${what}`);
      value = value * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  const ue = () => {
    let zeros = 0;
    while (!u(1)) {
      zeros++;
      if (zeros > MAX_EXP_GOLOMB_ZEROS) throw Error(`Invalid H.264 ${what}`);
    }

    return 2 ** zeros - 1 + u(zeros);
  };
  const se = () => {
    const code = ue();
    return code % 2 ? (code + 1) / 2 : -code / 2;
  };
  return {u, ue, se, flag: () => u(1) === 1};
}

/**
 * Skips one scaling list (7.3.2.1.1.1).
 * @param {ReturnType<typeof bitReader>} r
 * @param {number} size
 */
function skipScalingList(r, size) {
  let last = 8;
  let next = 8;
  for (let index = 0; index < size && next; index++) {
    next = (last + r.se() + 256) % 256;
    last = next || last;
  }
}

/**
 * Skips hrd_parameters (E.1.2).
 * @param {ReturnType<typeof bitReader>} r
 */
function skipHrd(r) {
  const count = r.ue() + 1;
  r.u(8);
  for (let index = 0; index < count; index++) {
    r.ue();
    r.ue();
    r.u(1);
  }
  r.u(20);
}

/**
 * The VUI fields up to bitstream_restriction (E.1.1).
 * @param {ReturnType<typeof bitReader>} r
 */
function readVui(r) {
  if (r.flag()) {
    if (r.u(8) === EXTENDED_SAR) r.u(32);
  }
  if (r.flag()) r.u(1);
  if (r.flag()) {
    r.u(4);
    if (r.flag()) r.u(24);
  }
  if (r.flag()) {
    r.ue();
    r.ue();
  }
  if (r.flag()) r.u(65);

  const nalHrd = r.flag();
  if (nalHrd) skipHrd(r);
  const vclHrd = r.flag();
  if (vclHrd) skipHrd(r);
  if (nalHrd || vclHrd) r.u(1);
  r.u(1);

  if (!r.flag()) return {bitstreamRestriction: false};
  r.u(1);
  for (let field = 0; field < 4; field++) r.ue();
  return {
    bitstreamRestriction: true,
    maxNumReorderFrames: r.ue(),
    maxDecFrameBuffering: r.ue()
  };
}

/**
 * @typedef {object} Sps
 * @property {number} profileIdc
 * @property {number} constraintFlags
 * @property {number} levelIdc
 * @property {number} pocType pic_order_cnt_type
 * @property {number} maxNumRefFrames
 * @property {boolean} vui
 * @property {boolean} bitstreamRestriction
 * @property {number | null} maxNumReorderFrames null without bitstream_restriction
 * @property {number | null} maxDecFrameBuffering
 */

/**
 * Parses an SPS NAL unit (header byte included) as far as its VUI bitstream restriction.
 * @param {Uint8Array} nal
 * @returns {Sps}
 */
function parseSps(nal) {
  if (!nal?.length || (nal[0] & NAL_TYPE_MASK) !== NAL_SPS) throw Error('Not an H.264 SPS');
  const r = bitReader(rbsp(nal), 'SPS');
  const profileIdc = r.u(8);
  const constraintFlags = r.u(8);
  const levelIdc = r.u(8);
  r.ue();

  if (HIGH_PROFILES.includes(profileIdc)) {
    const chroma = r.ue();
    if (chroma === CHROMA_444) r.u(1);
    r.ue();
    r.ue();
    r.u(1);
    const lists = chroma === CHROMA_444 ? 12 : 8;
    if (r.flag()) {
      for (let list = 0; list < lists; list++) {
        if (r.flag()) skipScalingList(r, list < 6 ? 16 : 64);
      }
    }
  }

  r.ue();
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const cycle = r.ue();
    for (let index = 0; index < cycle; index++) r.se();
  }

  const maxNumRefFrames = r.ue();
  r.u(1);
  r.ue();
  r.ue();
  if (!r.flag()) r.u(1);
  r.u(1);
  if (r.flag()) for (let edge = 0; edge < 4; edge++) r.ue();

  const vui = r.flag();
  const restriction = vui ? readVui(r) : {bitstreamRestriction: false};
  return {
    profileIdc,
    constraintFlags,
    levelIdc,
    pocType,
    maxNumRefFrames,
    vui,
    bitstreamRestriction: restriction.bitstreamRestriction,
    maxNumReorderFrames: restriction.maxNumReorderFrames ?? null,
    maxDecFrameBuffering: restriction.maxDecFrameBuffering ?? null
  };
}

/**
 * Why a stream with this SPS may have its output reordered, or null when it cannot.
 * Without bitstream_restriction max_num_reorder_frames is inferred as MaxDpbFrames (E.2.1),
 * except for intra profiles with constraint_set3_flag; pic_order_cnt_type 2 rules it out.
 * @param {Sps} sps
 * @returns {string | null}
 */
function reorderOf(sps) {
  if (sps.maxNumReorderFrames) return `max_num_reorder_frames ${sps.maxNumReorderFrames}`;
  if (sps.bitstreamRestriction || sps.pocType === POC_DECODE_ORDER) return null;

  const constraintSet3 = Boolean(sps.constraintFlags & CONSTRAINT_SET3);
  if (constraintSet3 && INTRA_PROFILES.includes(sps.profileIdc)) return null;
  return `pic_order_cnt_type ${sps.pocType} without bitstream_restriction`;
}

/**
 * The slice_type of a coded slice NAL unit, or null for any other NAL or a short header.
 * @param {Uint8Array} nal
 * @returns {number | null}
 */
function sliceType(nal) {
  const type = nal[0] & NAL_TYPE_MASK;
  if (type !== NAL_SLICE && type !== NAL_IDR_SLICE) return null;
  const r = bitReader(rbsp(nal, SLICE_HEADER_BYTES), 'slice header');
  try {
    r.ue();
    return r.ue();
  } catch {
    return null;
  }
}

/**
 * @param {number | null} type
 * @returns {boolean}
 */
const isBSlice = type => type !== null && type % SLICE_TYPES === B_SLICE;

export {parseSps, reorderOf, sliceType, isBSlice};
