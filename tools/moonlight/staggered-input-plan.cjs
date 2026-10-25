// Input worker frames for the staggered lag-2 path. Per access unit N the receive frame reads
// N over native TCP and parks on the decode gate. Once the host's checked gate write opens it,
// the frame signals the descriptor's fetch gate (held output N-2, or the ignored gate before
// N=3), then waits for the output worker's acquisition acknowledgement of N-1, and only then
// jumps through sendDispatch to the send frame that submits N. Each submit therefore follows
// the acquisition of every earlier output, so the auto-clear decoder event never carries two
// unacquired outputs. Releasing N-2 before that wait is what lets the output worker reach N-1.
// The acknowledgement event starts signalled for N=1, standing in for the host-decoded IDR.
// Stop rewrites the dispatches to the exit frame before it signals the gate and the
// acknowledgement, so a stop wake never reaches SendInput. A descriptor the worker can reach
// before its checked gate write always names the ignored fetch gate (start and every gate write
// fill the next descriptor that way), so a stop wake cannot open a fetch either.
const {build} = require('../../../hbl-platform/smilebasic/engine/shared/frames.cjs');
const {CODE, IPC_COPY} = require('../../../hbl-platform/sdk/native/thread.cjs');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');
const status = require('./staggered-status.cjs');

const CONTROL = {
  decodeGate: 0x00,
  ignoredFetchGate: 0x10,
  sendDispatch: [0x40, 0x48],
  receiveDispatch: [0x50, 0x58],
  descriptors: [0x100, 0x180]
};

const DESCRIPTOR = {
  sequence: 0,
  length: 4,
  pts: 8,
  inputAddress: 16,
  inputIndex: 24,
  fetchGate: 32,
  bytes: 0x80
};

function locations(base) {
  return {
    receive: [base + 0x10000, base + 0x210000],
    receiveSnapshot: [base + 0x80000, base + 0x280000],
    send: [base + 0x110000, base + 0x300000],
    sendSnapshot: [base + 0x180000, base + 0x380000],
    exit: base + 0x3f0000
  };
}

function gateWrite({snapshot, expected, input, current, next, fetchGate, ignoredFetchGate}) {
  const checked = status.check(snapshot, expected);
  if (
    !Number.isInteger(input?.index) ||
    input.index < 0 ||
    !Number.isSafeInteger(input.address) ||
    input.address <= 0 ||
    !Number.isInteger(input.capacity) ||
    input.capacity < expected.receive.bytes ||
    (checked.inputIndex !== null && checked.inputIndex !== input.index)
  )
    throw Error('Staggered input slot is not the checked decoder buffer');
  if (
    !current ||
    current.sequence !== expected.receive.sequence ||
    current.length !== expected.receive.bytes ||
    current.length > 0x100000 ||
    typeof current.pts !== 'bigint' ||
    current.pts < 0n ||
    current.pts > 0xffffffffffffffffn ||
    !next ||
    next.sequence !== current.sequence + 1 ||
    !Number.isInteger(next.length) ||
    next.length < 1 ||
    next.length > 0x100000 ||
    typeof next.pts !== 'bigint' ||
    next.pts <= current.pts ||
    next.pts > 0xffffffffffffffffn ||
    !Number.isSafeInteger(fetchGate) ||
    fetchGate <= 0 ||
    !Number.isSafeInteger(ignoredFetchGate) ||
    ignoredFetchGate <= 0
  )
    throw Error('Invalid staggered current or next access unit');
  const descriptors = Buffer.alloc(2 * DESCRIPTOR.bytes);
  const put = (slot, unit, address, index, signal) => {
    const offset = slot * DESCRIPTOR.bytes;
    descriptors.writeUInt32LE(unit.sequence, offset + DESCRIPTOR.sequence);
    descriptors.writeUInt32LE(unit.length, offset + DESCRIPTOR.length);
    descriptors.writeBigUInt64LE(unit.pts, offset + DESCRIPTOR.pts);
    descriptors.writeBigUInt64LE(BigInt(address), offset + DESCRIPTOR.inputAddress);
    descriptors.writeUInt32LE(index, offset + DESCRIPTOR.inputIndex);
    descriptors.writeBigUInt64LE(BigInt(signal), offset + DESCRIPTOR.fetchGate);
  };
  const currentSlot = (current.sequence - 1) % 2;
  put(currentSlot, current, input.address, input.index, expected.acquire ? fetchGate : ignoredFetchGate);
  put(1 - currentSlot, next, 0, 0, ignoredFetchGate);
  return descriptors;
}

