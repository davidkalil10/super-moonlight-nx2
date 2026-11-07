import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {STAGES, glslLayout} from './layout.js';
import {packRenderer, sourceHashes, BLOB, PREBUILT} from './bundle.js';

/** @param {string} directory @param {{install?: boolean}} [options] `install` copies the bundle to prebuilt/ */
export async function buildRenderer(directory, {install = false} = {}) {
  directory = path.resolve(directory);
  const relative = path.relative('/media/storage2/builds/moonlight', directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw Error('Choose a new build directory under /media/storage2/builds/moonlight');
  await fs.mkdir(directory, {mode: 0o700});
  const source = path.join(import.meta.dirname, 'shaders');
  await fs.writeFile(path.join(directory, 'layout.glsl'), glslLayout());
  const shaders = /** @type {Record<string, Buffer>} */ ({});
  const commands = [];
  for (const [name, filename] of Object.entries(STAGES)) {
    const target = path.join(directory, filename + '.spv');
    const compile = ['-O', '--target-env=vulkan1.0', '-I', directory, '-I', source, path.join(source, filename), '-o', target];
    execFileSync('glslc', compile, {stdio: 'pipe'});
    execFileSync('spirv-val', ['--target-env', 'vulkan1.0', target], {stdio: 'pipe'});
    commands.push(['glslc', ...compile], ['spirv-val', '--target-env', 'vulkan1.0', target]);
    shaders[name] = await fs.readFile(target);
  }
  const hashes = await sourceHashes();
  const {blob, manifest} = packRenderer(shaders, hashes);
  await fs.writeFile(path.join(directory, BLOB), blob);
  await fs.writeFile(path.join(directory, 'renderer.json'), JSON.stringify(manifest, null, 2) + '\n');
  const metadata = {sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim()),
    builder: os.hostname(), targetArchitecture: 'SPIR-V for Civ7 Vulkan; host generator',
    compiler: execFileSync('glslc', ['--version'], {encoding: 'utf8'}).trim(), commands, shaderSourceHashes: hashes,
    shaderBytes: Object.fromEntries(Object.entries(shaders).map(([name, bytes]) => [name, bytes.length])),
    blobBytes: blob.length, built: new Date().toISOString(), installed: install ? PREBUILT : null};
  await fs.writeFile(path.join(directory, 'BUILD-INFO.json'), JSON.stringify(metadata, null, 2) + '\n');
  if (install) {
    await fs.mkdir(PREBUILT, {recursive: true});
    for (const name of ['renderer.json', BLOB]) await fs.copyFile(path.join(directory, name), path.join(PREBUILT, name));
  }
  return {directory, ...metadata};
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const {values} = parseArgs({options: {directory: {type: 'string'}, install: {type: 'boolean'}}});
  if (!values.directory) throw Error('Expected --directory NEW_BUILD_DIRECTORY [--install]');
  console.log(JSON.stringify(await buildRenderer(values.directory, {install: values.install})));
}
