const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {
  run,
  createIdrRequester,
  countsSince
} = require('../../../hbl-moonlight/tools/moonlight/native-h264.js');

const accessUnit = Buffer.from('0000016742001eab00000168ce0100000165abcd', 'hex');
const pcm = Buffer.from('0001020304050607', 'hex');

test('stats rows report staggered waits since the previous row', () => {
  assert.deepEqual(countsSince({receive: 7, applied: 2}, {receive: 4, applied: 2}), {receive: 3});
  assert.deepEqual(countsSince({slot: 1}, {}), {slot: 1});
  assert.deepEqual(countsSince({}, {}), {});
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
    rpc: {a: {session: 'test-session', protocol: 3}, host: '192.0.2.10'},
    storage: {},
    helperPath: 'test-helper',
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
            address: 0x1000000 + (++workerSequence * 32768),
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
        autoQueue: config.autoQueue,
        linkedGates: config.linkedGates,
        splitWorkerFactory: config.splitWorkerFactory
      });
      let splitSequence = 0;
      return {
        async configure(sps, pps, fps) {
          events.push({type: 'configure', sps, pps, fps});
        },
        async submit(unit) {
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
        async startPersistent() {
          events.push({type: 'start-persistent'});
        },
        async beginPersistent(unit) {
          events.push({type: 'begin-persistent', unit});
        },
        async finishPersistent(destination) {
          events.push({type: 'finish-persistent', destination});
          return {format: 'nv12', width: 128, height: 96, stride: 128, sliceHeight: 96};
        },
        async startSplit() {
          events.push({type: 'start-split'});
        },
        async submitSplit(unit) {
          events.push({type: 'submit-split', unit});
          return {sequence: ++splitSequence, pts: unit.pts, presentation: {current: 0, applied: 0}};
        },
        async stageSplitInput(unit) {
          events.push({type: 'stage-split', unit});
          return {sequence: ++splitSequence, pts: unit.pts};
        },
        async verifySplitReceive() {
          events.push({type: 'verify-receive'});
        },
        async waitSplitOutputAcquired(job) {
          events.push({type: 'wait-acquire', job});
          return {index: 0, presentation: {current: 0, applied: 0}};
        },
        async openSplitOutputFetch(job, destination, nextJob) {
          events.push({type: 'open-fetch', job, destination, nextJob});
        },
        async finishSplitInputAfterLinkedGate() {
          events.push({type: 'finish-linked-input'});
          return {sequence: splitSequence, pts: 3000, presentation: {current: 0, applied: 0}};
        },
        async completeSplitOutputFetch(job) {
          events.push({type: 'complete-fetch', job});
          return {format: 'nv12', width: 128, height: 96, stride: 128, sliceHeight: 96};
        },
        async queueSplitOutput(job) {
          events.push({type: 'queue-split', job});
        },
        async finishSplitOutput(job, destination, nextJob) {
          events.push({type: 'finish-split', job, destination, nextJob});
          return {
            format: 'nv12',
            width: 128,
            height: 96,
            stride: 128,
            sliceHeight: 96,
            pts: String(job.pts)
          };
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

test('persistent worker takes over after a host-driven first frame', {timeout: 5000}, async () => {
  const f = await fixture({
    units: [
      {hex: accessUnit.toString('hex'), keyframe: true, pts: 1000},
      {hex: accessUnit.toString('hex'), keyframe: false, pts: 2000}
    ]
  });
  await exercise(f, async () => {
    await run(f.options);
    assert.equal(f.events.find(event => event.type === 'create-decoder').mode, 'persistent');
    assert.equal(f.events.filter(event => event.type === 'submit').length, 1);
    assert.equal(f.events.filter(event => event.type === 'receive').length, 1);
    assert.equal(f.events.filter(event => event.type === 'start-persistent').length, 1);
    assert.equal(f.events.filter(event => event.type === 'begin-persistent').length, 1);
    assert.equal(f.events.filter(event => event.type === 'finish-persistent').length, 1);
    const began = f.events.findIndex(event => event.type === 'begin-persistent');
    const destination = f.events.findIndex(
      (event, index) => index > began && event.type === 'destination'
    );
    const finished = f.events.findIndex(event => event.type === 'finish-persistent');
    assert.ok(began < destination && destination < finished);
    assert.equal(f.events.filter(event => event.type === 'publish').length, 2);
  });
});

test(
  'split workers submit the next input before fetching the previous output',
  {timeout: 5000},
  async () => {
    const f = await fixture({
      units: [
        {hex: accessUnit.toString('hex'), keyframe: true, pts: 1000},
        {hex: accessUnit.toString('hex'), keyframe: false, pts: 2000},
        {hex: accessUnit.toString('hex'), keyframe: false, pts: 3000}
      ]
    });
    f.options.args.push('--split-decoder');
    await exercise(f, async () => {
      await run(f.options);
      assert.equal(f.events.find(event => event.type === 'create-decoder').mode, 'split');
      assert.equal(f.events.filter(event => event.type === 'start-split').length, 1);
      assert.equal(f.events.filter(event => event.type === 'submit').length, 1);
      assert.equal(f.events.filter(event => event.type === 'submit-split').length, 2);
      assert.equal(f.events.filter(event => event.type === 'publish').length, 3);
      const inputThree = f.events.findIndex(
        event => event.type === 'submit-split' && event.unit.pts === 3000
      );
      const firstQueue = f.events.findIndex(event => event.type === 'queue-split');
      const firstFetch = f.events.findIndex(event => event.type === 'finish-split');
      assert.ok(firstQueue < inputThree && inputThree < firstFetch);
      assert.deepEqual(
        f.events.filter(event => event.type === 'finish-split').map(event => event.job.pts),
        [2000, 3000]
      );
    });
  }
);

test('native split publication leaves frame commits to the output worker', {timeout: 5000}, async () => {
  const f = await fixture({
    units: [
      {hex: accessUnit.toString('hex'), keyframe: true, pts: 1000},
      {hex: accessUnit.toString('hex'), keyframe: false, pts: 2000},
      {hex: accessUnit.toString('hex'), keyframe: false, pts: 3000}
    ]
  });
  f.options.args.push('--split-decoder', '--native-publish');
  await exercise(f, async () => {
    await run(f.options);
    assert.deepEqual(f.events.find(event => event.type === 'create-decoder').publication, {
      mapped: 0x1000000,
      color: 1
    });
    assert.equal(f.events.filter(event => event.type === 'publish').length, 1);
    assert.equal(f.events.filter(event => event.type === 'worker-destination').length, 2);
    assert.equal(f.events.filter(event => event.type === 'finish-split').length, 2);
    assert.deepEqual(
      f.events.filter(event => event.type === 'worker-destination').map(event => event.presentation),
      [{current: 0, applied: 0}, null]
    );
  });
});

test('automatic output queue passes the next job without a second host queue call', {timeout: 5000}, async () => {
  const f = await fixture({
    units: [
      {hex: accessUnit.toString('hex'), keyframe: true, pts: 1000},
      {hex: accessUnit.toString('hex'), keyframe: false, pts: 2000},
      {hex: accessUnit.toString('hex'), keyframe: false, pts: 3000}
    ]
  });
  f.options.args.push('--split-decoder', '--native-publish', '--auto-output-queue');
  await exercise(f, async () => {
    await run(f.options);
    assert.equal(f.events.find(event => event.type === 'create-decoder').autoQueue, true);
    assert.equal(f.events.filter(event => event.type === 'queue-split').length, 1);
    assert.deepEqual(
      f.events.filter(event => event.type === 'finish-split').map(event => [event.job.pts, event.nextJob?.pts]),
      [[2000, 3000], [3000, undefined]]
    );
    assert.equal(f.events.filter(event => event.type === 'worker-destination').length, 2);
  });
});

test('linked gates check receive and acquire before opening the fetch gate', {timeout: 5000}, async () => {
  const f = await fixture({
    units: [
      {hex: accessUnit.toString('hex'), keyframe: true, pts: 1000},
      {hex: accessUnit.toString('hex'), keyframe: false, pts: 2000},
      {hex: accessUnit.toString('hex'), keyframe: false, pts: 3000}
    ]
  });
  f.options.args.push('--split-decoder', '--native-publish', '--auto-output-queue', '--linked-gates');
  await exercise(f, async () => {
    await run(f.options);
    assert.equal(f.events.find(event => event.type === 'create-decoder').linkedGates, true);
    assert.equal(f.events.filter(event => event.type === 'queue-split').length, 1);
    assert.equal(f.events.filter(event => event.type === 'submit-split').length, 1);
    const names = f.events.map(event => event.type);
    const checked = Math.max(names.indexOf('verify-receive'), names.indexOf('wait-acquire'));
    assert.ok(checked < names.indexOf('open-fetch'));
    assert.equal(f.events.find(event => event.type === 'open-fetch').nextJob.sequence, 2);
    assert.equal(f.events.filter(event => event.type === 'complete-fetch').length, 1);
    assert.equal(f.events.filter(event => event.type === 'finish-split').length, 1);
  });
});

test(
  'persistent worker waits for a late first output before taking over',
  {timeout: 5000},
  async () => {
    const f = await fixture({
      emptyPolls: 2,
      units: [
        {hex: accessUnit.toString('hex'), keyframe: true, pts: 1000},
        {hex: accessUnit.toString('hex'), keyframe: false, pts: 2000}
      ]
    });
    await exercise(f, async () => {
      await run(f.options);
      assert.equal(f.events.filter(event => event.type === 'submit').length, 1);
      assert.equal(f.events.filter(event => event.type === 'receive').length, 3);
      assert.equal(f.events.filter(event => event.type === 'start-persistent').length, 1);
      assert.equal(f.events.filter(event => event.type === 'begin-persistent').length, 1);
    });
  }
);

test('the persistent decoder gets its own TCP transport', {timeout: 5000}, async () => {
  const f = await fixture({
    units: [
      {hex: accessUnit.toString('hex'), keyframe: true, pts: 1000},
      {hex: accessUnit.toString('hex'), keyframe: false, pts: 2000}
    ]
  });
  await exercise(f, async () => {
    await run(f.options);
    assert.deepEqual(
      f.events.filter(event => event.type === 'create-transport').map(event => event.host),
      ['192.0.2.10']
    );
    assert.equal(f.events.filter(event => event.type === 'close-transport').length, 1);
    assert.equal(f.events.filter(event => event.type === 'finish-persistent').length, 1);
  });
});

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
    assert.equal(saved.workerMode, 'persistent');
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
        f.events.slice(-4).map(event => event.type),
        ['socket-audio-close', 'decoder-close', 'close-transport', 'sink-close']
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

function pairedFake(events, {stopFails = false} = {}) {
  return config => {
    let exists = false;
    let retained = false;
    events.push({type: 'paired-create', publication: config.publication});
    return {
      async factory() {
        exists = true;
      },
      async start() {
        events.push({type: 'paired-start'});
      },
      async pair({decoder, sink, units, layout, onDecoded, onPresented}) {
        events.push({type: 'paired-pair', pts: units.map(item => item.pts), layout});
        for (const item of units) await decoder.submitSplit(item);
        onDecoded(2);
        await sink.workerDestination();
        await sink.workerDestination();
        onPresented(1);
        onPresented(1);
      },
      async snapshot() {
        return {};
      },
      async stop() {
        events.push({type: 'paired-stop'});
        if (stopFails) {
          retained = true;
          throw Error('Paired loop worker did not stop; restart SmileBASIC');
        }
        exists = false;
      },
      get exists() {
        return exists;
      },
      get retained() {
        return retained;
      }
    };
  };
}

const pairedUnits = count =>
  Array.from({length: count}, (_, index) => ({
    hex: accessUnit.toString('hex'),
    keyframe: index === 0,
    pts: (index + 1) * 1000
  }));

test('--paired-loop rejects the other split worker flags', {timeout: 5000}, async () => {
  const f = await fixture();
  await exercise(f, async () => {
    f.options.args.push('--paired-loop', '--linked-gates');
    await assert.rejects(run(f.options), /--paired-loop publishes from its own worker/);
  });
});

test(
  '--paired-loop pairs units after the host IDR and stops the loop before the decoder',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(6)});
    f.options.createPaired = pairedFake(f.events);
    f.options.args.push('--paired-loop', '--queue', '16');
    await exercise(f, async () => {
      const summary = await run(f.options);
      const created = f.events.find(event => event.type === 'create-decoder');
      assert.equal(created.mode, 'split');
      assert.deepEqual(created.publication, {mapped: 0x1000000, color: 1});
      assert.equal(typeof created.splitWorkerFactory, 'function');
      const names = f.events.map(event => event.type);
      assert.ok(names.indexOf('publish') < names.indexOf('start-split'));
      assert.ok(names.indexOf('start-split') < names.indexOf('paired-start'));
      assert.deepEqual(
        f.events.filter(event => event.type === 'paired-pair').map(event => event.pts),
        [
          [2000, 3000],
          [4000, 5000]
        ]
      );
      assert.equal(f.events.find(event => event.type === 'paired-pair').layout.width, 128);
      assert.deepEqual(names.slice(-4), [
        'paired-stop',
        'decoder-close',
        'close-transport',
        'sink-close'
      ]);
      assert.equal(summary.workerMode, 'paired');
      assert.equal(summary.unpaired, 1);
    });
  }
);

