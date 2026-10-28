// The Moonlight HB package loads on backend one with the bytes build.js committed. The vertex
// stage, state, data and memory image are still the Git blobs of hbl-moonlight 10c102a (T216
// move table), the last revision in the app.json layout; the compute and fragment stages moved
// with the console UI (U2) and are the shim build of this revision.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const moonlight = path.resolve(__dirname, '../../..');
const platform = path.resolve(__dirname, '../../../../hbl-platform');
const launcher = path.resolve(__dirname, '../../../../HBLauncher');
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-build-')));
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
      cwd: path.resolve(copy, cwd),
      encoding: 'utf8',
      env: {...process.env, ...env}
    });
    return {...result, copy, unchanged: JSON.stringify(snapshot()) === JSON.stringify(before)};
  } finally {
    fs.rmSync(root, {recursive: true});
  }
}

/** The hint build.js prints for `target` from `cwd`: the shorter form, absolute from /. */
function hint(cwd, target) {
  const relative = path.relative(cwd, target) || '.';
  return relative.length < target.length && cwd !== '/' ? relative : target;
}

test('build.js refuses arguments before it writes the package', () => {
  for (const [cwd, check] of [
    ['', 'node ../hbl-platform/sdk/build.js --check apps/moonlight'],
    ['apps/moonlight', 'node ../../../hbl-platform/sdk/build.js --check .'],
    ...[__dirname, '/'].map(from => [
      from,
      copy =>
        `node ${hint(from, path.resolve(copy, '../hbl-platform/sdk/build.js'))} --check ` +
        hint(from, path.join(copy, 'apps/moonlight'))
    ])
  ]) {
    const result = buildCopy(['--check'], {cwd});
    const shown = typeof check === 'function' ? check(result.copy) : check;
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr,
      'build.js takes no arguments and rewrites the package in place; to check it, run ' +
        shown +
        '\n'
    );
    assert.ok(result.unchanged);
  }
  const wrongGlslc = buildCopy(['--check'], {env: {GLSLC: '/bin/false'}});
  assert.match(wrongGlslc.stderr, /^build\.js takes no arguments/);
  assert.ok(wrongGlslc.unchanged);
});

/** Runs buildCopy with GLSLC set to a shell script made from `body`, in a directory of its own. */
function withGlslc(body, options = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glslc-'));
  const glslc = path.join(directory, 'glslc');
  fs.writeFileSync(glslc, '#!/bin/sh\n' + body(directory) + '\n', {mode: 0o755});
  try {
    const result = buildCopy([], {...options, env: {...options.env, GLSLC: glslc}});
    const log = path.join(directory, 'calls');
    return {...result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''};
  } finally {
    fs.rmSync(directory, {recursive: true});
  }
}

test('build.js refuses another glslc before it writes the package', () => {
  for (const [body, found] of [
    [() => 'echo "shaderc v2025.2 2025-05-01"', 'shaderc v2025.2 2025-05-01'],
    [() => 'echo "broken install" >&2; exit 1', 'none (Command failed: ']
  ]) {
    const result = withGlslc(body);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^build\.js compiles with glslc shaderc v2026\.1 [^\n]* found /);
    assert.ok(result.stderr.includes(' found ' + found), result.stderr);
    assert.match(result.stderr, /; install it or point GLSLC at it\. Nothing was written\.\n$/);
    if (found.startsWith('none')) assert.match(result.stderr, /\); install it/);
    assert.equal(result.stderr.split('\n').length, 2, result.stderr);
    assert.ok(result.unchanged);
  }
});

test('build.js compiles with the GLSLC it checked, whatever GLSLANG says', async () => {
  const {GLSLC_VERSION} = await import(path.join(PACKAGE, 'build.js'));
  const result = withGlslc(
    directory =>
      `if [ "$1" = --version ]; then echo '${GLSLC_VERSION}'; exit 0; fi\n` +
      `echo "$@" >> ${directory}/calls; exit 3`,
    {env: {GLSLANG: '/bin/false'}}
  );
  assert.notEqual(result.status, 0);
  assert.match(result.calls, /^-Os --target-env=vulkan1\.0 \S+app\.vert -o \S+app\.vert\.spv$/m);
  assert.match(
    result.stderr,
    /^build\.js ignores GLSLANG and compiles through \S+glslang-shim\.sh/m
  );
  const relativeShim = withGlslc(
    directory =>
      `if [ "$1" = --version ]; then echo '${GLSLC_VERSION}'; exit 0; fi\n` +
      `echo "$@" >> ${directory}/calls; exit 3`,
    {env: {GLSLANG: 'tools/moonlight/glslang-shim.sh'}}
  );
  assert.match(relativeShim.calls, /app\.vert\.spv$/m);
  assert.doesNotMatch(relativeShim.stderr, /ignores GLSLANG/);
});

test('the package has no portable entry and no unlisted assets', async () => {
  const {readPackage} = await import(path.join(platform, 'sdk/package/manifest.js'));
  const pkg = await readPackage(PACKAGE);
  assert.equal(pkg.manifest.entry, undefined);
  assert.deepEqual(Object.keys(pkg.assets), ['assets/icon.png', 'assets/text.bin']);
  assert.deepEqual(pkg.sources, {});
});
