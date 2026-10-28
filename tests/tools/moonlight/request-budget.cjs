// Offline request budget for the staggered native H.264 host loop: a virtual-clock model of
// the lag-2 gate cycle, with the present pacer and the decode and receive waits it uses.
const cli = require('../../../../hbl-platform/sdk/cli.js');
const presentPacer = require('../../../host/stream/present-pacer.js');
const decodeWaits = require('../../../host/stream/decode-wait.js');
const receiveWaits = require('../../../host/stream/receive-wait.js');

// requestMs is the 3a figure (23.46 ms / 10.47 requests); that run has no overlapping
// requests, so it is pure bridge cost. decodeMs is the decode latency the host sees after
// the decode gate, fitted to the 3a poll counts.
const MODEL = {
  requestMs: 2.24,
  decodeMs: 8.5,
  vsyncMs: 1000 / 60,
  receiveMs: 2,
  submitMs: 0.5,
  fetchMs: 1.5,
  sourceFps: 30
};
const R3_DECODE_MS = 6.85;
// staggered-live.js rereads a late gate status back to back; it paused 5 ms before.
const STAGGERED = {retryWaitMs: 0, audioIntervalMs: 1000};
// A 1080p120 access unit on the QXCfhS live run averaged this size.
const UNIT_BYTES = 24576;
const GATE_WAITER = {progressPollMs: 0.5, bridgeWaitMs: 1};

function createClock() {
  let now = 0;
  let order = 0;
  const timers = [];
  const schedule = (callback, ms = 0, ...args) => {
    const timer = {at: now + Math.max(0, Number(ms) || 0), order: order++, callback, args};
    timers.push(timer);
    return timer;
  };
  const cancel = timer => {
    const index = timers.indexOf(timer);
    if (index >= 0) timers.splice(index, 1);
  };
  return {
    now: () => now,
    schedule,
    sleep: ms => new Promise(resolve => schedule(resolve, ms)),
    async run(body) {
      const immediate = setImmediate;
      const saved = [globalThis.setTimeout, globalThis.clearTimeout, Date.now];
      globalThis.setTimeout = schedule;
      globalThis.clearTimeout = cancel;
      Date.now = () => now;
      try {
        let settled = false;
        const result = body();
        result.then(
          () => (settled = true),
          () => (settled = true)
        );
        while (!settled) {
          await new Promise(resolve => immediate(resolve));
          if (settled) break;
          if (!timers.length) throw Error('Request budget simulation stalled');
          timers.sort((a, b) => a.at - b.at || a.order - b.order);
          const timer = timers.shift();
          now = timer.at;
          timer.callback(...timer.args);
        }
        return await result;
      } finally {
        [globalThis.setTimeout, globalThis.clearTimeout, Date.now] = saved;
      }
    }
  };
}

