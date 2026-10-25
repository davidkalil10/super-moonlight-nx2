const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {main, STAGES, loggedRpc} = require('../tools/probe-persistent-first-job.cjs');

test('journal marks a lost bridge before any cleanup request', async () => {
  const rows = [];
  const rpc = loggedRpc(
    {
      async callAddress() {
        throw Error('Console disconnected');
      }
    },
    {write: row => rows.push(row)}
  );
  await assert.rejects(rpc.callAddress(123, []), /Console disconnected/);
  assert.equal(rpc.bridgeLost, true);
  assert.deepEqual(
    rows.map(row => row.phase),
    ['before', 'error']
  );
});

test('fetch job matches the surface passed to host-driven GetOutput', async () => {
  const rows = [];
  let signalled = false;
  const rpc = loggedRpc(
    {
      async pair() {
        return {results: [0n, 0n]};
      },
      async writeAndCall() {
        signalled = true;
      }
    },
    {write: row => rows.push(row)}
  );
  await rpc.pair([
    {address: 1, args: [10, 0x72000000, 0x400000, 0]},
    {address: 2, args: [20, 0, 10, 30]}
  ]);
  const job = Buffer.alloc(16);
  job.writeBigUInt64LE(0x72000000n);
  job.writeBigUInt64LE(0x400000n, 8);
  await rpc.writeAndCall(100, job, 3, [4]);
  assert.equal(signalled, true);
  assert.equal(rows.find(row => row.fetchJob)?.surfaceMatch, true);
  job.writeBigUInt64LE(0x71000000n);
  await assert.rejects(rpc.writeAndCall(100, job, 3, [4]), /fetch job differs/);
  assert.equal(signalled, true);
  assert.equal(rows.filter(row => row.surfaceMatch === false).length, 1);
});

test('first-job probe journals each stage and closes the decoder', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hbl-first-job-'));
  const clip = path.join(directory, 'two-idr.h264');
  const unit = Buffer.from('0000016742001eab00000168ce0100000165abcd', 'hex');
  await fs.writeFile(clip, Buffer.concat([unit, unit]));
  const calls = [];
  try {
    const result = await main(directory, {
      clip,
      stage: 'send',
      output: path.join(directory, 'output'),
      sourceRevision: 'test-revision',
      sessionRpc: {a: {session: 'test-session'}},
      allocateSurface: async (_, bytes) => {
        assert.equal(bytes, 20480);
        return 0x70000000;
      },
      async create(options) {
        assert.equal(options.workerMode, 'persistent');
        return {
          async configure() {
            calls.push('configure');
            return {width: 128, height: 96};
          },
          async submit(unit) {
            calls.push('submit:' + unit.pts);
          },
          async receive() {
            calls.push('receive');
            return {pts: '0'};
          },
          async startPersistent(options) {
            calls.push('start:' + options.stage);
          },
          async processPersistent(unit) {
            calls.push('process:' + unit.pts);
            return {
              probe: {
                stage: 'send',
                sendStatus: 0,
                acquireStatus: 0,
                outputIndex: -1,
                completedSequence: 0
              }
            };
          },
          async close() {
            calls.push('close');
          }
        };
      }
    });
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(calls, [
      'configure',
      'submit:0',
      'receive',
      'start:send',
      'process:1',
      'close'
    ]);
    const journal = (await fs.readFile(path.join(directory, 'output', 'first-job.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      journal.filter(row => row.step === 'worker job').map(row => row.phase),
      ['before', 'after']
    );
    assert.equal(journal.at(-1).step, 'decoder close');
    assert.deepEqual(STAGES, [
      'gate',
      'dispatch',
      'send',
      'wait',
      'acquire',
      'setData',
      'getOutput',
      'release',
      'input',
      'done',
      'restore',
      'fetch'
    ]);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('fetch probe checks two jobs on one worker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hbl-two-jobs-'));
  const clip = path.join(directory, 'three-idr.h264');
  const unit = Buffer.from('0000016742001eab00000168ce0100000165abcd', 'hex');
  await fs.writeFile(clip, Buffer.concat([unit, unit, unit]));
  const calls = [];
  try {
    const record = await main(directory, {
      clip,
      stage: 'fetch',
      jobs: 2,
      output: path.join(directory, 'output'),
      sourceRevision: 'test-revision',
      sessionRpc: {a: {session: 'test-session'}},
      allocateSurface: async () => 0x70000000,
      async create() {
        return {
          async configure() {
            return {width: 128, height: 96};
          },
          async submit() {},
          async receive() {
            return {pts: '0'};
          },
          async startPersistent({stage}) {
            assert.equal(stage, null);
          },
          async processPersistent(unit) {
            calls.push(unit.pts);
            return {pts: String(unit.pts)};
          },
          async close() {}
        };
      }
    });
    assert.equal(record.verdict, 'PASS');
    assert.deepEqual(calls, [1, 2]);
    assert.deepEqual(record.result, [{pts: '1'}, {pts: '2'}]);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});
