// The Moonlight HB package runs the same bytes on backend one as the legacy app folder did.
// The hashes are the Git blobs of hbl-moonlight 10c102a (T216 move table), the last revision
// with apps/moonlight in the app.json layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const moonlight = path.resolve(__dirname, '../../../hbl-moonlight');
const platform = path.resolve(__dirname, '../../../hbl-platform');
const launcher = path.resolve(__dirname, '../../../HBLauncher');
const PACKAGE = path.join(moonlight, 'apps/moonlight');

const LEGACY = {
  vertex: 'b7ff21339bf0cf87fc6d428091deb15913533c94d08062539ea48a2e54a9fe4f',
  fragment: '216d2872f6862da641f42cbafb21d7b2996fe72dcd4bbdfdd094d98acbcb2d1a',
  compute: 'e8c1329e9f5d3dbcfce3c017c56a8dff39b6b68abc8dc20e021bc4564b03b858',
  state: '370c0ab9bc38e877611b4dc867e5eabab6d0fd6cf24f90a6010f8e3a51b80051',
  data: 'f5bd127446b306fc0d512f5382c53087f34ce4b7fb4fc8477743520bce98ffdd',
  memory: '9573805be9a6be2fe3b4f095fe2180a771321d3549fdcf48eba1cb1607a8efa2',
  icon: '19493baa4f4ddb1eedd69716f18ed68a97a3e1cd7b646777bba162d508d2eb90'
};
const MEMORY_BYTES = 11829248;

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('the Moonlight package loads on backend one with the legacy bytes', async () => {
  const {loadApp} = await import(path.join(platform, 'sdk/package/loader.js'));
  const {backend} = await import(path.join(launcher, 'sdk/host/package-backend.js'));
  const app = await loadApp(PACKAGE, [backend], {validate: false});
  assert.equal(app.id, 'moonlight');
  assert.equal(app.name, 'Moonlight');
  assert.deepEqual(Object.keys(app.files).sort(), Object.keys(LEGACY).sort());
  for (const [name, hash] of Object.entries(LEGACY))
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
