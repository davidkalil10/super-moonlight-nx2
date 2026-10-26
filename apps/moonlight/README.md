# Moonlight

Displays PC frames written by the host into the app's private storage. Two
formats share the ring: HBV1 (`tools/moonlight/hbv.js`, fixed-size intra
slots drawn straight from the ring) and HBV2 (`tools/moonlight/hbv2.js`,
inter-coded variable-rate slots that the compute shader decodes into a
persistent 1080p frame). Without a sender the app shows the built-in HBV2 test
card. Design, format and measurements: `docs/moonlight/DESIGN.md`.

`--codec h264` also accepts the helper's raw H.264 stream and decodes it through
the console's native movie API into NV12 surfaces. Audio, controller and touch
remain enabled. Setup, DUT results and performance limits are documented in
[Native H.264](../../docs/moonlight/NATIVE-H264.md).

Build and check from the project root:

```sh
tools/moonlight/build-hbv2enc.sh       # native encoder, used by check.cjs CLIP and live.js
node apps/moonlight/build.js           # needs glslangValidator and spirv-val
node apps/moonlight/check.cjs [CLIP]   # desktop Vulkan decode check, bit-exact against hbv2.js
```

`build.js` regenerates `shaders/hbv.glsl`, `shaders/hbv2-tables.glsl`,
`shaders/ring.glsl` and `assets/memory.bin`; do not edit those by hand.

Without glslangValidator, build through `tools/moonlight/glslang-shim.sh`,
which maps the `-V ... SRC -o OUT` call onto `glslc -Os --target-env=vulkan1.0`:

```sh
GLSLANG=tools/moonlight/glslang-shim.sh node apps/moonlight/build.js
```

The committed `app.comp.spv` and `app.frag.spv` were built that way;
`app.vert.spv` is still the glslangValidator build. Rebuild all three with
glslangValidator when it is available.

Stream to a running app (the newest `runs/launcher-*` session):

```sh
node tools/moonlight/live.js --screen --codec hbv2 --budget 96
```