// R(N) reads one status snapshot, W(N) is one writeAndCall that opens decode gate N
// and fetch gate N-1. A late receive, acquire or renderer ack costs one extra read
// after an off-bridge wait. With a modeled host wait, retryRate injects a
// retryInputSlot RPC after the first eligible status and one follow-up read.
// Without a host wait, retryRate retains the older one-extra-read estimate.
// With barrier set the console orders each submit as in cb183ad: gate N releases the
// held output first (fetchMs), then N is submitted once output N-1 is acquired. The
// host side is unchanged.
// With hostWait set the host reads status instead of waking exactly when the frame
// is ready. The waiter arms with the gate write, samples GPU-applied status every
// 0.5 ms, and pairs a bounded event wait with one status copy in one bridge request.
// Its hint still needs the same host-side status check before the next gate opens.
// skipRule 'backlog' is the T23 rule: with more than skipBacklog units queued an output goes
// off screen, at most maxSkips in a row, and every published output is waited for. skipRule
// 'vsync' (poll or pacer host wait only) keeps at most one publication pending and publishes
// the newest output once that one is applied; until then outputs go off screen. A gate waits
// for the pending publication only while no more than skipBacklog units are queued, or once it
// has been pending for two vsync periods. presented counts applied publications.
// decodeWait (vsync rule only) sleeps to the acquire decode-wait.js predicts instead of
// rereading while the input is pending; receiveWait does the same for a pending receive with
// receive-wait.js.
async function simulate({
  frames = 120,
  warmup = 4,
  paced = true,
  presentHz = 60,
  appliedHz = presentHz,
  retryRate = 0,
  lag = 1,
  barrier = false,
  retryWaitMs = STAGGERED.retryWaitMs,
  hostWait = null,
  skipBacklog = null,
  maxSkips = 4,
  skipRule = 'backlog',
  decodeWait = false,
  receiveWait = false,
  model = MODEL
}) {
  if (hostWait && !['poll', 'pacer', 'waiter'].includes(hostWait))
    throw Error('Unknown staggered host wait ' + hostWait);
  if (!['backlog', 'vsync'].includes(skipRule))
    throw Error('Unknown staggered skip rule ' + skipRule);
  if (skipRule === 'vsync' && (!['poll', 'pacer'].includes(hostWait) || skipBacklog === null))
    throw Error('The vsync skip rule needs a poll or pacer host wait and a backlog threshold');
  if (decodeWait && skipRule !== 'vsync') throw Error('The decode wait needs the vsync skip rule');
  const timing = {...model, vsyncMs: 1000 / presentHz};
  const applyMs = 1000 / appliedHz;
  const clock = createClock();
  return clock.run(async () => {
    const interval = 1000 / timing.sourceFps;
    const origin = clock.now();
    const decoded = [];
    let busyUntil = 0;
    let exchanges = 0;
    let bridgeMs = 0;
    let decoderFree = 0;
    let sent = origin;
    let started = origin;
    let presented = 0;
    let skipped = 0;
    let skips = 0;
    const offScreen = new Set();
    let retryDebt = 0;
    let nextAudio = origin;
    let rereads = 0;
    let inputSlotRetryRpcs = 0;
    let waiterBridgeMs = 0;
    let fetchOpened = null;
    let pending = null;
    const vsyncRule = skipRule === 'vsync';
    const queued = frame =>
      paced
        ? Math.min(warmup + frames, Math.floor((clock.now() - origin) / interval) + 1) - frame - 1
        : warmup + frames - frame - 1;
    const pacer = presentPacer.create({
      periodMs: timing.vsyncMs,
      now: clock.now,
      sleep: clock.sleep
    });
    const request = async (waitMs = 0) => {
      busyUntil = Math.max(clock.now(), busyUntil) + timing.requestMs + waitMs;
      exchanges++;
      bridgeMs += timing.requestMs + waitMs;
      await clock.sleep(busyUntil - clock.now());
    };
    const decode = decodeWait ? decodeWaits.create({now: clock.now, sleep: clock.sleep}) : null;
    const receive = receiveWait
      ? receiveWaits.create({maxSleepMs: timing.vsyncMs, now: clock.now, sleep: clock.sleep})
      : null;
    receive?.sent(0, UNIT_BYTES, sent);
    const applied = [];
    const apply = (frame, fetchDone, skip) => {
      if (skip) {
        applied[frame] = frame ? applied[frame - 1] : 0;
        return;
      }
      const vsync = Math.ceil((fetchDone + 1e-6) / applyMs) * applyMs;
      applied[frame] = Math.max(vsync, frame ? applied[frame - 1] + applyMs : 0);
    };
    for (let frame = 0; frame < warmup + frames; frame++) {
      if (frame === warmup) {
        exchanges = 0;
        bridgeMs = 0;
        presented = 0;
        skipped = 0;
        retryDebt = 0;
        rereads = 0;
        inputSlotRetryRpcs = 0;
        started = clock.now();
        nextAudio = started;
      }
      const arrival = paced ? origin + frame * interval : origin;
      const receiveReady = sent + timing.receiveMs;
      const inputReady = Math.max(receiveReady, frame >= lag ? decoded[frame - lag] : 0);
      const presentReady = frame > lag ? applied[frame - lag - 1] : 0;
      const ready = hostWait ? arrival : Math.max(arrival, inputReady, presentReady);
      if (ready > clock.now()) await clock.sleep(ready - clock.now());
      if (clock.now() >= nextAudio) {
        nextAudio += STAGGERED.audioIntervalMs;
        await request();
      }
      retryDebt += retryRate;
      const inputSlotRetry = hostWait && retryDebt >= 1;
      if (retryDebt >= 1) {
        retryDebt -= 1;
        if (!hostWait) {
          await request();
          await clock.sleep(retryWaitMs);
        }
      }
      const acked = vsyncRule
        ? pending !== null &&
          (queued(frame) <= skipBacklog || clock.now() - pending.at > 2 * pacer.periodMs)
        : frame > lag && !offScreen.has(frame - lag - 1);
      if (vsyncRule) {
        let retriedInputSlot = false;
        const due = pending ? pending.applied : 0;
        if (acked) await pacer.beforeRead(pending.at);
        let at;
        let inputSeen = false;
        let pendingSeen = false;
        let receiveSeen = false;
        let receivePendingSeen = false;
        for (;;) {
          const linkWaited =
            receive && !receiveSeen
              ? await receive.beforeRead(frame, receivePendingSeen, timing.requestMs)
              : false;
          const waited = decode
            ? await decode.beforeRead(frame - lag, pendingSeen, timing.requestMs)
            : false;
          const startedAt = clock.now();
          await request();
          at = clock.now();
          if (pending) pacer.observe(startedAt, due <= at, pending.at);
          if (receive && !receiveSeen) {
            receiveSeen = receiveReady <= at;
            receive.observe(frame, at, receiveSeen, {
              waited: linkWaited,
              pendingSeen: receivePendingSeen
            });
            receivePendingSeen ||= !receiveSeen;
          }
          if (!inputSeen) decode?.observe(frame - lag, at, inputReady <= at, {waited, pendingSeen});
          inputSeen ||= inputReady <= at;
          pendingSeen ||= !inputSeen && frame >= lag;
          if (inputSlotRetry && !retriedInputSlot && inputReady <= at) {
            await request();
            inputSlotRetryRpcs++;
            retriedInputSlot = true;
            rereads++;
            continue;
          }
          if (inputReady <= at && (!acked || due <= at)) break;
          rereads++;
          if (inputReady <= at && hostWait === 'pacer') await pacer.pending();
        }
        if (pending && due <= at) {
          if (frame >= warmup) presented++;
          pending = null;
        }
      } else if (hostWait) {
        let retriedInputSlot = false;
        if (hostWait !== 'poll' && acked) await pacer.beforeRead(fetchOpened);
        const sampledPresentReady = acked
          ? Math.ceil((presentReady + 1e-6) / GATE_WAITER.progressPollMs) *
            GATE_WAITER.progressPollMs
          : 0;
        const waiterReady = Math.max(inputReady, sampledPresentReady);
        let receiveSeen = false;
        let receivePendingSeen = false;
        for (;;) {
          const linkWaited =
            receive && !receiveSeen
              ? await receive.beforeRead(frame, receivePendingSeen, timing.requestMs)
              : false;
          const startedAt = clock.now();
          const waitMs =
            hostWait === 'waiter'
              ? Math.max(0, Math.min(GATE_WAITER.bridgeWaitMs, waiterReady - startedAt))
              : 0;
          await request(waitMs);
          waiterBridgeMs += waitMs;
          const at = clock.now();
          if (acked) pacer.observe(startedAt, presentReady <= at);
          if (receive && !receiveSeen) {
            receiveSeen = receiveReady <= at;
            receive.observe(frame, at, receiveSeen, {
              waited: linkWaited,
              pendingSeen: receivePendingSeen
            });
            receivePendingSeen ||= !receiveSeen;
          }
          if (inputSlotRetry && !retriedInputSlot && inputReady <= at) {
            await request();
            inputSlotRetryRpcs++;
            retriedInputSlot = true;
            rereads++;
            continue;
          }
          const generationReady = hostWait !== 'waiter' || waiterReady <= at;
          if (generationReady && inputReady <= at && presentReady <= at) break;
          rereads++;
          if (inputReady <= at && hostWait !== 'poll') await pacer.pending();
        }
      } else await request();
      await request();
      decode?.opened(frame, clock.now());
      if (frame >= lag) fetchOpened = clock.now();
      let submit = clock.now();
      if (barrier && frame)
        submit = Math.max(submit + (frame >= lag ? timing.fetchMs : 0), decoded[frame - 1]);
      decoded[frame] = Math.max(submit, decoderFree) + timing.decodeMs;
      decoderFree = decoded[frame];
      const arrived = paced
        ? Math.min(warmup + frames, Math.floor((clock.now() - origin) / interval) + 1)
        : warmup + frames;
      if (vsyncRule) {
        if (frame >= lag && pending) skipped++;
        else if (frame >= lag) {
          const fetchDone = clock.now() + timing.fetchMs;
          const vsync = Math.ceil((fetchDone + 1e-6) / applyMs) * applyMs;
          pending = {at: clock.now(), applied: vsync};
        }
        sent = clock.now();
        receive?.sent(frame + 1, UNIT_BYTES, sent);
        continue;
      }
      const skip =
        skipBacklog !== null &&
        frame > lag &&
        arrived - frame - 1 > skipBacklog &&
        skips < maxSkips;
      skips = skip ? skips + 1 : 0;
      if (skip) offScreen.add(frame - lag);
      if (frame >= lag) apply(frame - lag, clock.now() + timing.fetchMs, skip);
      sent = clock.now();
      receive?.sent(frame + 1, UNIT_BYTES, sent);
      if (frame >= lag && skip) skipped++;
      else if (frame >= lag) presented++;
    }
    const elapsed = clock.now() - started;
    const outputs = vsyncRule ? frames : presented + skipped;
    const perFrame = value => Math.round((value / outputs) * 100) / 100;
    return {
      frames: presented,
      paced,
      staggered: true,
      presentHz,
      appliedHz,
      appliedPeriodMs: pacer.periodMs,
      pacer: pacer.counters,
      retryRate,
      lag,
      barrier,
      retryWaitMs,
      hostWait,
      rereadsPerFrame: perFrame(rereads),
      inputSlotRetryRpcsPerFrame: perFrame(inputSlotRetryRpcs),
      waiterBridgeMsPerFrame: perFrame(waiterBridgeMs),
      skipBacklog,
      skipRule,
      decodeWait,
      receiveWait,
      skipped,
      requestsPerFrame: perFrame(exchanges),
      bridgeMsPerFrame: perFrame(bridgeMs),
      msPerFrame: perFrame(elapsed),
      fps: Math.round((presented * 100000) / elapsed) / 100,
      decodedFps: Math.round((outputs * 100000) / elapsed) / 100
    };
  });
}

