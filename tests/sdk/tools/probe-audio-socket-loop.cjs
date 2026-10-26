const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const session = require('../../../hbl-platform/sdk/host/session.js');
const {create: createTransport} = require('../../../hbl-moonlight/tools/moonlight/native-tcp.js');
const {
  create: createAudio
} = require('../../../hbl-moonlight/tools/moonlight/audio-socket-worker.js');

const BUILD_ROOT = '/media/storage2/builds/HBLauncher/native-h264';
const BUFFER_BYTES = 7680;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function journal(file) {
  const descriptor = fsSync.openSync(file, 'wx', 0o600);
  let sequence = 0;
  return {
    write(value) {
      fsSync.writeSync(
        descriptor,
        JSON.stringify({sequence: ++sequence, at: new Date().toISOString(), ...value}) + '\n'
      );
      fsSync.fsyncSync(descriptor);
    },
    close() {
      fsSync.closeSync(descriptor);
    }
  };
}

function loggedRpc(raw, entries) {
  const rpc = {...raw, bridgeLost: false};
  for (const operation of ['request', 'call', 'callAddress', 'read', 'write', 'query']) {
    rpc[operation] = async (...args) => {
      const target = operation === 'request' ? args[0]?.command : args[0];
      entries.write({phase: 'before', operation, target});
      try {
        const result = await raw[operation](...args);
        entries.write({phase: 'after', operation, target});
        return result;
      } catch (error) {
        if (/disconnected|timed out|ECONN|EPIPE|socket hang up/i.test(error.message))
          rpc.bridgeLost = true;
        entries.write({phase: 'error', operation, target, message: error.message});
        throw error;
      }
    };
  }
  return rpc;
}

async function requireNewAudioSession(id, root = BUILD_ROOT) {
  for (const name of await fs.readdir(root)) {
    if (!name.includes('-audio-')) continue;
    for (const file of ['audio-event.json', 'audio-socket-loop.json']) {
      try {
        const record = JSON.parse(await fs.readFile(path.join(root, name, file), 'utf8'));
        if (record.session === id)
          throw Object.assign(Error('Start a new normal START session before socket audio loop'), {
            prior: path.join(root, name, file)
          });
      } catch (error) {
        if (error.prior) throw error;
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

async function main(directory = session.resolve(), {output} = {}) {
  directory = path.resolve(directory);
  const raw = session.rpc(directory);
  if (!raw.host) throw Error('Socket audio loop needs a normal START session');
  await requireNewAudioSession(raw.a.session);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  }).trim();
  output ||= path.join(
    BUILD_ROOT,
    new Date().toISOString().replace(/[:.]/g, '-') +
      '-' +
      revision.slice(0, 8) +
      '-audio-socket-loop'
  );
  await fs.mkdir(output, {recursive: true, mode: 0o700});
  const entries = journal(path.join(output, 'audio-socket-loop.jsonl'));
  const rpc = loggedRpc(raw, entries);
  const record = {
    probe: 'audio-socket-loop',
    session: raw.a.session,
    sourceRevision: revision,
    builder: os.hostname(),
    targetArchitecture: 'aarch64',
    command: process.argv,
    started: new Date().toISOString()
  };
  const report = path.join(output, 'audio-socket-loop.json');
  const save = () => fs.writeFile(report, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  let transport = null;
  let audio = null;
  let failure = null;
  try {
    transport = await createTransport({rpc, host: rpc.host});
    audio = await createAudio({rpc, transport, bufferBytes: BUFFER_BYTES});
    const silence = Buffer.alloc(BUFFER_BYTES);
    await audio.start(silence, silence);
    for (let index = 0; index < 6; index++) {
      await pause(40);
      await audio.send(silence);
    }
    record.health = await audio.health();
    await audio.stop();
    await transport.close();
    record.verdict = 'PASS';
  } catch (error) {
    failure = error;
    record.verdict = 'FAIL';
    record.error = error.message;
  } finally {
    if (audio && !audio.retained && record.verdict !== 'PASS') {
      try {
        await audio.stop();
      } catch (error) {
        record.cleanupError = error.message;
      }
    }
    if (transport && record.verdict !== 'PASS') {
      if (!audio?.retained && !rpc.bridgeLost) {
        try {
          await transport.close();
        } catch (error) {
          record.cleanupError = error.message;
        }
      } else transport.abort();
    }
    record.retainedForSafety = Boolean(audio?.retained || rpc.bridgeLost);
    record.finished = new Date().toISOString();
    await save();
    entries.close();
  }
  console.log(`AUDIO SOCKET LOOP ${record.verdict} (${report})`);
  if (failure) throw failure;
  return record;
}

module.exports = {main, requireNewAudioSession};
if (require.main === module)
  main(session.resolve(process.argv[2])).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
