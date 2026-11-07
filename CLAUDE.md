# moonlight-nx2

Session state lives in a local, untracked handoff file when one exists; it is never committed.

Moonlight for the Switch 2 on the CivSwitch loader (Civ7): one payload streams Sunshine games
to the console. Code under `src/`; tests, fixtures and component READMEs in the sibling
`moonlight-nx2-dev` repo, at the same `src/...` paths. README.md has
the layout, build, run and the console/host contract; this file has the decisions, constraints
and measurements. The SmileBASIC/HBLauncher route this grew out of is gone; its measurements
(pacing, bridge budget, protocol 3, HBV formats) are in this file at 891fd6e.

## Layout

```
src/renderer/   console shaders: civ7/ is the renderer, prebuilt/ the SPIR-V the bundle ships
src/streamer/   civ7/ (console backend, shipped by toString()) and payload/ (bundle, launch,
                serve), protocol/ (hbmoonlight, C), session/ (access units, movie decoder,
                bitrate, helper pin), input/, ui/, shared/ring.js, console-api/ (native ABI
                tables), loopback/ (flip window for the latency film), test-support/
```

The component docs hold their rules, and code comments cite them: `src/streamer/civ7/README.md`,
`src/streamer/payload/README.md`, `src/streamer/input/`, `src/streamer/ui/`,
`src/streamer/protocol/` (helper build) and `src/renderer/civ7/README.md` (renderer).

## Standalone

The runtime imports nothing outside this repo. `payload/build.js` copies the import closure of
`serve.js` and `launch.js` into `runtime/src/...` and refuses an import that leaves the repo.
Nothing at dev time reads HBLauncher either; its display golden tests were dropped with the
split (2026-11-08).

## Build

- `src/renderer/civ7/build.js` compiles and validates the shaders; `--install` copies
  `renderer.json` and `shaders.bin` to `prebuilt/`, which the bundle ships. The renderer test
  fails when `prebuilt/` is older than the sources.

## Decisions

- Console first (2026-11-07, user decision): everything except the Sunshine session runs on the
  console payload: UI state machine, settings, text, input mapping, the stop chord and audio
  pacing. The PC keeps only moonlight-common-c (pairing, RTSP, ENet control, encrypted input)
  and relays video, audio and input records. The end state is one standalone run-once payload
  that brings itself up on the console.
- Console decode, shader display. The helper writes raw access units and decodes nothing; the
  console's `movie::Decoder` (H.264) or the lower decoder service (AV1) writes NV12 into the
  frame areas, and the renderer's shaders display them.
- Latest wins: never queue frames, drop on a stall, resume on a keyframe. Wi-Fi varies by an
  order of magnitude between sessions.
- Graphics addresses are never reused across console app restarts; the graphics ledger in
  `payload/console-startup.js` only reuses what the same process still holds.
- Only device-verified options ship. Ack batching, AV1 direct TLS and MAILBOX were removed
  untested (2026-11-07); the deferred GPU wait above 60 fps stays.

## Gotchas

- The graphics ledger keys reuse on the compat table hash and the blob hash, so a new
  `prebuilt/` rebuilds the app stage on the next attach and keeps the display.
- Host config is `$XDG_CONFIG_HOME/moonlight-nx2`. `serve` copies an old `hblauncher/moonlight`
  once; the pinned helper still reads the old name, so the podman wrapper mounts both.

## Tests

- Tests live in `moonlight-nx2-dev` (split 2026-11-08). Its `link-app.cjs` links the app's
  `src/` entries beside each `test/`, so a test still imports the code beside it, from the
  checkout `$MOONLIGHT_APP` names (default `../moonlight-nx2`, then `../hbl-moonlight`).
- `npm test` here runs the dev repo's suite against this checkout (README.md, Tests).
  `npm run typecheck` and `npm run typecheck:strict` cover the files `tsconfig*.json` list.
  TypeScript is a dev dependency only; there is no build step.
- One test file per subsystem, each under about 1500 lines. Shared helpers live in the dev
  repo's `src/streamer/test-support/`.
