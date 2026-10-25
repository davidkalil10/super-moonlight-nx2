const fsp = require('node:fs/promises');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
const session = require('../host/session.cjs');
const {STAGES} = require('./probe-split-decoder.cjs');

const PROBE = path.join(__dirname, 'probe-split-decoder.cjs');
const BUILDS = '/media/storage2/builds/HBLauncher/native-h264';
const RUNS_FILE = '/media/storage/local/hbl-notes/RUNS.md';
const RESTART = 'Restart SmileBASIC (fresh normal START session) before any further probe run.';
const VALUE_OPTIONS = ['--clip', '--stages', '--output', '--reject-session'];
const FLAGS = ['--dry-run', '--native-publish', '--auto-output-queue'];

function parseArgs(args) {
  const parsed = {
    directory: null,
    clip: null,
    stages: STAGES,
    output: null,
    dryRun: false,
    nativePublish: false,
    autoOutputQueue: false,
    rejectSession: null
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (FLAGS.includes(arg)) {
      if (arg === '--dry-run') parsed.dryRun = true;
      else if (arg === '--native-publish') parsed.nativePublish = true;
      else parsed.autoOutputQueue = true;
    } else if (VALUE_OPTIONS.includes(arg)) {
      const value = args[++index];
      if (value === undefined || value === '' || value.startsWith('--'))
        throw Error(arg + ' needs a value');
      if (arg === '--clip') parsed.clip = value;
      else if (arg === '--output') parsed.output = value;
      else if (arg === '--stages') parsed.stages = parseStages(value);
      else parsed.rejectSession = value;
    } else if (arg.startsWith('--')) {
      throw Error('Unknown option ' + arg);
    } else if (index === 0) {
      parsed.directory = arg;
    } else {
      throw Error('Unexpected argument ' + arg);
    }
  }
  if (!parsed.clip) throw Error('Pass --clip with an H.264 probe clip');
  if (parsed.autoOutputQueue && !parsed.nativePublish)
    throw Error('--auto-output-queue requires --native-publish');
  return parsed;
}

function parseStages(value) {
  const names = value.split(',').map(name => name.trim());
  for (const name of names)
    if (!STAGES.includes(name)) throw Error('Unknown stage ' + JSON.stringify(name));
  if (new Set(names).size !== names.length) throw Error('Repeated stage in --stages');
  return STAGES.filter(stage => names.includes(stage));
}

function stageCommand({directory, clip, stage, nativePublish = false, autoOutputQueue = false}) {
  const args = [PROBE];
  if (directory) args.push(path.resolve(directory));
  args.push('--clip', path.resolve(clip), '--stage', stage);
  if (nativePublish) args.push('--native-publish');
  if (autoOutputQueue) args.push('--auto-output-queue');
  return {command: process.execPath, args};
}

function quote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
}

function verdictOf(stage, {code, stdout}) {
  const marker = new RegExp(
    '^SPLIT DECODER ' + stage + ' (PASS|FAIL) \\(record (.+)\\)$',
    'm'
  ).exec(stdout);
  return {
    verdict: code === 0 && marker?.[1] === 'PASS' ? 'PASS' : 'FAIL',
    record: marker ? marker[2] : null
  };
}

function runProbe({command, args}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['inherit', 'pipe', 'inherit']});
    let stdout = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout}));
  });
}

function revision() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8'
  }).trim();
}

async function main(
  options,
  {
    run = runProbe,
    log = console.log,
    sourceRevision,
    builds = BUILDS,
    runsFile = RUNS_FILE,
    now = () => new Date()
  } = {}
) {
  const {directory, clip, stages, dryRun, nativePublish, autoOutputQueue, rejectSession} = options;
  const commands = stages.map(stage => ({
    stage,
    ...stageCommand({directory, clip, stage, nativePublish, autoOutputQueue})
  }));
  if (dryRun) {
    for (const {command, args} of commands) log([command, ...args].map(quote).join(' '));
    return {dryRun: true, commands};
  }
  if (rejectSession && directory && path.basename(path.resolve(directory)) === rejectSession)
    throw Error('Start a fresh normal START session before retrying; ' + rejectSession + ' is exhausted');
  const rev = sourceRevision || revision();
  const started = now();
  const output =
    options.output ||
    path.join(
      builds,
      started.toISOString().replace(/[:.]/g, '-') +
        '-' +
        rev.slice(0, 8) +
        (autoOutputQueue ? '-split-auto-ladder' : nativePublish ? '-split-publish-ladder' : '-split-ladder')
    );
  await fsp.mkdir(output, {recursive: true, mode: 0o700});
  const ladder = {
    probe: 'split-ladder',
    sourceRevision: rev,
    session: directory ? path.resolve(directory) : null,
    clip: path.resolve(clip),
    nativePublish,
    autoOutputQueue,
    stages: [],
    started: started.toISOString()
  };
  await fsp.appendFile(
    runsFile,
    '\n## ' +
      started.toISOString().slice(0, 10) +
      ' — split safety ladder at `' +
      rev.slice(0, 8) +
      '` (' +
      output +
      ')\n\n'
  );
  for (const {stage, command, args} of commands) {
    const begin = now();
    let result;
    try {
      result = verdictOf(stage, await run({command, args, stage}));
    } catch (error) {
      result = {verdict: 'FAIL', record: null, error: error.message};
    }
    const seconds = Number(((now() - begin) / 1000).toFixed(1));
    ladder.stages.push({stage, ...result, seconds, command: [command, ...args]});
    await fsp.appendFile(
      runsFile,
      '- ' +
        stage +
        ': ' +
        result.verdict +
        ', ' +
        (result.record || 'no record') +
        ', ' +
        seconds +
        's\n'
    );
    if (result.verdict !== 'PASS') break;
  }
  const failed = ladder.stages.find(entry => entry.verdict !== 'PASS');
  ladder.skipped = stages.slice(ladder.stages.length);
  ladder.finished = now().toISOString();
  ladder.verdict = failed ? 'FAIL' : 'PASS';
  await fsp.writeFile(path.join(output, 'ladder.json'), JSON.stringify(ladder, null, 2) + '\n', {
    mode: 0o600
  });
  if (failed) {
    log('SPLIT LADDER FAIL at ' + failed.stage + ' (record ' + output + ')');
    log(RESTART);
  } else {
    log('SPLIT LADDER PASS (record ' + output + ')');
  }
  return {...ladder, output};
}

module.exports = {main, parseArgs, stageCommand, verdictOf};
if (require.main === module) {
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    if (!options.directory) {
      try {
        options.directory = session.resolve();
      } catch (error) {
        if (!options.dryRun) throw error;
      }
    }
    const ladder = await main(options);
    if (ladder.verdict === 'FAIL') process.exitCode = 1;
  })().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
