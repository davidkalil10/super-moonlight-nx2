// The native H.264 host loop and the access-unit reader that feeds it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter, once} = require('node:events');
const {PassThrough} = require('node:stream');
const {
  run,
  createIdrRequester,
  countsSince,
  receiveRow,
  auTiming,
  hiddenQueue,
  hiddenTiming,
  withInputStage
} = require('../../../host/stream/native-h264.js');
const {AccessUnits, parameterSets} = require('../../../host/stream/h264-stream.js');

// native-h264.js
const accessUnit = Buffer.from('0000016742001eab00000168ce0100000165abcd', 'hex');
const pcm = Buffer.from('0001020304050607', 'hex');

test('stats rows report staggered waits since the previous row', () => {
  assert.deepEqual(countsSince({receive: 7, applied: 2}, {receive: 4, applied: 2}), {receive: 3});
  assert.deepEqual(countsSince({slot: 1}, {}), {slot: 1});
  assert.deepEqual(countsSince({}, {}), {});
});

test('the helper stamps split the time before arrival into its parts', () => {
  const stamps = {receiveMs: 4, queueMs: 0.5, queued: 0, unread: 0, writeMs: 0.1, hostMs: 0};
  assert.deepEqual(hiddenQueue({...stamps, writtenAt: 1000}, 1003), {
    totalMs: 7,
    pipeMs: 3,
    ...stamps
  });
  assert.equal(hiddenQueue({seq: 1, bytes: 9}, 1003), null, 'an unstamped unit has none');
  const {hostMs, ...older} = stamps;
  assert.equal(hiddenQueue({...older, writtenAt: 1000}, 1003).hostMs, hostMs, 'no hostMs is 0');
  const late = {receiveMs: 6, queueMs: 2.5, queued: 2, unread: 4096, writeMs: 0.3, hostMs: 0};
  assert.deepEqual(
    hiddenTiming([
      {hidden: hiddenQueue({...stamps, writtenAt: 1000}, 1003)},
      {hidden: null},
      {hidden: hiddenQueue({...late, writtenAt: 1020}, 1030)}
    ]),
    {
      units: 2,
      totalMs: {mean: 11.5, max: 16},
      pipeMs: {mean: 6.5, max: 10},
      receiveMs: {mean: 5, max: 6},
      queueMs: {mean: 1.5, max: 2.5},
      queued: {mean: 1, max: 2},
      unread: {mean: 2048, max: 4096},
      writeMs: {mean: 0.2, max: 0.3}
    }
  );
  assert.equal(hiddenTiming([{hidden: null}]), null, 'a row with no stamps reports none');
  const hosted = hiddenTiming(
    [3, 0, 5.2].map(ms => ({hidden: hiddenQueue({...stamps, hostMs: ms, writtenAt: 1000}, 1003)}))
  );
  assert.deepEqual(hosted?.hostMs, {units: 2, mean: 4.1, max: 5.2}, 'host times of 0 are skipped');
  assert.equal(hosted?.units, 3);
  assert.equal(hiddenTiming([]), null);
});

test('a stats row carries the receive sleeps since its start and the latest estimate', () => {
  const now = {sleeps: 7, ms: 20.04, fixedMs: 3.26};
  assert.deepEqual(receiveRow(now, {sleeps: 4, ms: 8}), {sleeps: 3, sleptMs: 12, fixedMs: 3.3});
  assert.deepEqual(receiveRow(now, null), {sleeps: 7, sleptMs: 20, fixedMs: 3.3});
});

test('access-unit timing reports the wait to send, the age at gate and the units in hand', () => {
  assert.deepEqual(
    auTiming([
      {arrivedAt: 100, gatedAt: null, sentAt: 103, inHand: null},
      {arrivedAt: 110, gatedAt: 130, sentAt: 132.5, inHand: 1},
      {arrivedAt: 120, gatedAt: 150, sentAt: 151, inHand: 3}
    ]),
    {units: 3, gated: 2, waitMs: 18.8, maxWaitMs: 31, gateAgeMs: 25, inHand: 2, maxInHand: 3}
  );
  assert.deepEqual(auTiming([]), {
    units: 0,
    gated: 0,
    waitMs: null,
    maxWaitMs: null,
    gateAgeMs: null,
    inHand: null,
    maxInHand: null
  });
});

test('the input feeder counts land in bridgeByStage, not in the row totals', () => {
  const counts = {
    exchanges: 10,
    bridgeMs: 20,
    bridgeByStage: {read: {exchanges: 10, bridgeMs: 20}}
  };
  assert.deepEqual(withInputStage(counts, {exchanges: 120, bridgeMs: 240.4}), {
    exchanges: 10,
    bridgeMs: 20,
    bridgeByStage: {read: {exchanges: 10, bridgeMs: 20}, input: {exchanges: 120, bridgeMs: 240}}
  });
  assert.deepEqual(
    withInputStage({exchanges: 0, bridgeMs: 0, bridgeByStage: {}}, {exchanges: 0, bridgeMs: 0}),
    {
      exchanges: 0,
      bridgeMs: 0,
      bridgeByStage: {}
    }
  );
});

test('backlog IDR requests recover within 100 ms and coalesce dropped frames', () => {
  let time = 1000;
  let nextTimer = 0;
  const timers = new Map();
  const sent = [];
  const requester = createIdrRequester(() => sent.push(time), {
    now: () => time,
    schedule(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, {at: time + delay, callback});
      return id;
    },
    cancel: id => timers.delete(id)
  });
  function advance(to) {
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > to) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    time = to;
  }
  requester.request();
  requester.request();
  advance(1000);
  assert.deepEqual(sent, [1000]);
  advance(1020);
  requester.request();
  requester.request();
  advance(1099);
  assert.deepEqual(sent, [1000]);
  advance(1100);
  assert.deepEqual(sent, [1000, 1100]);
  requester.request();
  requester.close();
  advance(2000);
  assert.deepEqual(sent, [1000, 1100]);
});

