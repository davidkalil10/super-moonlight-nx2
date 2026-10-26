/**
 * Lifecycle of the paired loop, the console thread that runs the frames of
 * paired-loop-plan.js.
 *
 * create() verifies the SDK code it relies on, allocates the worker and its control page,
 * initializes the three auto-clear light events, writes every frame next to its snapshot and
 * checks each snapshot back. A pass is then driven gate by gate: beginPair() clears the slots
 * and results to sentinels and opens the start gate with the job sequence, acquire() polls for
 * the acquire stamp and checks both outputs' status and PTS, openFetch() writes both
 * descriptors and opens the fetch gate, finishFirst() and finishSecond() wait for each
 * output's stamp and for the renderer to apply its publication.
 *
 * Stopping points every dispatch word at the exit frame, wakes all three gates and, if the
 * thread may still wait on the decoder output event, signals that event until each pending
 * acquisition lands or the thread exits. Outputs the thread acquired but never released are
 * released after the join. Whenever the thread may still be running, an output may still be
 * held or a gate write may have half landed, the native objects are retained: nothing is
 * finalized and SmileBASIC has to be restarted.
 */
import {allocate} from '../../../hbl-platform/sdk/native/allocate.js';
import {verify} from '../../../hbl-platform/sdk/native/symbols.js';
import {SENTINEL} from '../../../hbl-platform/smilebasic/engine/shared/frames.js';
import {
  CODE,
  verifyCode,
  verifyCopy,
  verifyPreamble,
  spawn,
  wait,
  join
} from '../../../hbl-platform/sdk/native/thread.js';
import SYNC from '../../../hbl-platform/sdk/native/os-sync-functions.json' with {type: 'json'};
import {metadata} from './paired-output-frame.js';
import * as loop from './paired-loop-plan.js';
import * as ring from './ring.js';

const c = loop.CONTROL;

/** Reply output bytes for native calls: too few to carry an output slot, only the result. */
const SHORT = 2;
const AUTO_CLEAR = 1;
const WORKER_BYTES = 0x400000;
const CONTROL_BYTES = 0x1000;
/** Where pthread_join stores the worker's exit value; spawn stores the thread at offset 0. */
const EXIT_SLOT_OFFSET = 8;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const POLL_MS = 5;
const STOP_POLL_MS = 25;
const MAX_SEQUENCE = 0xffffffff;
const ADDRESS_BYTES = 8;
const SEQUENCE_BYTES = 4;
/** tryWait's result once the thread has exited. */
const EXITED = 1n;

const SYNC_FUNCTIONS = [
  'initializeLightEvent',
  'finalizeLightEvent',
  'waitLightEvent',
  'signalLightEvent',
  'waitEvent',
  'signalEvent'
];
const GATES = [c.startGate, c.fetchGate, c.secondGate];
/** Each frame of the plan and the snapshot it is restored from. */
const FRAMES = [
  ['gate', 'gateSnapshot'],
  ['acquire', 'acquireSnapshot'],
  ['singleAcquire', 'singleAcquireSnapshot'],
  ['first', 'firstSnapshot'],
  ['second', 'secondSnapshot'],
  ['singleFirst', 'singleFirstSnapshot']
];
/** The dispatch targets, in dispatch word order: each stage jumps to the next. */
const DISPATCH_TARGETS = ['acquire', 'first', 'second', 'gate'];
const DISPATCH_BYTES = c.dispatch.length * ADDRESS_BYTES;

/**
 * A pass starts by filling the slots, descriptors and results with 0xff, so slot indices read
 * -1, and every native result word with SENTINEL.
 */
const RESET_BYTES = 0x280;
const RESULT_WORDS = [
  c.acquireResults + loop.ACQUIRE_RESULTS.status[0],
  c.acquireResults + loop.ACQUIRE_RESULTS.status[1],
  c.firstResults + loop.FETCH_RESULTS.set,
  c.firstResults + loop.FETCH_RESULTS.get,
  c.firstResults + loop.FETCH_RESULTS.release,
  c.secondResults + loop.FETCH_RESULTS.set,
  c.secondResults + loop.FETCH_RESULTS.get,
  c.secondResults + loop.FETCH_RESULTS.release
];
const FETCH_STATUSES = [loop.FETCH_RESULTS.set, loop.FETCH_RESULTS.get, loop.FETCH_RESULTS.release];
/** Both acquired slots, as read back for releases and snapshots. */
const SLOTS_BYTES = c.acquired[1] - c.acquired[0] + loop.SLOT.bytes;
/** The acquire, first and second results, as read back for releases and snapshots. */
const RESULTS_BYTES = 0x80;
/** The acquire poll reads both slots through the acquire stamp. */
const ACQUIRE_POLL_BYTES =
  c.acquireResults + loop.ACQUIRE_RESULTS.sequence + SEQUENCE_BYTES - c.acquired[0];
