const {build} = require('../../../hbl-platform/smilebasic/engine/shared/frames.js');
const {CODE, IPC_COPY} = require('../../../hbl-platform/sdk/native/thread.js');
const SYNC = require('../../../hbl-platform/sdk/native/os-sync-functions.json');
const ring = require('./ring.cjs');

const CONTROL = {
  startGate: 0x00,
  fetchGate: 0x10,
  secondGate: 0x20,
  job: 0x100,
  acquired: [0x140, 0x180],
  destinations: [0x200, 0x240],
  acquireResults: 0x300,
  firstResults: 0x330,
  secondResults: 0x360,
  dispatch: [0x400, 0x408, 0x410, 0x418]
};

function locations(base) {
  return {
    gate: base + 0x10000,
    gateSnapshot: base + 0x80000,
    singleAcquire: base + 0x9a000,
    acquire: base + 0x110000,
    acquireSnapshot: base + 0x180000,
    singleAcquireSnapshot: base + 0x1a0000,
    first: base + 0x210000,
    firstSnapshot: base + 0x280000,
    singleFirst: base + 0x2a0000,
    second: base + 0x300000,
    secondSnapshot: base + 0x380000,
    singleFirstSnapshot: base + 0x3a0000,
    exit: base + 0x3f0000
  };
}

