// Output worker frames for the staggered lag-2 path. The acquire frame waits once on the
// auto-clear decoder output event, acquires one output, stamps its status and sequence, then
// signals the input worker's acquisition acknowledgement before it parks on the fetch gate.
// The acknowledgement comes only after the stamps, so the input worker's next SendInput can
// never race the host-visible acquire status. The fetch frame copies the held output into the
// descriptor's ring surface, releases it and stamps the fetch status.
const {build} = require('../../smilebasic/engine/shared/frames.cjs');
const {CODE, IPC_COPY} = require('../../sdk/native/thread.cjs');
const SYNC = require('../../sdk/native/os-sync-functions.json');
const {metadata} = require('./paired-output-frame.cjs');
const status = require('./staggered-status.cjs');
const ring = require('./ring.cjs');

const CONTROL = {
  fetchGate: 0x20,
  fetchDispatch: [0x60, 0x68],
  acquireDispatch: [0x70, 0x78],
  descriptors: [0x200, 0x280]
};

const DESCRIPTOR = {
  sequence: 0,
  address: 8,
  bytes: 16,
  metadata: 24,
  size: 0x80
};

function locations(base) {
  return {
    acquire: [base + 0x10000, base + 0x210000],
    acquireSnapshot: [base + 0x80000, base + 0x280000],
    fetch: [base + 0x110000, base + 0x300000],
    fetchSnapshot: [base + 0x180000, base + 0x380000],
    exit: base + 0x3f0000
  };
}

function outputDescriptor({auSequence, destination, frame, publication}) {
  if (
    !Number.isInteger(auSequence) ||
    auSequence < 1 ||
    auSequence > 0xffffffff ||
    !Number.isSafeInteger(publication?.mapped) ||
    !destination ||
    destination.address !== publication.mapped + ring.frameOffset(destination.index) ||
    destination.color !== publication.color
  )
    throw Error('Invalid staggered output publication target');
  const bytes = Buffer.alloc(DESCRIPTOR.size);
  bytes.writeUInt32LE(auSequence, DESCRIPTOR.sequence);
  bytes.writeBigUInt64LE(BigInt(destination.address), DESCRIPTOR.address);
  bytes.writeBigUInt64LE(BigInt(destination.bytes), DESCRIPTOR.bytes);
  metadata(destination, frame).copy(bytes, DESCRIPTOR.metadata);
  return bytes;
}

function placeholderDescriptor(auSequence) {
  if (!Number.isInteger(auSequence) || auSequence < 1 || auSequence > 0xffffffff)
    throw Error('Invalid staggered output sequence');
  const bytes = Buffer.alloc(DESCRIPTOR.size);
  bytes.writeUInt32LE(auSequence, DESCRIPTOR.sequence);
  return bytes;
}

function plan({sdk, base, control, mapped, event, acquireAck, functions, decoder, output, format}) {
  const addresses = [sdk, base, control, mapped, event, acquireAck, decoder, output, format];
  if (
    addresses.some(value => !Number.isSafeInteger(value) || value <= 0) ||
    ['acquireOutput', 'bufferSetData', 'getOutput', 'releaseOutput'].some(
      name => !Number.isSafeInteger(functions?.[name]) || functions[name] <= 0
    )
  )
    throw Error('Invalid staggered output frame addresses');
  const loc = locations(base);
  const at = offset => control + offset;
  const ringAt = offset => mapped + offset;
  const copy = sdk + IPC_COPY.offset;
  const jump = sdk + CODE.longjmp.offset;
  const sync = name => sdk + SYNC[name].offset;
  const verified = new Set(Object.values(functions));
  const frame = (address, calls, results = {}) => {
    const built = build(address, sdk, calls, CODE, false, verified);
    for (const [logical, destination] of Object.entries(results)) {
      const native = built.proof.logicalResultIndices[Number(logical)];
      built.frame.writeBigUInt64LE(
        BigInt(ringAt(destination)),
        built.proof.stackOffsets[native] + 0x118
      );
    }
    if (built.frame.length > 0x70000) throw Error('Staggered output frame exceeds its region');
    return built;
  };
  const acquire = [];
  const fetch = [];
  const calls = {acquire: [], fetch: []};
  for (let slot = 0; slot < 2; slot++) {
    const descriptor = at(CONTROL.descriptors[slot]);
    const acquireCalls = [
      {function: sync('waitEvent'), args: [event, 0, 0, 0]},
      {
        function: functions.acquireOutput,
        args: [
          decoder,
          ringAt(status.STATUS.acquire + 8),
          ringAt(status.STATUS.acquire + 16),
          ringAt(status.STATUS.acquire + 32),
          ringAt(status.STATUS.acquire + 36)
        ]
      },
      {
        function: copy,
        args: [ringAt(status.STATUS.acquire + 24), descriptor + DESCRIPTOR.sequence, 4, 0]
      },
      {function: sync('signalLightEvent'), args: [acquireAck, 0, 0, 0]},
      {function: sync('waitLightEvent'), args: [at(CONTROL.fetchGate), 0, 0, 0]},
      {function: jump, args: [{u64: at(CONTROL.fetchDispatch[slot])}, 1, 0, 0]}
    ];
    acquire.push(frame(loc.acquire[slot], acquireCalls, {1: status.STATUS.acquire}));
    calls.acquire.push(acquireCalls);
  }
  for (let slot = 0; slot < 2; slot++) {
    const descriptor = at(CONTROL.descriptors[slot]);
    const restore = [
      {
        function: copy,
        args: [loc.acquire[slot], loc.acquireSnapshot[slot], acquire[slot].frame.length, 0]
      },
      {
        function: copy,
        args: [loc.fetch[slot], loc.fetchSnapshot[slot], 0, 0]
      }
    ];
    const fetchCalls = [
      {
        function: functions.bufferSetData,
        args: [output, {u64: descriptor + DESCRIPTOR.address}, {u64: descriptor + DESCRIPTOR.bytes}, 0]
      },
      {
        function: functions.getOutput,
        args: [decoder, {u32: ringAt(status.STATUS.acquire + 8)}, output, format]
      },
      {
        function: functions.releaseOutput,
        args: [decoder, {u32: ringAt(status.STATUS.acquire + 8)}, 0, 0]
      },
      {
        function: copy,
        args: [ringAt(ring.CONTROL.nativeIndex), descriptor + DESCRIPTOR.metadata, 28, 0]
      },
      {
        function: copy,
        args: [ringAt(ring.CONTROL.nativeSequence), descriptor + DESCRIPTOR.metadata + 28, 4, 0]
      },
      {
        function: copy,
        args: [ringAt(status.STATUS.fetch + 24), descriptor + DESCRIPTOR.sequence, 4, 0]
      },
      ...restore,
      {function: jump, args: [{u64: at(CONTROL.acquireDispatch[slot])}, 1, 0, 0]}
    ];
    let built = frame(loc.fetch[slot], fetchCalls, {
      0: status.STATUS.fetch,
      1: status.STATUS.fetch + 8,
      2: status.STATUS.fetch + 16
    });
    restore[1].args[2] = built.frame.length;
    built = frame(loc.fetch[slot], fetchCalls, {
      0: status.STATUS.fetch,
      1: status.STATUS.fetch + 8,
      2: status.STATUS.fetch + 16
    });
    fetch.push(built);
    calls.fetch.push(fetchCalls);
  }
  return {control: CONTROL, descriptor: DESCRIPTOR, locations: loc, acquire, fetch, calls};
}

module.exports = {CONTROL, DESCRIPTOR, locations, outputDescriptor, placeholderDescriptor, plan};
