const fs = require('node:fs/promises');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const session = require('../../../hbl-platform/sdk/host/session.js');
const split = require('./probe-split-decoder.cjs');
const paired = require('./probe-paired-output.cjs');

const STAGES = ['one', 'two', 'stop-input', 'stop-output', 'short-recv'];
const BUILD_ROOT = '/media/storage2/builds/HBLauncher/native-h264';
const RUNS_FILE = '/media/storage/local/hbl-notes/RUNS.md';

function parseArgs(args) {
  const options = {
    directory: null,
    clip: null,
    stages: STAGES,
    dryRun: false,
    loop: false,
    staggered: false
  };
  let stagesSpecified = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--loop') options.loop = true;
    else if (arg === '--staggered') options.staggered = true;
    else if (arg === '--clip' || arg === '--stages') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error(arg + ' needs a value');
      if (arg === '--clip') options.clip = value;
      else {
        stagesSpecified = true;
        const names = value.split(',');
        if (new Set(names).size !== names.length || names.some(name => !STAGES.includes(name)))
          throw Error('Invalid paired ladder stages');
        options.stages = STAGES.filter(name => names.includes(name));
      }
    } else if (!arg.startsWith('--') && !options.directory) options.directory = arg;
    else throw Error('Unknown paired ladder argument ' + arg);
  }
  if (!options.clip) throw Error('Pass --clip with the ordered 1080p IP clip');
  if (options.staggered && (options.loop || stagesSpecified))
    throw Error('Staggered ladder selects its own complete safety stages');
  return options;
}

function stageCommand(directory, clip, stage, looping = false) {
  const script = path.join(
    __dirname,
    stage === 'one' ? 'probe-split-decoder.cjs' : 'probe-paired-output.cjs'
  );
  const args = [script];
  if (directory) args.push(path.resolve(directory));
  args.push('--clip', path.resolve(clip), '--stage', looping && stage !== 'one' ? `loop-${stage}` : stage);
  if (stage === 'one') args.push('--native-publish');
  return [process.execPath, ...args];
}

function quote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
}

async function main(
  options,
  {
    runSplit = split.main,
    runPaired = paired.main,
    runStaggered = require('./probe-staggered-ladder.cjs').main,
    ensureFresh = paired.requireNewPairedSession,
    sessionRpc = session.rpc,
    sourceRevision,
    builds = BUILD_ROOT,
    runsFile = RUNS_FILE,
    now = () => new Date(),
    log = console.log
  } = {}
) {
  const {clip, stages, dryRun, loop: looping = false} = options;
  if (options.staggered)
    return runStaggered(options.directory, {clip, dryRun});
  const directory = options.directory ? path.resolve(options.directory) : null;
  const commands = stages.map(stage => ({
    stage,
    command: stageCommand(directory, clip, stage, looping)
  }));
  if (dryRun) {
    for (const item of commands) log(item.command.map(quote).join(' '));
    return {dryRun: true, commands};
  }
  const current = directory || session.resolve();
  const rpc = sessionRpc(current);
  if (!rpc.host) throw Error('Paired ladder needs a normal START session');
  await ensureFresh(rpc.a.session);
  const revision =
    sourceRevision ||
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8'
    }).trim();
  const started = now();
  const output = path.join(
    builds,
    started.toISOString().replace(/[:.]/g, '-') + '-' + revision.slice(0, 8) +
      (looping ? '-r3-paired-loop-ladder' : '-r3-paired-ladder')
  );
  await fs.mkdir(output, {recursive: true, mode: 0o700});
  const ladder = {
    probe: looping ? 'paired-loop-ladder' : 'paired-ladder',
    session: rpc.a.session,
    sourceRevision: revision,
    clip: path.resolve(clip),
    started: started.toISOString(),
    stages: []
  };
  await fs.appendFile(
    runsFile,
    `\n## ${started.toISOString().slice(0, 10)} — R3 ${looping ? 'paired-loop' : 'paired-output'} ladder at \`${revision.slice(0, 8)}\` (${output})\n\n`
  );
  for (const {stage, command} of commands) {
    const stageOutput = path.join(output, stage);
    const began = now();
    let verdict = 'PASS';
    let error = null;
    try {
      if (stage === 'one')
        await runSplit(current, {
          clip,
          stage,
          output: stageOutput,
          nativePublish: true
        });
      else
        await runPaired(current, {
          clip,
          stage: looping ? `loop-${stage}` : stage,
          output: stageOutput,
          allowSameSession: true
        });
    } catch (failure) {
      verdict = 'FAIL';
      error = failure.message;
    }
    const seconds = Number(((now() - began) / 1000).toFixed(1));
    const possibleRecord = path.join(
      stageOutput,
      stage === 'one' ? 'result.json' : 'paired-output.json'
    );
    const record = await fs.access(possibleRecord).then(
      () => possibleRecord,
      () => null
    );
    const result = {stage, verdict, record, seconds, command, ...(error ? {error} : {})};
    ladder.stages.push(result);
    await fs.appendFile(
      runsFile,
      `- ${stage}: ${verdict}, ${record || 'no record'}, ${seconds}s\n`
    );
    if (verdict === 'FAIL') break;
  }
  ladder.skipped = stages.slice(ladder.stages.length);
  ladder.finished = now().toISOString();
  ladder.verdict = ladder.stages.some(item => item.verdict === 'FAIL') ? 'FAIL' : 'PASS';
  await fs.writeFile(path.join(output, 'ladder.json'), JSON.stringify(ladder, null, 2) + '\n', {
    mode: 0o600
  });
  log(`PAIRED ${looping ? 'LOOP ' : ''}LADDER ${ladder.verdict} (${output})`);
  if (ladder.verdict === 'FAIL') log('Restart SmileBASIC before any further device run.');
  return {...ladder, output};
}

module.exports = {main, parseArgs, stageCommand, STAGES};
if (require.main === module)
  (async () => {
    const options = parseArgs(process.argv.slice(2));
    const result = await main(options);
    if (result.verdict === 'FAIL') process.exitCode = 1;
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
