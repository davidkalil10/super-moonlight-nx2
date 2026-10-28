# hbl-moonlight tests

Tests, simulators and offline tools for `hbl-moonlight`. Nothing here ships to users. The
runtime, its flags and the console/host contract are documented in `../README.md`.

## Checkouts

Everything runs against the runtime code by relative path:

```
<dir>/hbl-moonlight      the code under test, these tests in tests/
<dir>/hbl-platform       bridge, sdk/host, sdk/native, sdk/package; tests/ mocks (recording-rpc,
                         audio-out-mock, gate-worker-mock)
<dir>/HBLauncher         sdk/host/package-backend.js, the hb-package hello-world template
```

## Test

```sh
npm install                        # once: TypeScript and @types/node
npm test                           # node --test over every tracked *.test.cjs, 416 tests
npm run typecheck                  # tsc --checkJs over the modules listed in tsconfig.json
node apps/moonlight/check.cjs [CLIP]
```

`check.cjs` renders the real Moonlight shaders on desktop Vulkan through
`tools/moonlight/gpu-check.c` (compute and draw per frame, like the launcher): exit handling,
the waiting screen, the HBV2 test card, an HBV1 slot, and an HBV2 P chain with a torn slot, a
stray reference and a catch-up dispatch, all bit-exact against the JS decoder. With CLIP it
also streams the clip through the native encoder. It builds under
`$HB_MOONLIGHT_CHECK_BUILDS` (default `~/claude-builds/HBLauncher/gpu-check`) and needs a GPU,
`cc`, the Vulkan headers, `glslangValidator` and `spirv-val`. A test clip:

```sh
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=60 -t 3 -pix_fmt yuv420p -c:v libx264 -crf 12 testsrc2.mp4
```

GPU and PIL tests skip with the reason when their tools are missing. `sdk/desktop-vulkan/` is
HB package backend two (offscreen Vulkan); its README is read by `desktop-vulkan.test.cjs`.

## Tools

- `tools/moonlight/request-budget.cjs`: offline request budget for the staggered native H.264
  host loop, a virtual-clock model of its gate cycle. Run it before any device run.
- `tools/moonlight/encode.cjs CLIP OUT.hbv [--size 640x352] [--frames N]`: the HBV1 slot stream
  the host would write; `hbl-moonlight/tools/moonlight/feed.js` replays it into a live ring.
- `tools/moonlight/desktop-scenes.py SCENE FRAMES OUT`: synthetic 1920x1080 desktop sequences
  (typing, scroll, drag, pan) as raw RGB24.
- `tools/moonlight/controller-watch.cjs [RUN_DIR] [--hz 60] [--labels] [--sources]`: prints
  the console controller as Moonlight gamepad state.
- `tools/moonlight/helper/tests/input.c`: the helper input-routing test, built by the
  hbl-moonlight helper CMake project.

## Fake console

`tools/moonlight/fake-console` stands in for a running Moonlight app, so `feed.js` can be
developed without a console. `shared/rpc.cjs` simulates the bridge: one serial link of 32 KiB
exchanges whose concurrent writes interleave at random, and a 60 Hz dispatch that runs the JS
HBV2 decoder over the ring and writes back `applied`.

```sh
# HBV1 slots of a clip, fed on the measured 5.7 MB/s link
node tools/moonlight/encode.cjs clip.mp4 clip.hbv --size 1920x1088
node ../tools/moonlight/feed.js tools/moonlight/fake-console clip.hbv
# a 1.5 s stall at t=4 s
STALL=1500@4000 node ../tools/moonlight/feed.js tools/moonlight/fake-console clip.hbv
```

Env: `RATE` (link bytes/s, default 5.7e6), `STALL=ms@at` (pause the dispatch once), `DECODE=1`
(full pixel decode instead of the light apply).

`bridge.cjs DIR [--pad]` serves the same fake console through the real
`hbl-platform/smilebasic/engine/lib/bridge.js` and writes a run directory, so `live.js` or
`input-feeder.js` pay the same HTTP, JSON and base64 costs as on a
console. It also simulates the sound-memory allocation and an AudioOut that plays appended
buffers in real time (underruns counted); `--pad` cycles a scripted controller and touch state
every 500 ms. `HB_PIPELINE` works as on the launcher.

```sh
HB_PIPELINE=2 RATE=12e6 node tools/moonlight/fake-console/bridge.cjs /tmp/fake --pad &
node ../host/input/input-feeder.js /tmp/fake
```

`shared/console.cjs` is a separate byte-level model of the `bootstrap.bas` `RPC()` loop for
protocols 1, 2 and 3 (header and data recv, response framing, memmove/read/QueryMemory) over a
flat memory buffer; `formats.test.cjs` round-trips the real `native.js` through it.

## Live test pass

Only with the user at the console (DEVICE-RULES.md). From `hbl-moonlight`, against a fresh
`./start.sh --app moonlight` session showing the HBV2 test card, in order:

1. Video: `node host/stream/live.js --moonlight 192.168.8.245 Desktop --codec h264 --staggered --no-input --no-audio`
   (the h264 flags are in `../README.md`).
2. Input: drop `--no-input`. Sticks and taps move the host cursor; touch is native multi-touch.
3. Audio: drop `--no-audio`. If `OpenDefaultAudioOut` fails, the audio process prints a hint
   and exits while video and input keep running.
4. A real game from `hbmoonlight list 192.168.8.245` in place of `Desktop`.

## Protocol 3 write test

To tell whether the console loop is bound by per-exchange overhead or by the byte copy, start
two sessions with `HB_WRITE_CHUNK=32768 ./start.sh` and `HB_WRITE_CHUNK=258048 ./start.sh`
(the latter is the protocol 3 default). In each, the gap in
`runs/<session>/launcher-auto-operations.jsonl` between `vkMapMemory2` and the next
`vkCreateBuffer` is the launcher's startup write (8 MiB of zeros, the state, the text atlas and
the catalog raster: 14,681,088 bytes in the 2026-10-24 sessions); divide to get MB/s. Capture a
protocol 2 session too if small exchanges dominate the workload.
