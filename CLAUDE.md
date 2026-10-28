# hbl-moonlight

The Moonlight streaming app and its host side, split out of HBLauncher (Phase 1 of the
rewrite in the team notes). Code under `src/`; each component's unit tests in its `test/`.
README.md has the layout, build, run, flags, tests and the console/host contract; this file
has the decisions, constraints and measurements. The docs the old tests CLAUDE.md replaced are
kept verbatim in the team notes (moonlight docs archive).

## Layout

```
src/renderer/   console side: moonlight/ is the HB package, built from the HBV codecs beside it
src/streamer/   PC side: protocol/ (hbmoonlight, C), stream/{session,scheduler,worker,native}/,
                input/, audio/, ui/, shared/ (ring.js, feed.js), console-api/ (native ABI
                tables), test-support/
```

The component CLAUDE.md files hold their rules, and code comments cite them:
`src/streamer/stream/` (staggered contract, numbered invariants, flags), `src/streamer/input/`
(pull vs push input), `src/streamer/protocol/` (helper build) and `src/renderer/` (package).

## Sibling checkouts

Code outside this repo is required by relative path from sibling checkouts (README.md names
them). Package `exports` replace the relative paths later in Phase 2.

## Build

- `build.js` compiles with glslc 2026.1 (Fedora 44) only and refuses another version: the
  committed SPIR-V under `src/renderer/moonlight/backends/hblauncher.gpu-app/` is the build of glslc
  `shaderc v2026.1`, `spirv-tools v2026.1`, `glslang 301b4ede` (Fedora 44 `glslc-2026.1-1`),
  which reproduces all three files byte for byte; the package test pins them. glslangValidator
  16.2.0 builds different bytes. Moving to a new glslc means changing `GLSLC_VERSION` in
  `build.js` and the pinned hashes in `src/renderer/test/` together.
- It refuses any argument because it rewrites the package in place; the check that writes
  nothing is `node ../hbl-platform/sdk/build.js --check src/renderer/moonlight`.

## Decisions

- PC decode, shader display. Sunshine's stream is terminated on the PC by moonlight-common-c;
  the console only runs fixed native call chains and GPU shaders, so no decoder logic runs on
  console CPU. The stream is raw H.264 fed to the console's `movie::Decoder` (nnCompat), which
  writes NV12 straight into the ring's surfaces. The PC-side HBV1/HBV2 encoders are gone; the
  shaders keep their HBV decode because the package bytes are pinned, and `memory.bin` still
  holds an HBV2 test card made by `hbv2.js`.