const FETCH_POLL_BYTES = loop.FETCH_RESULTS.sequence + SEQUENCE_BYTES;

/** The ring words a presentation check reads, from CONTROL.current through nativeApplied. */
const PRESENTATION = {
  index: 0,
  sequence: ring.CONTROL.nativeApplied - ring.CONTROL.current,
  bytes: ring.CONTROL.nativeApplied + SEQUENCE_BYTES - ring.CONTROL.current
};

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A native result's 32-bit status. */
const status = value => Number(BigInt.asUintN(32, value));

/** @returns {Buffer} */
function resetPass() {
  const reset = Buffer.alloc(RESET_BYTES, 0xff);
  for (const offset of RESULT_WORDS) reset.writeBigUInt64LE(SENTINEL, offset - c.acquired[0]);
  return reset;
}

/**
 * @param {number[]} addresses
 * @returns {Buffer}
 */
function addressWords(addresses) {
  const words = Buffer.alloc(addresses.length * ADDRESS_BYTES);
  addresses.forEach((address, index) =>
    words.writeBigUInt64LE(BigInt(address), index * ADDRESS_BYTES)
  );
  return words;
}

/**
 * @param {Buffer} results A fetch stage's results.
 * @returns {boolean}
 */
function fetchFailed(results) {
  return FETCH_STATUSES.some(offset => status(results.readBigUInt64LE(offset)) !== 0);
}