async function fixture({
  hangSubmit = 0,
  slowSubmit = 0,
  audioFailure = false,
  emptyPolls = 0,
  units = [{hex: accessUnit.toString('hex'), keyframe: true, pts: 123456}]
} = {}) {
  const root = process.env.HB_NATIVE_TEST_DIR || path.join(os.tmpdir(), 'hbl-native-h264-tests');
  await fs.mkdir(root, {recursive: true});
  const directory = await fs.mkdtemp(path.join(root, 'pipes-'));
  await fs.writeFile(
    path.join(directory, 'app-runtime.json'),
    JSON.stringify({active: {id: 'moonlight'}})
  );
  const events = [];
  const children = [];
  let pipeline = 0,
    pending = 0;
  const options = {
    args: ['--moonlight', 'host', 'Desktop'],
    directory,
    rpc: {
      a: {session: 'test-session', protocol: 3},
      host: '192.0.2.10',
      request: () =>
        new Promise((resolve, reject) =>
          slowSubmit
            ? setTimeout(resolve, slowSubmit)
            : setTimeout(() => reject(Error('Console response timed out')), hangSubmit)
        )
    },
    storage: {},
    helperPath: 'test-helper',
    createStaggered: staggeredFake(events),
    sourceRevision: '049e2efe32799194a16c2f2f871025c1961aaade',
    width: 128,
    height: 96,
    fps: 30,
    async createTransport({host}) {
      events.push({type: 'create-transport', host});
      return {
        async close() {
          events.push({type: 'close-transport'});
        }
      };
    },
    async createSink() {
      let workerSequence = 0;
      return {
        workerPublication: {mapped: 0x1000000, color: 1},
        async destination() {
          events.push({type: 'destination'});
          return {address: 0x1000000, bytes: 32768, index: 1};
        },
        async publish(destination, frame) {
          events.push({type: 'publish', destination, frame});
        },
        async workerDestination(presentation) {
          events.push({type: 'worker-destination', presentation});
          return {
            address: 0x1000000 + ++workerSequence * 32768,
            bytes: 32768,
            index: workerSequence % 3,
            sequence: workerSequence,
            color: 1
          };
        },
        async wait() {},
        async close() {
          events.push({type: 'sink-close'});
        }
      };
    },
    async createDecoder(config) {
      events.push({
        type: 'create-decoder',
        mode: config.workerMode,
        publication: config.publication,
        splitWorkerFactory: config.splitWorkerFactory
      });
      return {
        async configure(sps, pps, fps) {
          events.push({type: 'configure', sps, pps, fps});
        },
        async submit(unit) {
          if (hangSubmit || slowSubmit) await config.rpc.request();
          events.push({type: 'submit', unit});
          pipeline++;
        },
        async receive() {
          events.push({type: 'receive'});
          if (pending < emptyPolls) {
            pending++;
            return null;
          }
          pending = 0;
          if (pipeline <= 0) return null;
          pipeline--;
          return {format: 'nv12', width: 128, height: 96, stride: 128, sliceHeight: 96};
        },
        async close() {
          events.push({type: 'decoder-close'});
          await config.transport?.close();
        }
      };
    },
    spawnProcess(command, args, spawnOptions) {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.stdio = [];
      child.kill = signal => {
        if (child.exitCode !== null || child.signalCode !== null) return true;
        child.signalCode = signal;
        setImmediate(() => child.emit('exit', 0, signal));
        return true;
      };
      if (command === 'test-helper') {
        assert.deepEqual(args.slice(-4), ['--raw-h264-fd', '4', '--audio-fd', '3']);
        child.stdin = new PassThrough();
        child.stderr = new PassThrough();
        child.stdio = [child.stdin, null, child.stderr, new PassThrough(), new PassThrough()];
        const lines = [];
        let pending = '';
        child.stdin.on('data', chunk => {
          pending += chunk.toString();
          for (;;) {
            const end = pending.indexOf('\n');
            if (end < 0) break;
            lines.push(JSON.parse(pending.slice(0, end)));
            pending = pending.slice(end + 1);
            if (lines.length !== 2) continue;
            fsSync.writeFileSync(path.join(directory, 'input.json'), JSON.stringify(lines));
            child.stdio[3].end(pcm);
            for (const unit of units) child.stdio[4].write(Buffer.from(unit.hex, 'hex'));
            child.stdio[4].end();
            units.forEach((unit, seq) => {
              child.stderr.write(
                JSON.stringify({
                  type: 'au',
                  seq,
                  frame: seq + 1,
                  bytes: Buffer.from(unit.hex, 'hex').length,
                  pts: unit.pts,
                  keyframe: unit.keyframe
                }) + '\n'
              );
            });
            child.stderr.end();
            child.exitCode = 0;
            setImmediate(() => child.emit('exit', 0, null));
          }
        });
      } else if (path.basename(args[0]) === 'input-feeder.js') {
        setImmediate(() => {
          spawnOptions.stdio[1].write(
            JSON.stringify({type: 'controller', buttonFlags: 8192}) + '\n'
          );
          spawnOptions.stdio[1].write(
            JSON.stringify({
              type: 'touch',
              events: [{id: 7, action: 'down', x: 0.25, y: 0.5, pressure: 0}]
            }) + '\n'
          );
        });
      } else if (path.basename(args[0]) === 'audio-stream.js') {
        if (audioFailure) {
          child.exitCode = 7;
          process.nextTick(() => child.emit('exit', 7, null));
        } else {
          const chunks = [];
          spawnOptions.stdio[0].on('data', chunk => chunks.push(chunk));
          spawnOptions.stdio[0].on('end', () => {
            fsSync.writeFileSync(path.join(directory, 'audio.pcm'), Buffer.concat(chunks));
            child.exitCode = 0;
            child.emit('exit', 0, null);
          });
        }
      } else throw Error('Unexpected child: ' + command);
      children.push(child);
      return child;
    }
  };
  return {options, events, directory, children};
}

