# Moonlight

Displays PC frames written by the host into the app's private storage. Two
formats share the ring: HBV1 (`tools/moonlight/hbv.cjs`, fixed-size intra
slots drawn straight from the ring) and HBV2 (`tools/moonlight/hbv2.cjs`,
inter-coded variable-rate slots that the compute shader decodes into a
persistent 1080p frame). Without a sender the app shows the built-in HBV2 test
card. Design, format and measurements: `docs/moonlight/DESIGN.md`.

Build and check from the project root:

```sh
tools/moonlight/build-hbv2enc.sh       # native encoder, used by check.cjs CLIP and live.cjs
node apps/moonlight/build.cjs          # needs glslangValidator and spirv-val
node apps/moonlight/check.cjs [CLIP]   # desktop Vulkan decode check, bit-exact against hbv2.cjs
```

`build.cjs` regenerates `shaders/hbv.glsl`, `shaders/hbv2-tables.glsl`,
`shaders/ring.glsl` and `assets/memory.bin`; do not edit those by hand.

Without glslangValidator, point `GLSLANG` at a wrapper that maps its
`-V ... SRC -o OUT` call onto `glslc -Os --target-env=vulkan1.0 SRC -o OUT`
and run `GLSLANG=/path/to/wrapper node apps/moonlight/build.cjs`. The
committed `app.comp.spv` and `app.frag.spv` were built that way;
`app.vert.spv` is still the glslangValidator build. Rebuild all three with
glslangValidator when it is available.

Stream to a running app (the newest `runs/launcher-*` session):

```sh
node tools/moonlight/live.cjs --screen --codec hbv2 --budget 96
```
