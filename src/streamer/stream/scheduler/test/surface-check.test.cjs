const test = require('node:test');
const assert = require('node:assert/strict');

let surfaceCheck;
test.before(async () => {
  surfaceCheck = await import('../surface-check.js');
});

const frame = {width: 1920, height: 1080, stride: 2048};

/** A checker over three fake surfaces whose bytes the test sets. */
function checker(every) {
  const memory = [0, 1, 2].map(() => Buffer.alloc(frame.stride * frame.height));
  const reads = [];
  const check = surfaceCheck.create({
    every,
    read: async (index, offset, bytes) => {
      reads.push({index, offset, bytes});
      return memory[index].subarray(offset, offset + bytes);
    }
  });
  check.start(frame);
  return {check, memory, reads};
}

test('the sample is the middle of the last luma row', () => {
  assert.deepEqual(surfaceCheck.sampleSpan(frame), {offset: 1079 * 2048 + 704, bytes: 512});
  assert.deepEqual(surfaceCheck.sampleSpan({width: 256, height: 2, stride: 256}), {
    offset: 256,
    bytes: 256
  });
  assert.equal(surfaceCheck.hash(Buffer.alloc(0)), '811c9dc5');
  assert.notEqual(surfaceCheck.hash(Buffer.from([1])), surfaceCheck.hash(Buffer.from([2])));
});

test('every Kth published surface is read once and re-read on reuse', async () => {
  const {check, memory, reads} = checker(2);
  memory[1].fill(7);
  await check.first(1, {index: 0});
  await check.first(2, {index: 1});
  await check.first(4, {index: 2, skip: true});
  await check.first(6, undefined);
  assert.equal(reads.length, 1);
  await check.reuse({index: 0});
  await check.reuse(null);
  assert.equal(reads.length, 1);
  await check.reuse({index: 1});
  const [sample] = check.take();
  assert.deepEqual(sample, {
    seq: 2,
    surface: 1,
    hash: sample.hash,
    reread: sample.hash,
    torn: false
  });
  assert.deepEqual(check.take(), []);
  assert.deepEqual(check.counts, {
    every: 2,
    sampled: 1,
    rereads: 1,
    torn: 0,
    pending: 0,
    offset: 1079 * 2048 + 704,
    bytes: 512
  });
});

test('a surface that changes before its reuse counts as torn', async () => {
  const {check, memory} = checker(1);
  await check.first(1, {index: 2});
  await check.first(2, {index: 0});
  memory[2].fill(1, frame.stride * (frame.height - 1));
  await check.reuse({index: 2});
  const [sample] = check.take();
  assert.equal(sample.torn, true);
  assert.notEqual(sample.reread, sample.hash);
  assert.equal(check.counts.torn, 1);
  assert.equal(check.counts.pending, 1);
});
