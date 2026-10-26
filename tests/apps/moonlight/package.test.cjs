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
  fragment: '85ef945f4b7a22b9924d0a8da2c0f403e3d8d6ca36c890b68b47b2c185e42021',
  compute: '64538e6bf2075e4c4307655acfd53f347d5014ab4ed073f44ad7dd19cf447fd5',
  state: '370c0ab9bc38e877611b4dc867e5eabab6d0fd6cf24f90a6010f8e3a51b80051',
  data: 'f5bd127446b306fc0d512f5382c53087f34ce4b7fb4fc8477743520bce98ffdd',
  memory: '9573805be9a6be2fe3b4f095fe2180a771321d3549fdcf48eba1cb1607a8efa2',
  icon: '19493baa4f4ddb1eedd69716f18ed68a97a3e1cd7b646777bba162d508d2eb90'
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

test('the package has no portable entry and no unlisted assets', async () => {
  const {readPackage} = await import(path.join(platform, 'sdk/package/manifest.js'));
  const pkg = await readPackage(PACKAGE);
  assert.equal(pkg.manifest.entry, undefined);
  assert.deepEqual(Object.keys(pkg.assets), ['assets/icon.png', 'assets/text.bin']);
  assert.deepEqual(pkg.sources, {});
});
