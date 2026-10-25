const {allocate} = require('../../../hbl-platform/sdk/native/allocate.cjs');
const {verify} = require('../../../hbl-platform/sdk/native/symbols.cjs');
const {SENTINEL} = require('../../../hbl-platform/smilebasic/engine/shared/frames.cjs');
const {
  verifyCode,
  verifyCopy,
  verifyPreamble,
  spawn,
  wait,
  join
} = require('../../../hbl-platform/sdk/native/thread.cjs');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');
const acquireFrame = require('./paired-acquire-frame.cjs');
const outputFrame = require('../../../hbl-moonlight/tools/moonlight/paired-output-frame.cjs');
const ring = require('../../../hbl-moonlight/tools/moonlight/ring.cjs');

const WORKER_BYTES = 0x400000;
const FRAME_OFFSET = 0x10000;
const CONTROL_BYTES = 0x1000;
const ACQUIRED_FIRST = 0x100;
const ACQUIRED_SECOND = 0x140;
const METADATA_FIRST = 0x200;
const METADATA_SECOND = 0x240;
const SHORT = 2;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = value => Number(BigInt.asUintN(32, value));

function resultsFor(program, bytes) {
  return program.proof.logicalResultIndices.map(index => bytes.readBigUInt64LE(index * 8));
}

