# Moonlight

Displays PC frames written by the host into the app's private storage. Two
formats share the ring: HBV1 (`tools/moonlight/hbv.js`, fixed-size intra
slots drawn straight from the ring) and HBV2 (`tools/moonlight/hbv2.js`,
inter-coded variable-rate slots that the compute shader decodes into a
persistent 1080p frame). Without a sender the app shows the built-in HBV2 test
card. Design, format and measurements: [Moonlight design](../../../moonlight-dev/docs/moonlight/DESIGN.md).

`--codec h264` also accepts the helper's raw H.264 stream and decodes it through
the console's native movie API into NV12 surfaces. Audio, controller and touch
remain enabled. Setup, DUT results and performance limits are documented in
[Native H.264](../../../moonlight-dev/docs/moonlight/NATIVE-H264.md).

The app is an HB package (`manifest.json`, see hbl-platform `docs/hb-package.md`):
`assets/` holds the icon and text atlas and `backends/hblauncher.gpu-app/` the shaders
with their includes, the SPIR-V and the state and memory images. The compute and fragment
shaders read the frame ring, so the package has no portable entry and no `src/` yet.

Build and check from the project root:

```sh
tools/moonlight/build-hbv2enc.sh       # native encoder, used by check.cjs CLIP and live.js
node apps/moonlight/build.js           # needs glslangValidator and spirv-val
node ../moonlight-dev/apps/moonlight/check.cjs [CLIP]  # desktop Vulkan decode check, bit-exact against hbv2.js
```

`build.js` regenerates `hbv.glsl`, `hbv2-tables.glsl`, `ring.glsl`, `state.bin` and
`memory.bin` under `backends/hblauncher.gpu-app/`, and `assets.py` the icon, the text atlas
and `text.glsl`; do not edit those by hand.

Without glslangValidator, build through `tools/moonlight/glslang-shim.sh`,
which maps the `-V ... SRC -o OUT` call onto `glslc -Os --target-env=vulkan1.0`:

```sh
GLSLANG=tools/moonlight/glslang-shim.sh node apps/moonlight/build.js
```

The committed SPIR-V under `backends/hblauncher.gpu-app/` is that build; rebuilding
through the shim reproduces all three files byte for byte.

Stream to a running app (the newest `runs/launcher-*` session):

```sh
node tools/moonlight/live.js --screen --codec hbv2 --budget 96
```
