const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {run} = require('./native-h264.cjs');

const accessUnit = Buffer.from('0000016742001eab00000168ce0100000165abcd', 'hex');
const pcm = Buffer.from('0001020304050607', 'hex');

async function fixture({
  audioFailure = false,
  latency = 0,
  units = [{hex: accessUnit.toString('hex'), keyframe: true, pts: 123456}]
} = {}) {
  const root = '/media/storage2/builds/HBLauncher/native-h264-tests';
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
  let pipeline = 0;
  const options = {
    args: ['--moonlight', 'host', 'Desktop'],
    directory,
    rpc: {a: {session: 'test-session', protocol: 3}},
    storage: {},
    helperPath: 'test-helper',
    width: 128,
    height: 96,
    fps: 30,
    async createSink() {
      return {
        async destination() {
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
    async createDecoder() {
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
          if (pipeline <= latency) return null;
          pipeline--;
          return {format: 'nv12', width: 128, height: 96, stride: 128, sliceHeight: 96};
        },
        async close() {
          events.push({type: 'decoder-close'});
        }
      };
    },
    spawnProcess(command, args, options) {
      let program;
      if (command === 'test-helper') {
        assert.deepEqual(args.slice(-4), ['--raw-h264-fd', '4', '--audio-fd', '3']);
        program = `
          const fs = require('node:fs');
          const readline = require('node:readline');
          const lines = [];
          readline.createInterface({input: process.stdin}).on('line', line => {
            lines.push(JSON.parse(line));
            if (lines.length !== 2) return;
            fs.writeFileSync(${JSON.stringify(path.join(directory, 'input.json'))}, JSON.stringify(lines));
            fs.writeSync(3, Buffer.from('${pcm.toString('hex')}', 'hex'));
            fs.closeSync(3);
            const units = ${JSON.stringify(units)};
            for (const unit of units) fs.writeSync(4, Buffer.from(unit.hex, 'hex'));
            fs.closeSync(4);
            units.forEach((unit, seq) => {
              const bytes = Buffer.from(unit.hex, 'hex').length;
              console.error(JSON.stringify({type:'au',seq,frame:seq+1,bytes,pts:unit.pts,keyframe:unit.keyframe}));
            });
            setTimeout(() => process.exit(0), 100);
          });
          setTimeout(() => { console.error('Input channel did not arrive'); process.exit(1); }, 2000);
        `;
      } else if (path.basename(args[0]) === 'input-feeder.cjs') {
        program = `
          console.log(JSON.stringify({type:'controller',buttonFlags:8192}));
          console.log(JSON.stringify({type:'touch',events:[{id:7,action:'down',x:0.25,y:0.5,pressure:0}]}));
          setInterval(() => {}, 1000);
          process.on('SIGINT', () => process.exit(0));
        `;
      } else if (path.basename(args[0]) === 'audio-stream.cjs') {
        if (audioFailure) program = 'process.exit(7)';
        else
          program = `
          const fs = require('node:fs');
          const chunks = [];
          process.stdin.on('data', chunk => chunks.push(chunk));
          process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(path.join(directory, 'audio.pcm'))}, Buffer.concat(chunks)));
        `;
      } else throw Error('Unexpected child: ' + command);
      const child = spawn(process.execPath, ['-e', program], options);
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
