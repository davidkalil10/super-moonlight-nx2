// On-device Moonlight menu, rendered entirely on the PC host.
//
// The menu is NOT a new console shader: it is a PC-rendered screen shown
// through the SAME frame ring the video stream uses. menu-render.py paints a
// 1920x1080 RGB24 screen, the HBV2 encoder turns it into a keyframe slot, and
// that slot is written into the running app's ring exactly like live.js writes
// video. Controller + touch are read back through the same state buffer
// (controller.js / touch.js) to move a selection. So the whole display and
// input path is reused with zero console-side change.
//
// Flow: splash -> host list -> (pair with a PIN) -> game list -> launch a game
// (spawns live.js and pauses the menu) -> hold L+R ~1 s to return -> menu.
// An "Exit to HBLauncher" entry writes STATE.exitRequest so the launcher tears
// the app down (verified against homebrew-launcher/app-runtime.cjs: afterBatch
// reads byte 1016 and returns to the menu; the app shader only ever sets that
// byte via hbExit() on a held +/-, so a host write survives).
//
// Usage: node tools/moonlight/menu.js [runs/launcher-XXXX]
//        [--host IP]... [--budget 96] [--qp 8] [--rate 2] (Hz heartbeat)
//        [--js] (pure-JS encode, no native binary)
//        [--no-input] [--script up,down,a,...] (offline driver)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import * as ring from './ring.js';
import * as hbv2 from './hbv2.js';
import {findPrivateStorage, nextSequence} from './feed.js';
import {STATE} from '../../../hbl-platform/sdk/host/state-layout.js';
import {NPAD, NPAD_BYTES, decode} from './controller.js';
import {TOUCH_BYTES, parseTouch, createTracker, step} from './touch.js';
import {HELPER} from './helper.js';
import * as session from '../../../hbl-platform/sdk/host/session.js';
import * as cli from '../../../hbl-platform/sdk/cli.js';
import {Encoder} from './hbv2-encoder.js';

const WIDTH = 1920;
const HEIGHT = 1080;
const DEFAULT_HOST = {name: 'Sunshine', address: '192.168.8.245'};
const RETURN_MASK = NPAD.l | NPAD.r;
// Screen geometry shared with menu-render.py (sent in every spec) and reused by
// touchTarget so a tap maps to the same row the renderer drew.
const LAYOUT = {width: WIDTH, height: HEIGHT, listTop: 320, rowHeight: 92};

// --- host list ----------------------------------------------------------

function hostsFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'hblauncher', 'moonlight', 'hosts.json');
}

function loadHosts(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(h => h && typeof h.address === 'string')
      .map(h => ({
        name: typeof h.name === 'string' && h.name ? h.name : h.address,
        address: h.address
      }));
  } catch {
    return [];
  }
}

function saveHosts(file, hosts) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const partial = file + '.part';
  fs.writeFileSync(partial, JSON.stringify(hosts, null, 2) + '\n');
  fs.renameSync(partial, file);
}

// Keep the configured hosts, append any extra addresses, and make sure the
// default Sunshine host is always present. Pairing state is not stored per host
// (libgamestream keeps only client-side keys), so it is queried live on open.
function seedHosts(existing, extra = []) {
  const out = [];
  const seen = new Set();
  const add = host => {
    if (!host || seen.has(host.address)) return;
    seen.add(host.address);
    out.push({name: host.name || host.address, address: host.address});
  };
  for (const host of existing) add(host);
  for (const address of extra) add({name: address, address});
  add(DEFAULT_HOST);
  return out;
}

function parseList(stdout) {
  const line = stdout.split('\n').find(l => l.includes('"apps"'));
  if (!line) throw Error('no app list in hbmoonlight output');
  const parsed = JSON.parse(line);
  return {
    currentGame: parsed.currentGame || 0,
    apps: (parsed.apps || []).map(a => ({
      id: a.id,
      name: a.name,
      ...(typeof a.cover === 'string' ? {cover: a.cover} : {})
    }))
  };
}

// --- state machine (pure) ----------------------------------------------

function makeModel(hosts) {
  return {
    screen: 'splash',
    hosts,
    cursor: 0,
    host: null,
    games: [],
    game: null,
    currentGame: 0,
    pin: null,
    message: null,
    exit: false
  };
}