async function exercise(f, body) {
  const previous = process.env.HB_NATIVE_LOG_DIR;
  process.env.HB_NATIVE_LOG_DIR = path.join(f.directory, 'logs');
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.HB_NATIVE_LOG_DIR;
    else process.env.HB_NATIVE_LOG_DIR = previous;
    for (const child of f.children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      });
    }
    for (const child of f.children) for (const stream of child.stdio) stream?.destroy();
    await fs.rm(f.directory, {recursive: true, force: true});
  }
}

test(
  'native stream carries H.264, PCM, controller and touch on their own pipes',
  {timeout: 5000},
  async () => {
    const f = await fixture();
    await exercise(f, async () => {
      await run(f.options);
      assert.deepEqual(await fs.readFile(path.join(f.directory, 'audio.pcm')), pcm);
      const input = JSON.parse(await fs.readFile(path.join(f.directory, 'input.json')));
      assert.deepEqual(
        input.map(line => line.type),
        ['controller', 'touch']
      );
      assert.equal(input[0].buttonFlags, 8192);
      assert.equal(input[1].events[0].id, 7);
      assert.deepEqual(f.events.find(event => event.type === 'submit').unit.data, accessUnit);
      assert.equal(f.events.find(event => event.type === 'submit').unit.pts, 123456);
      assert.equal(
        f.events.find(event => event.type === 'configure').sps.toString('hex'),
        '6742001eab'
      );
      assert.equal(f.events.filter(event => event.type === 'publish').length, 1);
      assert.equal(
        f.events.filter(event => event.type === 'receive').length,
        f.events.filter(event => event.type === 'submit').length,
        'one receive per submit; no known-empty acquireOutput poll'
      );
      assert.deepEqual(
        f.events.slice(-3).map(event => event.type),
        ['decoder-close', 'close-transport', 'sink-close']
      );
    });
  }
);