function plan({
  sdk,
  base,
  control,
  mapped,
  scratch,
  fd,
  recvFunction,
  functions,
  decoder,
  acquireAck
}) {
  const addresses = [sdk, base, control, mapped, scratch, recvFunction, decoder, acquireAck];
  if (
    addresses.some(value => !Number.isSafeInteger(value) || value <= 0) ||
    !Number.isInteger(fd) ||
    fd < 0 ||
    ['sendInput', 'acquireInput'].some(
      name => !Number.isSafeInteger(functions?.[name]) || functions[name] <= 0
    )
  )
    throw Error('Invalid staggered input frame addresses');
  const loc = locations(base);
  const at = offset => control + offset;
  const ringAt = offset => mapped + offset;
  const copy = sdk + IPC_COPY.offset;
  const jump = sdk + CODE.longjmp.offset;
  const sync = name => sdk + SYNC[name].offset;
  const verified = new Set([recvFunction, functions.sendInput, functions.acquireInput]);
  const frame = (address, calls, results = {}) => {
    const built = build(address, sdk, calls, CODE, false, verified);
    for (const [logical, destination] of Object.entries(results)) {
      const native = built.proof.logicalResultIndices[Number(logical)];
      built.frame.writeBigUInt64LE(
        BigInt(ringAt(destination)),
        built.proof.stackOffsets[native] + 0x118
      );
    }
    if (built.frame.length > 0x70000) throw Error('Staggered input frame exceeds its region');
    return built;
  };
  const receive = [];
  const send = [];
  const calls = {receive: [], send: []};
  for (let slot = 0; slot < 2; slot++) {
    const descriptor = at(CONTROL.descriptors[slot]);
    const receiveCalls = [
      {
        function: recvFunction,
        args: [fd, scratch, {u32: descriptor + DESCRIPTOR.length}, 0x40]
      },
      {
        function: copy,
        args: [ringAt(status.STATUS.receive + 8), descriptor + DESCRIPTOR.sequence, 4, 0]
      },
      {function: sync('waitLightEvent'), args: [at(CONTROL.decodeGate), 0, 0, 0]},
      {
        function: sync('signalLightEvent'),
        args: [{u64: descriptor + DESCRIPTOR.fetchGate}, 0, 0, 0]
      },
      {function: sync('waitLightEvent'), args: [acquireAck, 0, 0, 0]},
      {function: jump, args: [{u64: at(CONTROL.sendDispatch[slot])}, 1, 0, 0]}
    ];
    receive.push(
      frame(loc.receive[slot], receiveCalls, {0: status.STATUS.receive})
    );
    calls.receive.push(receiveCalls);
  }
  for (let slot = 0; slot < 2; slot++) {
    const descriptor = at(CONTROL.descriptors[slot]);
    const restore = [
      {
        function: copy,
        args: [loc.receive[slot], loc.receiveSnapshot[slot], receive[slot].frame.length, 0]
      },
      {
        function: copy,
        args: [loc.send[slot], loc.sendSnapshot[slot], 0, 0]
      }
    ];
    const sendCalls = [
      {
        function: copy,
        args: [
          {u64: descriptor + DESCRIPTOR.inputAddress},
          scratch,
          {u32: descriptor + DESCRIPTOR.length},
          0
        ]
      },
      {
        function: functions.sendInput,
        args: [
          decoder,
          {u32: descriptor + DESCRIPTOR.inputIndex},
          0,
          {u32: descriptor + DESCRIPTOR.length},
          {u64: descriptor + DESCRIPTOR.pts},
          0
        ]
      },
      {
        function: functions.acquireInput,
        args: [
          decoder,
          ringAt(status.STATUS.input + 16),
          ringAt(status.STATUS.input + 24),
          0
        ]
      },
      {
        function: copy,
        args: [
          ringAt(status.STATUS.input + 20),
          descriptor + DESCRIPTOR.sequence,
          4,
          0
        ]
      },
      ...restore,
      {function: jump, args: [{u64: at(CONTROL.receiveDispatch[slot])}, 1, 0, 0]}
    ];
    let built = frame(loc.send[slot], sendCalls, {
      1: status.STATUS.input,
      2: status.STATUS.input + 8
    });
    restore[1].args[2] = built.frame.length;
    built = frame(loc.send[slot], sendCalls, {
      1: status.STATUS.input,
      2: status.STATUS.input + 8
    });
    send.push(built);
    calls.send.push(sendCalls);
  }
  return {control: CONTROL, descriptor: DESCRIPTOR, locations: loc, receive, send, calls};
}

module.exports = {CONTROL, DESCRIPTOR, locations, gateWrite, plan};
