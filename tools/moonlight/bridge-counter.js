/**
 * Counts bridge exchanges and the time spent in them, per stage. `instrument` wraps an rpc so
 * every call is attributed to the stage the caller is in when it starts; `take` returns the
 * totals since the last take and resets them. Reads and writes count one exchange per chunk.
 * `silentMs` says how long the console has kept a call waiting without settling any.
 * `watchBridge` marks an rpc `bridgeLost` once a call fails because the connection is gone.
 */

/** The rpc methods that reach the console. */
const METHODS = [
  'request',
  'call',
  'callAddress',
  'pair',
  'read',
  'write',
  'query',
  'writeAndCall'
];
/** Errors that mean the bridge to the console is gone rather than one request failing. */
const LOST = /Console disconnected|timed out|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i;
/** The bridge splits reads and writes into exchanges of at most this many bytes. */
const CHUNK_BYTES = 0x80000;

/**
 * Number of bridge exchanges an rpc call makes.
 * @param {string} name the rpc method
 * @param {any[]} args its arguments
 * @returns {number}
 */
function requestsFor(name, args) {
  if (name === 'read')
    return Number.isInteger(args[1]) && args[1] > 0 ? Math.ceil(args[1] / CHUNK_BYTES) : 0;
  if (name === 'write')
    return Buffer.isBuffer(args[1]) ? Math.ceil(args[1].length / CHUNK_BYTES) : 0;
  return 1;
}

/**
 * @typedef {{exchanges: number, bridgeMs: number}} Counts
 */

/**
 * Wraps the console-facing methods of an rpc so their exchanges and time are counted.
 * @param {object} rpc
 * @param {() => string} stage returns the current stage's name
 * @param {() => number} [now] clock in milliseconds
 * @returns {{rpc: object, take(): Counts & {bridgeByStage: Record<string, Counts>}, silentMs(): number}}
 */
function instrument(rpc, stage, now = () => performance.now()) {
  const measured = {...rpc};
  let exchanges = 0;
  let bridgeMs = 0;
  /** @type {Record<string, Counts>} */
  let byStage = {};
  let pending = 0;
  let answered = now();
  for (const name of METHODS) {
    if (typeof rpc[name] !== 'function') continue;
    measured[name] = async (...args) => {
      const label = stage();
      const started = now();
      if (pending++ === 0) answered = started;
      try {
        return await rpc[name](...args);
      } finally {
        pending--;
        answered = now();
        const count = requestsFor(name, args);
        const elapsed = answered - started;
        const row = (byStage[label] ||= {exchanges: 0, bridgeMs: 0});
        exchanges += count;
        bridgeMs += elapsed;
        row.exchanges += count;
        row.bridgeMs += elapsed;
      }
    };
  }
  return {
    rpc: measured,
    take() {
      const result = {
        exchanges,
        bridgeMs: Math.round(bridgeMs),
        bridgeByStage: Object.fromEntries(
          Object.entries(byStage).map(([name, row]) => [
            name,
            {exchanges: row.exchanges, bridgeMs: Math.round(row.bridgeMs)}
          ])
        )
      };
      exchanges = bridgeMs = 0;
      byStage = {};
      return result;
    },
    silentMs() {
      return pending ? now() - answered : 0;
    }
  };
}

/**
 * A copy of `rpc` whose bridge methods set `bridgeLost` when the connection is lost.
 * @param {any} rpc
 * @returns {any}
 */
function watchBridge(rpc) {
  const watched = {...rpc, bridgeLost: false};
  for (const name of METHODS) {
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

export {instrument, requestsFor, watchBridge};
