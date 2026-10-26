/**
 * Host scheduler for the paired live path.
 *
 * The input-only split worker feeds decoder input and one long-lived paired loop
 * (paired-loop-worker.js) acquires, fetches and publishes two outputs per pair. Each pair
 * opens the loop's gates in order: begin, both inputs, acquire with the expected PTS, two
 * ring destinations, fetch, then each publication. Gate and stop order follow
 * moonlight-dev's sdk/tools/probe-paired-output.cjs.
 *
 * A loop that fails to stop, or stops while still holding native objects, is retained for
 * the rest of the session: no new loop can be created until SmileBASIC restarts.
 */
import {create as createSplitWorker} from './split-decoder-worker.js';
import {create as createPairedLoop} from './paired-loop-worker.js';

const RESTART = 'Paired loop native objects retained; restart SmileBASIC';
/** Errors that mean the bridge to the console is gone rather than one request failing. */
const LOST = /Console disconnected|timed out|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i;
const BRIDGE_METHODS = [
  'request',
  'call',
  'callAddress',
  'pair',
  'read',
  'write',
  'writeAndCall',
  'query'
];

/**
 * The next pair sequence, wrapping from 0xffffffff to 1 because 0 is never a job.
 * @param {number} sequence
 * @returns {number}
 */
function nextSequence(sequence) {
  return (sequence + 1) >>> 0 || 1;
}

/**
 * A copy of `rpc` whose bridge methods set `bridgeLost` when the connection is lost.
 * @param {any} rpc
 * @returns {any}
 */
function watchBridge(rpc) {
  const watched = {...rpc, bridgeLost: false};
  for (const name of BRIDGE_METHODS) {
    if (typeof rpc[name] !== 'function') continue;
    watched[name] = async (...args) => {
      try {
        return await rpc[name](...args);
      } catch (error) {
        if (LOST.test(error.message)) watched.bridgeLost = true;
        throw error;
      }
    };
  }
  return watched;
}

/**
 * @param {object} options
 * @param {any} options.rpc
 * @param {{mapped: number, color: number}} options.publication The native ring.
 * @param {(options: any) => Promise<any>} [options.createInput]
 * @param {(options: any) => Promise<any>} [options.createLoop]
 */
function create({
  rpc,
  publication,
  createInput = createSplitWorker,
  createLoop = createPairedLoop
}) {
  let loop = null;
  let started = false;
  let sequence = 0;
  let retained = false;

  return {
    async factory(options) {
      if (loop || retained) throw Error('Paired loop worker already exists');
      const input = await createInput({...options, inputOnly: true});
      loop = await createLoop({
        rpc,
        functions: options.functions,
        decoder: options.decoder,
        output: options.output,
        format: options.format,
        event: input.outputEvent,
        publication
      });
      return input;
    },

    async start() {
      if (!loop || started) throw Error('Paired loop worker is not ready to start');
      started = true;
      await loop.start();
    },

    /**
     * Decodes, fetches and publishes one pair of access units.
     * @param {object} options
     * @param {any} options.decoder The input-only split worker.
     * @param {any} options.sink The native sink that hands out ring destinations.
     * @param {Array<{pts: number}>} options.units Two access units in PTS order.
     * @param {any} options.layout The decoded frame layout.
     * @param {(stage: string) => void} [options.enter] Called as each stage starts.
     * @param {(count: number) => void} [options.onDecoded]
     * @param {(count: number) => void} [options.onPresented]
     */
    async pair({
      decoder,
      sink,
      units: [left, right],
      layout,
      enter = () => {},
      onDecoded,
      onPresented
    }) {
      if (!loop || !started || retained) throw Error('Paired loop worker is not running');
      if (!(right.pts > left.pts)) throw Error('Paired loop needs increasing access-unit PTS');
      sequence = nextSequence(sequence);
      enter('paired-begin');
      await loop.beginPair(sequence);
      enter('paired-input');
      await decoder.submitSplit(left);
      await decoder.submitSplit(right);
      enter('paired-acquire');
      const acquired = await loop.acquire([BigInt(left.pts), BigInt(right.pts)]);
      onDecoded?.(2);
      enter('destination');
      const destinations = [await sink.workerDestination(), await sink.workerDestination()];
      enter('paired-fetch');
      await loop.openFetch(destinations, layout);
      const first = await loop.finishFirst();
      onPresented?.(1);
      const second = await loop.finishSecond();
      onPresented?.(1);
      return {sequence, acquired, published: [first, second]};
    },

    async snapshot() {
      return loop ? loop.snapshot() : null;
    },

    async stop() {
      if (retained) throw Error(RESTART);
      if (!loop) return;
      try {
        await loop.stop();
      } catch (error) {
        retained = true;
        throw error;
      }
      if (loop.diagnostics.retained) {
        retained = true;
        throw Error(RESTART);
      }
      loop = null;
      started = false;
    },

    get exists() {
      return loop !== null;
    },

    get retained() {
      return retained || Boolean(loop?.diagnostics.retained);
    }
  };
}

export {create, watchBridge, RESTART};