// The selectable rows of the current screen, in order. Non-interactive screens
// (splash, pair, streaming) have none.
function rows(model) {
  if (model.screen === 'hosts')
    return [
      ...model.hosts.map(host => ({kind: 'host', host, label: `${host.name}  (${host.address})`})),
      {kind: 'exit', label: 'Exit to HBLauncher'}
    ];
  if (model.screen === 'games')
    return [
      ...model.games.map(game => ({kind: 'game', game, label: game.name})),
      {kind: 'back', label: 'Back to hosts'}
    ];
  return [];
}

function clampCursor(model) {
  const n = rows(model).length;
  if (n === 0) return 0;
  return Math.max(0, Math.min(model.cursor, n - 1));
}

function navigate(model, delta) {
  const n = rows(model).length;
  if (n === 0) return model;
  return {...model, cursor: (((model.cursor + delta) % n) + n) % n};
}

// A press (A on the controller, or a tap). Returns the next model and an intent
// for main() to carry out (open a host, launch a game, exit) or null.
function activate(model) {
  if (model.screen === 'splash') return {model: toHosts(model), intent: null};
  const row = rows(model)[clampCursor(model)];
  if (!row) return {model, intent: null};
  if (row.kind === 'exit') return {model: {...model, exit: true}, intent: {type: 'exit'}};
  if (row.kind === 'back') return {model: toHosts(model), intent: {type: 'cancel'}};
  if (row.kind === 'host')
    return {
      model: {...model, host: row.host, message: `Connecting to ${row.host.address}…`},
      intent: {type: 'openHost', host: row.host}
    };
  if (row.kind === 'game')
    return {
      model: {...model, screen: 'streaming', game: row.game, message: `Streaming ${row.game.name}`},
      intent: {type: 'launch', host: model.host, game: row.game}
    };
  return {model, intent: null};
}

// B on the controller.
function back(model) {
  if (model.screen === 'games' || model.screen === 'pair')
    return {model: toHosts(model), intent: {type: 'cancel'}};
  return {model, intent: null};
}

function toHosts(model, message = null) {
  return {
    ...model,
    screen: 'hosts',
    cursor: 0,
    host: null,
    games: [],
    game: null,
    pin: null,
    message
  };
}

function toPair(model, pin = null) {
  return {...model, screen: 'pair', pin, message: null};
}

function pinReceived(model, pin) {
  return {...model, screen: 'pair', pin};
}

function toGames(model, list) {
  return {
    ...model,
    screen: 'games',
    cursor: 0,
    games: list.apps,
    currentGame: list.currentGame,
    message: null
  };
}

// Result of `hbmoonlight list`: paired -> game list; not paired -> pair screen.
function hostListed(model, result) {
  return result.paired ? toGames(model, result) : toPair(model);
}

function streamEnded(model) {
  return {...model, screen: 'games', game: null, message: null};
}

function errored(model, message) {
  return toHosts(model, message);
}

// --- RETURN chord: hold L+R for `ticks` polls, fires once per hold ----

function createChord(ticks, mask = RETURN_MASK) {
  let held = 0;
  let fired = false;
  return {
    tick(buttons) {
      if ((buttons & mask) === mask) {
        held++;
        if (held >= ticks && !fired) {
          fired = true;
          return true;
        }
      } else {
        held = 0;
        fired = false;
      }
      return false;
    },
    reset() {
      held = 0;
      fired = false;
    }
  };
}

// Rising edge of `mask` between two polled button words.
function pressed(previous, current, mask) {
  return (current & mask) !== 0 && (previous & mask) === 0;
}

// One pad poll, edge-detected against the previous one, plus touch. Pure: it
// moves the cursor, activates on A, backs on B, or taps a row, and returns the
// next model (a new reference only when something changed) with any intent for
// main() to act on. Native Switch layout: physical A selects, physical B backs.
function onInput(model, previousButtons, buttons, touchEvents = []) {
  let next = model;
  let intent = null;
  if (pressed(previousButtons, buttons, NPAD.up)) next = navigate(next, -1);
  else if (pressed(previousButtons, buttons, NPAD.down)) next = navigate(next, 1);
  if (pressed(previousButtons, buttons, NPAD.a)) ({model: next, intent} = activate(next));
  else if (pressed(previousButtons, buttons, NPAD.b)) ({model: next, intent} = back(next));
  if (!intent) {
    const target = touchTarget(touchEvents, rows(next).length);
    if (target >= 0) ({model: next, intent} = activate({...next, cursor: target}));
  }
  return {model: next, intent};
}