test(
  'an uncertain paired loop stop leaves decoder and sink retained',
  {timeout: 5000},
  async () => {
    const f = await fixture({units: pairedUnits(3)});
    f.options.createPaired = pairedFake(f.events, {stopFails: true});
    const createTransport = f.options.createTransport;
    f.options.createTransport = async config => ({
      ...(await createTransport(config)),
      abort() {
        f.events.push({type: 'abort-transport'});
      }
    });
    f.options.args.push('--paired-loop');
    await exercise(f, async () => {
      await assert.rejects(run(f.options), error =>
        error.errors.some(item => /restart SmileBASIC/.test(item.message))
      );
      const names = f.events.map(event => event.type);
      assert.deepEqual(names.slice(-2), ['paired-stop', 'abort-transport']);
      assert.equal(names.includes('decoder-close'), false);
      assert.equal(names.includes('sink-close'), false);
    });
  }
);

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

test('--staggered rejects the paired and split worker flags', {timeout: 5000}, async () => {
  for (const flag of [
    '--paired-loop',
    '--native-publish',
    '--auto-output-queue',
    '--linked-gates'
  ]) {
    const f = await fixture();
    await exercise(f, async () => {
      f.options.args.push('--staggered', flag);
      await assert.rejects(run(f.options), /--staggered drives its own input and output workers/);
    });
  }
});

