const {allocate} = require('../../../hbl-platform/sdk/native/allocate.cjs');
const {verify} = require('../../../hbl-platform/sdk/native/symbols.cjs');
const {SENTINEL} = require('../../../hbl-platform/smilebasic/engine/shared/frames.cjs');
const {
  CODE,
  verifyCode,
  verifyCopy,
  verifyPreamble,
  spawn,
  wait,
  join
} = require('../../../hbl-platform/sdk/native/thread.cjs');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');
const {metadata} = require('./paired-output-frame.cjs');
const loop = require('./paired-loop-plan.cjs');
const ring = require('./ring.cjs');

const SHORT = 2;
const AUTO_CLEAR = 1;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const status = value => Number(BigInt.asUintN(32, value));

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
    !Number.isSafeInteger(publication?.mapped) ||
    publication.mapped <= 0 ||
    ![1, 2].includes(publication.color) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  )
    throw Error('Paired loop needs a qualified output event and native publication ring');
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verifyPreamble(rpc);
  for (const name of [
    'initializeLightEvent',
    'finalizeLightEvent',
    'waitLightEvent',
    'signalLightEvent',
    'waitEvent',
    'signalEvent'
  ])
    await verify(rpc, rpc.a.sdk + SYNC[name].offset, SYNC[name].hex);
  const base = await allocate(rpc, 0x400000, {
    failed: 'Paired loop worker allocation failed',
    invalid: 'Invalid paired loop worker allocation'
  });
  const control = await allocate(rpc, 0x1000, {
    failed: 'Paired loop control allocation failed',
    invalid: 'Invalid paired loop control allocation'
  });
  const built = loop.plan({
    sdk: rpc.a.sdk,
    base,
    control,
    event,
    functions,
    decoder,
    output,
    format,
    publication
  });
  const at = offset => control + offset;
  const c = loop.CONTROL;
  const signal = name =>
    rpc.callAddress(rpc.a.sdk + SYNC.signalLightEvent.offset, [at(c[name])], SHORT);
  const initialized = [];
  for (const offset of [c.startGate, c.fetchGate, c.secondGate]) {
    await rpc.callAddress(
      rpc.a.sdk + SYNC.initializeLightEvent.offset,
      [at(offset), 0, AUTO_CLEAR, 0],
      SHORT
    );
    initialized.push(offset);
  }
  const frames = [
    ['gate', 'gateSnapshot'],
    ['acquire', 'acquireSnapshot'],
    ['singleAcquire', 'singleAcquireSnapshot'],
    ['first', 'firstSnapshot'],
    ['second', 'secondSnapshot'],
    ['singleFirst', 'singleFirstSnapshot']
  ];
  for (const [name, snapshot] of frames) {
    await rpc.write(built.locations[name], built[name].frame);
    await rpc.write(built.locations[snapshot], built[name].frame);
    if (
      !(await rpc.read(built.locations[snapshot], built[name].frame.length)).equals(
        built[name].frame
      )
    )
      throw Error(`Paired loop ${name} snapshot readback differs`);
  }
  await rpc.write(built.locations.exit, built.stop);
  const dispatch = Buffer.alloc(32);
  [
    built.locations.acquire,
    built.locations.first,
    built.locations.second,
    built.locations.gate
  ].forEach((address, index) => dispatch.writeBigUInt64LE(BigInt(address), index * 8));
  await rpc.write(at(c.dispatch[0]), dispatch);
  let thread = null;
  let joined = false;
  let retained = false;
  let closed = false;
  let stopping = false;
  let selectedCount = 2;
  let active = null;

  async function pollSequence(offset, sequence, bytes) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !stopping) {
      const value = await rpc.read(at(offset), bytes);
      if (value.readUInt32LE(bytes - 4) === sequence) return value;
      await pause(5);
    }
    if (stopping) throw Error('Paired loop stopped while waiting for output');
    retained = true;
    throw Error('Paired loop worker timed out; restart SmileBASIC');
  }

  async function waitForPresentation(destination) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !stopping) {
      const state = await rpc.read(publication.mapped + ring.CONTROL.current, 24);
      if (
        state.readUInt32LE(0) === destination.index &&
        state.readUInt32LE(20) === destination.sequence
      )
        return;
      await pause(5);
    }
    if (stopping) throw Error('Paired loop stopped while waiting for presentation');
    retained = true;
    throw Error('Paired loop publication was not applied; restart SmileBASIC');
  }

  function descriptor(destination, frame) {
    if (
      destination.address !== publication.mapped + ring.frameOffset(destination.index) ||
      destination.color !== publication.color
    )
      throw Error('Paired loop destination differs from the native ring');
    const bytes = Buffer.alloc(48);
    bytes.writeBigUInt64LE(BigInt(destination.address), 0);
    bytes.writeBigUInt64LE(BigInt(destination.bytes), 8);
    metadata(destination, frame).copy(bytes, 16);
    return bytes;
  }

  async function releaseHeld() {
    if (!active) return;
    const slots = await rpc.read(at(c.acquired[0]), c.acquired[1] - c.acquired[0] + 32);
    const results = await rpc.read(at(c.acquireResults), 0x80);
    for (let index = 0; index < active.count; index++) {
      const outputIndex = slots.readInt32LE(index * 0x40);
      const acquiredStatus = status(results.readBigUInt64LE(index * 8));
      const fetchOffset = (index ? c.secondResults : c.firstResults) - c.acquireResults;
      const fetchedSequence = results.readUInt32LE(fetchOffset + 24);
      const releasedStatus = status(results.readBigUInt64LE(fetchOffset + 16));
      if (
        acquiredStatus !== 0 ||
        outputIndex < 0 ||
        (fetchedSequence === active.sequence && releasedStatus === 0)
      )
        continue;
      const {result} = await rpc.callAddress(
        functions.releaseOutput,
        [decoder, outputIndex, 0, 0],
        SHORT
      );
      if (status(result) !== 0) {
        retained = true;
        throw Error(`Paired loop held output ${index} release failed`);
      }
    }
  }

  return {
    async start() {
      if (thread || retained || closed || stopping)
        throw Error('Paired loop worker already started or retained');
      try {
        thread = await spawn(rpc, base, built.locations.gate, {
          failed: 'Paired loop worker creation failed',
          outputBytes: SHORT
        });
      } catch (error) {
        retained = true;
        throw error;
      }
    },

    async beginPair(sequence, count = 2) {
      if (
        !thread ||
        joined ||
        active ||
        retained ||
        stopping ||
        ![1, 2].includes(count) ||
        !Number.isInteger(sequence) ||
        sequence < 1 ||
        sequence > 0xffffffff
      )
        throw Error('Paired loop cannot start another pair');
      const reset = Buffer.alloc(0x280, 0xff);
      for (const offset of [
        c.acquireResults,
        c.acquireResults + 8,
        c.firstResults,
        c.firstResults + 8,
        c.firstResults + 16,
        c.secondResults,
        c.secondResults + 8,
        c.secondResults + 16
      ])
        reset.writeBigUInt64LE(SENTINEL, offset - c.acquired[0]);
      await rpc.write(at(c.acquired[0]), reset);
      const job = Buffer.alloc(4);
      job.writeUInt32LE(sequence);
      active = {sequence, count, acquired: null, destinations: null, firstDone: false};
      try {
        if (count !== selectedCount) {
          const selectors = Buffer.alloc(16);
          selectors.writeBigUInt64LE(
            BigInt(built.locations[count === 1 ? 'singleAcquire' : 'acquire']),
            0
          );
          selectors.writeBigUInt64LE(
            BigInt(built.locations[count === 1 ? 'singleFirst' : 'first']),
            8
          );
          await rpc.write(at(c.dispatch[0]), selectors);
          selectedCount = count;
        }
        await rpc.writeAndCall(at(c.job), job, rpc.a.sdk + SYNC.signalLightEvent.offset, [
          at(c.startGate)
        ]);
      } catch (error) {
        retained = true;
        throw error;
      }
    },

    async acquire(expectedPts) {
      if (!active || active.acquired || retained) throw Error('Paired loop acquire unavailable');
      if (
        !Array.isArray(expectedPts) ||
        expectedPts.length !== active.count ||
        expectedPts.some(pts => typeof pts !== 'bigint' || pts < 0n) ||
        (active.count === 2 && expectedPts[1] <= expectedPts[0])
      )
        throw Error('Paired loop needs ordered output PTS values');
      const offset = c.acquired[0];
      const bytes = c.acquireResults + 20 - offset;
      const state = await pollSequence(offset, active.sequence, bytes);
      const resultAt = c.acquireResults - offset;
      const acquired = [];
      for (let index = 0; index < active.count; index++) {
        const slot = (c.acquired[index] - offset);
        const value = state.readBigUInt64LE(resultAt + index * 8);
        const outputIndex = state.readInt32LE(slot);
        const pts = state.readBigUInt64LE(slot + 8);
        if (value === SENTINEL || status(value) !== 0 || outputIndex < 0 || pts !== expectedPts[index])
          throw Error(`Paired loop output ${index} acquisition failed or PTS differs`);
        acquired.push({index: outputIndex, pts});
      }
      if (active.count === 2 && acquired[0].index === acquired[1].index)
        throw Error('Paired loop acquired the same output index twice');
      active.acquired = acquired;
      return acquired;
    },

    async openFetch(destinations, frame) {
      if (!active?.acquired || active.destinations || retained)
        throw Error('Paired loop fetch gate is unavailable');
      if (
        !Array.isArray(destinations) ||
        destinations.length !== active.count ||
        (active.count === 2 &&
          (destinations[0].index === destinations[1].index ||
            destinations[1].sequence !== destinations[0].sequence + 1))
      )
        throw Error('Paired loop needs distinct ordered surfaces');
      const data = Buffer.alloc(
        active.count === 2 ? c.destinations[1] - c.destinations[0] + 48 : 48
      );
      destinations.forEach((destination, index) =>
        descriptor(destination, frame).copy(data, c.destinations[index] - c.destinations[0])
      );
      active.destinations = destinations;
      try {
        await rpc.writeAndCall(
          at(c.destinations[0]),
          data,
          rpc.a.sdk + SYNC.signalLightEvent.offset,
          [at(c.fetchGate)]
        );
      } catch (error) {
        retained = true;
        throw error;
      }
    },

    async finishFirst() {
      if (!active?.destinations || active.firstDone || retained)
        throw Error('Paired loop first output is unavailable');
      const results = await pollSequence(c.firstResults, active.sequence, 28);
      if ([0, 8, 16].some(offset => status(results.readBigUInt64LE(offset)) !== 0)) {
        retained = true;
        throw Error('Paired loop first fetch or release failed');
      }
      await waitForPresentation(active.destinations[0]);
      const completed = {pts: active.acquired[0].pts, sequence: active.destinations[0].sequence};
      if (active.count === 1) active = null;
      else active.firstDone = true;
      return completed;
    },

    async finishSecond() {
      if (!active?.firstDone || active.count !== 2 || retained)
        throw Error('Paired loop second output unavailable');
      try {
        await signal('secondGate');
      } catch (error) {
        retained = true;
        throw error;
      }
      const results = await pollSequence(c.secondResults, active.sequence, 28);
      if ([0, 8, 16].some(offset => status(results.readBigUInt64LE(offset)) !== 0)) {
        retained = true;
        throw Error('Paired loop second fetch or release failed');
      }
      await waitForPresentation(active.destinations[1]);
      const completed = {pts: active.acquired[1].pts, sequence: active.destinations[1].sequence};
      active = null;
      return completed;
    },

    async stop() {
      if (retained) throw Error('Paired loop native objects retained for safety');
      if (closed) return;
      stopping = true;
      if (thread && !joined) {
        const redirects = Buffer.alloc(32);
        for (let index = 0; index < 4; index++)
          redirects.writeBigUInt64LE(BigInt(built.locations.exit), index * 8);
        await rpc.write(at(c.dispatch[0]), redirects);
        await signal('startGate');
        await signal('fetchGate');
        await signal('secondGate');
        if (active && !active.acquired) {
          const until = Date.now() + timeoutMs;
          for (let index = 0; index < active.count; index++) {
            while (Date.now() < until) {
              const current = await rpc.read(at(c.acquireResults + index * 8), 8);
              if (current.readBigUInt64LE() !== SENTINEL) break;
              const state = (
                await rpc.callAddress(rpc.a.sdk + CODE.tryWait.offset, [thread], SHORT)
              ).result;
              if (state === 1n) break;
              if (state !== 0n) {
                retained = true;
                throw Error('Paired loop thread state invalid during stop');
              }
              await rpc.callAddress(rpc.a.sdk + SYNC.signalEvent.offset, [event], SHORT);
              await pause(25);
            }
          }
        }
        const done = await wait(rpc, thread, {
          timeoutMs,
          pollMs: 25,
          invalid: 'Paired loop thread state invalid',
          outputBytes: SHORT
        });
        if (!done) {
          retained = true;
          throw Error('Paired loop worker did not stop; restart SmileBASIC');
        }
        await join(rpc, thread, base + 8, {
          failed: 'Paired loop worker join failed',
          outputBytes: SHORT
        });
        joined = true;
        await releaseHeld();
        active = null;
      }
      for (const offset of initialized.reverse())
        await rpc.callAddress(rpc.a.sdk + SYNC.finalizeLightEvent.offset, [at(offset)], SHORT);
      initialized.length = 0;
      closed = true;
    },

    async snapshot() {
      return {
        active: active?.sequence ?? null,
        retained,
        joined,
        acquiredSlots: (await rpc.read(at(c.acquired[0]), 0x60)).toString('hex'),
        results: (await rpc.read(at(c.acquireResults), 0x80)).toString('hex'),
        dispatch: (await rpc.read(at(c.dispatch[0]), 32)).toString('hex')
      };
    },

    get diagnostics() {
      return {retained, active: active?.sequence ?? null, joined};
    }
  };
}

module.exports = {create};
