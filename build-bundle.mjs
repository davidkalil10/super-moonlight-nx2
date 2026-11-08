import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {build} from './src/streamer/payload/build.js';

const root = import.meta.dirname;

export async function buildBundle(args) {
  const {values} = parseArgs({args, options: {
    host: {type: 'string'}, directory: {type: 'string'},
    port: {type: 'string', default: '39380'},
    help: {type: 'boolean', short: 'h'}
  }});
  if (values.help) {
    console.log('Usage: npm run bundle -- --host HOST_IP [--directory BUILD_DIR] [--port 39380]');
    return;
  }
  if (!values.host || !net.isIPv4(values.host)) throw Error('--host must be this computer’s LAN IPv4 address');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('--port must be 1–65535');
  if (process.platform !== 'linux') throw Error('Bundle builds currently require Linux');

  for (const program of ['git', 'cmake', 'cc', 'podman']) {
    try { execFileSync(program, ['--version'], {stdio: 'ignore'}); }
    catch { throw Error('Install ' + program + ' before building'); }
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const directory = path.resolve(values.directory ?? path.join(root, 'dist', stamp + '-' + revision.slice(0, 7)));
  fs.mkdirSync(path.dirname(directory), {recursive: true});
  fs.mkdirSync(directory);
  const log = fs.openSync(path.join(directory, 'build.log'), 'a');
  const commands = [];
  function run(label, program, argv) {
    console.log(label);
    commands.push([program, ...argv]);
    try { execFileSync(program, argv, {cwd: root, stdio: ['ignore', log, log]}); }
    catch { throw Error(label + ' failed; see ' + path.join(directory, 'build.log')); }
  }
  const image = 'localhost/hbmoonlight-build:latest';
  try {
    run('Fetching protocol sources', 'bash', ['src/streamer/protocol/fetch.sh', path.join(directory, 'upstream')]);
    run('Building helper image', 'podman', ['build', '-t', image,
      '-f', 'src/streamer/protocol/Containerfile', 'src/streamer/protocol']);
    const mount = ['run', '--rm', '--userns=keep-id', '--security-opt', 'label=disable',
      '-v', root + ':/src:ro', '-v', directory + ':/work', image];
    run('Configuring helper', 'podman', [...mount, 'cmake', '-S', '/src/src/streamer/protocol',
      '-B', '/work/helper', '-DUPSTREAM_DIR=/work/upstream', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_TESTING=OFF']);
    run('Compiling helper', 'podman', [...mount, 'cmake', '--build', '/work/helper', '--parallel']);
    run('Configuring inspector', 'cmake', ['-S', 'src/inspector', '-B', path.join(directory, 'inspector'),
      '-DCMAKE_BUILD_TYPE=Release']);
    run('Compiling inspector', 'cmake', ['--build', path.join(directory, 'inspector'), '--parallel']);
    console.log('Packing bundle');
    const result = await build({directory: path.join(directory, 'bundle'), host: values.host, port,
      helper: path.join(directory, 'helper', 'hbmoonlight'),
      inspector: path.join(directory, 'inspector', 'nx2-modules'), image});
    fs.writeFileSync(path.join(directory, 'BUILD-INFO.json'), JSON.stringify({
      sourceRevision: revision, builder: os.hostname(),
      targetArchitecture: process.arch + ' Linux host; aarch64 console JavaScript + SPIR-V',
      command: process.argv, commands, result
    }, null, 2) + '\n');
    console.log('Bundle: ' + result.directory);
    console.log('Launch: node ' + "'" + path.join(result.directory, 'launch.mjs').replaceAll("'", "'\\''") + "' SWITCH_IP");
    return result;
  } finally { fs.closeSync(log); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  buildBundle(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
