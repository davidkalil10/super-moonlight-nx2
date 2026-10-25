// Moonlight PCM paced over a native TCP stream into the console socket audio worker.
const {ByteQueue} = require('./audio-stream.cjs');

const SAMPLE_RATE = 48000;
const FRAME_BYTES = 4;
const PRIMED = 2;
const HEALTH_MS = 1000;
const MAX_PENDING_CHUNKS = 4;
const BRIDGE_LOST = /disconnected|timed out|ECONN|EPIPE|socket hang up/i;
const RPC_METHODS = [
  'request',
  'call',
  'callAddress',
  'pair',
  'read',
  'write',
  'query',
  'writeAndCall'
];

function watched(rpc, state) {
  const device = {...rpc};
  for (const name of RPC_METHODS) {
    if (typeof rpc[name] !== 'function') continue;
    device[name] = async (...args) => {
      try {
        return await rpc[name](...args);
      } catch (error) {
        if (BRIDGE_LOST.test(error.message)) state.bridgeLost = true;
        throw error;
      }
    };
  }
  return device;
}

async function create({
  rpc,
  host = rpc.host,
  bufferBytes = 7680,
  maxPending = MAX_PENDING_CHUNKS * bufferBytes,
  healthMs = HEALTH_MS,
  createTransport = require('./native-tcp.cjs').create,
  createAudio = require('./audio-socket-worker.cjs').create,
  now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  every = (callback, ms) => setInterval(callback, ms),
  cancel = clearInterval,
  onError = () => {}
}) {
  const bufferMs = (bufferBytes / FRAME_BYTES / SAMPLE_RATE) * 1000;
  const silence = Buffer.alloc(bufferBytes);
  const state = {bridgeLost: false};
  const device = watched(rpc, state);
  const stats = {
    bufferBytes,
    sent: 0,
    underruns: 0,
    silenceChunks: 0,
    overruns: 0,
    droppedBytes: 0,
    receivedBytes: 0,
    late: 0,
    healthPolls: 0,
    lastCycle: null,
    cycleCheck: null,
    retainedForSafety: false,
    error: null
  };
  let transport = null;
  let audio = null;

  async function release() {
    let failure = null;
    if (audio && !audio.retained) {
      try {
        await audio.stop();
        if (stats.sent) stats.cycleCheck = 'pass';
      } catch (error) {
        failure = error;
      }
    }
    const retained = Boolean(audio?.retained || state.bridgeLost);
    if (transport) {
      if (retained) transport.abort();
      else
        try {
          await transport.close();
        } catch (error) {
          failure ||= error;
        }
    }
    stats.retainedForSafety = retained;
    if (failure) stats.error ||= failure.message;
    if (retained) {
      stats.error ||= 'Socket audio objects retained for safety';
      if (!/restart SmileBASIC/.test(stats.error)) stats.error += '; restart SmileBASIC';
    }
  }

  try {
    transport = await createTransport({rpc: device, host});
    audio = await createAudio({rpc: device, transport, bufferBytes});
    await audio.start(silence, silence);
    stats.sent = PRIMED;
  } catch (error) {
    stats.error = error.message;
    await release();
    throw Object.assign(Error(stats.error), {report: report()});
  }

  const queue = new ByteQueue();
  let input = null;
  let halted = false;
  let fed = false;
  let underflowing = false;
  let failed = false;
  let polling = null;
  let closing = null;
  let wake = () => {};

  function fail(error) {
    if (halted || failed) return;
    failed = true;
    stats.error ||= error.message;
    halt();
    onError(error);
  }

  function onData(chunk) {
    if (halted) return;
    fed = true;
    stats.receivedBytes += chunk.length;
    queue.push(chunk);
    if (queue.bytes > maxPending) {
      const drop = queue.bytes - maxPending;
      const whole = Math.ceil(drop / bufferBytes) * bufferBytes;
      const dropped = queue.dropOldest(Math.min(whole, queue.bytes));
      stats.droppedBytes += dropped;
      stats.overruns += Math.round(dropped / bufferBytes) || 1;
    }
  }
  const onInputError = error => fail(error);

  const pacing = (async () => {
    let due = now();
    while (!halted) {
      const wait = due - now();
      if (wait > 0) {
        await new Promise(resolve => {
          wake = resolve;
          sleep(wait).then(resolve);
        });
        continue;
      }
      if (now() - due > PRIMED * bufferMs) {
        stats.late++;
        due = now();
      }
      let chunk = silence;
      if (queue.bytes >= bufferBytes) {
        chunk = queue.pull(bufferBytes);
        underflowing = false;
      } else {
        stats.silenceChunks++;
        if (fed && !underflowing) stats.underruns++;
        underflowing = fed;
      }
      await audio.send(chunk);
      stats.sent++;
      due += bufferMs;
    }
  })().catch(fail);

  const timer = every(() => {
    if (halted || polling) return;
    polling = audio
      .health()
      .then(health => {
        stats.healthPolls++;
        stats.lastCycle = health.results ?? null;
      })
      .catch(fail)
      .finally(() => {
        polling = null;
      });
  }, healthMs);

  function attach(stream) {
    if (input || halted) throw Error('Socket audio input is already attached');
    input = stream;
    input.on('data', onData);
    input.on('error', onInputError);
  }

  function halt() {
    if (halted) return;
    halted = true;
    wake();
    cancel(timer);
    if (input) {
      input.off('data', onData);
      input.on('error', () => {});
      input.destroy?.();
    }
  }

  function report() {
    return {
      ...stats,
      appended: stats.sent,
      released: Math.max(0, stats.sent - PRIMED),
      countersFrom: 'host'
    };
  }

  function close() {
    closing ||= (async () => {
      halt();
      await pacing;
      await polling;
      await release();
      return report();
    })();
    return closing;
  }

  return {attach, halt, close, report};
}

module.exports = {create};
