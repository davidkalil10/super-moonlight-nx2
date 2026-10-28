/**
 * End-to-end desktop.vulkan run of HBLauncher's hello-world package. The template is copied into
 * <build>/package/hello-world (it is never edited), given the desktop.vulkan section, its entry
 * compiled into backends/desktop.vulkan/ and run through loadApp() with the checked-in frame
 * script: idle frames, then B pressed, held and released.
 *   node sdk/desktop-vulkan/hello-world.cjs BUILD_DIR [OUTPUT_DIR]
 * Prints the run summary as JSON and exits nonzero unless desktop.vulkan was selected, every
 * frame was read back and the B press requested exit.
 */
const fs = require('node:fs');
const path = require('node:path');
const {backend, build, ID, SECTION_DIR} = require('./backend.js');
const {initialState} = require('./state.js');
const {readPackage} = require('../../../../hbl-platform/sdk/package/manifest.js');
const {loadApp, select} = require('../../../../hbl-platform/sdk/package/loader.js');

const TEMPLATE = path.resolve(
  __dirname,
  '../../../../HBLauncher/sdk/template/hb-package/hello-world'
);
const BACKEND_ONE = 'backends/hblauncher.gpu-app';
const SCRIPT = path.join(__dirname, 'fixtures/hello-world-input-time.json');
const SECTION = {
  abi: 1,
  shaders: {
    vertex: SECTION_DIR + 'app.vert.spv',
    fragment: SECTION_DIR + 'app.frag.spv',
    compute: SECTION_DIR + 'app.comp.spv'
  },
  initialState: SECTION_DIR + 'state.bin',
  data: SECTION_DIR + 'text.bin'
};

/**
 * Copies the template and adds the desktop.vulkan section. The atlas is backend one's generated
 * text.bin, which matches the checked-in src/text.glsl; regenerating it needs the host font.
 * @param {string} buildDir
 * @param {{compile?: boolean}} [options] compile false copies backend one's SPIR-V, built from
 *   the same sources, so host-only tests need no shader compiler.
 * @returns {Promise<string>} The package folder.
 */
async function preparePackage(buildDir, {compile = true} = {}) {
  const root = path.join(buildDir, 'package/hello-world');
  fs.rmSync(root, {recursive: true, force: true});
  fs.cpSync(TEMPLATE, root, {recursive: true});
  const section = path.join(root, SECTION_DIR);
  fs.mkdirSync(section, {recursive: true});
  fs.writeFileSync(path.join(section, 'state.bin'), initialState());
  fs.copyFileSync(path.join(root, BACKEND_ONE, 'text.bin'), path.join(section, 'text.bin'));
  if (!compile)
    for (const stage of ['vert', 'frag', 'comp'])
      fs.copyFileSync(
        path.join(root, BACKEND_ONE, 'app.' + stage + '.spv'),
        path.join(section, 'app.' + stage + '.spv')
      );
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.backends[ID] = SECTION;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  if (compile) await build(await readPackage(root));
  return root;
}

/**
 * @param {object} options
 * @param {string} options.buildDir
 * @param {string} [options.outputDir] Defaults to <build>/output.
 * @param {string | object} [options.script] Defaults to the checked-in fixture.
 * @param {string} [options.runner]
 */
async function runHelloWorld({buildDir, outputDir, script = SCRIPT, runner}) {
  const root = await preparePackage(buildDir);
  const selected = select(await readPackage(root), [backend]).backend.id;
  const result = await loadApp(root, [backend], {
    buildDir,
    outputDir: outputDir ?? path.join(buildDir, 'output'),
    script,
    runner
  });
  return {selected, ...result};
}

/** @param {Awaited<ReturnType<typeof runHelloWorld>>} result */
function summary(result) {
  return {
    selected: result.selected,
    device: result.device.name,
    frameCount: result.frameCount,
    sha256: result.sha256,
    state: result.state,
    files: result.files
  };
}

async function main() {
  const [buildDir, outputDir] = process.argv.slice(2);
  if (!buildDir) throw Error('usage: node hello-world.cjs BUILD_DIR [OUTPUT_DIR]');
  const result = await runHelloWorld({
    buildDir: path.resolve(buildDir),
    outputDir: outputDir && path.resolve(outputDir)
  });
  console.log(JSON.stringify(summary(result), null, 2));
  if (result.selected !== ID || result.frames.length !== result.frameCount)
    throw Error('desktop.vulkan did not run every frame');
  if (result.state.exitRequest !== 1) throw Error('B press did not request exit');
}

module.exports = {TEMPLATE, SCRIPT, SECTION, preparePackage, runHelloWorld, summary};

if (require.main === module)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