test(
  'a console that stops answering is reported, stops the stream and retains native objects',
  {timeout: 5000},
  async () => {
    const f = await fixture({hangSubmit: 2500});
    await exercise(f, async () => {
      await assert.rejects(run({...f.options, consoleStallMs: 300}), error =>
        error.errors.some(item => /restart SmileBASIC/.test(item.message))
      );
      assert.equal(
        f.events.some(event => event.type === 'decoder-close'),
        false
      );
      const events = (await fs.readFile(path.join(f.directory, 'logs', 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      const stalled = events.find(event => event.event === 'console-stalled');
      assert.ok(stalled && stalled.silentMs >= 300, 'the stall is reported before the timeout');
      assert.ok(
        events.some(event => event.event === 'native-stop' && event.reason === 'console-stalled')
      );
      assert.ok(events.some(event => event.event === 'native-retained'));
    });
  }
);

test(
  'a console that stops answering without losing the bridge fails the run',
  {timeout: 5000},
  async () => {
    const f = await fixture({slowSubmit: 1200});
    await exercise(f, async () => {
      const summary = await run({...f.options, consoleStallMs: 300});
      assert.equal(summary.stopReason, 'console-stalled');
      assert.equal(summary.pass, false);
      assert.ok(summary.failures.includes('console stopped answering'));
      const events = (await fs.readFile(path.join(f.directory, 'logs', 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(events.find(event => event.event === 'summary').mode, 'split');
    });
  }
);

test(
  'the first-frame drain waits for a late output before the staggered workers start',
  {timeout: 5000},
  async () => {
    const f = await fixture({emptyPolls: 2, units: pairedUnits(2)});
    await exercise(f, async () => {
      await run(f.options);
      const before = f.events.slice(
        0,
        f.events.findIndex(event => event.type === 'staggered-start')
      );
      assert.equal(before.filter(event => event.type === 'receive').length, 3);
      assert.equal(f.events.filter(event => event.type === 'staggered-start').length, 1);
    });
  }
);

test('the decoder gets its own TCP transport to the console host', {timeout: 5000}, async () => {
  const f = await fixture({units: pairedUnits(2)});
  await exercise(f, async () => {
    await run(f.options);
    assert.deepEqual(
      f.events.filter(event => event.type === 'create-transport').map(event => event.host),
      ['192.0.2.10']
    );
    assert.equal(f.events.filter(event => event.type === 'close-transport').length, 1);
  });
});

test(
  'stopping signals the helper before its video pipe closes and keeps draining it',
  {timeout: 5000},
  async () => {
    const f = await fixture();
    const seen = {};
    const spawnProcess = f.options.spawnProcess;
    f.options.spawnProcess = (command, args, options) => {
      const child = spawnProcess(command, args, options);
      if (command !== 'test-helper') return child;
      child.stdin.removeAllListeners('data');
      child.stdin.resume();
      child.stdio[3].end(pcm);
      const unit = (seq, keyframe) => {
        child.stdio[4].write(accessUnit, error => {
          if (error) seen.writeError = error.code;
        });
        child.stderr.write(
          JSON.stringify({
            type: 'au',
            seq,
            frame: seq + 1,
            bytes: accessUnit.length,
            pts: seq,
            keyframe
          }) + '\n'
        );
      };
      setImmediate(() => unit(0, true));
      child.kill = signal => {
        if (child.exitCode !== null) return true;
        seen.signal = signal;
        seen.destroyedAtSignal = child.stdio[4].destroyed;
        unit(1, false);
        child.stdio[4].end();
        child.stderr.end();
        child.exitCode = 0;
        setImmediate(() => child.emit('exit', 0, null));
        return true;
      };
      return child;
    };
    f.options.args.push('--duration', '0.3');
    await exercise(f, async () => {
      const summary = await run(f.options);
      assert.equal(summary.stopReason, 'duration');
      assert.equal(seen.signal, 'SIGINT');
      assert.equal(seen.destroyedAtSignal, false, 'the helper is signalled before the pipe closes');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(seen.writeError, undefined, 'late helper output is drained, not cut off');
    });
  }
);

test('a scored run writes summary.json and rejects a bare --expect', {timeout: 5000}, async () => {
  const f = await fixture();
  await exercise(f, async () => {
    f.options.args.push('--expect', 'fps=30,idr=0', '--duration', '30');
    const summary = await run(f.options);
    const saved = JSON.parse(
      await fs.readFile(path.join(f.directory, 'logs', 'summary.json'), 'utf8')
    );
    assert.deepEqual(saved, JSON.parse(JSON.stringify(summary)));
    assert.equal(saved.pass, false);
    assert.equal(saved.stopReason, 'cleanup');
    assert.ok(saved.failures.includes('ended before duration: cleanup'));
    assert.deepEqual(saved.expect, {fps: 30, idr: 0});
    assert.equal(saved.workerMode, 'staggered');
    const events = (await fs.readFile(path.join(f.directory, 'logs', 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.ok(events.some(event => event.event === 'helper-exit' && event.code === 0));
    assert.ok(events.some(event => event.event === 'native-stop' && event.reason === 'cleanup'));
  });
  const g = await fixture();
  await exercise(g, async () => {
    g.options.args.push('--expect', '--duration', '5');
    await assert.rejects(run(g.options), /--expect needs a value/);
  });
  const h = await fixture();
  await exercise(h, async () => {
    h.options.args.push('--queue', '0');
    await assert.rejects(run(h.options), /--queue takes 1 to 16/);
  });
});

test(
  'an audio process failure ends the native stream and releases decoder/display ownership',
  {timeout: 5000},
  async () => {
    const f = await fixture({audioFailure: true});
    await exercise(f, async () => {
      await assert.rejects(run(f.options), /audio stream exited: 7/);
      assert.deepEqual(
        f.events.slice(-3).map(event => event.type),
        ['decoder-close', 'close-transport', 'sink-close']
      );
    });
  }
);

test('--socket-audio cannot run without audio', {timeout: 5000}, async () => {
  const f = await fixture();
  await exercise(f, async () => {
    f.options.args.push('--socket-audio', '--no-audio');
    await assert.rejects(run(f.options), /--socket-audio cannot be combined with --no-audio/);
  });
});

test(
  '--socket-audio sends helper PCM to the socket source instead of audio-stream',
  {timeout: 5000},
  async () => {
    const f = await fixture();
    await exercise(f, async () => {
      const spawned = [];
      const spawnProcess = f.options.spawnProcess;
      f.options.spawnProcess = (command, args, options) => {
        spawned.push(command === 'test-helper' ? command : path.basename(args[0]));
        return spawnProcess(command, args, options);
      };
      const received = [];
      f.options.createSocketAudio = async config => {
        f.events.push({type: 'socket-audio', host: config.host, bufferBytes: config.bufferBytes});
        return {
          attach(stream) {
            stream.on('data', chunk => received.push(chunk));
          },
          halt() {
            f.events.push({type: 'socket-audio-halt'});
          },
          async close() {
            f.events.push({type: 'socket-audio-close'});
            return {sent: 4, underruns: 0, overruns: 0, droppedBytes: 0, error: null};
          }
        };
      };
      f.options.args.push('--socket-audio');
      const summary = await run(f.options);
      assert.deepEqual(spawned, ['test-helper', 'input-feeder.js']);
      assert.deepEqual(Buffer.concat(received), pcm);
      assert.deepEqual(
        f.events.find(event => event.type === 'socket-audio'),
        {
          type: 'socket-audio',
          host: '192.0.2.10',
          bufferBytes: 7680
        }
      );
      assert.deepEqual(
        f.events.slice(-5).map(event => event.type),
        ['socket-audio-close', 'staggered-stop', 'decoder-close', 'close-transport', 'sink-close']
      );
      assert.equal(summary.audioFrames, 1920);
      assert.equal(summary.socketAudio.sent, 4);
      const saved = (await fs.readdir(f.directory)).filter(name =>
        name.startsWith('moonlight-audio-')
      );
      assert.equal(saved.length, 1);
      const record = JSON.parse(await fs.readFile(path.join(f.directory, saved[0]), 'utf8'));
      assert.equal(record.mode, 'socket');
      assert.equal(record.session, 'test-session');
    });
  }
);

const pairedUnits = count =>
  Array.from({length: count}, (_, index) => ({
    hex: accessUnit.toString('hex'),
    keyframe: index === 0,
    pts: (index + 1) * 1000
  }));

function staggeredFake(events, {pushFails = null, stopFails = false} = {}) {
  return () => {
    let pending = false;
    events.push({type: 'staggered-create'});
    return {
      async factory() {},
      start({frame}) {
        events.push({type: 'staggered-start', layout: frame});
      },
      async push(unit, {sink, onDecoded, onPresented}) {
        events.push({type: 'staggered-push', pts: unit.pts});
        if (unit.pts === pushFails) throw Error('Short receive 10/20');
        if (pending) {
          await sink.workerDestination({current: 0, applied: 0});
          onDecoded(1);
          onPresented(1);
        }
        pending = true;
      },
      async finish({onDecoded, onPresented}) {
        events.push({type: 'staggered-finish'});
        pending = false;
        onDecoded(2);
        onPresented(2);
        return {drained: 2};
      },
      async snapshot() {
        events.push({type: 'staggered-snapshot'});
        return {receive: {sequence: 1, count: '10'}};
      },
      async stop() {
        events.push({type: 'staggered-stop'});
        if (stopFails) throw Error('Staggered worker native objects retained; restart SmileBASIC');
      },
      exists: true,
      get pending() {
        return pending;
      },
      get counts() {
        return {submitted: 5, decoded: 5, presented: 5, tailDrained: 2, waiting: {}};
      }
    };
  };
}

test(
  '--staggered queues 8 units by default so a source burst is not dropped',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(6)});
    f.options.createStaggered = staggeredFake(f.events);
    f.options.args.push('--staggered');
    await exercise(f, async () => {
      assert.equal((await run(f.options)).queue, 8);
    });
  }
);

test(
  '--staggered feeds units after the host IDR, drains the tail, then stops before the decoder',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(6)});
    f.options.createStaggered = staggeredFake(f.events);
    f.options.args.push('--staggered', '--queue', '16');
    await exercise(f, async () => {
      const summary = await run(f.options);
      const created = f.events.find(event => event.type === 'create-decoder');
      assert.equal(created.mode, 'split');
      assert.deepEqual(created.publication, {mapped: 0x1000000, color: 1});
      assert.equal(typeof created.splitWorkerFactory, 'function');
      const names = f.events.map(event => event.type);
      assert.ok(names.indexOf('publish') < names.indexOf('staggered-start'));
      assert.equal(names.includes('start-split'), false);
      assert.equal(f.events.find(event => event.type === 'staggered-start').layout.width, 128);
      assert.deepEqual(
        f.events.filter(event => event.type === 'staggered-push').map(event => event.pts),
        [2000, 3000, 4000, 5000, 6000]
      );
      assert.ok(names.lastIndexOf('staggered-push') < names.indexOf('staggered-finish'));
      assert.deepEqual(names.slice(-4), [
        'staggered-stop',
        'decoder-close',
        'close-transport',
        'sink-close'
      ]);
      assert.equal(summary.workerMode, 'staggered');
      assert.deepEqual(summary.staggered.tail, {drained: 2});
      assert.equal(summary.staggered.tailDrained, 2);
    });
  }
);

test(
  'a failed staggered check snapshots the worker and stops it without a tail',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(4)});
    f.options.createStaggered = staggeredFake(f.events, {pushFails: 3000});
    f.options.args.push('--staggered', '--queue', '16');
    await exercise(f, async () => {
      await assert.rejects(run(f.options), /Short receive/);
      const names = f.events.map(event => event.type);
      assert.equal(names.includes('staggered-finish'), false);
      assert.ok(names.indexOf('staggered-snapshot') < names.indexOf('staggered-stop'));
      assert.deepEqual(names.slice(-4), [
        'staggered-stop',
        'decoder-close',
        'close-transport',
        'sink-close'
      ]);
    });
  }
);