// A touch-down event -> the row it lands on, using the same geometry the
// renderer drew. Returns the row index or -1.
function touchTarget(events, rowCount, layout = LAYOUT) {
  for (const event of events) {
    if (event.action !== 'down') continue;
    const row = Math.floor((event.y * layout.height - layout.listTop) / layout.rowHeight);
    if (row >= 0 && row < rowCount) return row;
  }
  return -1;
}

// --- screen spec for the renderer (pure) -------------------------------

function screenSpec(model) {
  const footer =
    model.screen === 'streaming'
      ? 'Hold L + R  return to menu'
      : 'Up / Down  move      A  select      B  back      Hold + and -  exit';
  const base = {width: WIDTH, height: HEIGHT, layout: LAYOUT, title: 'Moonlight', footer};
  if (model.screen === 'splash') return {...base, screen: 'splash', message: 'Starting…'};
  if (model.screen === 'pair')
    return {
      ...base,
      screen: 'pair',
      pin: model.pin?.pin || '----',
      lines: [
        'Enter this PIN to pair:',
        model.pin ? `at ${model.pin.url}` : `at https://${model.host?.address}:47990/pin`
      ]
    };
  if (model.screen === 'streaming')
    return {...base, screen: 'streaming', message: model.message || 'Streaming'};
  const entries = rows(model);
  return {
    ...base,
    screen: model.screen,
    cursor: clampCursor(model),
    rows: entries.map(r => r.label),
    note:
      model.screen === 'hosts'
        ? model.message || 'Adding a host by IP is not in this version; edit hosts.json.'
        : model.message || ''
  };
}

// --- re-stamp a cached keyframe slot with a fresh sequence --------------

function restampSlot(slot, sequence) {
  const copy = Buffer.from(slot);
  copy.writeUInt32LE(sequence >>> 0, 4);
  const payloadBytes = copy.readUInt32LE(12);
  const trailer = hbv2.exchangesFor(payloadBytes) * hbv2.EXCHANGE_BYTES - 4;
  copy.writeUInt32LE(sequence >>> 0, trailer);
  return copy;
}

// --- renderer + encoder seams (spawn real tools in main) ---------------

function spawnRenderer() {
  const child = spawn('python3', [path.join(import.meta.dirname, 'menu-render.py')], {
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let pending = Buffer.alloc(0);
  let waiting = null;
  child.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    if (waiting && pending.length >= WIDTH * HEIGHT * 3) {
      const frame = pending.subarray(0, WIDTH * HEIGHT * 3);
      pending = pending.subarray(WIDTH * HEIGHT * 3);
      const resolve = waiting;
      waiting = null;
      resolve(frame);
    }
  });
  return {
    render(spec) {
      if (waiting) return Promise.reject(Error('renderer is busy'));
      child.stdin.write(JSON.stringify(spec) + '\n');
      return new Promise(resolve => (waiting = resolve));
    },
    close() {
      child.stdin.end();
    }
  };
}

function jsEncoder(qp) {
  return {
    encode(rgb, sequence) {
      const frame = hbv2.toFrame(rgb, WIDTH, HEIGHT);
      return Promise.resolve(hbv2.encode(frame, {sequence, qp}));
    },
    close() {}
  };
}

// A menu keyframe is ~96 KiB at qp 8, so budget=cap=96 KiB with a pinned qp sits
// right at the edge and the encoder would defer macroblocks that never arrive
// (the menu only re-stamps, never re-sends them). Give it a roomy cap and a qp
// range so bisection fits the whole intra frame at `qp` or finer.
function nativeEncoder(qp) {
  const encoder = new Encoder({});
  const cap = 256 * 1024;
  return {
    async encode(rgb, sequence) {
      const result = await encoder.encode(rgb, WIDTH, HEIGHT, {
        sequence,
        keyframe: true,
        budget: cap,
        cap,
        qpMin: qp,
        qpMax: hbv2.MAX_QP,
        refresh: 0
      });
      return result.slot;
    },
    close() {
      return encoder.close();
    }
  };
}

// --- the menu sender: owns the ring while the menu is visible ----------

class MenuSender {
  constructor({rpc, mapped, encoder, rateHz}) {
    this.rpc = rpc;
    this.mapped = mapped;
    this.encoder = encoder;
    this.interval = 1000 / rateHz;
    this.slot = null;
    this.sequence = 0;
    this.applied = 0;
  }

  async resync() {
    this.sequence = (await nextSequence(this.rpc, this.mapped)) - 1;
    this.applied = (await this.rpc.read(this.mapped + ring.CONTROL.applied, 4)).readUInt32LE();
  }

