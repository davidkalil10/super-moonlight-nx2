# desktop.vulkan

Backend two of the HB package format: runs a package's compute and draw shaders on a desktop
Vulkan device, offscreen, at 1920x1080, and reads every frame back as RGBA. It proves package
selection, shader execution, service state and output; it is not a window or a display.

## Manifest section

```json
"desktop.vulkan": {
  "abi": 1,
  "shaders": {
    "vertex": "backends/desktop.vulkan/app.vert.spv",
    "fragment": "backends/desktop.vulkan/app.frag.spv",
    "compute": "backends/desktop.vulkan/app.comp.spv"
  },
  "initialState": "backends/desktop.vulkan/state.bin",
  "data": "backends/desktop.vulkan/text.bin"
}
```

Every path stays under `backends/desktop.vulkan/`. `supports()` checks the ABI, the three SPIR-V
stages, symlink escapes, a 1024-byte state and whole-word data up to 7 MiB before any Vulkan work.
Other fields (`memory`, `computeSequence`, `audio`) are refused.

Services: `present 1`, `input 1`, `time 2`. No audio: a package requiring `audio` is refused.

## Frames, input and time

Binding 0 is one persistent 8 MiB buffer: the state block, then the data at byte 1024. A frame
script (`hb-desktop-frame-script` v1, `fixtures/hello-world-input-time.json`) gives a full
button and connected snapshot per frame. Before each compute dispatch the host writes buttons
(+8), connected (+32) and the time 2 words: the fixed-step clock `originMs + N*1000/rateHz` in
whole ms (+48), which a script must keep within 0 and 2^32, and the frame index N (+52). It
never writes +64 time or +88 frames, which the hello-world shader advances itself. Each frame is
compute, barrier, draw, submit and wait, readback, with GPU timestamps.

## Requirements

`cc`, the Vulkan loader and headers, `glslangValidator`, `spirv-val` and a Vulkan device. The GPU
tests skip with the reason when any is missing.

## Smoke command

```sh
node sdk/desktop-vulkan/hello-world.cjs BUILD_DIR
```

It copies HBLauncher's hello-world template into `BUILD_DIR/package/hello-world` (the template is
not edited), compiles its entry into the desktop.vulkan section, runs the six-frame fixture and
prints the selected backend, device, final state words and the frame hash as JSON (after the
shader compiler's file names). `BUILD_DIR/output`
then holds `frame.rgba` (last frame), `state.bin`, `states.bin` (state after every frame),
`data.bin`, `frames.bin` and `run.json`, which records the frame hash and the SHA-256 of each
program file the runner read (the three SPIR-V stages, the state and the data).

The hash is only compared between runs on the same device and driver; rasterization differs
between GPUs, so there is no golden hash.

Tests build under `HB_BUILDS` (default `/media/storage2/builds/HBLauncher`):

```sh
HB_BUILDS=/media/storage2/builds/<dir> npm test
```

## Limits

- Offscreen only: no window, no swapchain, no claim about display presentation or refresh.
- No audio, and no Moonlight stream, decode or private ring memory.
- The input script stands in for a live keyboard or gamepad provider.