async function create({
  rpc,
  functions,
  decoder,
  output,
  format,
  event,
  publication,
  timeoutMs = 5000
}) {
  if (
    !Number.isSafeInteger(event) ||
    event <= 0 ||
    !Number.isSafeInteger(decoder) ||
    decoder <= 0 ||
    !Number.isSafeInteger(output) ||
    output <= 0 ||
    !Number.isSafeInteger(format) ||
    format <= 0 ||
    ['acquireOutput', 'bufferSetData', 'getOutput', 'releaseOutput'].some(
      name => !Number.isSafeInteger(functions?.[name]) || functions[name] <= 0
    ) ||
    !Number.isSafeInteger(publication?.mapped) ||
    publication.mapped <= 0 ||
    ![1, 2].includes(publication.color) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  )
    throw Error('Paired output worker needs a qualified decoder event and native ring');
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verifyPreamble(rpc);
  for (const name of ['waitEvent', 'signalEvent'])
    await verify(rpc, rpc.a.sdk + SYNC[name].offset, SYNC[name].hex);
  const base = await allocate(rpc, WORKER_BYTES, {
    failed: 'Paired output worker allocation failed',
    invalid: 'Invalid paired output worker allocation'
  });
  const control = await allocate(rpc, CONTROL_BYTES, {
    failed: 'Paired output control allocation failed',
    invalid: 'Invalid paired output control allocation'
  });
  const slots = [control + ACQUIRED_FIRST, control + ACQUIRED_SECOND];
  const metadataSlots = [control + METADATA_FIRST, control + METADATA_SECOND];
  let active = null;
  let acquired = null;
  let fetched = [false, false];
  let retained = false;

  async function start(kind, program) {
    if (active || retained) throw Error('Paired output worker is busy or retained');
    await rpc.write(base + FRAME_OFFSET, program.frame);
    try {
      const thread = await spawn(rpc, base, base + FRAME_OFFSET, {
        failed: `Paired output ${kind} worker creation failed`,
        outputBytes: SHORT
      });
      active = {kind, program, thread};
    } catch (error) {
      retained = true;
      throw error;
    }
  }

  async function resultBytes(program) {
    return rpc.read(
      base + FRAME_OFFSET + program.proof.resultOffsets[0],
      program.proof.resultOffsets.length * 8
    );
  }

  async function finish() {
    if (!active) throw Error('Paired output worker is not running');
    const {kind, program, thread} = active;
    try {
      const done = await wait(rpc, thread, {
        timeoutMs,
        pollMs: 25,
        invalid: `Paired output ${kind} worker state invalid`,
        outputBytes: SHORT
      });
      if (!done) throw Error(`Paired output ${kind} timed out; restart SmileBASIC`);
      await join(rpc, thread, base + 8, {
        failed: `Paired output ${kind} join failed`,
        outputBytes: SHORT
      });
      const bytes = await resultBytes(program);
      active = null;
      if (
        Array.from({length: bytes.length / 8}, (_, index) => index).some(
          index => bytes.readBigUInt64LE(index * 8) === SENTINEL
        )
      )
        throw Error(`Paired output ${kind} skipped a native call`);
      return bytes;
    } catch (error) {
      retained = true;
      throw error;
    }
  }

  async function readSlots() {
    const data = await rpc.read(control + ACQUIRED_FIRST, 0x60);
    return Buffer.concat([data.subarray(0, 32), data.subarray(0x40, 0x60)]);
  }

  async function releaseHeld() {
    if (!acquired || active || retained) return;
    for (let index = 0; index < 2; index++) {
      if (fetched[index] || acquired[index]?.index < 0) continue;
      const {result} = await rpc.callAddress(
        functions.releaseOutput,
        [decoder, acquired[index].index, 0, 0],
        SHORT
      );
      if (status(result) !== 0) {
        retained = true;
        throw Error(`Paired output ${index} release during stop failed`);
      }
      fetched[index] = true;
    }
  }

  async function waitForPresentation(destination) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const state = await rpc.read(publication.mapped + ring.CONTROL.current, 24);
      if (
        state.readUInt32LE(20) === destination.sequence &&
        state.readUInt32LE(0) === destination.index
      )
        return;
      await pause(5);
    }
    retained = true;
    throw Error('Paired output publication was not applied; restart SmileBASIC');
  }

  return {
    async startAcquire() {
      if (active || retained) throw Error('Paired output acquisition is unavailable');
      if (acquired && fetched.every(Boolean)) acquired = null;
      if (acquired) throw Error('Paired output acquisition is unavailable');
      await rpc.write(control + ACQUIRED_FIRST, Buffer.alloc(0x60, 0xff));
      const plan = acquireFrame.plan({
        sdk: rpc.a.sdk,
        acquireOutput: functions.acquireOutput,
        decoder,
        event,
        slots,
        base: base + FRAME_OFFSET
      });
      await start('acquire', plan.program);
      return plan;
    },

    async finishAcquire(plan, expectedPts) {
      if (active?.kind !== 'acquire' || !plan)
        throw Error('Paired output acquire worker is not running');
      const results = await finish();
      const saved = await readSlots();
      try {
        acquired = acquireFrame.checkedAcquisitions(plan, results, saved, expectedPts);
      } catch (error) {
        const logical = resultsFor(plan.program, results);
        acquired = plan.rows.map(row => ({
          index: status(logical[row.acquire]) === 0 ? saved.readInt32LE(row.index * 32) : -1
        }));
        await releaseHeld();
        acquired = null;
        throw error;
      }
      fetched = [false, false];
      return acquired;
    },

    async fetch(index, destinations, frame) {
      if (!acquired || ![0, 1].includes(index) || fetched[index] || active || retained)
        throw Error('Paired output fetch is unavailable');
      if (index === 1 && !fetched[0]) throw Error('Paired output must publish in PTS order');
      const plan = outputFrame.plan({
        sdk: rpc.a.sdk,
        functions,
        decoder,
        output,
        format,
        publication,
        acquired,
        acquiredSlots: slots,
        metadataSlots,
        destinations,
        frame,
        base: base + FRAME_OFFSET,
        index
      });
      await rpc.write(metadataSlots[index], plan.metadataBytes[index]);
      await start('fetch', plan.program);
      const results = resultsFor(plan.program, await finish());
      const row = plan.rows[0];
      if (status(results[row.fetch]) !== 0 || status(results[row.release]) !== 0) {
        retained = true;
        throw Error(`Paired output ${index} fetch or release failed`);
      }
      fetched[index] = true;
      if (
        results[row.metadata] !== BigInt(publication.mapped + ring.CONTROL.nativeIndex) ||
        results[row.commit] !== BigInt(publication.mapped + ring.CONTROL.nativeSequence)
      ) {
        retained = true;
        throw Error(`Paired output ${index} publication copy failed`);
      }
      await waitForPresentation(destinations[index]);
      return {index, pts: acquired[index].pts, sequence: destinations[index].sequence};
    },

    async stop() {
      if (retained) throw Error('Paired output native objects retained for safety');
      if (active?.kind === 'acquire') {
        const {program} = active;
        const first = program.proof.logicalResultIndices[1];
        const current = await resultBytes(program);
        if (current.readBigUInt64LE(first * 8) === SENTINEL) {
          await rpc.callAddress(rpc.a.sdk + SYNC.signalEvent.offset, [event], SHORT);
          const until = Date.now() + timeoutMs;
          while (Date.now() < until) {
            const bytes = await resultBytes(program);
            if (bytes.readBigUInt64LE(first * 8) !== SENTINEL) break;
            await pause(25);
          }
        }
        await rpc.callAddress(rpc.a.sdk + SYNC.signalEvent.offset, [event], SHORT);
        const results = await finish();
        const saved = await readSlots();
        const logical = resultsFor(program, results);
        acquired = [0, 1].map(index => ({
          index: status(logical[index * 2 + 1]) === 0 ? saved.readInt32LE(index * 32) : -1
        }));
      } else if (active) {
        retained = true;
        throw Error('Paired output fetch state is uncertain; restart SmileBASIC');
      }
      await releaseHeld();
      acquired = null;
    },

    async snapshot() {
      if (!active) return null;
      const results = await resultBytes(active.program);
      const outputSlots = await readSlots();
      const pendingNative = Array.from({length: results.length / 8}, (_, index) => index).find(
        index => results.readBigUInt64LE(index * 8) === SENTINEL
      );
      return {
        kind: active.kind,
        pendingNative: pendingNative ?? null,
        results: results.toString('hex'),
        outputSlots: outputSlots.toString('hex')
      };
    },

    get diagnostics() {
      return {retained, active: active?.kind ?? null, acquired, fetched};
    }
  };
}

module.exports = {create, resultsFor};
