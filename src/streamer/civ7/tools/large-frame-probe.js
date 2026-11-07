#!/usr/bin/env node
// AV1 decode above 1080p, or only the memory-block headroom, on the console (large-frame-probe.js).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {attach} from '../transport.js';
import {resolveCompatibility} from '../modules.js';
import {largeDimensions, probeLargeAv1, probeMemoryHeadroom} from '../large-frame-probe.js';
import {temporalUnits} from '../../session/av1-stream.js';

const MIB = 1024 * 1024;
const {values} = parseArgs({options: {
  console: {type: 'string'}, host: {type: 'string'}, directory: {type: 'string'},
  size: {type: 'string'}, sample: {type: 'string'}, reference: {type: 'string'},
  frames: {type: 'string'}, 'workspace-mib': {type: 'string'}, memory: {type: 'string', default: 'auto'},
  'open-only': {type: 'boolean'}, headroom: {type: 'string'},
  help: {type: 'boolean', short: 'h'}
}});
const usage = 'node src/streamer/civ7/tools/large-frame-probe.js --console IP --host IP ' +
  '--directory /media/storage2/builds/moonlight/NEW_RUN ' +
  '(--headroom 272,308 | --size WxH --sample OBU [--reference NV12 | --open-only] [--frames N] ' +
  '[--workspace-mib N] [--memory auto|bridge|block])';

/** @param {string} text */
function mebibytes(text) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 1024) throw Error('Expected MiB between 1 and 1024');
  return value * MIB;
}

async function inputs() {
  if (values.headroom) return {headroom: values.headroom.split(',').map(mebibytes)};

  const size = /^(\d+)x(\d+)$/.exec(values.size ?? '');
  if (!size || !values.sample) throw Error(usage);
  const {width, height} = largeDimensions(Number(size[1]), Number(size[2]));
  if (!['auto', 'bridge', 'block'].includes(String(values.memory))) throw Error('Expected --memory auto, bridge or block');
  if (!values['open-only'] && !values.reference) throw Error('A decode needs --reference, or pass --open-only');

  const all = temporalUnits(await fs.readFile(values.sample));
  const count = values.frames ? Number(values.frames) : all.length;
  if (!Number.isInteger(count) || count < 1 || count > all.length) throw Error('--frames exceeds the sample');
  const units = all.slice(0, count);

  const frameBytes = width * height * 3 / 2;
  const referenceBytes = values.reference ? await fs.readFile(values.reference) : Buffer.alloc(0);
  if (values.reference && referenceBytes.length < count * frameBytes) throw Error('The reference holds fewer frames');
  const references = Array.from({length: values.reference ? count : 0},
    (_, index) => referenceBytes.subarray(index * frameBytes, (index + 1) * frameBytes));
  const workspaceBytes = values['workspace-mib'] ? mebibytes(values['workspace-mib']) : undefined;
  const memory = /** @type {'auto' | 'bridge' | 'block'} */ (values.memory);
  return {decode: {width, height, units, references, workspaceBytes, memory, openOnly: Boolean(values['open-only'])}};
}

if (values.help) {
  console.log(usage);
} else {
  if (!values.console || !values.host || !values.directory) throw Error(usage);
  const plan = await inputs();
  const directory = path.resolve(values.directory);
  const relative = path.relative('/media/storage2/builds/moonlight', directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw Error('Choose a new directory under /media/storage2/builds/moonlight');
  await fs.mkdir(directory, {mode: 0o700});
  const journal = await fs.open(path.join(directory, 'events.jsonl'), 'wx', 0o600);
  const revision = await promisify(execFile)('git', ['rev-parse', 'HEAD']);
  const changes = await promisify(execFile)('git', ['status', '--porcelain']);
  const report = {sourceRevision: revision.stdout.trim(), dirty: Boolean(changes.stdout),
    command: process.argv.slice(1), targetArchitecture: 'aarch64', builder: os.hostname(),
    started: new Date().toISOString(), completed: '', error: '', session: '',
    units: plan.decode?.units.map(unit => unit.length) ?? [],
    result: /** @type {object | null} */ (null)};
  const files = ['../large-frame-probe.js', './large-frame-probe.js', '../../console-api/large-frame-probe-functions.json'];
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const name of files) {
    const bytes = await fs.readFile(new URL(name, import.meta.url));
    hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  await fs.writeFile(path.join(directory, 'SOURCE-SHA256.json'), JSON.stringify(hashes, null, 2) + '\n');

  /** @param {object} event */
  async function log(event) {
    await journal.write(JSON.stringify({at: new Date().toISOString(), ...event}) + '\n');
    await journal.sync();
  }
  const save = () => fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  let rpc;
  let restart = false;
  try {
    await save();
    rpc = await attach({consoleHost: values.console, hostAddress: values.host,
      log: message => process.stderr.write(message)});
    report.session = rpc.a.session;
    await log({event: 'attach-after', session: report.session});
    if (plan.headroom) {
      report.result = await probeMemoryHeadroom(rpc, {sizes: plan.headroom, log});
    } else if (plan.decode) {
      await resolveCompatibility(rpc, {directory, cache: path.join(directory, 'compat-cache')});
      const result = await probeLargeAv1(rpc, {...plan.decode, directory, log});
      report.result = result;
      restart = result.cleanup !== 'clean';
      if (!['pixels-verified', 'opened'].includes(result.status)) process.exitCode = 1;
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    await log({event: 'probe-error', message: report.error});
    process.exitCode = 1;
  } finally {
    if (rpc?.connected) {
      if (restart) rpc.disconnect(Error('Uncertain AV1 probe resources; restart the console app'));
      else {
        try { await rpc.close(); }
        catch (error) { report.error ||= String(error); process.exitCode = 1; }
      }
    }
    report.completed = new Date().toISOString();
    await save();
    await journal.close();
    console.log(JSON.stringify({directory, ...report}));
  }
}