test('the default path never creates the staggered scheduler', {timeout: 5000}, async () => {
  const f = await fixture({units: pairedUnits(3)});
  f.options.createStaggered = () => assert.fail('staggered scheduler created');
  await exercise(f, async () => {
    const summary = await run(f.options);
    assert.equal(summary.workerMode, 'persistent');
    assert.equal(summary.staggered, undefined);
    assert.equal(f.events.find(event => event.type === 'create-decoder').publication, null);
  });
});

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

test('--present-hz, --skip-backlog and --skip-rule reach the staggered scheduler', {timeout: 5000}, async () => {
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
    assert.deepEqual(created, [
      {presentHz: 120, skipBacklog: Infinity, skipRule: 'backlog', decodeWait: false}
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
    '--decode-wait'
  );
  await exercise(v, async () => {
    const summary = await run(v.options);
    assert.deepEqual(vsync, [
      {presentHz: 120, skipBacklog: 1, skipRule: 'vsync', decodeWait: true}
    ]);
    assert.equal(summary.skipRule, 'vsync');
    assert.equal(summary.decodeWait, true);
  });
  for (const [extra, message] of [
    [['--staggered', '--present-hz', '90'], /--present-hz takes 60 or 120/],
    [['--staggered', '--skip-backlog', '-1'], /--skip-backlog takes/],
    [['--staggered', '--skip-rule', 'newest'], /--skip-rule takes backlog or vsync/],
    [['--staggered', '--skip-rule', 'vsync', '--skip-backlog', 'off'], /needs a --skip-backlog/],
    [['--skip-rule', 'vsync'], /apply to --staggered/],
    [['--staggered', '--decode-wait'], /--decode-wait needs --skip-rule vsync/],
    [['--present-hz', '120'], /apply to --staggered/]
  ]) {
    const g = await fixture();
    await exercise(g, async () => {
      g.options.args.push(...extra);
      await assert.rejects(run(g.options), message);
    });
  }
});
