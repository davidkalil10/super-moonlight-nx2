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
const CHUNK_BYTES = 0x80000;

function requestsFor(name, args) {
  if (name === 'read')
    return Number.isInteger(args[1]) && args[1] > 0 ? Math.ceil(args[1] / CHUNK_BYTES) : 0;
  if (name === 'write')
    return Buffer.isBuffer(args[1]) ? Math.ceil(args[1].length / CHUNK_BYTES) : 0;
  return 1;
}

function instrument(rpc, stage, now = () => performance.now()) {
  const measured = {...rpc};
  let exchanges = 0;
  let bridgeMs = 0;
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

module.exports = {instrument, requestsFor};
