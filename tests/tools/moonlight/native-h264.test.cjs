const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {run, createIdrRequester} = require('./native-h264.cjs');

const accessUnit = Buffer.from('0000016742001eab00000168ce0100000165abcd', 'hex');
const pcm = Buffer.from('0001020304050607', 'hex');

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
      events.push({type: 'create-decoder', mode: config.workerMode, publication: config.publication});
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
        async queueSplitOutput(job) {
          events.push({type: 'queue-split', job});
        },
        async finishSplitOutput(job, destination) {
          events.push({type: 'finish-split', job, destination});
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
      } else if (path.basename(args[0]) === 'input-feeder.cjs') {
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
      } else if (path.basename(args[0]) === 'audio-stream.cjs') {
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
    assert.deepEqual(saved.expect, {fps: 30, idr: 0});
    assert.equal(saved.workerMode, 'persistent');
  });
  const g = await fixture();
  await exercise(g, async () => {
    g.options.args.push('--expect', '--duration', '5');
    await assert.rejects(run(g.options), /--expect needs a value/);
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