- The bridge is the bottleneck, not the GPU: cost is per exchange, not per byte, so formats
  fill whole 32 KiB exchanges and the senders are latest-wins (never queue frames, drop on a
  stall), since Wi-Fi varies by an order of magnitude between sessions. The numbers are in
  [Bridge budget](#bridge-budget-measured).
- One source of truth per layout: `ring.js` generates `ring.glsl`; `hbv.js`/`hbv2.js` generate
  their GLSL tables; `src/streamer/ui/page.js` mirrors the shader's page validator. Change the JS and
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
  changes on the 60 Hz grid (team note `120hz-result.md`). Nothing inside that process can
  present faster, an NRO included.

## Pacing results (2026-10-26, session DjIU1L, 60 Hz panel, m5 quiet)

| Run                                                                 | Presented fps | Requests/frame | Bridge ms/frame |
| ------------------------------------------------------------------- | ------------: | -------------: | --------------: |
| Control, 1080p60                                                    |          59.4 |            2.1 |             4.2 |
| `--present-hz 120 --receive-wait`                                   |          28.9 |            9.3 |            23.6 |
| Applied pacing: vsync rule, skip-backlog 1, decode and receive wait |          30.3 |            3.5 |            24.4 |

Requests per frame fell by about two thirds, but bridge ms/frame stayed flat; decoded units
never cross the bridge. Status and gate exchanges became 2.7x slower (2.5 to 7 ms) as they grew
sparser; the flat gap probe points to contention while streaming, not idle wake-up, leaving
roughly 40 fps at 120 present. `summary.staggered.exchanges` bins every status read and gate
write by its start against the last gate, the last send and the predicted decode-done and
receive-done (1 ms bins, host clock); `--avoid-window before-after` then keeps status reads out
of that span around a predicted event. The window is chosen from a live run's bins, not
guessed. The pacer stayed at 8.33 ms and did not learn the panel's 16.67 ms apply grid in 40 s;
that remains open.

## Gotchas

- `live.js` only streams H.264 to the console decoder; `--codec` accepts only `h264`.
- `live.js` refuses an app with private storage below `ring.MEMORY_BYTES`: the console runs an
  older package. Reopening the app reloads `memory.bin`, which wipes the ring.
- The h264 route needs a launcher session from the current revision: it records the host
  address the console connects back to over native TCP.
- A console worker that may still run is never reused or freed; a timed-out join leaks it and
  latches the decoder failed. Staggered workers that fail to stop, or a lost bridge, retain the
  native objects until SmileBASIC restarts.
- The package fingerprint covers the manifest bytes, listed assets and entry sources only, so
  docs and backend sources do not move it, but `src/renderer/test/package.test.cjs` pins the
  shader, state, data, memory and icon hashes.

## Tests and simulators

- Each test imports the code beside its `test/` directory, so a worktree always tests its own
  code; only the other repos must sit beside the checkout.
- `tsconfig.json` lists the hbl-moonlight modules that went through the readability
  rewrite; add each component as it lands. TypeScript is a dev dependency only, hbl-moonlight
  itself has no build step.
- One test file per subsystem, each under about 1500 lines; split one only at a section (an old
  file) boundary. Helpers shared inside this tree live in
  `src/streamer/test-support/test-helpers.cjs`; the only cross-repo ones are the hbl-platform/tests
  mocks.
- The root `.gitignore` ignores `node_modules`, a symlink included.
- No test binds the launcher port 39380; native TCP tests listen on port 0.
- `src/streamer/stream/scheduler/test/request-budget.cjs` is the offline cost model; run it
  before any device run. Console probes live in sibling `hbl-dev/sdk/tools`: the user runs them, one at a time,
  per `DEVICE-RULES.md` in hbl-notes.
- A test change that alters what the runtime sends needs its reason in the commit.

## Bridge budget (measured)

- `NativeClient.write` (hbl-platform `smilebasic/engine/lib/native.js`) splits a write into
  exchanges; every exchange carries a full request and response, so a 4 KiB frame costs what a
  32 KiB frame costs.
- 2026-10-24, Wi-Fi: 13.0 ms per 32 KiB exchange (2.52 MB/s, kTCkLD) in a good
  session, 97 ms (0.34 MB/s, W71IDj) in a poor one the same day. About 77 exchanges/s at best,
  so 32 KiB per frame at 60 fps.
- Protocol 2, HBV1 640x352 at depth 1/2: 56.9/59.3 fps on Wi-Fi with 3 ms ping (idrgtq). Wired
  GL.iNet (TJ2SqH) at depth 1/2/4: 83/353/412 exchanges/s, p50 5.2/5.4/9.5 ms. The ceiling is
  about 412 exchanges/s (13.5 MB/s) and it is the console loop, not the link (p50 grows with
  depth). A 1080p HBV1 frame is nine exchanges, so about 45 fps at best.
- Private storage is host coherent (flags 7): writes show without a flush. Slight tearing is
  visible and not investigated.

## Protocol 3

Protocol 2 made the response length variable (u16 at request byte 80). Protocol 3 adds a u32
request data length at byte 88, so one exchange carries up to 0x3f000 (252 KiB) of data instead
of 0x8000. The console recvs the 0x80-byte header first, then the data into `scratch+0x40080`.
The hard ceiling is 0x3ff80 (the request region is the 0x40000 bytes from `scratch+0x40000`);
0x3f000 is a 4 KiB multiple, keeps chunk destinations page aligned and leaves 0xf80 of slack.
The bootstrap rejects a larger length, which is all that stops a bad host writing past scratch.
The host keeps one path and sends the fixed 0x8080 request to protocol 1/2 consoles;
`HB_WRITE_CHUNK` overrides the write chunk on protocol 3.

Open: whether the loop is per-exchange-overhead bound (252 KiB would give up to ~8x) or
byte-copy bound (little gain); README.md's Protocol 3 write test is the A/B. Protocol 3 also
adds one recv and a compare to every exchange, small ones included.

## Formats

- HBV1 (fallback): fixed 9-word macroblocks, 1.125 bpp, intra only, decoded per pixel in the
  fragment shader with the IDCT evaluated at each output position (free upscale). Chosen over
  YUV420 and BC1 at one exchange per frame: best on the pan clip (+0.3 dB over BC1, visibly
  more detail), 4x the pixels of BC1 in the same block, and no rate control. BC1 wins the
  synthetic clips by 0.7-1.7 dB and HBV1 is weak on saturated chroma edges (6 chroma
  coefficients per 16x16). `reference.js` keeps the BC1/YUV420 comparison. Dirty tiles were
  rejected for HBV1: games change 100% of blocks every frame.
- HBV2 (1080p): inter-coded, variable rate, decoded by the compute shader into persistent
  frames, so the rate degrades before the quality. Integer IDCT shared by three
  implementations (a float one drifts), a chunk list of 8 macroblocks (one coherent invocation
  each, static regions free), two persistent frames (the reference survives, scan-out never
  reads the frame being decoded), one write per slot in a ring of 8 (trailer and eligibility
  make reorder and tearing safe).
- HBV2 rate control: bisect qp for the largest frame under `budget`; over `cap` at the
  coarsest qp, defer the macroblocks with the lowest distortion per bit; `refresh` chunks per
  frame are forced intra so losses heal without a keyframe.
- Measured on a 5.7 MB/s latest-wins replay, 1080p, 120 frames: desktop typing/scroll/drag at
  HBV2 64-96K is 34-52 KiB, 59 fps, coded 51.7-58.2 dB, against HBV1 288K at 19 fps and
  24.5-25.1 dB. Clips (720p upscaled, flattering): HBV2 64-96K holds 56-59 fps; 160K drops
  mandelbrot to 34 fps at 5.7 MB/s but holds 59 at 12 MB/s, so keep the budget near 64-96K on
  the slow link. `displayed` PSNR is low for fast-moving text in both codecs: it measures
  latency, not reconstruction. Encode was 2.4-5.8 ms per 1080p frame idle; desktop RADV
  decodes in 1-5 ms. Artifacts in `~/claude-builds/HBLauncher/hbv2-eval/`.
- Helper decode on m5 (`hbmoonlight-bench`, removed in lane Z; 1080p60 testsrc2 at 20 Mb/s):
  H.264 VAAPI 7.6 ms (6.4 with 4 slices), software 3.3 (2.8), HEVC VAAPI 7.0. VAAPI is likely
  slowed by the NV12 readback (not profiled); synthetic content flatters software, so compare
  on a real game before changing the default. A 1 s reader stall dropped 470 of 600 frames
  without slowing decode; raw mode reproduced the input byte for byte.

## 120 fps

Three things must hold together: the panel presents 120 distinct frames, a GPU frame takes
under 8.3 ms, and the bridge feeds 120 slots per second. The first is out inside SmileBASIC 4
(see Decisions). The rest still matters for latency and 60 fps headroom:

- Pacing: the launcher loop runs acquire, submit, present, `vkQueueWaitIdle` per frame under
  FIFO, so a frame that misses a vblank waits a whole period and the rate halves. gw7PCW
  (HBV1 fragment decode) spent 38 s at exactly 30 Hz; bXVJxN (HBV2 with audio) mixed 1- and
  2-vblank frames (median 58.6 Hz). The display stage builds its own surface and swapchain
  (HBLauncher `vulkan-copy.js`, surface min 2 and max 3 images): FIFO at the minimum by
  default, `HBL_PRESENT_MODE=mailbox` for MAILBOX with three images. `HBL_LOOP_FENCE=1` in
  `launcher-loop.js` swaps the per-frame `vkQueueWaitIdle` for a submit fence.
- HBV2 workgroup: 512 invocations, not 1024. At 1024 RADV caps each invocation at 64 VGPRs and
  spills the three private `int[64]` arrays (983 spilled on Raphael); Ampere has the same
  65536/1024 limit, so the console's single SM likely spilled too. 512 is bit-exact on both
  GPUs, 2.3x faster on Raphael (7.3-7.7 ms P frame), flat on Navi31; 256 is worse (four chunks
  in series per invocation). Skipping zero IDCT rows or clearing only touched rows is bit-exact
  but slower everywhere (more live state, more spills): don't retry. The console's
  `maxComputeWorkGroupInvocations` was never read; 512 fits any NVIDIA limit.
- Bridge: 120 fps of HBV2 at a 96K budget was about 360 video + 60 input + 40-50 audio
  exchanges/s, above the 412/s wired ceiling.
- Proposals not applied: a wide HBV2 dispatch through the manifest's `computeSequence`
  (pick, N-workgroup decode, commit; today one workgroup on one SM, est. 2-4x); dropping the
  per-frame 8 MB swapchain-to-buffer copy (`vkCmdCopyImageToBuffer2`) in hbl-platform
  `gpu-app.js` and HBLauncher `launcher.js`, keeping it only for the first present. GPU timestamps
  are unused on console: `vkGetQueryPoolResults` takes 8 arguments and the bridge passes 4.

## Native H.264

- The decoder is nnCompat's `movie::Decoder` (implementation `movie::VideoDecoder`, no `nn::`
  prefix), created as type 1 with CPU-copy output format 4 (NV12). The first IDR's bare SPS/PPS
  build the configuration. The adapter checks the module's symbol names, offsets, sizes and
  instruction signatures against `src/streamer/console-api/movie-functions.json` before any call. The
  captured catalog is in the team notes.
