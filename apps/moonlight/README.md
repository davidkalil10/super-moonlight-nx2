# Moonlight

Displays PC game frames streamed by the host in the HBV1 format
(`tools/moonlight/hbv.cjs`). The host stream service that fills the frame ring
is not written yet; without it the app shows the built-in test card. Design and
budget: `docs/moonlight/DESIGN.md`.

Build and check from the project root:

```sh
node apps/moonlight/build.cjs          # needs glslangValidator and spirv-val
node apps/moonlight/check.cjs [CLIP]   # desktop Vulkan decode check
```

`build.cjs` regenerates `shaders/hbv.glsl`, `shaders/ring.glsl` and
`assets/memory.bin`; do not edit those by hand.