async function budget({frames = 120, model = MODEL} = {}) {
  const staggered = {};
  for (const sourceFps of [60, 120]) {
    for (const presentHz of [60, 120]) {
      for (const retryRate of [0, 0.1, 0.3]) {
        const options = {frames, presentHz, retryRate};
        const rate = {...model, sourceFps};
        const paced = await simulate({...options, model: rate});
        const free = await simulate({...options, model: rate, paced: false});
        staggered[`${sourceFps}fps-${presentHz}Hz-retry${retryRate * 100}`] = {
          requestsPerFrame: paced.requestsPerFrame,
          bridgeMsPerFrame: paced.bridgeMsPerFrame,
          fps: paced.fps,
          predictedFps: free.fps
        };
      }
    }
  }
  const staggeredLag2 = {};
  for (const decodeMs of [model.decodeMs, R3_DECODE_MS]) {
    for (const retryRate of [0, 0.1, 0.3]) {
      const options = {frames, presentHz: 120, retryRate, lag: 2};
      const rate = {...model, decodeMs, sourceFps: 120};
      const paced = await simulate({...options, model: rate});
      const free = await simulate({...options, model: rate, paced: false});
      staggeredLag2[`120fps-120Hz-decode${decodeMs}-retry${retryRate * 100}`] = {
        requestsPerFrame: paced.requestsPerFrame,
        bridgeMsPerFrame: paced.bridgeMsPerFrame,
        fps: paced.fps,
        predictedFps: free.fps
      };
    }
  }
  const staggeredBarrier = {};
  for (const sourceFps of [60, 120]) {
    for (const presentHz of [60, 120]) {
      for (const decodeMs of [model.decodeMs, R3_DECODE_MS]) {
        for (const retryRate of [0, 0.1, 0.3]) {
          const options = {frames, presentHz, retryRate, lag: 2};
          const rate = {...model, decodeMs, sourceFps};
          const paced = await simulate({...options, barrier: true, model: rate});
          const free = await simulate({...options, barrier: true, model: rate, paced: false});
          const open = await simulate({...options, model: rate, paced: false});
          staggeredBarrier[
            `${sourceFps}fps-${presentHz}Hz-decode${decodeMs}-retry${retryRate * 100}`
          ] = {
            requestsPerFrame: paced.requestsPerFrame,
            bridgeMsPerFrame: paced.bridgeMsPerFrame,
            fps: paced.fps,
            predictedFps: free.fps,
            predictedFpsWithoutBarrier: open.fps
          };
        }
      }
    }
  }
  const staggeredRetryWait = {};
  for (const decodeMs of [model.decodeMs, R3_DECODE_MS]) {
    for (const retryRate of [0.1, 0.3]) {
      for (const retryWaitMs of [5, 1, 0]) {
        const options = {frames, presentHz: 120, retryRate, lag: 2};
        const rate = {...model, decodeMs, sourceFps: 120};
        const free = await simulate({
          ...options,
          barrier: true,
          retryWaitMs,
          model: rate,
          paced: false
        });
        staggeredRetryWait[`decode${decodeMs}-retry${retryRate * 100}-wait${retryWaitMs}`] = {
          requestsPerFrame: free.requestsPerFrame,
          predictedFps: free.fps
        };
      }
    }
  }
  const staggeredHostWait = {};
  for (const presentHz of [60, 120]) {
    for (const paced of [true, false]) {
      for (const hostWait of ['poll', 'pacer', 'waiter']) {
        const result = await simulate({
          frames,
          presentHz,
          lag: 2,
          barrier: true,
          hostWait,
          paced,
          model: {...model, sourceFps: presentHz}
        });
        staggeredHostWait[`${presentHz}Hz-${paced ? 'paced' : 'unpaced'}-${hostWait}`] = {
          requestsPerFrame: result.requestsPerFrame,
          bridgeMsPerFrame: result.bridgeMsPerFrame,
          rereadsPerFrame: result.rereadsPerFrame,
          fps: result.fps
        };
      }
    }
  }
  const staggered120HzGateWaiter = {};
  for (const decodeMs of [R3_DECODE_MS, MODEL.decodeMs]) {
    for (const retryRate of [0, 0.1, 0.3]) {
      const options = {
        frames,
        presentHz: 120,
        lag: 2,
        barrier: true,
        paced: false,
        retryRate,
        model: {...model, decodeMs, sourceFps: 120}
      };
      const current = await simulate({...options, hostWait: 'pacer'});
      const waiter = await simulate({...options, hostWait: 'waiter'});
      staggered120HzGateWaiter[`decode${decodeMs}-retry${retryRate * 100}`] = {
        current: {
          fps: current.fps,
          requestsPerFrame: current.requestsPerFrame,
          bridgeMsPerFrame: current.bridgeMsPerFrame
        },
        waiter: {
          fps: waiter.fps,
          requestsPerFrame: waiter.requestsPerFrame,
          bridgeMsPerFrame: waiter.bridgeMsPerFrame,
          waiterBridgeMsPerFrame: waiter.waiterBridgeMsPerFrame
        }
      };
    }
  }
  const staggeredDecodeWait = {};
  for (const presentHz of [60, 120]) {
    for (const decodeMs of [model.decodeMs, R3_DECODE_MS]) {
      for (const retryRate of [0, 0.1, 0.3]) {
        const options = {
          frames,
          presentHz,
          lag: 2,
          barrier: true,
          hostWait: 'pacer',
          skipBacklog: 1,
          skipRule: 'vsync',
          retryRate,
          model: {...model, sourceFps: 120, decodeMs}
        };
        const reread = await simulate(options);
        const waited = await simulate({...options, decodeWait: true});
        staggeredDecodeWait[`${presentHz}Hz-decode${decodeMs}-retry${retryRate * 100}`] = {
          requestsPerFrame: [reread.requestsPerFrame, waited.requestsPerFrame],
          fps: [reread.fps, waited.fps]
        };
      }
    }
  }
  return {
    frames,
    model,
    assumptions: [
      'Requests, bridge-ms and byStage are at the paced source rate; predictedFps is the same loop with every access unit already waiting.',
      'The loop mirrors the native-h264.js staggered steady state.',
      'The 120 Hz gate-waiter matrix uses unpaced 120 fps source, two decodes in flight, the acquire barrier, one paired status request and one gate write per normal AU. A waiter event is a hint; the model requires the same status readiness before opening the next gate.',
      'Retry 10/30% in the 120 Hz comparison means one retryInputSlot RPC plus its follow-up status read on that fraction of frames, after the first ready input status. The waiter adds up to 1 ms of serialized bridge wait per status request and samples GPU-applied status at 0.5 ms intervals.'
    ],
    staggered,
    staggeredLag2,
    staggeredBarrier,
    staggeredRetryWait,
    staggeredHostWait,
    staggered120HzGateWaiter,
    staggeredDecodeWait
  };
}

if (require.main === module) {
  const frames = cli.number(process.argv, '--frames', 120);
  if (!Number.isInteger(frames) || frames < 1) {
    console.error('Usage: node tools/moonlight/request-budget.cjs [--frames N]');
    process.exit(2);
  }
  budget({frames}).then(
    result => console.log(JSON.stringify(result, null, 2)),
    error => {
      console.error(error);
      process.exit(1);
    }
  );
}

module.exports = {MODEL, STAGGERED, GATE_WAITER, createClock, simulate, budget};
