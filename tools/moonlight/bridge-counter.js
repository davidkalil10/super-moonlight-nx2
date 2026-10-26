/**
 * Counts bridge exchanges and the time spent in them, per stage. `instrument` wraps an rpc so
 * every call is attributed to the stage the caller is in when it starts; `take` returns the
 * totals since the last take and resets them. Reads and writes count one exchange per chunk.
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
 * @returns {{rpc: object, take(): Counts & {bridgeByStage: Record<string, Counts>}}}
 */
function instrument(rpc, stage, now = () => performance.now()) {
  const measured = {...rpc};
  let exchanges = 0;
  let bridgeMs = 0;
  /** @type {Record<string, Counts>} */
  let byStage = {};
  for (const name of METHODS) {
    if (typeof rpc[name] !== 'function') continue;
    measured[name] = async (...args) => {
      const label = stage();
      const started = now();
      try {
        return await rpc[name](...args);
      } finally {
        const count = requestsFor(name, args);
        const elapsed = now() - started;
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
    }
  };
}

export {instrument, requestsFor};
