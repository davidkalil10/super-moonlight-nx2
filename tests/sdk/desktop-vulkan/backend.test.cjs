// desktop.vulkan backend selection and section checks, all before any Vulkan work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {backend, ID, SECTION_DIR} = require('./backend.js');
const {preparePackage} = require('./hello-world.cjs');
const {readPackage} = require('../../../hbl-platform/sdk/package/manifest.js');
const {loadApp, select} = require('../../../hbl-platform/sdk/package/loader.js');
const {builds} = require('../../../hbl-platform/scripts/toolchain.js');

fs.mkdirSync(builds('desktop-vulkan'), {recursive: true});
const scratch = fs.mkdtempSync(path.join(builds('desktop-vulkan'), 'backend-'));
test.after(() => fs.rmSync(scratch, {recursive: true, force: true}));

let count = 0;

/**
 * A fresh hello-world package with the desktop.vulkan section, changed by `change`.
 * @param {(manifest: any, root: string) => void} [change]
 */
async function hello(change = () => {}) {
  const root = await preparePackage(path.join(scratch, String(count++)), {compile: false});
  const file = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(manifest, root);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return root;
}

/** @param {(manifest: any, root: string) => void} change */
const reason = async change => backend.supports(await readPackage(await hello(change)));

/** A backend whose load must never run. */
const guarded = {
  ...backend,
  load: async () => assert.fail('runner started')
};

test('selects-desktop-vulkan-for-hello-world', async () => {
  const pkg = await readPackage(await hello());
  assert.deepEqual(Object.keys(pkg.manifest.services), ['present', 'input', 'time']);
  const selected = select(pkg, [backend]);
  assert.equal(selected.backend.id, ID);
  assert.deepEqual(selected.absentOptional, []);
  assert.equal(backend.supports(pkg), null);
  assert.equal(backend.services.audio, undefined);
});

test('refuses-required-audio', async () => {
  const root = await hello(manifest => (manifest.services.audio = '1'));
  const pkg = await readPackage(root);
  assert.throws(() => select(pkg, [guarded]), /lacks audio 1 \(not provided\)/);
  await assert.rejects(loadApp(root, [guarded], {}), /desktop\.vulkan lacks audio/);
});

test('refuses-unsupported-backend-abi', async () => {
  assert.equal(
    await reason(manifest => (manifest.backends[ID].abi = 2)),
    'Unsupported desktop.vulkan abi 2'
  );
  assert.equal(
    await reason(manifest => delete manifest.backends[ID].abi),
    'Unsupported desktop.vulkan abi undefined'
  );
});

test('refuses-missing-required-shader-stage', async () => {
  for (const stage of ['compute', 'fragment', 'vertex'])
    assert.equal(
      await reason(manifest => delete manifest.backends[ID].shaders[stage]),
      'Missing desktop.vulkan ' + stage + ' shader'
    );
  assert.equal(
    await reason(manifest => delete manifest.backends[ID].shaders),
    'Package has no desktop.vulkan shaders'
  );
});

test('refuses-missing-or-escaping-backend-file', async () => {
  assert.equal(
    await reason(manifest => (manifest.backends[ID].data = SECTION_DIR + 'absent.bin')),
    'Missing backend file: ' + SECTION_DIR + 'absent.bin'
  );
  assert.equal(
    await reason(
      manifest => (manifest.backends[ID].initialState = SECTION_DIR + '../../state.bin')
    ),
    'Path must stay inside ' + SECTION_DIR + ': ' + SECTION_DIR + '../../state.bin'
  );
  assert.equal(
    await reason(manifest => (manifest.backends[ID].shaders.compute = 'src/app.comp')),
    'Path must stay inside ' + SECTION_DIR + ': src/app.comp'
  );
  const outside = path.join(scratch, 'outside.spv');
  fs.copyFileSync(path.join(await hello(), SECTION_DIR, 'app.comp.spv'), outside);
  const root = await hello((manifest, root) => {
    fs.symlinkSync(outside, path.join(root, SECTION_DIR, 'escape.spv'));
    manifest.backends[ID].shaders.compute = SECTION_DIR + 'escape.spv';
  });
  assert.equal(
    backend.supports(await readPackage(root)),
    'Path escapes its package: ' + SECTION_DIR + 'escape.spv'
  );
  await assert.rejects(loadApp(root, [guarded], {}), /Path escapes its package/);
});

test('refuses-section-file-linked-elsewhere-in-the-package', async () => {
  const root = await hello((manifest, root) => {
    fs.symlinkSync(
      '../hblauncher.gpu-app/app.comp.spv',
      path.join(root, SECTION_DIR, 'linked.spv')
    );
    manifest.backends[ID].shaders.compute = SECTION_DIR + 'linked.spv';
  });
  assert.equal(
    backend.supports(await readPackage(root)),
    'Path leaves ' + SECTION_DIR + ': ' + SECTION_DIR + 'linked.spv'
  );
});

test('checks-state-and-data-size', async () => {
  assert.equal(
    await reason((manifest, root) =>
      fs.writeFileSync(path.join(root, SECTION_DIR, 'state.bin'), Buffer.alloc(1000))
    ),
    'Invalid file size: ' + SECTION_DIR + 'state.bin'
  );
  assert.equal(
    await reason(manifest => delete manifest.backends[ID].data),
    'Path must stay inside ' + SECTION_DIR + ': undefined'
  );
  assert.equal(
    await reason((manifest, root) =>
      fs.writeFileSync(path.join(root, SECTION_DIR, 'text.bin'), Buffer.alloc(7 * 1024 * 1024 + 4))
    ),
    'Invalid file size: ' + SECTION_DIR + 'text.bin'
  );
  assert.equal(
    await reason((manifest, root) =>
      fs.writeFileSync(path.join(root, SECTION_DIR, 'text.bin'), '')
    ),
    'Invalid file size: ' + SECTION_DIR + 'text.bin'
  );
  assert.equal(
    await reason((manifest, root) =>
      fs.writeFileSync(path.join(root, SECTION_DIR, 'text.bin'), Buffer.alloc(6))
    ),
    'Data is not whole words: ' + SECTION_DIR + 'text.bin'
  );
  assert.equal(
    await reason(manifest => (manifest.backends[ID].memory = SECTION_DIR + 'memory.bin')),
    'Unknown desktop.vulkan field: memory'
  );
});
