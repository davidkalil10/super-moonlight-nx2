// Host scheduler for the paired live path: the input-only split worker feeds decoder
// input and one long-lived paired loop acquires, fetches and publishes two outputs.
// Gate and stop order follow sdk/tools/probe-paired-output.cjs.
const RESTART = 'Paired loop native objects retained; restart SmileBASIC';
const LOST = /Console disconnected|timed out|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i;

function watchBridge(rpc) {
  const watched = {...rpc, bridgeLost: false};
  for (const name of [
    'request',
    'call',
    'callAddress',
    'pair',
    'read',
    'write',
    'writeAndCall',
    'query'
  ]) {
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

function create({
  rpc,
  publication,
  createInput = require('./split-decoder-worker.cjs').create,
  createLoop = require('./paired-loop-worker.cjs').create
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
      sequence = (sequence + 1) >>> 0 || 1;
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

module.exports = {create, watchBridge, RESTART};
