const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ring = require('../../tools/moonlight/ring.cjs');
const {main, verifyPublication} = require('../tools/probe-split-decoder.cjs');

async function fixture(stage) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hbl-split-probe-'));
  const clip = path.join(directory, 'idr.h264');
  const accessUnit = Buffer.from('0000016742001eab00000168ce0100000165abcd', 'hex');
  await fs.writeFile(clip, Buffer.concat([accessUnit, accessUnit, accessUnit]));
  const calls = [];
  let sequence = 0;
  let receiveLength = 0;
  const result = await main(directory, {
    clip,
    stage,
    output: path.join(directory, 'record'),
    sourceRevision: 'test-revision',
    sessionRpc: {a: {session: 'test-session'}, host: '127.0.0.1'},
    allocateSurface: async () => 0x73000000,
    openTransport: async () => ({
      fd: 12,
      maxAccessUnit: 0x100000,
      recvFunction: 0x40000000,
      async send(bytes) {
        calls.push('send:' + bytes.length);
      },
      abort() {
        calls.push('abort');
      },
      async close() {
        calls.push('transport-close');
      }
    }),
    async create({workerMode, transport}) {
      assert.equal(workerMode, 'split');
      return {
        splitDiagnostics: {decodeGateSignals: 0},
        async configure() {
          return {width: 128, height: 96};
        },
        async submit() {
          calls.push('host-submit');
        },
        async receive() {
          calls.push('host-receive');
          return {pts: '0'};
        },
        async startSplit() {
          calls.push('start');
        },
        async stageSplitInput(unit) {
          calls.push('stage:' + unit.pts);
          receiveLength = unit.receiveLength;
        },
        async completeSplitInput(payload) {
          assert.equal(payload.length, receiveLength);
          await transport.send(payload);
          throw Error(
            `Native TCP receive returned ${payload.length}/${payload.length * 2} bytes and sequence 1/1`
          );
        },
        async submitSplit(unit) {
          calls.push('input:' + unit.pts);
          return {sequence: ++sequence, pts: BigInt(unit.pts)};
        },
        async queueSplitOutput(job) {
          calls.push('queue:' + job.sequence);
        },
        async finishSplitOutput(job) {
          calls.push('fetch:' + job.sequence);
          return {pts: job.pts.toString()};
        },
        async close() {
          calls.push('close');
          await transport.close();
        }
      };
    }
  });
  return {result, calls, directory};
}

test('two-job probe queues output before the next input and fetches in order', async () => {
  const {result, calls} = await fixture('two');
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(calls.slice(2, 8), [
    'start',
    'input:1',
    'queue:1',
    'input:2',
    'fetch:1',
    'queue:2'
  ]);
  assert.equal(calls.at(-2), 'close');
});

test('short receive probe accepts only a closed decode gate', async () => {
  const {result, calls} = await fixture('short-recv');
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.result.decodeGateSignals, 0);
  assert.ok(calls.some(call => call.startsWith('send:')));
  assert.equal(calls.includes('abort'), false);
  assert.equal(calls.at(-2), 'close');
});

test('publication readback requires matching metadata and sequence', async () => {
  const data = Buffer.alloc(32);
  const values = [7, 2, 1920, 1080, 1920, 1088, 1];
  values.push(ring.nativeChecksum(7, values.slice(1)));
  values.forEach((value, index) =>
    data.writeUInt32LE(value, index * 4)
  );
  const rpc = {read: async () => data};
  const destination = {sequence: 7, index: 2, color: 1};
  const frame = {width: 1920, height: 1080, stride: 1920, sliceHeight: 1088};
  assert.deepEqual(await verifyPublication(rpc, 0x30000000, destination, frame), {
    sequence: 7,
    index: 2,
    ...frame,
    color: 1,
    commit: values[7]
  });
  data.writeUInt32LE(1, 4);
  await assert.rejects(
    verifyPublication(rpc, 0x30000000, destination, frame),
    /publication differs/
  );
});
