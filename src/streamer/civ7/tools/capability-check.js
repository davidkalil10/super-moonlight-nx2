#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify, parseArgs} from 'node:util';
import {attach} from '../transport.js';
import {checkCapabilities} from '../capability-check.js';

const {values} = parseArgs({options: {
  console: {type: 'string'}, host: {type: 'string'}, directory: {type: 'string'},
  help: {type: 'boolean', short: 'h'}
}});
const usage = 'node src/streamer/civ7/tools/capability-check.js --console IP --host IP ' +
  '--directory /media/storage2/builds/moonlight/NEW_RUN';

if (values.help) {
  console.log(usage);
} else {
  if (!values.console || !values.host || !values.directory) throw Error(usage);
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
    result: /** @type {Awaited<ReturnType<typeof checkCapabilities>> | null} */ (null)};
  const files = ['../capability-check.js', './capability-check.js', '../../console-api/capability-check-functions.json', '../runtime-capabilities.js', '../payload.js'];
  const hashes = /** @type {Record<string, string>} */ ({});
  for (const name of files) {
    const file = new URL(name, import.meta.url);
    const bytes = await fs.readFile(file);
    hashes[name] = crypto.createHash('sha256').update(bytes).digest('hex');
    const destination = path.join(directory, 'source', name === './capability-check.js' ? 'tools' : '', path.basename(file.pathname));
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination, bytes, {mode: 0o600});
  }
  await fs.writeFile(path.join(directory, 'SOURCE-SHA256.json'), JSON.stringify(hashes, null, 2) + '\n');
  /** @param {object} event */
  async function log(event) {
    await journal.write(JSON.stringify({at: new Date().toISOString(), ...event}) + '\n');
    await journal.sync();
  }
  const save = () => fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  let rpc;
  try {
    await save();
    await log({event: 'attach-before'});
    rpc = await attach({consoleHost: values.console, hostAddress: values.host,
      log: message => process.stderr.write(message)});
    report.session = rpc.a.session;
    await log({event: 'attach-after', session: report.session});
    report.result = await checkCapabilities(rpc, {log});
    if (report.result.status === 'failed' || report.result.cleanup !== 'clean') process.exitCode = 1;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    await log({event: 'probe-error', message: report.error});
    process.exitCode = 1;
  } finally {
    if (rpc?.connected) {
      if (report.result?.cleanup === 'restart-required') {
        rpc.disconnect(Error('Uncertain capability query resources; restart the console app'));
      } else {
        try { await rpc.close(); }
        catch (error) { report.error = String(error); process.exitCode = 1; }
      }
    }
    report.completed = new Date().toISOString();
    await save();
    await journal.close();
    console.log(JSON.stringify({directory, ...report}));
  }
}
