const {allocate} = require('../../sdk/native/allocate.cjs');
const {sdkResolver, verify} = require('../../sdk/native/symbols.cjs');
const {create: createFinite} = require('../../sdk/native/finite.cjs');
const repeating = require('../../sdk/native/repeating.cjs');
const {CODE, verifyCode, verifyCopy, spawn, wait, join} = require('../../sdk/native/thread.cjs');
const SYNC = require('../../sdk/native/os-sync-functions.json');
const audioSocket = require('./audio-socket-plan.cjs');

const AUDIO_BYTES = 0x20000;
const EVENT_OFFSET = 0x100;
const PARAM_OFFSET = 0x300;
const DESCRIPTOR_OFFSET = 0x400;
const PCM_OFFSET = 0x10000;
const PCM_STRIDE = 0x4000;
const DESCRIPTOR_STRIDE = 0x40;
const SHORT = 2;
const OPEN_WITH_EVENT =
  'OpenDefaultAudioOutEPNS0_8AudioOutEPNS_2os11SystemEventERKNS0_17AudioOutParameterE';

function checkedPcm(bytes, length) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== length)
    throw Error('Socket audio needs one complete PCM chunk');
  return bytes;
}

async function create({rpc, transport, bufferBytes = 7680, timeoutMs = 5000}) {
  if (
    !rpc?.a?.sdk ||
    !transport ||
    !Number.isInteger(transport.fd) ||
    transport.fd < 0 ||
    !Number.isSafeInteger(transport.recvFunction) ||
    typeof transport.send !== 'function' ||
    !Number.isInteger(bufferBytes) ||
    bufferBytes < 4 ||
    bufferBytes > PCM_STRIDE ||
    bufferBytes % 4 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 60000
  )
    throw Error('Socket audio needs a bounded native TCP transport');
  await verifyCode(rpc);
  await verifyCopy(rpc);
  await verify(rpc, rpc.a.sdk + SYNC.waitSystemEvent.offset, SYNC.waitSystemEvent.hex);
  const resolve = sdkResolver(rpc, {ambiguous: 'Ambiguous socket audio function '});
  const names = [
    'InitializeAudioOutParameter',
    OPEN_WITH_EVENT,
    'GetAudioOutSampleRate',
    'GetAudioOutChannelCount',
    'GetAudioOutSampleFormat',
    'SetAudioOutBufferInfo',
    'AppendAudioOutBuffer',
    'StartAudioOut',
    'GetReleasedAudioOutBuffer',
    'GetAudioOutBufferCount',
    'StopAudioOut',
    'FlushAudioOutBuffers',
    'CloseAudioOut'
  ];
  const functions = {};
  for (const name of names) functions[name] = await resolve(name);
  const call = async (name, args = []) =>
    (await rpc.callAddress(functions[name], args, SHORT)).result;
  const audio = await allocate(rpc, AUDIO_BYTES, {
    align: 65536,
    failed: 'Socket audio allocation failed',
    invalid: 'Invalid socket audio allocation'
  });
  await rpc.write(audio, Buffer.alloc(65536));
  const event = audio + EVENT_OFFSET;
  const param = audio + PARAM_OFFSET;
  const slots = [0, 1].map(index => ({
    descriptor: audio + DESCRIPTOR_OFFSET + index * DESCRIPTOR_STRIDE,
    data: audio + PCM_OFFSET + index * PCM_STRIDE
  }));
  await call('InitializeAudioOutParameter', [param]);
  const parameter = await rpc.read(param, 8);
  parameter.writeUInt32LE(48000, 0);
  parameter.writeUInt16LE(2, 4);
  await rpc.write(param, parameter);
  if ((await call(OPEN_WITH_EVENT, [audio, event, param])) !== 0n)
    throw Error('Socket AudioOut event overload failed');
  let opened = true;
  let started = false;
  let running = false;
  let stopped = false;
  let retained = false;
  let thread = null;
  let program = null;
  let cycleRows = null;
  let cycleCallCount = 0;
  let sent = 0;
  try {
    if (
      (await call('GetAudioOutSampleRate', [audio])) !== 48000n ||
      (await call('GetAudioOutChannelCount', [audio])) !== 2n ||
      (await call('GetAudioOutSampleFormat', [audio])) !== 2n
    )
      throw Error('Unexpected socket AudioOut format');
    for (const slot of slots)
      await call('SetAudioOutBufferInfo', [slot.descriptor, slot.data, PCM_STRIDE, bufferBytes]);
    const finite = await createFinite(rpc, {
      verified: new Set([transport.recvFunction, functions.AppendAudioOutBuffer])
    });
    const workerBase = await allocate(rpc, 0x400000, {
      failed: 'Socket audio recycle worker allocation failed',
      invalid: 'Invalid socket audio recycle worker allocation'
    });
    const options = {
      sdk: rpc.a.sdk,
      base: workerBase,
      fd: transport.fd,
      audio,
      event,
      recv: transport.recvFunction,
      append: functions.AppendAudioOutBuffer,
      getReleased: functions.GetReleasedAudioOutBuffer,
      slots,
      bufferBytes
    };

    async function send(bytes) {
      if (stopped || retained) throw Error('Socket audio is no longer writable');
      await transport.send(checkedPcm(bytes, bufferBytes));
      sent++;
    }

    async function start(first, second) {
      if (started || stopped || retained) throw Error('Socket audio start is not available');
      checkedPcm(first, bufferBytes);
      checkedPcm(second, bufferBytes);
      await send(first);
      await send(second);
      const received = await finite
        .run(
          slots.map(slot => ({
            function: transport.recvFunction,
            args: [transport.fd, slot.data, bufferBytes, 0x40]
          }))
        )
        .catch(error => {
          retained = true;
          throw error;
        });
      if (received.some(value => Number(BigInt.asIntN(64, value)) !== bufferBytes))
        throw Error('Socket audio prime receive was short; append gate remains closed');
      const appended = await finite
        .run(
          slots.map(slot => ({
            function: functions.AppendAudioOutBuffer,
            args: [audio, slot.descriptor, 0, 0]
          }))
        )
        .catch(error => {
          retained = true;
          throw error;
        });
      if (appended.some(value => value !== 1n))
        throw Error('Socket AudioOut rejected prime buffer');
      const cycle = audioSocket.cycle(options);
      cycleRows = cycle.rows;
      cycleCallCount = cycle.calls.length;
      program = await repeating.prepare(rpc, {
        base: workerBase,
        code: CODE,
        calls: cycle.calls,
        verified: cycle.verified
      });
      if ((await call('StartAudioOut', [audio])) !== 0n)
        throw Error('Socket AudioOut start failed');
      started = true;
      try {
        thread = await spawn(rpc, workerBase, program.live, {
          failed: 'Socket audio recycle worker creation failed',
          outputBytes: SHORT
        });
      } catch (error) {
        retained = true;
        throw error;
      }
      running = true;
    }

    async function health() {
      if (!running || !program) return {sent, running, retained};
      const bytes = await rpc.read(program.results, cycleCallCount * 8);
      return {
        sent,
        running,
        retained,
        results: Array.from({length: cycleCallCount}, (_, index) =>
          String(bytes.readBigUInt64LE(index * 8))
        )
      };
    }

    async function stop() {
      if (stopped) {
        if (retained) throw Error('Socket audio objects retained for safety');
        return;
      }
      stopped = true;
      let cycleError = null;
      if (running) {
        try {
          await program.stop();
          await transport.send(Buffer.alloc(bufferBytes));
          await transport.send(Buffer.alloc(bufferBytes));
        } catch (error) {
          retained = true;
          throw error;
        }
        try {
          const done = await wait(rpc, thread, {
            timeoutMs,
            pollMs: 25,
            invalid: 'Socket audio recycle worker state invalid',
            outputBytes: SHORT
          });
          if (!done) throw Error('Socket audio recycle worker did not stop; restart SmileBASIC');
          await join(rpc, thread, workerBase + 8, {
            failed: 'Socket audio recycle worker join failed',
            outputBytes: SHORT
          });
        } catch (error) {
          retained = true;
          throw error;
        }
        running = false;
        const bytes = await rpc.read(program.results, cycleCallCount * 8);
        const results = Array.from({length: cycleCallCount}, (_, index) =>
          bytes.readBigUInt64LE(index * 8)
        );
        try {
          audioSocket.checkedCycle(results, cycleRows, slots, bufferBytes);
        } catch (error) {
          cycleError = error;
        }
      }
      if (retained) throw Error('Socket audio objects retained for safety');
      if (started) await call('StopAudioOut', [audio]);
      if (opened) {
        await call('FlushAudioOutBuffers', [audio]);
        await call('CloseAudioOut', [audio]);
        opened = false;
      }
      if (cycleError) throw cycleError;
    }

    return {
      start,
      send,
      health,
      stop,
      get retained() {
        return retained;
      }
    };
  } catch (error) {
    if (opened) {
      await call('FlushAudioOutBuffers', [audio]).catch(() => {});
      await call('CloseAudioOut', [audio]).catch(() => {});
    }
    throw error;
  }
}

module.exports = {create, checkedPcm};
