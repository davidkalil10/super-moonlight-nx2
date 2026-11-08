import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import {builtinModules} from 'node:module';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import ts from 'typescript';
import {buildPayload} from '../civ7/payload.js';
import {HELPER} from '../session/protocol-binary.js';

const projectRoot = path.resolve(import.meta.dirname, '../../..');
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));

/**
 * Copies `entries` and every module they import into `destination`, refusing a bare dependency.
 * @param {string} root
 * @param {string[]} entries
 * @param {string} destination
 */
export async function copyModules(root, entries, destination) {
  /** @type {Set<string>} */
  const copied = new Set();
  /** @param {string} file */
  async function visit(file) {
    file = path.resolve(file);
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
      throw Error('Module leaves package source tree');
    if (copied.has(relative)) return;
    copied.add(relative);
    const bytes = await fs.readFile(file);
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, bytes);
    if (path.extname(file) === '.json') return;
    const source = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    /** @type {string[]} */
    const imports = [];
    /** @param {ts.Node} node */
    function walk(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
      ts.forEachChild(node, walk);
    }
    walk(source);
    for (const specifier of imports) {
      if (specifier.startsWith('.')) await visit(path.resolve(path.dirname(file), specifier));
      else if (!builtins.has(specifier.replace(/^node:/, ''))) throw Error('Unbundled dependency: ' + specifier);
    }
  }
  for (const entry of entries) await visit(entry);
  return [...copied].sort();
}

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function filesIn(directory) {
  /** @type {string[]} */
  const files = [];
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(file));
    else files.push(file);
  }
  return files;
}

/**
 * The helper entry: the first SIGINT or SIGTERM stops serve() in order, a second one exits at
 * once, for a session whose cleanup hangs.
 * @param {string} serveModule import specifier of serve.js
 */
export function serveEntry(serveModule) {
  return `import os from 'node:os';
import {serve} from '${serveModule}';
const abort = new AbortController();
const shutdown = name => {
  if (abort.signal.aborted) process.exit(128 + os.constants.signals[name]);
  abort.abort();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
serve(import.meta.dirname, abort.signal, event => console.log(JSON.stringify(event)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
`;
}

/** What the command line uses for an option it is not given; `helper` is the pinned helper. */
export const BUILD_DEFAULTS = {port: '39380', transport: 'udp', helper: HELPER};

/**
 * Writes the payload bundle: runtime sources, helper, inspector, payload and host.json.
 * @param {{directory: string, host: string, helper: string, inspector: string, image?: string,
 *   port?: number, transport?: string}} options
 *   `transport` tcp sends video over TCP instead of UDP (civ7/README.md, "UDP transport")
 */