- The access-unit reader drains the raw pipe before matching stderr metadata (an AU is
  announced only after its payload is written), validates lengths, sequences and EOF, and after
  dropping units resumes only on an independent keyframe, never on a dependent P frame.
- Decoder calls are strictly serial and fail closed: `movie::Decoder` thread safety is
  unverified, so gains come from fewer exchanges, not overlapping calls. The host-driven frame
  costs 10 exchanges (one finite worker carries SendInput, AcquireOutput and the next
  AcquireInput; the input index is pipelined one frame ahead and `-1` never reaches SendInput).
  Live streams use the staggered input and output workers fed over native TCP; the first frame
  stays host-driven to establish the output layout.
- `src/streamer/stream/session/protocol-binary.js` pins the default helper to
  `moonlight-helper-main-c33e545`; bump the pin with each helper build, `$HBMOONLIGHT`
  overrides it.
- `--output-lag 0` (60 Hz only) is refused on a stream that can reorder and ends the run on a
  decoder-wait timeout; `--surface-check K` re-reads sampled surfaces before reuse to catch a
  late write. Both stay opt-in until the next slot decides them (src/streamer/stream/CLAUDE.md).
- Validated on SmileBASIC 4.4.9 / Switch 2 23.0.1: a 128x96 test frame decoded and displayed,
  then a 1920x1080 Sunshine stream with sound. The first protocol-2 run presented 1-2 fps and
  dropped audio under the combined RPC load, which led to protocol 3 and the TCP data path.

