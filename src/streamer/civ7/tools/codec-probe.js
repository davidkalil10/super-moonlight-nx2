#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {attach} from '../transport.js';
import {probeCodec, probeDimensions} from '../codec-probe.js';
import {resolveCompatibility} from '../modules.js';
import {create as createDecoder} from '../decoder.js';
import {createSampleProbe} from '../codec-sample.js';

const {values} = parseArgs({options: {
  console: {type: 'string'}, host: {type: 'string'}, directory: {type: 'string'},
  codec: {type: 'string'}, size: {type: 'string', default: '128x96'},
  sample: {type: 'string'}, reference: {type: 'string'},
  'control-sample': {type: 'string'}, 'control-reference': {type: 'string'},
  'hevc-registration': {type: 'string'},
  drain: {type: 'boolean'},
  help: {type: 'boolean', short: 'h'}
}});
const usage = 'node src/streamer/civ7/tools/codec-probe.js --console IP --host IP ' +
  '--directory /media/storage2/builds/moonlight/NEW_RUN --codec h264|hevc|av1|vp8|vp9 ' +
  '[--size 1280x720 --sample FILE --reference NV12 --control-sample H264 --control-reference NV12] ' +
  '[--hevc-registration 0|2] [--drain]';

if (values.help) {
  console.log(usage);
} else {
  if (!values.console || !values.host || !values.directory || !values.codec)
    throw Error(usage);
  if (!['h264', 'hevc', 'av1', 'vp8', 'vp9'].includes(values.codec)) throw Error('Expected codec h264, hevc, av1, vp8 or vp9');
  const hevcRegistration = values['hevc-registration'];
  if (hevcRegistration && (values.codec !== 'hevc' || !['0', '2'].includes(hevcRegistration)))
    throw Error('--hevc-registration accepts 0 or 2 for HEVC only');
  const size = /^(\d+)x(\d+)$/.exec(values.size);
  if (!size) throw Error('Expected --size WIDTHxHEIGHT');
  const {width, height} = probeDimensions(values.codec, Number(size[1]), Number(size[2]));
  const frameBytes = width * height * 3 / 2;
  const sampleRequested = Boolean(values.sample || values.reference);
  if (!sampleRequested && (values['control-sample'] || values['control-reference']))
    throw Error('Control samples require --sample and --reference');
  if (sampleRequested && (!values.sample || !values.reference))
    throw Error('A decode probe needs --sample and --reference');
  if (sampleRequested && values.codec !== 'h264' && (!values['control-sample'] || !values['control-reference']))
    throw Error('A decode probe needs H.264 --control-sample and --control-reference');
  /** @param {string} file @param {number} maximum */
  async function sampleFile(file, maximum) {
    if ((await fs.stat(file)).size > maximum) throw Error('Sample file exceeds its size limit');
    return fs.readFile(file);
  }
  const sample = values.sample ? await sampleFile(values.sample, 1024 * 1024) : null;
  const reference = values.reference ? await sampleFile(values.reference, frameBytes) : null;
  const controlSample = values['control-sample'] ? await sampleFile(values['control-sample'], 1024 * 1024) : sample;
  const controlReference = values['control-reference'] ? await sampleFile(values['control-reference'], frameBytes) : reference;
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
    started: new Date().toISOString(), completed: '', error: '', status: 'running',
    results: /** @type {object[]} */ ([])};
  /** @param {object} event */
  async function log(event) {
    await journal.write(JSON.stringify({at: new Date().toISOString(), ...event}) + '\n');
    await journal.sync();
  }
  const save = () => fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  let rpc;
  let controlDecoder;
  try {
    await save();
    await log({event: 'attach-before'});
    rpc = await attach({consoleHost: values.console, hostAddress: values.host,
      log: message => process.stderr.write(message)});
    await log({event: 'attach-after', session: rpc.a.session});
    await resolveCompatibility(rpc, {directory, cache: path.join(directory, 'compat-cache')});
    await log({event: 'control-decoder-before'});
    controlDecoder = await createDecoder({rpc, directory});
    await log({event: 'control-decoder-after'});
    const codecs = values.codec === 'h264' ? ['h264'] : ['h264', values.codec];
    for (const codec of codecs) {
      const data = codec === 'h264' ? controlSample : sample;
      const expected = codec === 'h264' ? controlReference : reference;
      const sampleProbe = data && expected ? createSampleProbe({data, reference: expected, width, height,
        drain: Boolean(values.drain) && codec === values.codec,
        savePixels: pixels => fs.writeFile(path.join(directory, codec + '.nv12'), pixels, {mode: 0o600})}) : undefined;
      const registration = codec === 'hevc' && hevcRegistration ? Number(hevcRegistration) : undefined;
      const result = await probeCodec(rpc, {codec, log, sample: sampleProbe, width, height, registration});
      report.results.push(result);
      await save();
      console.log(JSON.stringify(result));
      if (!result.accepted) {
        report.status = codec === 'h264' ? 'inconclusive-control-failed' : 'service-open-rejected';
        break;
      }
      if (sampleRequested && !result.decoded) {
        report.status = codec === 'h264' ? 'inconclusive-control-decode-failed' : 'decode-unverified';
        break;
      }
    }
    if (report.status === 'running') report.status = sampleRequested
      ? 'decoded-pixels-verified' : 'service-open-accepted-decode-unverified';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    await log({event: 'probe-error', message: report.error});
    process.exitCode = 1;
  } finally {
    if (rpc?.connected) {
      try {
        if (controlDecoder) {
          await log({event: 'control-decoder-close-before'});
          await controlDecoder.close();
          await log({event: 'control-decoder-close-after'});
        }
        await rpc.close();
      }
      catch (error) {
        rpc.disconnect(Error('Codec probe cleanup failed; restart the console app'));
        report.status = 'cleanup-failed';
        report.error = String(error);
        await log({event: 'cleanup-error', message: String(error)});
        process.exitCode = 1;
      }
    }
    report.completed = new Date().toISOString();
    await save();
    await journal.close();
    console.log(JSON.stringify({directory, ...report}));
  }
}