/**
 * Starts the paired loop's native objects and frames; the thread itself starts with start().
 * @param {object} options
 * @param {any} options.rpc
 * @param {Record<string, number>} options.functions Movie decoder function addresses.
 * @param {number} options.decoder
 * @param {number} options.output The movie Buffer GetOutputBuffer fills.
 * @param {number} options.format The MediaData GetOutputBuffer fills.
 * @param {number} options.event The decoder output event the input worker created.
 * @param {{mapped: number, color: number}} options.publication The native ring.
 * @param {number} [options.timeoutMs]
 */
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
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    throw Error('Paired loop needs a qualified output event and native publication ring');
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verifyPreamble(rpc);
  for (const name of SYNC_FUNCTIONS)
    await verify(rpc, rpc.a.sdk + SYNC[name].offset, SYNC[name].hex);
  const base = await allocate(rpc, WORKER_BYTES, {
    failed: 'Paired loop worker allocation failed',
    invalid: 'Invalid paired loop worker allocation'
  });
  const control = await allocate(rpc, CONTROL_BYTES, {
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
  const signal = name =>
    rpc.callAddress(rpc.a.sdk + SYNC.signalLightEvent.offset, [at(c[name])], SHORT);
  const initialized = [];
  for (const offset of GATES) {
    await rpc.callAddress(
      rpc.a.sdk + SYNC.initializeLightEvent.offset,
      [at(offset), 0, AUTO_CLEAR, 0],
      SHORT
    );
    initialized.push(offset);
  }
  for (const [name, snapshot] of FRAMES) {
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
  await rpc.write(
    at(c.dispatch[0]),
    addressWords(DISPATCH_TARGETS.map(name => built.locations[name]))
  );
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
      if (value.readUInt32LE(bytes - SEQUENCE_BYTES) === sequence) return value;
      await pause(POLL_MS);
    }
    if (stopping) throw Error('Paired loop stopped while waiting for output');
    retained = true;
    throw Error('Paired loop worker timed out; restart SmileBASIC');
  }

  async function waitForPresentation(destination) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until && !stopping) {
      const state = await rpc.read(publication.mapped + ring.CONTROL.current, PRESENTATION.bytes);
      if (
        state.readUInt32LE(PRESENTATION.index) === destination.index &&
        state.readUInt32LE(PRESENTATION.sequence) === destination.sequence
      )
        return;
      await pause(POLL_MS);
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
    const bytes = Buffer.alloc(loop.DESCRIPTOR.size);
    bytes.writeBigUInt64LE(BigInt(destination.address), loop.DESCRIPTOR.address);
    bytes.writeBigUInt64LE(BigInt(destination.bytes), loop.DESCRIPTOR.bytes);
    metadata(destination, frame).copy(bytes, loop.DESCRIPTOR.metadata);
    return bytes;
  }

  /** The dispatch words that select a pair or a single pass. */
  function passSelectors(count) {
    return addressWords([
      built.locations[count === 1 ? 'singleAcquire' : 'acquire'],
      built.locations[count === 1 ? 'singleFirst' : 'first']
    ]);
  }

  /**
   * The output index the thread acquired for output `index` and still holds, or -1. An
   * output is held when its acquisition succeeded and its fetch did not both stamp this
   * pass and release it.
   */
  function heldOutput(slots, results, index) {
    const outputIndex = slots.readInt32LE(c.acquired[index] - c.acquired[0] + loop.SLOT.index);
    const acquiredStatus = status(results.readBigUInt64LE(loop.ACQUIRE_RESULTS.status[index]));
    const fetchOffset = (index ? c.secondResults : c.firstResults) - c.acquireResults;
    const fetchedSequence = results.readUInt32LE(fetchOffset + loop.FETCH_RESULTS.sequence);
    const releasedStatus = status(
      results.readBigUInt64LE(fetchOffset + loop.FETCH_RESULTS.release)
    );
    if (
      acquiredStatus !== 0 ||
      outputIndex < 0 ||
      (fetchedSequence === active.sequence && releasedStatus === 0)
    )
      return -1;
    return outputIndex;
  }

  async function releaseHeld() {
    if (!active) return;
    const slots = await rpc.read(at(c.acquired[0]), SLOTS_BYTES);
    const results = await rpc.read(at(c.acquireResults), RESULTS_BYTES);
    for (let index = 0; index < active.count; index++) {
      const outputIndex = heldOutput(slots, results, index);
      if (outputIndex < 0) continue;
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

  /**
   * Parses the acquire stage once it carries this pass's stamp.
   * @returns {Array<{index: number, pts: bigint}>}
   */
  function acquisitions(state, expectedPts) {
    const acquired = [];
    for (let index = 0; index < active.count; index++) {
      const slot = c.acquired[index] - c.acquired[0];
      const value = state.readBigUInt64LE(
        c.acquireResults - c.acquired[0] + loop.ACQUIRE_RESULTS.status[index]
      );
      const outputIndex = state.readInt32LE(slot + loop.SLOT.index);
      const pts = state.readBigUInt64LE(slot + loop.SLOT.pts);
      if (
        value === SENTINEL ||
        status(value) !== 0 ||
        outputIndex < 0 ||
        pts !== expectedPts[index]
      )
        throw Error(`Paired loop output ${index} acquisition failed or PTS differs`);
      acquired.push({index: outputIndex, pts});
    }
    return acquired;
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
        sequence > MAX_SEQUENCE
      )
        throw Error('Paired loop cannot start another pair');
      await rpc.write(at(c.acquired[0]), resetPass());
      const job = Buffer.alloc(SEQUENCE_BYTES);
      job.writeUInt32LE(sequence);
      active = {sequence, count, acquired: null, destinations: null, firstDone: false};
      try {
        if (count !== selectedCount) {
          await rpc.write(at(c.dispatch[0]), passSelectors(count));
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
      const state = await pollSequence(c.acquired[0], active.sequence, ACQUIRE_POLL_BYTES);
      const acquired = acquisitions(state, expectedPts);
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
        active.count === 2
          ? c.destinations[1] - c.destinations[0] + loop.DESCRIPTOR.size
          : loop.DESCRIPTOR.size
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
      const results = await pollSequence(c.firstResults, active.sequence, FETCH_POLL_BYTES);
      if (fetchFailed(results)) {
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
      const results = await pollSequence(c.secondResults, active.sequence, FETCH_POLL_BYTES);
      if (fetchFailed(results)) {
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
        await rpc.write(
          at(c.dispatch[0]),
          addressWords(c.dispatch.map(() => built.locations.exit))
        );
        await signal('startGate');
        await signal('fetchGate');
        await signal('secondGate');
        if (active && !active.acquired) {
          const until = Date.now() + timeoutMs;
          for (let index = 0; index < active.count; index++) {
            while (Date.now() < until) {
              const current = await rpc.read(
                at(c.acquireResults + loop.ACQUIRE_RESULTS.status[index]),
                ADDRESS_BYTES
              );
              if (current.readBigUInt64LE() !== SENTINEL) break;
              const state = (
                await rpc.callAddress(rpc.a.sdk + CODE.tryWait.offset, [thread], SHORT)
              ).result;
              if (state === EXITED) break;
              if (state !== 0n) {
                retained = true;
                throw Error('Paired loop thread state invalid during stop');
              }
              await rpc.callAddress(rpc.a.sdk + SYNC.signalEvent.offset, [event], SHORT);
              await pause(STOP_POLL_MS);
            }
          }
        }
        const done = await wait(rpc, thread, {
          timeoutMs,
          pollMs: STOP_POLL_MS,
          invalid: 'Paired loop thread state invalid',
          outputBytes: SHORT
        });
        if (!done) {
          retained = true;
          throw Error('Paired loop worker did not stop; restart SmileBASIC');
        }
        await join(rpc, thread, base + EXIT_SLOT_OFFSET, {
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
        acquiredSlots: (await rpc.read(at(c.acquired[0]), SLOTS_BYTES)).toString('hex'),
        results: (await rpc.read(at(c.acquireResults), RESULTS_BYTES)).toString('hex'),
        dispatch: (await rpc.read(at(c.dispatch[0]), DISPATCH_BYTES)).toString('hex')
      };
    },

    get diagnostics() {
      return {retained, active: active?.sequence ?? null, joined};
    }
  };
}

export {create};