function plan({sdk, base, control, event, functions, decoder, output, format, publication}) {
  if (
    !Number.isSafeInteger(sdk) ||
    !Number.isSafeInteger(base) ||
    !Number.isSafeInteger(control) ||
    !Number.isSafeInteger(event) ||
    !Number.isSafeInteger(decoder) ||
    !Number.isSafeInteger(output) ||
    !Number.isSafeInteger(format) ||
    !Number.isSafeInteger(publication?.mapped) ||
    [sdk, base, control, event, decoder, output, format, publication.mapped].some(
      value => value <= 0
    ) ||
    ['acquireOutput', 'bufferSetData', 'getOutput', 'releaseOutput'].some(
      name => !Number.isSafeInteger(functions?.[name]) || functions[name] <= 0
    )
  )
    throw Error('Invalid paired loop addresses');
  const at = offset => control + offset;
  const loc = locations(base);
  const copy = sdk + IPC_COPY.offset;
  const jump = sdk + CODE.longjmp.offset;
  const sync = name => sdk + SYNC[name].offset;
  const verified = new Set(Object.values(functions));
  const frame = (address, calls, results = {}) => {
    const built = build(address, sdk, calls, CODE, false, verified);
    for (const [logical, destination] of Object.entries(results)) {
      const native = built.proof.logicalResultIndices[Number(logical)];
      built.frame.writeBigUInt64LE(
        BigInt(at(destination)),
        built.proof.stackOffsets[native] + 0x118
      );
    }
    if (built.frame.length > 0x70000) throw Error('Paired loop frame exceeds its region');
    return built;
  };
  const gateCalls = [
    {function: sync('waitLightEvent'), args: [at(CONTROL.startGate), 0, 0, 0]},
    {function: jump, args: [{u64: at(CONTROL.dispatch[0])}, 1, 0, 0]}
  ];
  const gate = frame(loc.gate, gateCalls);
  const acquireCalls = [];
  for (const slot of CONTROL.acquired) {
    acquireCalls.push({function: sync('waitEvent'), args: [event, 0, 0, 0]});
    acquireCalls.push({
      function: functions.acquireOutput,
      args: [decoder, at(slot), at(slot + 8), at(slot + 16), at(slot + 20)]
    });
  }
  acquireCalls.push({
    function: copy,
    args: [at(CONTROL.acquireResults + 16), at(CONTROL.job), 4, 0]
  });
  acquireCalls.push({function: sync('waitLightEvent'), args: [at(CONTROL.fetchGate), 0, 0, 0]});
  acquireCalls.push({function: jump, args: [{u64: at(CONTROL.dispatch[1])}, 1, 0, 0]});
  const acquire = frame(loc.acquire, acquireCalls, {
    1: CONTROL.acquireResults,
    3: CONTROL.acquireResults + 8
  });
  const singleAcquireCalls = [
    {function: sync('waitEvent'), args: [event, 0, 0, 0]},
    {
      function: functions.acquireOutput,
      args: [
        decoder,
        at(CONTROL.acquired[0]),
        at(CONTROL.acquired[0] + 8),
        at(CONTROL.acquired[0] + 16),
        at(CONTROL.acquired[0] + 20)
      ]
    },
    {function: copy, args: [at(CONTROL.acquireResults + 16), at(CONTROL.job), 4, 0]},
    {function: sync('waitLightEvent'), args: [at(CONTROL.fetchGate), 0, 0, 0]},
    {function: jump, args: [{u64: at(CONTROL.dispatch[1])}, 1, 0, 0]}
  ];
  const singleAcquire = frame(loc.singleAcquire, singleAcquireCalls, {
    1: CONTROL.acquireResults
  });
  const fetchCalls = (index, resultOffset) => {
    const destination = CONTROL.destinations[index];
    const slot = CONTROL.acquired[index];
    return [
      {
        function: functions.bufferSetData,
        args: [output, {u64: at(destination)}, {u64: at(destination + 8)}, 0]
      },
      {
        function: functions.getOutput,
        args: [decoder, {u32: at(slot)}, output, format]
      },
      {function: functions.releaseOutput, args: [decoder, {u32: at(slot)}, 0, 0]},
      {
        function: copy,
        args: [publication.mapped + ring.CONTROL.nativeIndex, at(destination + 16), 28, 0]
      },
      {
        function: copy,
        args: [publication.mapped + ring.CONTROL.nativeSequence, at(destination + 44), 4, 0]
      },
      {function: copy, args: [at(resultOffset + 24), at(CONTROL.job), 4, 0]}
    ];
  };
  const firstCalls = [
    ...fetchCalls(0, CONTROL.firstResults),
    {function: sync('waitLightEvent'), args: [at(CONTROL.secondGate), 0, 0, 0]},
    {function: jump, args: [{u64: at(CONTROL.dispatch[2])}, 1, 0, 0]}
  ];
  const first = frame(loc.first, firstCalls, {
    0: CONTROL.firstResults,
    1: CONTROL.firstResults + 8,
    2: CONTROL.firstResults + 16
  });
  const restores = [
    [loc.gate, loc.gateSnapshot, gate.frame.length],
    [loc.acquire, loc.acquireSnapshot, acquire.frame.length],
    [loc.first, loc.firstSnapshot, first.frame.length],
    [loc.second, loc.secondSnapshot, 0]
  ];
  const secondCalls = [
    ...fetchCalls(1, CONTROL.secondResults),
    ...restores.map(([destination, source, bytes]) => ({
      function: copy,
      args: [destination, source, bytes, 0]
    })),
    {function: jump, args: [{u64: at(CONTROL.dispatch[3])}, 1, 0, 0]}
  ];
  let second = frame(loc.second, secondCalls, {
    0: CONTROL.secondResults,
    1: CONTROL.secondResults + 8,
    2: CONTROL.secondResults + 16
  });
  secondCalls[secondCalls.length - 2].args[2] = second.frame.length;
  second = frame(loc.second, secondCalls, {
    0: CONTROL.secondResults,
    1: CONTROL.secondResults + 8,
    2: CONTROL.secondResults + 16
  });
  const singleRestores = [
    [loc.gate, loc.gateSnapshot, gate.frame.length],
    [loc.singleAcquire, loc.singleAcquireSnapshot, singleAcquire.frame.length],
    [loc.singleFirst, loc.singleFirstSnapshot, 0]
  ];
  const singleFirstCalls = [
    ...fetchCalls(0, CONTROL.firstResults),
    ...singleRestores.map(([destination, source, bytes]) => ({
      function: copy,
      args: [destination, source, bytes, 0]
    })),
    {function: jump, args: [{u64: at(CONTROL.dispatch[3])}, 1, 0, 0]}
  ];
  let singleFirst = frame(loc.singleFirst, singleFirstCalls, {
    0: CONTROL.firstResults,
    1: CONTROL.firstResults + 8,
    2: CONTROL.firstResults + 16
  });
  singleFirstCalls[singleFirstCalls.length - 2].args[2] = singleFirst.frame.length;
  singleFirst = frame(loc.singleFirst, singleFirstCalls, {
    0: CONTROL.firstResults,
    1: CONTROL.firstResults + 8,
    2: CONTROL.firstResults + 16
  });
  if (
    loc.singleAcquire + singleAcquire.frame.length > loc.acquire ||
    loc.singleAcquireSnapshot + singleAcquire.frame.length > loc.first ||
    loc.singleFirst + singleFirst.frame.length > loc.second ||
    loc.singleFirstSnapshot + singleFirst.frame.length > loc.exit
  )
    throw Error('Paired single-output frame exceeds its reserved region');
  const stop = Buffer.alloc(0xb0);
  stop.writeBigUInt64LE(BigInt(sdk + CODE.exit.offset), 0x58);
  stop.writeBigUInt64LE(BigInt(base + 0x370000), 0x68);
  return {
    control: CONTROL,
    locations: loc,
    gate,
    acquire,
    singleAcquire,
    first,
    second,
    singleFirst,
    stop,
    calls: {
      gate: gateCalls,
      acquire: acquireCalls,
      singleAcquire: singleAcquireCalls,
      first: firstCalls,
      second: secondCalls,
      singleFirst: singleFirstCalls
    }
  };
}

module.exports = {CONTROL, locations, plan};
