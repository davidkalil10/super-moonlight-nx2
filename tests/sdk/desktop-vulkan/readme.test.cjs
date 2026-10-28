// The README's smoke command, run as written against the hello-world fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {gpuStatus} = require('./run.cjs');
const {builds} = require('../../../hbl-platform/sdk/build.js');

const README = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
const ROOT = path.resolve(__dirname, '../..');
fs.mkdirSync(builds('desktop-vulkan'), {recursive: true});
const scratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'readme-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));
const gpu = gpuStatus(path.join(scratch, 'runner'));

test('documented-smoke-command-is-reproducible', {skip: gpu.reason ?? false}, () => {
  assert.match(README, /Offscreen only/);
  assert.match(README, /No audio/);
  assert.match(README, /no Moonlight stream/);
  const line = README.split('\n').find(text => text.startsWith('node sdk/desktop-vulkan/'));
  assert.ok(line, 'README has no smoke command');
  const [command, ...args] = line.split(' ').map(word => (word === 'BUILD_DIR' ? scratch : word));
  assert.equal(command, 'node');
  const stdout = execFileSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const report = JSON.parse(stdout.slice(stdout.search(/^\{/m)));
  assert.equal(report.selected, 'desktop.vulkan');
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  assert.equal(report.state.exitRequest, 1);
  assert.equal(report.state.frames, 6);
  const output = path.join(scratch, 'output');
  for (const name of [
    'frame.rgba',
    'state.bin',
    'states.bin',
    'data.bin',
    'frames.bin',
    'run.json'
  ]) {
    assert.ok(README.includes('`' + name + '`'), name + ' undocumented');
    assert.ok(fs.statSync(path.join(output, name)).size > 0, name);
  }
});