test(
  'an uncertain staggered stop aborts TCP and leaves decoder and sink retained',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(3)});
    f.options.createStaggered = staggeredFake(f.events, {stopFails: true});
    const createTransport = f.options.createTransport;
    f.options.createTransport = async config => ({
      ...(await createTransport(config)),
      abort() {
        f.events.push({type: 'abort-transport'});
      }
    });
    f.options.args.push('--staggered');
    await exercise(f, async () => {
      await assert.rejects(run(f.options), error =>
        error.errors.every(item => /restart SmileBASIC/.test(item.message))
      );
      const names = f.events.map(event => event.type);
      assert.deepEqual(names.slice(-2), ['staggered-stop', 'abort-transport']);
      assert.equal(names.filter(name => name === 'staggered-stop').length, 1);
      assert.equal(names.includes('decoder-close'), false);
      assert.equal(names.includes('sink-close'), false);
    });
  }
);

test(
  '--present-hz, --skip-backlog and --skip-rule reach the staggered scheduler',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(6)});
    const created = [];
    const fake = staggeredFake(f.events);
    f.options.createStaggered = options => {
      created.push(options);
      return fake();
    };
    f.options.args.push('--staggered', '--present-hz', '120', '--skip-backlog', 'off');
    await exercise(f, async () => {
      const summary = await run(f.options);
      assert.equal(created.length, 1);
      assert.equal(typeof created[0].now(), 'number', 'the scheduler runs on the host clock');
      delete created[0].now;
      assert.deepEqual(created, [
        {
          presentHz: 120,
          skipBacklog: Infinity,
          skipRule: 'backlog',
          decodeWait: false,
          receiveWait: false,
          avoid: null
        }
      ]);
      assert.equal(summary.presentHz, 120);
      assert.equal(summary.skipBacklog, 'off');
      assert.equal(summary.skipRule, 'backlog');
    });
    const v = await fixture({units: pairedUnits(6)});
    const vsync = [];
    const vsyncFake = staggeredFake(v.events);
    v.options.createStaggered = options => {
      vsync.push(options);
      return vsyncFake();
    };
    v.options.args.push(
      '--staggered',
      '--present-hz',
      '120',
      '--skip-rule',
      'vsync',
      '--decode-wait',
      '--receive-wait'
    );
    await exercise(v, async () => {
      const summary = await run(v.options);
      delete vsync[0]?.now;
      assert.deepEqual(vsync, [
        {
          presentHz: 120,
          skipBacklog: 1,
          skipRule: 'vsync',
          decodeWait: true,
          receiveWait: true,
          avoid: null
        }
      ]);
      assert.equal(summary.skipRule, 'vsync');
      assert.equal(summary.decodeWait, true);
      assert.equal(summary.receiveWait, true);
    });
    for (const [extra, message] of [
      [['--staggered', '--present-hz', '90'], /--present-hz takes 60 or 120/],
      [['--staggered', '--skip-backlog', '-1'], /--skip-backlog takes/],
      [['--staggered', '--skip-rule', 'newest'], /--skip-rule takes backlog or vsync/],
      [['--staggered', '--skip-rule', 'vsync', '--skip-backlog', 'off'], /needs a --skip-backlog/],
      [['--staggered', '--decode-wait'], /--decode-wait needs --skip-rule vsync/]
    ]) {
      const g = await fixture();
      await exercise(g, async () => {
        g.options.args.push(...extra);
        await assert.rejects(run(g.options), message);
      });
    }
  }
);