- No test binds the helper port 39380 or touches the real config directory; servers listen on
  port 0 and config tests set `XDG_CONFIG_HOME`.
- A test change that alters what the runtime sends needs its reason in the commit.

## Native H.264

- The decoder is nnCompat's `movie::Decoder` (implementation `movie::VideoDecoder`, no `nn::`
  prefix), created as type 1 with CPU-copy output format 4 (NV12). The first IDR's bare SPS/PPS
  build the configuration. The adapter checks the module's symbol names, offsets, sizes and
  instruction signatures against `src/streamer/console-api/movie-functions.json` before any call. The
  captured catalog is in the team notes.
- No HEVC through the public movie API (nnCompat capture 2026-10-24, same offsets in Civ7's
  `compatibility-module.json`): `movie::Decoder` video types are 1..3 (ctor check
  `type - 1 < 3`), mapped to H.264, VP8 and VP9 (table `{0, 4, 1, 0x41, 0x42}` for types 1..5,
  AAC and Vorbis after), and `Configure` refuses a `mime` whose codec differs. The mime mapper
  (nnCompat +0x2b62130) knows `video/avc`, `x-vnd.on2.vp8`, `x-vnd.on2.vp9`, `mp4a-latm` and
  `vorbis` only; `video/hevc` and `csd-hevc` exist only in the bundled stagefright key table.
  There is no `CreateH265DecoderConfigurationData`. This bounds the public API, not the decoder
  service. The internal backend has AV1 IDs 3/7 and a MIME-bearing service open; HEVC/AV1
  service probes are in `civ7/codec-probe.js`. AV1
  decoded a 720p Main8 frame with all 1,382,400 NV12 bytes matching the reference (2026-11-07).
  Candidate registration 2 was rejected, but its codec identity is unproven; extractor HEVC=2
  is a different enum. Registration 0 with `video/hevc` yielded no verified image.
  Internal constructor ID 2 aborts; aliases 5/6/7 abort during input submission. Do not
  enumerate IDs blindly. Civ7 streams AV1 by default
  (settings v4), H.264 as the fallback (`src/streamer/civ7/README.md`, "Fallbacks").
- The access-unit reader drains the raw pipe before matching stderr metadata (an AU is
  announced only after its payload is written), validates lengths, sequences and EOF, and after
  dropping units resumes only on an independent keyframe, never on a dependent P frame.
- Decoder calls are strictly serial and fail closed: `movie::Decoder` thread safety is
  unverified. `session/native-decoder.js` verifies the module, configures from the first IDR's
  SPS/PPS and destroys in reverse order; a failed destroy keeps the memory.
- `src/streamer/session/protocol-binary.js` pins the default helper (also `payload/build.js`'s
  `--helper` default) to `moonlight/20261107T200357Z-19b4f09-helper`: raw-only relay, no
  FFmpeg, `--codec h264|av1 --raw-fd`, `unpair`, `--sops`, `--local-audio`, codec negotiation check, connection-status and rtt
  events, validated options, list `uniqueid` and bounded list time; built from 19b4f09, rig, podman `hbmoonlight-build`, ctest 4/4; `build/hbmoonlight`
  SHA-256 `d3dc5ad10efa11f73ea5f2c4c8677cddacc3c89f99b8aa9e4d27c932855c0241` (BUILD-INFO there).
- Touch maps the 1280x720 panel straight onto the full video rect. Revisit if the app ever
  letterboxes inside 16:9 (the panel is already 16:9). Distinct `fingerId`s for simultaneous
  fingers on the real panel are not confirmed.
- Controller and touch are read on the console each acknowledgement and sent as input
  records (src/streamer/input/CLAUDE.md).

## Direct NVDEC research

