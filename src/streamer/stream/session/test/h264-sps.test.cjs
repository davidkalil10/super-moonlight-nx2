// What an H.264 SPS and slice headers say about reordering, on hand-built NAL units.
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseSps, reorderOf, sliceType, isBSlice} = require('../h264-sps.js');
const {scanUnit, parameterSets} = require('../h264-stream.js');
const {spsNal, sliceNal, bitWriter} = require('../../../test-support/test-helpers.cjs');

const annexB = (...nals) => Buffer.concat(nals.flatMap(nal => [Buffer.from([0, 0, 0, 1]), nal]));

test('a no-reorder high profile SPS reads its VUI bitstream restriction', () => {
  const sps = parseSps(spsNal());
  assert.deepEqual(sps, {
    profileIdc: 100,
    constraintFlags: 0,
    levelIdc: 40,
    pocType: 0,
    maxNumRefFrames: 1,
    vui: true,
    bitstreamRestriction: true,
    maxNumReorderFrames: 0,
    maxDecFrameBuffering: 1
  });
  assert.equal(reorderOf(sps), null);
});

test('max_num_reorder_frames above 0 allows reordering', () => {
  const sps = parseSps(spsNal({reorder: 2}));
  assert.equal(sps.maxNumReorderFrames, 2);
  assert.equal(sps.maxDecFrameBuffering, 3);
  assert.equal(reorderOf(sps), 'max_num_reorder_frames 2');
});

test('pic_order_cnt_type 0 or 1 without a bitstream restriction allows reordering', () => {
  for (const pocType of [0, 1]) {
    const sps = parseSps(spsNal({pocType, reorder: null}));
    assert.equal(sps.pocType, pocType);
    assert.equal(sps.bitstreamRestriction, false);
    assert.equal(sps.maxNumReorderFrames, null);
    assert.equal(reorderOf(sps), `pic_order_cnt_type ${pocType} without bitstream_restriction`);
    const bare = parseSps(spsNal({pocType, vui: false}));
    assert.equal(bare.vui, false);
    assert.equal(reorderOf(bare), `pic_order_cnt_type ${pocType} without bitstream_restriction`);
  }
});

test('pic_order_cnt_type 2 and intra profiles with constraint_set3 rule reordering out', () => {
  assert.equal(reorderOf(parseSps(spsNal({pocType: 2, reorder: null}))), null);
  assert.equal(reorderOf(parseSps(spsNal({pocType: 2, vui: false}))), null);
  const intra = parseSps(spsNal({constraints: 0x10, reorder: null}));
  assert.equal(intra.constraintFlags, 0x10);
  assert.equal(reorderOf(intra), null);
  assert.equal(
    reorderOf(parseSps(spsNal({profile: 77, constraints: 0x10, reorder: null}))),
    'pic_order_cnt_type 0 without bitstream_restriction'
  );
});

test('scaling lists, HRD parameters and a main profile SPS still reach the restriction', () => {
  const scaled = parseSps(spsNal({scaling: true, hrd: true, reorder: 1}));
  assert.equal(scaled.maxNumReorderFrames, 1);
  const main = parseSps(spsNal({profile: 77}));
  assert.equal(main.profileIdc, 77);
  assert.equal(main.maxNumReorderFrames, 0);
});

test('emulation prevention bytes are dropped before the bits are read', () => {
  // A first_mb_in_slice of 2^24 - 1 starts with 24 zero bits, which need a 0x03.
  const nal = bitWriter()
    .ue(2 ** 24 - 1)
    .ue(6)
    .nal(0x41);
  assert.deepEqual([...nal.subarray(0, 4)], [0x41, 0, 0, 3]);
  assert.equal(sliceType(nal), 6);
});

test('a truncated or foreign SPS throws instead of passing as reorder-free', () => {
  const sps = spsNal();
  assert.throws(() => parseSps(sps.subarray(0, sps.length - 3)), /Truncated H.264 SPS/);
  assert.throws(() => parseSps(Buffer.from('6742001eab', 'hex')), /Truncated H.264 SPS/);
  assert.throws(() => parseSps(Buffer.from('68ce01', 'hex')), /Not an H.264 SPS/);
});

test('slice types come from coded slices only, and B slices are 1 and 6', () => {
  assert.deepEqual(
    [0, 1, 2, 5, 6, 7].map(type => sliceType(sliceNal(type))),
    [0, 1, 2, 5, 6, 7]
  );
  assert.deepEqual(
    [0, 1, 2, 5, 6, 7].map(type => isBSlice(sliceType(sliceNal(type)))),
    [false, true, false, false, true, false]
  );
  assert.equal(sliceType(spsNal()), null);
  assert.equal(sliceType(Buffer.from([0x41])), null, 'a slice with no header bits');
  assert.equal(isBSlice(null), false);
});

test('one scan of a unit returns its parameter sets and whether it carries a B slice', () => {
  const sps = spsNal();
  const pps = Buffer.from('68ce01', 'hex');
  const idr = scanUnit(annexB(sps, pps, sliceNal(7)));
  assert.equal(idr.bSlice, false);
  assert.deepEqual(idr.sps, sps);
  assert.deepEqual(idr.pps, pps);
  assert.equal(scanUnit(annexB(sliceNal(5), sliceNal(6))).bSlice, true);
  assert.deepEqual(Object.keys(parameterSets(annexB(sps, pps, sliceNal(1)))), ['sps', 'pps']);
});