## Input and audio

- Touch maps the 1280x720 panel straight onto the full video rect. Revisit if the app ever
  letterboxes inside 16:9 (the panel is already 16:9). Distinct `fingerId`s for simultaneous
  fingers on the real panel are not confirmed.
- Controller and touch share one 784-byte read per frame; `--sources` (extra pad sources far
  outside that window) is deliberately unsupported in the feeder.
- `--input-push` moves that read to a console worker that pushes records over native TCP
  (`--input-hz` defaults to 120 there); opt-in until its A/B runs (src/streamer/input/CLAUDE.md).
- `game-audio.js` opens AudioOut only for a package with effects, so the stream owns it while
  Moonlight runs. The `underruns` counter is a host-side proxy that misses gaps shorter than a
  poll; the honest live measure is `GetAudioOutBufferCount` reaching 0 or played-sample deltas.

## NVDEC research (not the chosen route)

Direct NVDEC was researched first and set aside for the console movie API. Kept for a future
native route:

- HBLauncher runs no arbitrary console CPU code, so any decode must be a fixed, branchless
  native chain with host-prepared arguments. On Switch 1 the application `nvdrv` mask includes
  NVDEC, VIC and nvmap, but nothing public confirms this on T239 / 23.0.1, and `nvdrv`
  Initialize needs a transfer-memory and handle path through the IPC bridge.
- Console-side UDP from Sunshine is a poor fit (SmileBASIC's fixed ~42 KB UDP recv buffer, no
  setsockopt qualified); the PC terminates Sunshine and sends TCP.
- Mesa NVK has experimental H.264-only Vulkan Video decode; it gives NVDEC method offsets,
  struct layouts (`nvdec_drv.h`) and field semantics, not a transport: Tegra NVDEC is a host1x
  client (class 0xF0), so a host1x encoder and THI offsets would come from averne's nvtegra or
  L4T. mesa-switch has no video; its nvmap, cache and syncpoint patterns carry over. The PC
  could build everything except device addresses (struct bytes, command words, a reloc table).
- Licenses: NVK and NVIDIA headers are MIT (keep notices); averne's nvtegra is LGPL, so use it
  as a reference only.

The sourced detail (switchbrew, Mesa paths, probe ladder) is in the archive's research and
Mesa/NVDEC notes.

## Rules

- The frozen reference is the 1080p60 worker at HBLauncher 4bdeb1a and its records
  (`native-h264/2026-10-25T17-20-16-026Z-4bdeb1a4`): they stay untouched and every change is
  measured against them. Main may change exchange count and pacing for 120 fps. Prove each
  change with the test suite, then a live pair before it lands: the 60 fps control
  in the reference shape (fps=59, dropped=0, idr=0), then the 120 run.
- Format, then rename/extract, never both in one commit.
- Code reads in blocks: blank lines between setup, validation, action and return, one concern
  per block. Split a long boolean chain into named checks (`fdOk`, `bufferOk`) with early
  returns, at most about three terms per group; no nested ternaries, no clever one-liners.
  `isBoundedSetup` in `src/streamer/audio/audio-socket-worker.js` is the model.
- Comments: the JSDoc types tsc needs, file headers of at most three lines, short why-notes.
  Design prose goes in the component's CLAUDE.md, and comments cite it instead of restating it.
- No live console runs unless the user is at the console (`DEVICE-RULES.md` in hbl-notes).
