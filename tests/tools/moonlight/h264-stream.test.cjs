const test = require('node:test');
const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const {once} = require('node:events');
const {AccessUnits, parameterSets} = require('../../../host/stream/h264-stream.js');

const metadata = (seq, bytes, fields = {}) => ({
  type: 'au',
  seq,
  frame: seq + 1,
  bytes,
  pts: seq * 16667,
  keyframe: seq === 0,
  ...fields
});

test(
  'raw data is drained before post-payload metadata, including access units larger than a pipe',
  {timeout: 3000},
  async () => {
    const pipe = new PassThrough({highWaterMark: 4096});
    const reader = new AccessUnits(pipe);
    const bytes = Buffer.alloc(1024 * 1024, 0x65);
    const writing = (async () => {
      for (let offset = 0; offset < bytes.length; offset += 4096)
        if (!pipe.write(bytes.subarray(offset, offset + 4096))) await once(pipe, 'drain');
      reader.announce(metadata(0, bytes.length));
      pipe.end();
      reader.endMetadata();
    })();
    const unit = await reader.next();
    assert.deepEqual(unit.value.data, bytes);
    assert.equal(unit.value.keyframe, true);
    assert.equal((await reader.next()).done, true);
    await writing;
    reader.close();
  }
);

test('coalesced and split pipe writes preserve access-unit boundaries and timestamps', async () => {
  const pipe = new PassThrough();
  const reader = new AccessUnits(pipe);
  reader.announce(metadata(0, 3));
  reader.announce(metadata(1, 4, {pts: 123456789}));
  pipe.write(Buffer.from([1]));
  pipe.write(Buffer.from([2, 3, 4, 5]));
  pipe.end(Buffer.from([6, 7]));
  reader.endMetadata();
  const units = [];
  for await (const unit of reader) units.push(unit);
  assert.deepEqual(
    units.map(unit => [...unit.data]),
    [
      [1, 2, 3],
      [4, 5, 6, 7]
    ]
  );
  assert.equal(units[1].pts, 123456789);
  assert.equal(units[1].keyframe, false);
  reader.close();
});

test('a bounded queue pauses the producer and resumes as ordered frames are consumed', async () => {
  const pipe = new PassThrough();
  const reader = new AccessUnits(pipe, {maxQueuedUnits: 1});
  for (let seq = 0; seq < 3; seq++) reader.announce(metadata(seq, 1));
  pipe.end(Buffer.from([10, 20, 30]));
  reader.endMetadata();
  assert.equal(pipe.isPaused(), true);
  const values = [];
  for await (const unit of reader) values.push(unit.data[0]);
  assert.deepEqual(values, [10, 20, 30]);
  reader.close();
});

test('binary EOF before the final metadata does not discard the last access unit', async () => {
  const pipe = new PassThrough();
  const reader = new AccessUnits(pipe);
  pipe.end(Buffer.from([1, 2, 3]));
  await once(pipe, 'end');
  reader.announce(metadata(0, 3));
  reader.endMetadata();
  assert.deepEqual([...(await reader.next()).value.data], [1, 2, 3]);
  assert.equal((await reader.next()).done, true);
  reader.close();
});

test('realtime overflow drains the pipe and resumes only at an independent frame', async () => {
  const pipe = new PassThrough();
  let requests = 0;
  const reader = new AccessUnits(pipe, {maxQueuedUnits: 2, onBacklog: () => requests++});
  for (let seq = 0; seq < 7; seq++) {
    pipe.write(Buffer.from([seq]));
    reader.announce(metadata(seq, 1, {keyframe: seq === 0 || seq === 5}));
  }
  assert.equal(pipe.isPaused(), false);
  assert.equal(reader.dropped, 5);
  assert.equal(requests, 3);
  pipe.end();
  reader.endMetadata();
  const units = [];
  for await (const unit of reader) units.push(unit);
  assert.deepEqual(
    units.map(unit => unit.seq),
    [5, 6]
  );
  assert.equal(units[0].keyframe, true);
  reader.close();
});

test('truncated units, invalid metadata and sequence gaps fail instead of shifting later frames', async () => {
  for (const run of [
    (reader, pipe) => {
      reader.announce(metadata(0, 4));
      pipe.end(Buffer.alloc(3));
      reader.endMetadata();
    },
    reader => reader.announce(metadata(0, -1)),
    reader => {
      reader.announce(metadata(0, 1));
      reader.announce(metadata(2, 1));
    }
  ]) {
    const pipe = new PassThrough();
    const reader = new AccessUnits(pipe);
    run(reader, pipe);
    await assert.rejects(reader.next(), /Truncated|Invalid|discontinuity/);
    reader.close();
  }
});

test('parameter sets contain bare NAL payloads for the native H.264 configuration helper', () => {
  const bytes = Buffer.from('000000016764001fac00000168ee3c800000000165deadbeef', 'hex');
  const sets = parameterSets(bytes);
  assert.equal(sets.sps.toString('hex'), '6764001fac');
  assert.equal(sets.pps.toString('hex'), '68ee3c80');
  assert.deepEqual(parameterSets(Buffer.from('00000165abcd', 'hex')), {});
});

test('units carry their arrival time only when the reader has a clock', async () => {
  let time = 40;
  const pipe = new PassThrough();
  const reader = new AccessUnits(pipe, {now: () => (time += 10)});
  reader.announce(metadata(0, 2));
  reader.announce(metadata(1, 2));
  pipe.end(Buffer.from([1, 2, 3, 4]));
  reader.endMetadata();
  const units = [];
  for await (const unit of reader) units.push(unit);
  assert.deepEqual(
    units.map(unit => unit.arrivedAt),
    [50, 60]
  );
  const plain = new PassThrough();
  const untimed = new AccessUnits(plain);
  untimed.announce(metadata(0, 1));
  plain.end(Buffer.from([1]));
  untimed.endMetadata();
  for await (const unit of untimed) assert.equal('arrivedAt' in unit, false);
});
