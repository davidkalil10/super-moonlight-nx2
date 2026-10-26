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

test('build.js refuses arguments before it writes the package', async () => {
  const fs = require('node:fs');
  const {spawnSync} = require('node:child_process');
  const section = path.join(PACKAGE, 'backends/hblauncher.gpu-app');
  const snapshot = () =>
    Object.fromEntries(
      fs.readdirSync(section).map(name => [name, sha256(fs.readFileSync(path.join(section, name)))])
    );
  const before = snapshot();
  const result = spawnSync(process.execPath, [path.join(PACKAGE, 'build.js'), '--check'], {
    cwd: moonlight,
    encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /takes no arguments.*sdk\/build\.js --check apps\/moonlight/);
  assert.deepEqual(snapshot(), before);
});

test('the package has no portable entry and no unlisted assets', async () => {
  const {readPackage} = await import(path.join(platform, 'sdk/package/manifest.js'));
  const pkg = await readPackage(PACKAGE);
  assert.equal(pkg.manifest.entry, undefined);
  assert.deepEqual(Object.keys(pkg.assets), ['assets/icon.png', 'assets/text.bin']);
  assert.deepEqual(pkg.sources, {});
});