function timedStaggeredFake(events, arrivals) {
  const fake = staggeredFake(events)();
  return () => ({
    ...fake,
    async push(unit, hooks) {
      arrivals.push(unit.arrivedAt);
      const gated = fake.pending;
      if (gated) hooks.onGate(unit.arrivedAt + 10);
      await fake.push(unit, hooks);
      await new Promise(resolve => setTimeout(resolve, 15));
      hooks.onSent(unit.arrivedAt + 12);
    },
    async finish(hooks) {
      await new Promise(resolve => setTimeout(resolve, 50));
      return fake.finish(hooks);
    },
    get pending() {
      return fake.pending;
    }
  });
}

test(
  'staggered stats rows time each unit from arrival and count the feeder reads as input',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(6)});
    const arrivals = [];
    f.options.createStaggered = timedStaggeredFake(f.events, arrivals);
    f.options.now = () => 1000;
    f.options.statsMs = 10;
    const spawnProcess = f.options.spawnProcess;
    const feeders = [];
    const pad = {
      reads: 2,
      readMeanMs: 3,
      readMaxMs: 4,
      stepMax: 2,
      stalls: 0,
      gaps: 1,
      ageMeanMs: 1,
      ageMaxMs: 2
    };
    f.options.spawnProcess = (command, args, spawnOptions) => {
      const child = spawnProcess(command, args, spawnOptions);
      if (path.basename(args[0] ?? '') === 'input-feeder.js') {
        feeders.push({args, stdio: spawnOptions.stdio});
        child.stdio[3] = new PassThrough();
        child.stdio[3].write(JSON.stringify({exchanges: 4, bridgeMs: 7, pad}) + '\n');
      }
      return child;
    };
    f.options.args.push('--staggered', '--queue', '16', '--warmup', '0');
    await exercise(f, async () => {
      const summary = await run(f.options);
      assert.deepEqual(arrivals, [1000, 1000, 1000, 1000, 1000]);
      assert.deepEqual(feeders[0].args.slice(-4), ['--hz', '60', '--counts-fd', '3']);
      assert.equal(feeders[0].stdio[3], 'pipe');
      assert.equal(summary.au.units, 5);
      assert.equal(summary.au.gated, 4);
      assert.equal(summary.au.waitMs, 12);
      assert.equal(summary.au.maxWaitMs, 12);
      assert.equal(summary.au.gateAgeMs, 10);
      assert.ok(summary.au.maxInHand >= 1);
      assert.deepEqual(Object.keys(summary.stages.input), [
        'requestsPerFrame',
        'bridgeMsPerFrame',
        'wallMsPerFrame',
        'waitMsPerFrame'
      ]);
      assert.equal(summary.stages.input.requestsPerFrame, +(4 / summary.presented).toFixed(2));
      const rows = (await fs.readFile(path.join(f.directory, 'logs', 'stats.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      const fed = rows.find(row => row.bridgeByStage.input);
      assert.deepEqual(fed.bridgeByStage.input, {exchanges: 4, bridgeMs: 7});
      assert.deepEqual(fed.inputPad, pad, 'the pad ages ride along in the same row');
      assert.equal(fed.exchanges, 0, 'the feeder reads stay out of the video exchange total');
      assert.equal(summary.trimmed, undefined);
      assert.ok(rows.every(row => !('trimmed' in row)));
    });
  }
);

test('--input-hz 120 reaches the input feeder and the summary', {timeout: 5000}, async () => {
  const f = await fixture();
  const feeders = [];
  const spawnProcess = f.options.spawnProcess;
  f.options.spawnProcess = (command, args, spawnOptions) => {
    if (path.basename(args[0] ?? '') === 'input-feeder.js') feeders.push(args);
    return spawnProcess(command, args, spawnOptions);
  };
  f.options.args.push('--input-hz', '120');
  await exercise(f, async () => {
    const summary = await run(f.options);
    assert.equal(feeders.length, 1);
    assert.deepEqual(feeders[0].slice(feeders[0].indexOf('--hz'), feeders[0].indexOf('--hz') + 2), [
      '--hz',
      '120'
    ]);
    assert.equal(summary.inputHz, 120);
  });
  const g = await fixture();
  await exercise(g, async () => {
    g.options.args.push('--input-hz', '121');
    await assert.rejects(run(g.options), /--input-hz takes 10 to 120/);
  });
});

test(
  '--trim-backlog-ms reaches the scheduler, logs each trim and counts it apart from drops',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(6)});
    const created = [];
    const timed = timedStaggeredFake(f.events, []);
    f.options.createStaggered = options => {
      created.push(options);
      const live = timed();
      return {
        ...live,
        async push(unit, hooks) {
          await live.push(unit, hooks);
          if (unit.pts === 4000) hooks.onTrimmed(31.26);
        },
        get pending() {
          return live.pending;
        }
      };
    };
    f.options.now = () => 1000;
    f.options.statsMs = 10;
    f.options.args.push('--staggered', '--queue', '16', '--warmup', '0', '--trim-backlog-ms', '20');
    await exercise(f, async () => {
      const summary = await run(f.options);
      assert.equal(created[0].trimBacklogMs, 20);
      assert.equal(summary.trimBacklogMs, 20);
      assert.equal(summary.trimmed, 1);
      assert.equal(summary.dropped, 0);
      assert.ok(!summary.failures.includes('dropped 0'));
      const events = (await fs.readFile(path.join(f.directory, 'logs', 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      const trims = events.filter(event => event.event === 'backlog-trim');
      assert.equal(trims.length, 1);
      assert.equal(trims[0].ageMs, 31.3);
      assert.equal(trims[0].trimBacklogMs, 20);
      assert.equal(events.find(event => event.event === 'summary').trimmed, 1);
    });
    for (const [extra, message] of [
      [['--staggered', '--trim-backlog-ms', '0'], /--trim-backlog-ms takes/],
      [['--staggered', '--trim-backlog-ms', 'soon'], /--trim-backlog-ms takes/],
      [
        ['--staggered', '--skip-rule', 'vsync', '--skip-backlog', '1', '--trim-backlog-ms', '20'],
        /--trim-backlog-ms needs --skip-rule backlog/
      ],
      [
        ['--staggered', '--skip-backlog', '0', '--trim-backlog-ms', '20'],
        /--trim-backlog-ms needs --skip-backlog 1 or more/
      ]
    ]) {
      const g = await fixture();
      await exercise(g, async () => {
        g.options.args.push(...extra);
        await assert.rejects(run(g.options), message);
      });
    }
  }
);

test(
  '--gate-on-receive reaches the staggered scheduler and refuses 120 Hz',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(4)});
    const created = [];
    const fake = staggeredFake(f.events);
    f.options.createStaggered = options => {
      created.push(options);
      return fake();
    };
    f.options.args.push('--staggered', '--gate-on-receive');
    await exercise(f, async () => {
      const summary = await run(f.options);
      assert.equal(created[0].gateOnReceive, true);
      assert.equal(summary.gateOnReceive, true);
    });
    const h = await fixture();
    await exercise(h, async () => {
      h.options.args.push('--staggered', '--gate-on-receive', '--present-hz', '120');
      await assert.rejects(run(h.options), /--gate-on-receive is untested at --present-hz 120/);
    });
  }
);

