const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {run} = require('./native-h264.cjs');

const accessUnit = Buffer.from('0000016742001eab00000168ce0100000165abcd', 'hex');
const pcm = Buffer.from('0001020304050607', 'hex');

async function fixture({
  audioFailure = false,
  latency = 0,
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
  // The decoder holds `latency` frames in its pipeline before the first comes
  // out, so a frame is ready to acquire only once more than `latency` are in.
  let pipeline = 0,
    pending = 0;
  const options = {
    args: ['--moonlight', 'host', 'Desktop'],
    directory,
    rpc: {a: {session: 'test-session', protocol: 3}},
    storage: {},
    helperPath: 'test-helper',
    sourceRevision: '049e2efe32799194a16c2f2f871025c1961aaade',
    width: 128,
    height: 96,
    fps: 30,
    async createSink() {
      return {
        async destination() {
          events.push({type: 'destination'});
          return {address: 0x1000000, bytes: 32768, index: 1};
        },
        async publish(destination, frame) {
          events.push({type: 'publish', destination, frame});
        },
        async wait() {},
        async close() {
          events.push({type: 'sink-close'});
        }
      };
    },
    async createDecoder(config) {
      events.push({type: 'create-decoder', mode: config.workerMode});
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
          if (pipeline <= latency) return null;
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
        async close() {
          events.push({type: 'decoder-close'});
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
        f.events.slice(-2).map(event => event.type),
        ['decoder-close', 'sink-close']
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
  f.options.args.push('--decoder-worker', 'persistent');
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
    f.options.args.push('--decoder-worker', 'persistent');
    await exercise(f, async () => {
      await run(f.options);
      assert.equal(f.events.filter(event => event.type === 'submit').length, 1);
      assert.equal(f.events.filter(event => event.type === 'receive').length, 3);
      assert.equal(f.events.filter(event => event.type === 'start-persistent').length, 1);
      assert.equal(f.events.filter(event => event.type === 'begin-persistent').length, 1);
    });
  }
);

test(
  'an audio process failure ends the native stream and releases decoder/display ownership',
  {timeout: 5000},
  async () => {
    const f = await fixture({audioFailure: true});
    await exercise(f, async () => {
      await assert.rejects(run(f.options), /audio stream exited: 7/);
      assert.deepEqual(
        f.events.slice(-2).map(event => event.type),
        ['decoder-close', 'sink-close']
      );
    });
  }
);

test(
  'a one-frame decode latency adds no known-empty acquireOutput per frame',
  {timeout: 5000},
  async () => {
    const units = [
      {hex: accessUnit.toString('hex'), keyframe: true, pts: 1000},
      {hex: '000001419a', keyframe: false, pts: 2000},
      {hex: '000001419b', keyframe: false, pts: 3000}
    ];
    const f = await fixture({latency: 1, units});
    await exercise(f, async () => {
      await run(f.options);
      const submits = f.events.filter(event => event.type === 'submit').length;
      const receives = f.events.filter(event => event.type === 'receive').length;
      assert.equal(submits, 3);
      assert.equal(receives, submits, 'exactly one receive per submit under 1-frame latency');
      // Two frames drain; the third stays in the pipeline until the next submit.
      assert.equal(f.events.filter(event => event.type === 'publish').length, 2);
    });
  }
);