export async function build({directory, host, helper, inspector, image, port = 39380,
  transport = BUILD_DEFAULTS.transport}) {
  if (!['tcp', 'udp'].includes(transport)) throw Error('Expected --transport tcp or udp');
  if (!net.isIPv4(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('Expected a LAN IPv4 host and TCP port');
  await fs.access(helper, constants.X_OK);
  await fs.access(inspector, constants.X_OK);
  directory = path.resolve(directory);
  await fs.mkdir(directory, {mode: 0o700});
  const runtime = path.join(directory, 'runtime');
  await copyModules(projectRoot, [path.join(import.meta.dirname, 'serve.js'), path.join(import.meta.dirname, 'launch.js')], runtime);
  const extra = ['src/renderer/civ7/prebuilt', 'src/streamer/ui/fonts/glyphs.bin', 'src/streamer/ui/fonts/OFL.txt',
    'src/streamer/payload/host-display/kscreen.py', 'src/inspector/libnx2/LICENSE', 'LICENSE'];
  for (const relative of extra) {
    const target = path.join(runtime, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.cp(path.join(projectRoot, relative), target, {recursive: true, dereference: true});
  }
  await fs.mkdir(path.join(directory, 'bin'));
  await fs.copyFile(helper, path.join(directory, 'bin/hbmoonlight'));
  await fs.copyFile(inspector, path.join(directory, 'bin/nx2-modules'));
  await fs.chmod(path.join(directory, 'bin/hbmoonlight'), 0o700);
  await fs.chmod(path.join(directory, 'bin/nx2-modules'), 0o700);
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  const token = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(path.join(directory, 'moonlight.js'), buildPayload({host, port, token, nativeStackBytes: 0x100000}), {mode: 0o600});
  const config = {host, port, token, transport, hosts: [{name: 'Sunshine', address: host}]};
  await fs.writeFile(path.join(directory, 'host.json'), JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
  const entry = 'runtime/src/streamer/payload/';
  await fs.writeFile(path.join(directory, 'serve.mjs'), serveEntry(`./${entry}serve.js`));
  await fs.writeFile(path.join(directory, 'launch.mjs'), `import {launch} from './${entry}launch.js';
launch(import.meta.dirname, process.argv[2]).then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
`);
  let wrapper = '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n';
  if (image) {
    if (!/^[a-zA-Z0-9_./:@-]+$/.test(image)) throw Error('Invalid helper image name');
    wrapper += `config="\${XDG_CONFIG_HOME:-$HOME/.config}/moonlight-nx2"
mkdir -p "$config/covers"
if [ "$1" = stream ]; then
  set -- --preserve-fds=2 ${image} hbmoonlight "$@"
else
  set -- ${image} hbmoonlight "$@"
fi
exec podman run -i --rm --network host --userns=keep-id --security-opt label=disable \\
  -e XDG_CONFIG_HOME=/config -v "$config:/config/moonlight-nx2" \\
  -v "$config/covers:$config/covers" \\
  -v "$root/bin/hbmoonlight:/usr/local/bin/hbmoonlight:ro" "$@"
`;
  } else wrapper += 'exec "$root/bin/hbmoonlight" "$@"\n';
  await fs.writeFile(path.join(directory, 'hbmoonlight'), wrapper, {mode: 0o700});
  await fs.writeFile(path.join(directory, 'README.md'), `# Moonlight payload

Run \`node launch.mjs CONSOLE_IP\` once. It starts the background helper and sends
\`moonlight.js\` to the console runtime on TCP 9026. Choose a PC and app through
the existing Moonlight UI. Controller, touch and stereo audio are included.

The host needs Node.js 22.12+. The helper uses
${image ? 'the installed Podman image `' + image + '`' : 'the host runtime libraries'}.
Pairing keys stay in the host's Moonlight config directory; they are not packaged.

\`helper.log\`, \`payload.log\` and \`runs/\` contain session logs. The helper
stays in the background and accepts another payload after Moonlight exits.
\`ready.json\` records its PID and local status port. Use SIGINT to stop it.

A 120 fps request raises the panel to 120 Hz and falls back to 60 when the console cannot keep
up. End-to-end latency remains to be measured.

## Touch

Handheld only. Enable Native Pen/Touch Support under Input in Sunshine
(https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html#native_pen_touch);
on Linux Sunshine needs uinput access, and the game must accept touch input.
`);
  const smoke = `await import(process.argv[1]);
const {loadRenderer} = await import(process.argv[2]);
await loadRenderer();
const {createRaster} = await import(process.argv[3]);
const raster = createRaster();
try { const strip = await raster.text('Moonlight', 24, 400); if (!strip.bytes.length) throw Error('Empty UI strip'); }
finally { raster.close(); }
`;
  execFileSync(process.execPath, ['--input-type=module', '-e', smoke,
    path.join(runtime, 'src/streamer/payload/serve.js'),
    path.join(runtime, 'src/renderer/civ7/bundle.js'),
    path.join(runtime, 'src/streamer/ui/raster.js')], {cwd: directory, timeout: 15000});
  const files = [];
  for (const file of (await filesIn(directory)).sort()) {
    const bytes = await fs.readFile(file);
    files.push({path: path.relative(directory, file), bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  const manifest = {id: crypto.randomUUID(), project: 'moonlight', created: new Date().toISOString(),
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: projectRoot, encoding: 'utf8'}).trim(),
    builder: os.hostname(), targetArchitecture: 'aarch64 console; host-native helper', command: process.argv,
    helperImage: image || null, files};
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return {directory, files: files.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const {values} = parseArgs({options: {directory: {type: 'string'}, host: {type: 'string'},
    helper: {type: 'string', default: BUILD_DEFAULTS.helper}, inspector: {type: 'string'}, image: {type: 'string'},
    port: {type: 'string', default: BUILD_DEFAULTS.port},
    transport: {type: 'string', default: BUILD_DEFAULTS.transport}}});
  /** @param {string | undefined} value @param {string} name */
  const required = (value, name) => {
    if (!value) throw Error('Missing --' + name);
    return value;
  };
  const options = {...values, directory: required(values.directory, 'directory'),
    host: required(values.host, 'host'), helper: required(values.helper, 'helper'),
    inspector: required(values.inspector, 'inspector'), port: Number(values.port)};
  console.log(JSON.stringify(await build(options)));
}