  // Encode a new screen and send it right away.
  async show(rgb) {
    this.sequence++;
    this.slot = await this.encoder.encode(rgb, this.sequence);
    await this.write();
  }

  // Re-send the current screen under a new sequence, so a reopened app (whose
  // ring was wiped by memory.bin) picks the menu up again without re-encoding.
  async heartbeat() {
    if (!this.slot) return;
    const now = (await this.rpc.read(this.mapped + ring.CONTROL.applied, 4)).readUInt32LE();
    // applied going backwards means the app reopened and reset its control block.
    if (now < this.applied) this.sequence = (await nextSequence(this.rpc, this.mapped)) - 1;
    this.applied = now;
    this.sequence++;
    await this.write();
  }

  async write() {
    const slot = restampSlot(this.slot, this.sequence);
    await this.rpc.write(this.mapped + ring.slotOffset(this.sequence), slot);
  }
}

// --- helpers ------------------------------------------------------------

function runHelper(args) {
  return new Promise(resolve => {
    const child = spawn(HELPER, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', code => resolve({code, out, err}));
    child.on('error', error => resolve({code: -1, out, err: error.message}));
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- main ---------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const extraHosts = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--host') extraHosts.push(args[i + 1]);
  const budget = cli.number(args, '--budget', 96);
  const qp = cli.number(args, '--qp', 8);
  const rateHz = cli.number(args, '--rate', 2);
  const noInput = args.includes('--no-input');
  const script = args.includes('--script')
    ? cli.option(args, '--script', '').split(',').filter(Boolean)
    : null;

  const directory = session.resolve(args[0]);
  const rpc = session.rpc(directory);
  const storage = await findPrivateStorage(directory);
  if (storage.bytes < ring.MEMORY_BYTES)
    throw Error('The running Moonlight app predates HBV2; rebuild and reinstall it');

  const file = hostsFile();
  const hosts = seedHosts(loadHosts(file), extraHosts);
  saveHosts(file, hosts);

  const renderer = spawnRenderer();
  const encoder = args.includes('--js') ? jsEncoder(qp) : nativeEncoder(qp);
  const sender = new MenuSender({rpc, mapped: storage.mapped, encoder, rateHz});
  await sender.resync();

  let model = makeModel(hosts);
  let dirty = true;
  let live = null;
  let stopping = false;
  process.on('SIGINT', () => (stopping = true));

  const redraw = async () => {
    if (!dirty) return;
    dirty = false;
    const rgb = await renderer.render(screenSpec(model));
    await sender.show(rgb);
  };

  // Carry out the side effect an activation asked for, then fold the result
  // back into the model.
  async function run(intent) {
    if (!intent) return;
    if (intent.type === 'exit') {
      const source = session.readSource(directory);
      if (source?.mapped !== undefined) {
        const one = Buffer.alloc(4);
        one.writeUInt32LE(1, 0);
        await rpc.write(source.mapped + STATE.exitRequest, one);
      }
      stopping = true;
      return;
    }
    if (intent.type === 'openHost') {
      dirty = true;
      await redraw(); // draw "Connecting…" before the helper call blocks the loop
      const result = await runHelper(['list', intent.host.address]);
      if (result.code === 0) {
        model = hostListed(model, {paired: true, ...parseList(result.out)});
      } else if (/not paired/.test(result.err)) {
        model = hostListed(model, {paired: false});
        dirty = true;
        await redraw();
        await pairFlow(intent.host);
      } else {
        model = errored(model, 'Cannot reach ' + intent.host.address);
      }
      dirty = true;
    } else if (intent.type === 'launch') {
      await stream(intent.host, intent.game);
      model = streamEnded(model);
      dirty = true;
    }
  }

  async function pairFlow(host) {
    const child = spawn(HELPER, ['pair', host.address], {stdio: ['ignore', 'pipe', 'inherit']});
    let cancelled = false;
    const closed = new Promise(resolve => child.on('close', resolve));
    readline.createInterface({input: child.stdout}).on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'pin') {
          model = pinReceived(model, {pin: event.pin, url: event.url});
          dirty = true;
          redraw().catch(() => {});
        }
      } catch {}
    });
    // Let B on the console cancel a long pairing wait.
    while (!noInput) {
      const done = await Promise.race([closed.then(() => true), sleep(150).then(() => false)]);
      if (done) break;
      const source = session.readSource(directory);
      if (source?.mapped === undefined) continue;
      try {
        const pad = decode((await rpc.read(source.mapped, NPAD_BYTES)).subarray(0, NPAD_BYTES));
        if (pad.buttons & NPAD.b) {
          cancelled = true;
          child.kill('SIGINT');
          break;
        }
      } catch {}
    }
    await closed;
    if (cancelled) {
      model = toHosts(model);
      return;
    }
    const result = await runHelper(['list', host.address]);
    model =
      result.code === 0
        ? toGames(model, parseList(result.out))
        : errored(model, 'Pairing did not complete');
  }

  async function stream(host, game) {
    await redraw(); // show the "Streaming…" screen once before handing over the ring
    live = spawn(
      process.execPath,
      [
        path.join(import.meta.dirname, 'live.js'),
        directory,
        '--moonlight',
        host.address,
        game.name,
        '--codec',
        'hbv2',
        '--budget',
        String(budget),
        ...(noInput ? ['--no-input', '--no-audio'] : [])
      ],
      {stdio: 'inherit'}
    );
    const chord = createChord(10);
    const exited = new Promise(resolve => live.on('close', resolve));
    while (live && !stopping) {
      const done = await Promise.race([exited.then(() => true), sleep(100).then(() => false)]);
      if (done) break;
      const source = session.readSource(directory);
      if (!noInput && source?.mapped !== undefined) {
        try {
          const pad = decode((await rpc.read(source.mapped, NPAD_BYTES)).subarray(0, NPAD_BYTES));
          if (chord.tick(pad.buttons)) {
            live.kill('SIGINT');
            break;
          }
        } catch {}
      }
    }
    await exited; // wait for the child to drain its ring writes before we resync
    live = null;
    await sender.resync();
  }

  // Offline driver: replay a list of synthetic presses against the fake console.
  if (script) {
    await redraw();
    for (const key of script) {
      const event = key.trim();
      if (event === 'up') model = navigate(model, -1);
      else if (event === 'down') model = navigate(model, 1);
      else if (event === 'b') ({model} = back(model));
      else if (event === 'a') {
        const result = activate(model);
        model = result.model;
        dirty = true;
        await redraw();
        await run(result.intent);
      }
      dirty = true;
      await redraw();
      await sleep(100);
    }
    await sender.heartbeat();
    console.log(
      JSON.stringify({applied: sender.applied, sequence: sender.sequence, screen: model.screen})
    );
    renderer.close();
    await encoder.close();
    process.exit();
  }

  // Show the splash once, then land on the host list without needing a press.
  await redraw();
  model = toHosts(model);
  dirty = true;

  // Live loop: poll the pad at 30 Hz, re-render only when the model changes,
  // and otherwise heartbeat the ring at `rateHz` so a reopened app recovers.
  const tracker = createTracker();
  let previousButtons = 0;
  let lastBeat = 0;
  let seenActive = false;
  while (!stopping && !model.exit) {
    const started = performance.now();
    const source = session.readSource(directory);
    const active = noInput || source?.package?.id === 'moonlight';
    if (!active) {
      // The app is gone (e.g. the user held +/- to exit); stop writing its ring.
      if (seenActive) break;
      await sleep(150);
      continue;
    }
    seenActive = true;
    if (!noInput && source?.mapped !== undefined) {
      try {
        const bytes = await rpc.read(source.mapped, STATE.touch + TOUCH_BYTES);
        const pad = decode(bytes.subarray(0, NPAD_BYTES));
        const {events} = step(tracker, parseTouch(bytes.subarray(STATE.touch)));
        const result = onInput(model, previousButtons, pad.buttons, events);
        previousButtons = pad.buttons;
        if (result.model !== model) dirty = true;
        model = result.model;
        if (result.intent) {
          dirty = true;
          await run(result.intent);
        }
      } catch {}
    }
    if (dirty) await redraw();
    else if (started - lastBeat > 1000 / rateHz) {
      lastBeat = started;
      await sender.heartbeat();
    }
    await sleep(Math.max(0, 1000 / 30 - (performance.now() - started)));
  }
  renderer.close();
  await encoder.close();
  process.exit();
}

export {
  DEFAULT_HOST,
  LAYOUT,
  loadHosts,
  saveHosts,
  seedHosts,
  hostsFile,
  parseList,
  makeModel,
  rows,
  navigate,
  activate,
  back,
  toHosts,
  toPair,
  pinReceived,
  toGames,
  hostListed,
  streamEnded,
  errored,
  createChord,
  pressed,
  touchTarget,
  onInput,
  screenSpec,
  restampSlot
};

if (cli.isMain(import.meta))
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
