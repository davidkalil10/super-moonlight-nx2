// The Moonlight HB package loads on backend one with the bytes build.js committed. The vertex
// stage, state, data and memory image are still the Git blobs of hbl-moonlight 10c102a (T216
// move table), the last revision in the app.json layout; the compute and fragment stages moved
// with the console UI (U2) and are the shim build of this revision.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const moonlight = path.resolve(__dirname, '../../../hbl-moonlight');
const platform = path.resolve(__dirname, '../../../hbl-platform');
const launcher = path.resolve(__dirname, '../../../HBLauncher');
const PACKAGE = path.join(moonlight, 'apps/moonlight');

const PINNED = {
  vertex: 'b7ff21339bf0cf87fc6d428091deb15913533c94d08062539ea48a2e54a9fe4f',
  fragment: 'a640be602c8fb874a314e1349a1c4d6baa51638e5bcff85ab810cd593775da08',
  compute: 'beb948bfe8070a75c91c2657801d0fdeb8add89f9382beea86044805e8fd50a2',
  state: '370c0ab9bc38e877611b4dc867e5eabab6d0fd6cf24f90a6010f8e3a51b80051',
  data: 'f5bd127446b306fc0d512f5382c53087f34ce4b7fb4fc8477743520bce98ffdd',
  memory: '9573805be9a6be2fe3b4f095fe2180a771321d3549fdcf48eba1cb1607a8efa2',
  icon: '35075423270cead4efeb1bcdc88c7ed3104806dfd3a4899fb2ce8d92aed344bd'
};
const MEMORY_BYTES = 20217856;

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('the Moonlight package loads on backend one with the committed bytes', async () => {
  const {loadApp} = await import(path.join(platform, 'sdk/package/loader.js'));
  const {backend} = await import(path.join(launcher, 'sdk/host/package-backend.js'));
  const app = await loadApp(PACKAGE, [backend], {validate: false});
  assert.equal(app.id, 'moonlight');
  assert.equal(app.name, 'Moonlight');
  assert.deepEqual(Object.keys(app.files).sort(), Object.keys(PINNED).sort());
  for (const [name, hash] of Object.entries(PINNED))
    assert.equal(sha256(app.files[name].bytes), hash, name);
  assert.equal(app.files.memory.allocationBytes, MEMORY_BYTES);
  assert.deepEqual(app.effects, {});
  assert.deepEqual(app.manifest.sdk, {version: 1, capabilities: []});
});

/**
 * Runs build.js from a copy of the package and its tools beside the real hbl-platform, so a
 * build that should have been refused never rewrites the real package. Returns the result and
 * whether any file under the copied package changed.
 */
function buildCopy(args, {cwd = '', env = {}} = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const {spawnSync} = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-build-'));
  try {
    const copy = path.join(root, 'hbl-moonlight');
    for (const part of ['apps/moonlight', 'tools/moonlight'])
      fs.cpSync(path.join(moonlight, part), path.join(copy, part), {recursive: true});
    fs.symlinkSync(platform, path.join(root, 'hbl-platform'));
    const pkg = path.join(copy, 'apps/moonlight');
    const snapshot = () =>
      fs
        .readdirSync(pkg, {recursive: true})
        .filter(name => fs.statSync(path.join(pkg, name)).isFile())
        .sort()
        .map(name => name + ' ' + sha256(fs.readFileSync(path.join(pkg, name))));
    const before = snapshot();
    assert.ok(before.some(line => line.startsWith('assets/text.bin ')));
    assert.ok(before.some(line => line.startsWith('backends/hblauncher.gpu-app/text.glsl ')));
    const result = spawnSync(process.execPath, [path.join(pkg, 'build.js'), ...args], {
      cwd: path.join(copy, cwd),
      encoding: 'utf8',
      env: {...process.env, ...env}
    });
    return {...result, unchanged: JSON.stringify(snapshot()) === JSON.stringify(before)};
  } finally {
    fs.rmSync(root, {recursive: true});
  }
}

test('build.js refuses arguments before it writes the package', () => {
  for (const [cwd, check] of [
    ['', 'node ../hbl-platform/sdk/build.js --check apps/moonlight'],
    ['apps/moonlight', 'node ../../../hbl-platform/sdk/build.js --check .']
  ]) {
    const result = buildCopy(['--check'], {cwd});
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      'build.js takes no arguments and rewrites the package in place; to check it, run ' +
        check +
        '\n'
    );
    assert.ok(result.unchanged);
  }
});

test('build.js refuses another glslc before it writes the package', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const glslc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glslc-')), 'glslc');
  fs.writeFileSync(glslc, '#!/bin/sh\necho "shaderc v2025.2 2025-05-01"\n', {mode: 0o755});
  const result = buildCopy([], {env: {GLSLC: glslc}});
  fs.rmSync(path.dirname(glslc), {recursive: true});
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^build\.js compiles with glslc shaderc v2026\.1 .*found shaderc v2025\.2 .*Nothing was written\.\n$/
  );
  assert.ok(result.unchanged);
});

test('the package has no portable entry and no unlisted assets', async () => {
  const {readPackage} = await import(path.join(platform, 'sdk/package/manifest.js'));
  const pkg = await readPackage(PACKAGE);
  assert.equal(pkg.manifest.entry, undefined);
  assert.deepEqual(Object.keys(pkg.assets), ['assets/icon.png', 'assets/text.bin']);
  assert.deepEqual(pkg.sources, {});
});
