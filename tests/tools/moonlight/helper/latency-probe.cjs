// Preload for live.js (node -r) that measures what hbmoonlight-host reports
// as latencyMs: from a captured frame being complete to the bridge
// acknowledging its ring write. It tags frame buffers as live.js copies them
// out of the capture pipe, follows them through Encoder.encode and times the
// matching rpc.write. Prints one JSON line to stderr on exit.
const Module = require('node:module');
const path = require('node:path');

const FRAME_BYTES = Number(process.env.PROBE_FRAME_BYTES || 1920 * 1080 * 3);
const arrived = new WeakMap();
const latencies = [];

const from = Buffer.from;
Buffer.from = function (value, ...rest) {
  const buffer = from.call(Buffer, value, ...rest);
  if (buffer.length === FRAME_BYTES && value instanceof Uint8Array)
    arrived.set(buffer, performance.now());
  return buffer;
};

function wrapEncoder(exports) {
  const encode = exports.Encoder.prototype.encode;
  exports.Encoder.prototype.encode = async function (rgb, ...rest) {
    const result = await encode.call(this, rgb, ...rest);
    if (arrived.has(rgb) && result.slot) arrived.set(result.slot, arrived.get(rgb));
    return result;
  };
}

function wrapRpc(exports) {
  const write = exports.write;
  exports.write = async function (address, data) {
    const result = await write.call(this, address, data);
    if (arrived.has(data)) latencies.push(performance.now() - arrived.get(data));
    return result;
  };
}

const load = Module._load;
Module._load = function (request, parent, isMain) {
  const exports = load.apply(this, arguments);
  const name = path.basename(request);
  if (name === 'hbv2-encoder.js' && !exports.Encoder.probed) {
    wrapEncoder(exports);
    exports.Encoder.probed = true;
  }
  if (request.endsWith(path.join('shared', 'rpc.cjs')) && !exports.probed) {
    wrapRpc(exports);
    exports.probed = true;
  }
  return exports;
};

process.on('exit', () => {
  const sorted = latencies.sort((a, b) => a - b);
  const at = share => +(sorted[Math.floor(sorted.length * share)] || 0).toFixed(2);
  process.stderr.write(
    JSON.stringify({
      event: 'summary',
      written: sorted.length,
      latencyMs: {p50: at(0.5), p90: at(0.9), p99: at(0.99), max: +(sorted.at(-1) || 0).toFixed(2)}
    }) + '\n'
  );
});