The user requested direct NVDEC research for HEVC on 2026-11-07; the probes are
`civ7/nvdec-probe.js` and `civ7/nvdrv-service-probe.js`.
Reuse Civ7's initialized nnCompat nvdrv proxy; do not initialize graphics twice. The
older module-05 SDK has different offsets from the actual Civ7 capture.
Fresh-process checks open/close native `/dev/nvhost-ctrl` successfully;
NVDEC Open returns Result 0/NvError `0x30003`, no descriptor. SM acquisition
of `host1x`, `nvdrv:s` and `nvdrv:t` returns `0x1015` (NotAllowed). All cleanup
was clean; no decode commands ran. These are client-access limits, not evidence
of missing HEVC hardware. Further clean queries found only graphics/copy IDs 0/1/2
in ctrl-gpu engine information, and no Vulkan Video support in a complete 219-extension
list or the three queue families. The Vulkan probe borrowed the ready ledger physical
device without creating/destroying graphics objects. Latest cleanup: 12:23:55 UTC.
Evidence: `20261107T120912Z-891fd6e-gpu-engine-probe/` and
`20261107T122353Z-891fd6e-vulkan-video-probe/` under the Moonlight builds root.
A firmware-matched GSV/Host1x server/native consumer or codec-manager
registration-217/open-117 dispatch is needed for the remaining policy/enum question.
Those journal numbers are TIPC wire words: decoder logical 201/101. The creator
comes from GSV logical 906 (wire 922); the newer `nn::codec::video` implementation
lead maps to this same route. Logical 901 returns only Result, not capabilities.
Existing bridges and reviewed libnx2 tooling cannot dump another process's server
code. Exact dispatch/capture requirements and candidate module IDs are in the report.
The subsequent on-device checkup at `20261107T131805Z-891fd6e-civ7-checkup/`
verified exact 720p pixels for H.264/VP8/VP9/AV1; HEVC still returned EOS only.
It measured core mask 0x3f, priorities 28..59, 4 KiB pages and free-thread headroom 284.
`civ7/tools/capability-check.js` repeats the process/runtime/media snapshot.
Info31/32 raw values have unresolved semantics; do not trust a current/peak label.

Current Envideo and its FFmpeg HEVC backend provide host1x transport and
picture/scratch references. Their Switch backend still assumes T210;
T239 permission and firmware compatibility need device evidence. A direct
AV1 picture builder was absent from the inspected backends. The existing
movie-service AV1 path has verified pixels; direct decode performance is
unmeasured.

The archive's license note was wrong: old nvtegra HEVC/core and Envideo are
GPL-2.0-or-later; newer FFmpeg Envideo HEVC glue is LGPL-2.1-or-later. NVIDIA
hardware headers are MIT. Preserve the actual per-file notices when reusing code.

## Rules

- Prove each change with the test suite, then a live 60 fps control before a 120 run, with the
  user at the console.
- Format, then rename/extract, never both in one commit.
- Code reads in blocks: blank lines between setup, validation, action and return, one concern
  per block. Split a long boolean chain into named checks (`reuseOk`, `reapOk`) with early
  returns, at most about three terms per group; no nested ternaries, no clever one-liners.
  `ledgerStatus` in `src/streamer/payload/console-startup.js` is the model.
- Functions shipped by `toString()` stay self-contained; `civ7/test/payload-scope.test.cjs`
  checks them.
- Comments: the JSDoc types tsc needs, file headers of at most three lines, short why-notes.
  Design prose goes in the component's docs, and comments cite them instead of restating it.
- No live console runs unless the user is at the console (`DEVICE-RULES.md` in hbl-notes).


## Round 6 video

AV1 above 1080p submits the next unit before untile, present and ack of the ready frame;
its GPU wait is deferred per slot. Existing two frame slots and decoder surfaces suffice.
LOP2 logs `overlapped` and mean `overlappedMs` alongside the existing per-unit stage timings.
The replay reaches 60/s at 2160p and 120/s at 1440p; console throughput still needs a run.

Startup selects a native layer from the console's saved size when docked on AV1, before
opening graphics. The layer stays fixed for the process. A different size above 1080p streams
at 1080p with a badge and restart notice. UI coordinates stay 1920x1080 and scale to the layer.
Probe C verified the native layer calls; the combined streaming path still needs console checks.
