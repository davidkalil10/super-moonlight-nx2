// Runs one host (hbmoonlight-host or live.cjs --codec hbv2) against the fake
// console bridge and prints what it cost: written fps, CPU per written frame
// for the host process tree (encoder and ffmpeg included, bridge excluded),
// encode and write times, and frame-to-ack latency percentiles.
// Usage: node tools/moonlight/helper/compare-hosts.cjs native|node DIR CLIP
//          [--seconds 20] [--warmup 5] [--host BIN] [-- host args...]
// Env: RATE and HB_PIPELINE go to the fake bridge (see fake-console/bridge.cjs).
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const {spawn} = require('node:child_process');

const TICKS_PER_SECOND = 100;
const moonlight = path.join(__dirname, '..');

function option(args, name, fallback) {
  return args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
}

// CPU seconds of a process tree, keyed by thread name (OpenMP workers inherit
// the name of the thread that started them); capture tools count as a whole.
const WHOLE = ['ffmpeg', 'hbv2enc'];

function cpuSeconds(pid) {
  const byName = {};
  const stack = [pid];
  while (stack.length) {
    const id = stack.pop();
    try {
      const process = fs.readFileSync(`/proc/${id}/comm`, 'utf8').trim();
      for (const task of fs.readdirSync(`/proc/${id}/task`)) {
        const stat = fs.readFileSync(`/proc/${id}/task/${task}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const name = WHOLE.includes(process)
          ? process
          : stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        byName[name] =
          (byName[name] || 0) + (Number(fields[11]) + Number(fields[12])) / TICKS_PER_SECOND;
        stack.push(
          ...fs
            .readFileSync(`/proc/${id}/task/${task}/children`, 'utf8')
            .trim()
            .split(' ')
            .filter(Boolean)
            .map(Number)
        );
      }
    } catch {}
  }
  return byName;
}

const total = byName => Object.values(byName).reduce((sum, value) => sum + value, 0);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function lines(stream, onLine) {
  readline.createInterface({input: stream}).on('line', onLine);
}

async function main() {
  const separator = process.argv.indexOf('--');
  const args = separator < 0 ? process.argv.slice(2) : process.argv.slice(2, separator);
  const extra = separator < 0 ? [] : process.argv.slice(separator + 1);
  const [kind, directory, clip] = args;
  if (!['native', 'node'].includes(kind) || !directory || !clip)
    throw Error('Usage: compare-hosts.cjs native|node DIR CLIP [options] [-- host args]');
  const seconds = Number(option(args, '--seconds', 20));
  const warmup = Number(option(args, '--warmup', 5));
  const binary = option(
    args,
    '--host',
    path.join(
      process.env.HOME,
      'claude-builds/HBLauncher/moonlight-host/dev/build/hbmoonlight-host'
    )
  );

  fs.rmSync(directory, {recursive: true, force: true});
  fs.mkdirSync(directory, {recursive: true});
  const bridge = spawn(
    process.execPath,
    [path.join(moonlight, 'fake-console/bridge.cjs'), directory],
    {
      stdio: ['ignore', 'pipe', 'inherit']
    }
  );
  const bridgeStats = [];
  lines(bridge.stdout, line => {
    if (line.startsWith('bridge: ')) bridgeStats.push(JSON.parse(line.slice(8)));
  });
  while (!fs.existsSync(path.join(directory, 'connection.json'))) await sleep(50);
  await sleep(300);

  const host =
    kind === 'native'
      ? spawn(binary, [directory, '--input', clip, ...extra], {stdio: ['ignore', 'pipe', 'pipe']})
      : spawn(
          process.execPath,
          [
            '-r',
            path.join(__dirname, 'latency-probe.cjs'),
            path.join(moonlight, 'live.cjs'),
            directory,
            '--input',
            clip,
            '--codec',
            'hbv2',
            ...extra
          ],
          {stdio: ['ignore', 'pipe', 'pipe']}
        );
  const stats = [];
  let summary = null;
  lines(host.stdout, line => line.startsWith('{') && stats.push(JSON.parse(line)));
  lines(host.stderr, line => {
    if (line.includes('"summary"')) summary = JSON.parse(line);
    else if (!line.includes('"event"')) console.error(kind + ': ' + line);
  });
  const exited = new Promise(resolve => host.on('close', resolve));

  await sleep(warmup * 1000);
  const start = {host: cpuSeconds(host.pid), bridge: cpuSeconds(bridge.pid), stats: stats.length};
  await sleep(seconds * 1000);
  const end = {host: cpuSeconds(host.pid), bridge: cpuSeconds(bridge.pid), stats: stats.length};
  host.kill('SIGINT');
  await exited;
  bridge.kill('SIGINT');

  const window = stats.slice(start.stats, end.stats);
  const sum = name => window.reduce((total, line) => total + (line[name] || 0), 0);
  const mean = name => +(sum(name) / Math.max(1, window.length)).toFixed(2);
  const written = sum('written');
  const bridgeWindow = bridgeStats.slice(-window.length - 1, -1);
  const result = {
    kind,
    rate: Number(process.env.RATE || 5.7e6),
    depth: Number(process.env.HB_PIPELINE || 1),
    fps: +(written / window.length).toFixed(1),
    hostCpuMsPerFrame: +(
      ((total(end.host) - total(start.host)) * 1000) /
      Math.max(1, written)
    ).toFixed(2),
    cpuMsPerFrame: Object.fromEntries(
      Object.keys(end.host).map(name => [
        name,
        +(
          (((end.host[name] || 0) - (start.host[name] || 0)) * 1000) /
          Math.max(1, written)
        ).toFixed(2)
      ])
    ),
    hostCpuCores: +((total(end.host) - total(start.host)) / seconds).toFixed(2),
    bridgeCpuCores: +((total(end.bridge) - total(start.bridge)) / seconds).toFixed(2),
    encodeMs: mean('encodeMs'),
    bridgeWriteMs: +(
      bridgeWindow.reduce((total, line) => total + line.writeMs, 0) /
      Math.max(1, bridgeWindow.length)
    ).toFixed(2),
    droppedBusy: sum('droppedBusy'),
    resyncs: sum('resyncs'),
    kibPerFrame: +(sum('kib') / Math.max(1, written)).toFixed(1),
    latencyMs: summary?.latencyMs ?? null
  };
  if (kind === 'native') result.hostWriteMs = mean('writeMs');
  console.log(JSON.stringify(result));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