test('--output-lag reaches the staggered scheduler and takes 1 or 2', {timeout: 5000}, async () => {
  const f = await fixture({units: pairedUnits(4)});
  const created = [];
  const fake = staggeredFake(f.events);
  f.options.createStaggered = options => {
    created.push(options);
    return fake();
  };
  f.options.args.push('--staggered', '--output-lag', '1');
  await exercise(f, async () => {
    const summary = await run(f.options);
    assert.equal(created[0].lag, 1);
    assert.equal(summary.outputLag, 1);
  });
  for (const [args, message] of [
    [['--staggered', '--output-lag', '3'], /--output-lag takes 1 or 2/]
  ]) {
    const g = await fixture();
    await exercise(g, async () => {
      g.options.args.push(...args);
      await assert.rejects(run(g.options), message);
    });
  }
});

test(
  'the staggered-worker started event names the latency flags that were on',
  {timeout: 5000},
  async () => {
    const started = async args => {
      const f = await fixture({units: pairedUnits(4)});
      f.options.createStaggered = staggeredFake(f.events);
      f.options.args.push('--staggered', ...args);
      let event;
      await exercise(f, async () => {
        await run(f.options);
        const events = (await fs.readFile(path.join(f.directory, 'logs', 'events.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse);
        event = events.find(entry => entry.event === 'staggered-worker');
      });
      return event;
    };
    const flagged = await started([
      '--trim-backlog-ms',
      '40',
      '--gate-on-receive',
      '--output-lag',
      '1'
    ]);
    assert.equal(flagged.started, true);
    assert.equal(flagged.trimBacklogMs, 40);
    assert.equal(flagged.gateOnReceive, true);
    assert.equal(flagged.outputLag, 1);
    const plain = await started([]);
    assert.equal(plain.started, true);
    for (const key of ['trimBacklogMs', 'gateOnReceive', 'outputLag']) assert.ok(!(key in plain));
  }
);

test(
  'an error on the feeder counts pipe is logged and the run goes on',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(6)});
    f.options.createStaggered = timedStaggeredFake(f.events, []);
    f.options.statsMs = 10;
    const spawnProcess = f.options.spawnProcess;
    f.options.spawnProcess = (command, args, spawnOptions) => {
      const child = spawnProcess(command, args, spawnOptions);
      if (path.basename(args[0] ?? '') === 'input-feeder.js') {
        child.stdio[3] = new PassThrough();
        setImmediate(() => child.stdio[3].emit('error', Error('counts pipe broke')));
      }
      return child;
    };
    f.options.args.push('--staggered', '--queue', '16', '--warmup', '0');
    await exercise(f, async () => {
      const summary = await run(f.options);
      assert.equal(summary.presented > 0, true);
      const events = (await fs.readFile(path.join(f.directory, 'logs', 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      const failed = events.filter(event => event.event === 'input-counts-error');
      assert.deepEqual(
        failed.map(event => event.message),
        ['counts pipe broke']
      );
      assert.ok(events.some(event => event.event === 'summary'));
    });
  }
);

// h264-stream.js
const metadata = (seq, bytes, fields = {}) => ({
  type: 'au',
  seq,
  frame: seq + 1,
  bytes,
  pts: seq * 16667,
  keyframe: seq === 0,
  ...fields
});

test(
  'raw data is drained before post-payload metadata, including access units larger than a pipe',
  {timeout: 3000},
  async () => {
    const pipe = new PassThrough({highWaterMark: 4096});
    const reader = new AccessUnits(pipe);
    const bytes = Buffer.alloc(1024 * 1024, 0x65);
    const writing = (async () => {
      for (let offset = 0; offset < bytes.length; offset += 4096)
        if (!pipe.write(bytes.subarray(offset, offset + 4096))) await once(pipe, 'drain');
      reader.announce(metadata(0, bytes.length));
      pipe.end();
      reader.endMetadata();
    })();
    const unit = await reader.next();
    assert.deepEqual(unit.value.data, bytes);
    assert.equal(unit.value.keyframe, true);
    assert.equal((await reader.next()).done, true);
    await writing;
    reader.close();
  }
);

test('coalesced and split pipe writes preserve access-unit boundaries and timestamps', async () => {
  const pipe = new PassThrough();
  const reader = new AccessUnits(pipe);
  reader.announce(metadata(0, 3));
  reader.announce(metadata(1, 4, {pts: 123456789}));
  pipe.write(Buffer.from([1]));
  pipe.write(Buffer.from([2, 3, 4, 5]));
  pipe.end(Buffer.from([6, 7]));
  reader.endMetadata();
  const units = [];
  for await (const unit of reader) units.push(unit);
  assert.deepEqual(
    units.map(unit => [...unit.data]),
    [
      [1, 2, 3],
      [4, 5, 6, 7]
    ]
  );
  assert.equal(units[1].pts, 123456789);
  assert.equal(units[1].keyframe, false);
  reader.close();
});

test('a bounded queue pauses the producer and resumes as ordered frames are consumed', async () => {
  const pipe = new PassThrough();
  const reader = new AccessUnits(pipe, {maxQueuedUnits: 1});
  for (let seq = 0; seq < 3; seq++) reader.announce(metadata(seq, 1));
  pipe.end(Buffer.from([10, 20, 30]));
  reader.endMetadata();
  assert.equal(pipe.isPaused(), true);
  const values = [];
  for await (const unit of reader) values.push(unit.data[0]);
  assert.deepEqual(values, [10, 20, 30]);
  reader.close();
});

test('binary EOF before the final metadata does not discard the last access unit', async () => {
  const pipe = new PassThrough();
  const reader = new AccessUnits(pipe);
  pipe.end(Buffer.from([1, 2, 3]));
  await once(pipe, 'end');
  reader.announce(metadata(0, 3));
  reader.endMetadata();
  assert.deepEqual([...(await reader.next()).value.data], [1, 2, 3]);
  assert.equal((await reader.next()).done, true);
  reader.close();
});

test('realtime overflow drains the pipe and resumes only at an independent frame', async () => {
  const pipe = new PassThrough();
  let requests = 0;
  const reader = new AccessUnits(pipe, {maxQueuedUnits: 2, onBacklog: () => requests++});
  for (let seq = 0; seq < 7; seq++) {
    pipe.write(Buffer.from([seq]));
    reader.announce(metadata(seq, 1, {keyframe: seq === 0 || seq === 5}));
  }
  assert.equal(pipe.isPaused(), false);
  assert.equal(reader.dropped, 5);
  assert.equal(requests, 3);
  pipe.end();
  reader.endMetadata();
  const units = [];
  for await (const unit of reader) units.push(unit);
  assert.deepEqual(
    units.map(unit => unit.seq),
    [5, 6]
  );
  assert.equal(units[0].keyframe, true);
  reader.close();
});

test('truncated units, invalid metadata and sequence gaps fail instead of shifting later frames', async () => {
  for (const run of [
    (reader, pipe) => {
      reader.announce(metadata(0, 4));
      pipe.end(Buffer.alloc(3));
      reader.endMetadata();
    },
    reader => reader.announce(metadata(0, -1)),
    reader => {
      reader.announce(metadata(0, 1));
      reader.announce(metadata(2, 1));
    }
  ]) {
    const pipe = new PassThrough();
    const reader = new AccessUnits(pipe);
    run(reader, pipe);
    await assert.rejects(reader.next(), /Truncated|Invalid|discontinuity/);
    reader.close();
  }
});

test('parameter sets contain bare NAL payloads for the native H.264 configuration helper', () => {
  const bytes = Buffer.from('000000016764001fac00000168ee3c800000000165deadbeef', 'hex');
  const sets = parameterSets(bytes);
  assert.equal(sets.sps.toString('hex'), '6764001fac');
  assert.equal(sets.pps.toString('hex'), '68ee3c80');
  assert.deepEqual(parameterSets(Buffer.from('00000165abcd', 'hex')), {});
});

test('units carry their arrival time only when the reader has a clock', async () => {
  let time = 40;
  const pipe = new PassThrough();
  const reader = new AccessUnits(pipe, {now: () => (time += 10)});
  reader.announce(metadata(0, 2));
  reader.announce(metadata(1, 2));
  pipe.end(Buffer.from([1, 2, 3, 4]));
  reader.endMetadata();
  const units = [];
  for await (const unit of reader) units.push(unit);
  assert.deepEqual(
    units.map(unit => unit.arrivedAt),
    [50, 60]
  );
  const plain = new PassThrough();
  const untimed = new AccessUnits(plain);
  untimed.announce(metadata(0, 1));
  plain.end(Buffer.from([1]));
  untimed.endMetadata();
  for await (const unit of untimed) assert.equal('arrivedAt' in unit, false);
});
