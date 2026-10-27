# hbl-moonlight

The Moonlight streaming app and its host side, split out of HBLauncher (Phase 1 of the
rewrite, `hbl-notes/team/REWRITE.md`). Runtime code only: tests, probes and research live in
`moonlight-dev`. README.md has the build, run, flags and the console/host contract.

## Layout

The host is moving from `tools/moonlight/` into `host/`; until it is done both hold code:

- `apps/moonlight/`: the console app as an HB package (`manifest.json`, `assets/`,
  `backends/hblauncher.gpu-app/`, `build.js`, its own README).
- `tools/moonlight/`: the PC host (`live.js`, `native-h264.js`, staggered workers,
  ring/HBV formats) and `helper/` (`hbmoonlight`, C, GPLv3 upstreams).
- `host/ui/`: the console UI service, its rasteriser and the Sora font.
- `sdk/native/*-functions.json`: the native symbols only Moonlight uses.

## Sibling checkouts

Code outside this repo is required by relative path from sibling checkouts:

```
<dir>/hbl-moonlight
<dir>/hbl-platform     bridge, sdk/host, sdk/native, sdk/build.js, runs/
```

Package `exports` replace the relative paths later in Phase 2.

## Build and test

- Helper: `tools/moonlight/helper/build.sh [BUILD]`; the binary is `BUILD/build/hbmoonlight`.
  The bench, encoder check and input test build only when `moonlight-dev` sits beside this
  checkout (`DEV_DIR` in `helper/CMakeLists.txt`).
- Package: `node apps/moonlight/build.js`. It regenerates `hbv.glsl`, `hbv2-tables.glsl`,
  `ring.glsl`, `state.bin` and `memory.bin`; `assets.py` regenerates the text atlas and
  `text.glsl`. Never edit those by hand. It compiles through `tools/moonlight/glslang-shim.sh`
  with glslc 2026.1 (Fedora 44) only and refuses another version: the committed SPIR-V is
  that build byte for byte, and glslangValidator builds different bytes. It also refuses any
  argument; the check that writes nothing is `node ../hbl-platform/sdk/build.js --check
  apps/moonlight`.
- Tests: none here. Run `npm test` and `npm run typecheck` in `moonlight-dev`, plus
  `node apps/moonlight/check.cjs` there for shader changes.

## Decisions

- PC decode, shader display. Sunshine's stream is terminated on the PC by moonlight-common-c;
  the console only runs fixed native call chains and GPU shaders, so no decoder logic runs on
  console CPU. The stream is raw H.264 fed to the console's `movie::Decoder` (nnCompat), which
  writes NV12 straight into the ring's surfaces. The PC-side HBV1/HBV2 encoders are gone; the
  shaders keep their HBV decode because the package bytes are pinned, and `memory.bin` still
  holds an HBV2 test card made by `hbv2.js`.
- The bridge is the bottleneck, not the GPU: cost is per exchange, not per byte, so formats
  fill whole 32 KiB exchanges and the senders are latest-wins (never queue frames, drop on a
  stall).
- One source of truth per layout: `ring.js` generates `ring.glsl`; `hbv.js`/`hbv2.js` generate
  their GLSL tables; `host/ui/page.js` mirrors the shader's page validator. Change the JS and
  regenerate, never the outputs.
- HBV2 uses an integer IDCT shared by JS and GLSL; a float transform drifts across P frames.
- The console UI commands go through plain words in the control page, not the SDK mailbox: a
  pending mailbox request stops the native worker at the next 60-frame boundary and would hitch
  every press.
- The UI block has no status word (frozen 2026-10-26, U2), so quit results show as the app grid
  subtitle.
- 120 fps content is impossible inside the SmileBASIC 4 process. The 120 Hz display mode can be
  selected (native vsync 120/s), but SmileBASIC is a Switch 1 title under nnCompat, whose
  present descriptor packs interval 1 as 1/60 s; title VI stays at 60/s and filmed content
  changes on the 60 Hz grid (hbl-notes `team/research/120hz-result.md`). Nothing inside that
  process can present faster, an NRO included.

## Pacing results (2026-10-26, session DjIU1L, 60 Hz panel, m5 quiet)

| Run | Presented fps | Requests/frame | Bridge ms/frame |
| --- | ---: | ---: | ---: |
| Control, 1080p60 | 59.4 | 2.1 | 4.2 |
| `--present-hz 120 --receive-wait` | 28.9 | 9.3 | 23.6 |
| Applied pacing: vsync rule, skip-backlog 1, decode and receive wait | 30.3 | 3.5 | 24.4 |

Requests per frame fell by about two thirds, but bridge ms/frame stayed flat; decoded units never cross the bridge.
Status and gate exchanges became 2.7x slower (2.5 to 7 ms) as they grew sparser; the flat gap probe points to contention while streaming, not idle wake-up, leaving roughly 40 fps at 120 present.
`summary.staggered.exchanges` bins every status read and gate write by its start against the last gate, the last send and the predicted decode-done and receive-done (1 ms bins, host clock); `--avoid-window before-after` then keeps status reads out of that span around a predicted event. The window is chosen from a live run's bins, not guessed.
The pacer stayed at 8.33 ms and did not learn the panel's 16.67 ms apply grid in 40 s; that remains open.

## Gotchas

- `live.js` only streams H.264 to the console decoder; `--codec` accepts only `h264`.
- `live.js` refuses an app with private storage below `ring.MEMORY_BYTES`: the console runs an
  older package. Reopening the app reloads `memory.bin`, which wipes the ring.
- The h264 route needs a launcher session from the current revision: it records the host
  address the console connects back to over native TCP.
- A console worker that may still run is never reused or freed; a timed-out join leaks it and
  latches the decoder failed. Staggered workers that fail to stop, or a lost bridge, retain the
  native objects until SmileBASIC restarts.
- `apps/moonlight/README.md` is not part of the package fingerprint (manifest bytes, listed
  assets and entry sources only), but `moonlight-dev/apps/moonlight/package.test.cjs` pins the
  shader, state, data, memory and icon hashes.

## Rules

- The frozen reference is the 1080p60 worker at HBLauncher 4bdeb1a and its records
  (`native-h264/2026-10-25T17-20-16-026Z-4bdeb1a4`): they stay untouched and every change is
  measured against them. Main may change exchange count and pacing for 120 fps. Prove each
  change with the `moonlight-dev` tests, then a live pair before it lands: the 60 fps control
  in the reference shape (fps=59, dropped=0, idr=0), then the 120 run.
- Format, then rename/extract, never both in one commit.
- No live console runs unless the user is at the console (DEVICE-RULES.md).
