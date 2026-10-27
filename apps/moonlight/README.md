# Moonlight

Displays PC frames written by the host into the app's private storage. Two
formats share the ring: HBV1 (`tools/moonlight/hbv.js`, fixed-size intra
slots drawn straight from the ring) and HBV2 (`tools/moonlight/hbv2.js`,
inter-coded variable-rate slots that the compute shader decodes into a
persistent 1080p frame). Without a sender the app shows the built-in HBV2 test
card. Design, format and measurements: the [repo README](../../README.md).

`--codec h264` also accepts the helper's raw H.264 stream and decodes it through
the console's native movie API into NV12 surfaces. Audio, controller and touch
remain enabled. Setup, DUT results and performance limits are documented in
moonlight-dev [CLAUDE.md](../../../moonlight-dev/CLAUDE.md) (Native H.264).

The app is an HB package (`manifest.json`, see the package spec in hbl-platform's README):
`assets/` holds the icon and text atlas and `backends/hblauncher.gpu-app/` the shaders
with their includes, the SPIR-V and the state and memory images. The compute and fragment
shaders read the frame ring, so the package has no portable entry and no `src/` yet.

Build and check from the project root:

```sh
node apps/moonlight/build.js           # needs glslc 2026.1 (Fedora 44) and spirv-val
node ../hbl-platform/sdk/build.js --check apps/moonlight  # checks the package, writes nothing
node ../moonlight-dev/apps/moonlight/check.cjs  # desktop Vulkan decode check, bit-exact against hbv2.js
```

Private memory (`manifest.json` `memory.bytes`, layout in `tools/moonlight/ring.js`) holds the
control page, the HBV ring, three native frames and, since 1.1.0, two 4 MiB console UI page
buffers the host UI service publishes into (`host/ui/page.js`; format in
the [repo README](../../README.md), Page format).

The console UI (`ui.glsl`, included by `app.comp` and `app.frag`) draws the pages the host
service publishes: text strips and images at the positions the host laid out, a cursor the
console moves by geometry on the frame of the press, and one forwarded command per press
(A/B/X/Y, left/right on an adjustable item, L+R held one second). A page replaces the video
unless it is an overlay, which shows over the dimmed stream while raised. Plus and Minus held
together still exit to HBLauncher from any screen.

`build.js` regenerates `hbv.glsl`, `hbv2-tables.glsl`, `ring.glsl`, `state.bin` and
`memory.bin` under `backends/hblauncher.gpu-app/`, and `assets.py` the text atlas and
`text.glsl`; do not edit those by hand.

`assets/icon.png` is the Moonlight logo: the 256x256 frame of `app/moonlight.ico` from
[moonlight-qt](https://github.com/moonlight-stream/moonlight-qt) at commit ac29686,
GPL-3.0 like the helper's upstreams, exported as RGBA PNG with Pillow and otherwise unchanged.

`build.js` always compiles through `tools/moonlight/glslang-shim.sh`, which maps the
platform's `glslangValidator -V ... SRC -o OUT` call onto `glslc -Os --target-env=vulkan1.0`.
The committed SPIR-V under `backends/hblauncher.gpu-app/` is the build of glslc
`shaderc v2026.1`, `spirv-tools v2026.1`, `glslang 301b4ede` (Fedora 44 `glslc-2026.1-1`);
it reproduces all three files byte for byte, which the package test pins. glslangValidator
16.2.0 builds different bytes, so `build.js` refuses before writing anything when `glslc`
(or `GLSLC`) prints another version. Moving to a new glslc means changing `GLSLC_VERSION` in
`build.js` and the pinned hashes in `moonlight-dev` together.
`GLSLC` picks the glslc for both the version check and the shim; a `GLSLANG` setting is
ignored with a notice.

Stream to a running app (the newest `runs/launcher-*` session):

```sh
node host/stream/live.js --moonlight HOST APP --codec h264 --staggered --socket-audio
```
