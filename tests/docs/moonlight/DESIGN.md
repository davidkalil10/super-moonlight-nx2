# Moonlight on HBLauncher: design (PC decode, shader display)

Goal: play PC games streamed by Sunshine (rig, 192.168.8.245) on the Switch 2
through HBLauncher, using only what apps already have: PC-side networking and
decoding, frame bytes written by the host into app storage, a fragment shader
that draws them, and the game-audio PCM path. No console video decoder, no new
native or IPC probing. `RESEARCH.md` covers the NVDEC route this design avoids.

Summary: the host-to-console write path is the bottleneck, not the GPU. Today it
moves **one 32 KiB block per round trip, about 13 ms per round trip in the best
recorded session**. That is roughly 32 KiB per frame at 60 fps, so 720p60 and
540p60 are out of reach in any format we can decode in a shader. The plan is a
fixed-rate DCT format (HBV1) at **640x352, one round trip per frame, upscaled to
1080p in the fragment shader**, with an 864x480 two-round-trip mode at 30 fps.

## 1. Measured transfer budget

### How the host writes console memory

`NativeClient.write` (`smilebasic/engine/lib/native.cjs`) splits a buffer into
32 KiB parts. Each part is one exchange: a 0x8080-byte request (two call records
plus up to 0x8000 data bytes, landed in scratch and copied with `memcpy`)
and a fixed 0x8010-byte response. The two directions together move about
64 KiB on Wi-Fi per 32 KiB written. Exchanges are strictly serialized:
`Connection.read` refuses a second pending response, `NativeClient` chains
every exchange on one promise, and the local HTTP bridge
(`smilebasic/engine/lib/bridge.cjs`) puts every stage's request on one queue.
Pipelining is therefore not possible with the current code. It would need a
host change, and a live test to see whether the console side accepts
back-to-back requests.

Stage programs write the GPU-visible storage while the render worker is
running. `sdk/host/ftp-service.cjs` updates its status block in the mapped
binding-0 buffer every 150 ms during rendering, so mid-loop writes are
established practice. `gpu-app.cjs` keeps the app's private storage
(binding 1) mapped as well (`privateStorage.mapped`).

### Recorded timings (runs/, 2026-10-24)

`launcher.cjs:47` writes 8 MiB of zeros, the 1 KiB state, the 2 MiB text atlas
and the 4 MiB catalog right after `vkMapMemory2`. That is 14,681,088 bytes in
449 exchanges, and no other journaled call happens until the next
`vkCreateBuffer`. The gap between those two operations in
`launcher-auto-operations.jsonl` is therefore a direct write-throughput
measurement:

| Session | Gap | Per 32 KiB exchange | Throughput |
|---|---|---|---|
| launcher-kTCkLD (good Wi-Fi) | 5,817 ms | 13.0 ms | 2.52 MB/s |
| launcher-W71IDj (same day, poor) | 43,559 ms | 97 ms | 0.34 MB/s |

Calls with almost no payload took 13-27 ms in kTCkLD and 55-200 ms in W71IDj.
Every exchange carries the full 32 KiB request and response, so the cost is per
exchange and not per byte. A 4 KiB frame costs the same as a 32 KiB frame, so a
format should fill the block.

Present rate: `launcher-auto-loop.json` (kTCkLD) records 300 cycles of 60
frames at 0.9993-1.0002 s each, so the display runs at a steady **60 Hz**.

### Budget

| | Best session | Poor session |
|---|---|---|
| Exchanges per second | ~77 | ~10 |
| Exchanges per 16.7 ms frame | 1 | 0.17 |
| Bytes per frame at 60 fps | **32 KiB** | n/a (~10 fps at 32 KiB) |
| Bytes per frame at 30 fps | 64 KiB | n/a (~5 fps) |

Other traffic shares those ~77 exchanges per second:

- Audio: 48 kHz stereo int16 is 192 KB/s, about 6 exchanges per second of data
  plus the `AppendAudioOutBuffer` calls. With 100 ms buffers, each buffer fits
  in one exchange (call 1 `memcpy` into the PCM ring, call 2 the append), for
  about 10 exchanges per second.
- Input: Moonlight needs the console controller state on the PC. Do not poll it
  separately. Put it on the video exchange: call 2 is a `memcpy` of the 64-byte
  `raw[]` block into the response output area, so every frame write also returns
  input. `NativeClient.exchange` already supports two calls plus data. The
  bridge's `pair` command does not take a data payload yet, so this needs a
  small host-side bridge addition.

So, in the best session, 60 fps video plus audio uses about 70 of the ~77
exchanges per second. The stream service has to work on a latest-wins basis.
It sends the next exchange only when the previous one resolves, always encodes
the newest decoded frame, and never queues frames. A Wi-Fi stall then drops
frames instead of adding latency.

The biggest single lever, out of scope here: a write-only bridge command with a
short acknowledgement instead of the fixed 32 KiB response. That change is on
the SmileBASIC side.

## 2. Formats compared

All formats are decoded in the fragment shader from a storage buffer: the
pipeline has no textures (README, Graphics and assets). The prototype in
`tools/moonlight/` encodes ffmpeg frames and decodes them with the same integer
bit extraction and dequantisation as the shader.

- **YUV420**: planar 8-bit Y, Cb, Cr at 4:2:0, 12 bpp. Trivial to decode.
- **BC1**: 4x4 blocks with two RGB565 endpoints and 2-bit indices, 4 bpp. The
  shader does the BC1 math in ALU code. The prototype uses a simple
  principal-axis encoder; a cluster-fit encoder would gain about 1 dB.
- **HBV1** (new): 16x16 macroblocks of exactly 9 words. Four 8x8 luma DCT blocks
  of 56 bits each (8-bit DC, 3-bit per-block scale, 14 fixed-length AC
  coefficients) plus 8x8 Cb and Cr DCT blocks (4:2:0) of 32 bits each. That is
  1.125 bpp. The shader evaluates the inverse DCT at each output pixel's
  continuous position, which gives the upscale inside a block for free.
- **Dirty tiles** (a layer on top of any of them): only changed blocks are sent.
  The "changed" columns below give the fraction of blocks whose encoded bytes
  changed from one frame to the next.

### Cost at the requested sizes (10 frames each, PSNR at the coded size)

| Format | Size | Bytes/frame | Exch./frame | fps @13 ms | PSNR pan | PSNR mandelbrot | PSNR testsrc2 |
|---|---|---|---|---|---|---|---|
| YUV420 | 1280x720 | 1,382,400 | 43 | 1.8 | 52.3 | 51.1 | 50.6 |
| BC1 | 1280x720 | 460,800 | 15 | 5.1 | 33.8 | 33.4 | 37.8 |
| HBV1 | 1280x720 | 129,620 | 4 | 19.2 | 26.6 | 27.7 | 26.0 |
| YUV420 | 960x540 | 777,600 | 24 | 3.2 | 49.2 | 38.7 | 35.5 |
| BC1 | 960x540 | 259,200 | 8 | 9.6 | 34.9 | 34.3 | 37.5 |
| HBV1 | 960x544 | 73,460 | 3 | 25.6 | 28.3 | 28.9 | 26.9 |

Even HBV1 needs 3-4 exchanges per frame at these sizes. At the measured rate
there is no 60 fps format for 720p or 540p.

### Budget-fitting sizes (PSNR after upscaling to 1280x720 vs the 720p source)

| Format | Size | Bytes/frame | Exch. | pan | mandelbrot | testsrc2 | changed (pan / testsrc2) |
|---|---|---|---|---|---|---|---|
| YUV420 | 192x108 | 31,104 | 1 | 22.64 | 24.80 | 22.67 | 100% / 47% |
| BC1 | 320x180 | 28,800 | 1 | 23.44 | **26.02** | **23.99** | 100% / 12% |
| HBV1 | 640x352 | 31,700 | 1 | **23.72** | 25.32 | 22.27 | 100% / 19% |
| YUV420 | 256x144 | 55,296 | 2 | 23.16 | 25.70 | 22.49 | 100% / 36% |
| BC1 | 448x252 | 56,448 | 2 | 24.30 | **27.04** | **25.41** | 100% / 11% |
| HBV1 | 864x480 | 58,340 | 2 | **24.59** | 26.20 | 23.50 | 100% / 17% |

Clips (3 s, 60 fps, generated with ffmpeg; not committed):
- `pan`: a camera pan over a detailed forest photo, the closest of the three to
  game content.
- `mandelbrot`: lavfi zoom, very high-frequency edges.
- `testsrc2`: lavfi test card with saturated flat colour and sharp edges.

All three are synthetic stand-ins, so treat the PSNR as indicative only.

### Choice: HBV1

Reasons:

- On the pan clip it is the best format at both budgets (+0.3 dB over BC1).
  Side-by-side crops (`~/claude-builds/HBLauncher/moonlight/results/*-compare.png`)
  show visibly more detail than BC1 at 320x180. BC1 is a 4x bilinear blow-up, and
  PSNR rewards its blur.
- It carries 4x the pixels of BC1 in the same block. If the transport gets
  faster, the same decoder scales to 864x480 and above without a new format.
- Every block has a fixed size, so there is no rate control. A frame is always
  exactly one or two exchanges.

Honest costs:

- BC1 wins PSNR on the synthetic clips by 0.7-1.7 dB.
- HBV1's weak spot is saturated chroma edges (testsrc2 Cb about 25 dB), because
  chroma gets only 6 coefficients per 16x16 block.
- Keep BC1 320x180 as the fallback mode. The comparison code stays in
  `tools/moonlight/reference.cjs`.

Dirty tiles are rejected for now. On the pan clip 100% of blocks change on every
frame, and that is the normal case for games. They would also need a persistent
decoded plane plus a scatter pass, and that conflicts with the ring-slot model
below. They only pay off on static menus (testsrc2: 12-19% changed).

### Measured encoder speed

The pure-JS encoder runs at 16.5 ms per 640x352 frame on one core of the
HBLauncher host (Strix Halo). That is borderline for 60 fps. Split
macroblock rows across 3-4 `worker_threads` for 60 fps, or for 864x480 (about
30 ms on one core).

Shader correctness check:
- `apps/moonlight/check.cjs` renders the real fragment shader on desktop Vulkan
  (`homebrew-launcher/game-render`) and compares it with the JS decoder.
- The PSNR between them at 1920x1080 is 64-67 dB. The only differences are float
  rounding.

## 3. Architecture

```
rig: Sunshine (H.264/HEVC + Opus over RTP/ENet)
        |  LAN
HBLauncher host PC
  moonlight client (moonlight-common-c)      pairing: moonlight-embedded `pair 192.168.8.245`
    video DECODE_UNITs -> ffmpeg decode (VAAPI) -> scale to 640x352 RGB24
    audio Opus -> PCM 48 kHz s16
  stream service (Node, launcher stage like ftp-service)
    HBV1 encode (worker threads) -> slot (sequence % 3) of the app's private ring
    one exchange per frame: data = slot, call 1 memcpy -> ring, call 2 memcpy raw[] -> response
    PCM every ~100 ms: one exchange (memcpy -> PCM ring, AppendAudioOutBuffer)
    input from the response -> LiSendControllerEvent / LiSendMultiControllerEvent
        |  Wi-Fi, existing RPC bridge
Switch 2: apps/moonlight
  binding 1: 3 x 64 KiB ring (196,608 bytes, private storage)
  fragment: pick the newest slot whose header and trailer sequence match, HBV1 decode at 1080p
  compute: fade and B/Minus exit (template logic)
```

### PC side

- **Pairing and session**: moonlight-common-c does RTSP, ENet control, RTP
  reassembly, FEC and input encryption, but it does not pair or launch apps. Use
  moonlight-embedded (C, Linux), whose libgamestream pairs with Sunshine (PIN in
  the Sunshine web UI) and launches apps.
- **Getting frames out**: moonlight-qt renders into its own window and has no
  raw-frame output, so it is not usable here. Two ways to get frames:
  - moonlight-embedded's fake/dump platform, if it writes the elementary stream
    to a file or FIFO (not verified, check the source first).
  - A small C helper linked against moonlight-common-c. Its
    `submitDecodeUnit` writes Annex-B NAL units to stdout, and its audio callback
    writes decoded PCM to a second pipe.

  In both cases `ffmpeg -f h264 -i - -vf scale=640:352 -f rawvideo -pix_fmt rgb24 -`
  feeds the Node encoder (`tools/moonlight/frames.cjs` already reads that
  format).
- **Stream settings**: ask Sunshine for a low resolution (for example 1280x720
  at 60 fps and modest bitrate) so PC decode and scaling stay cheap. Encode
  quality is limited by HBV1 anyway.
- **Service wiring**: apps cannot ship host JavaScript (README: host service
  extensions are not supported). The stream service becomes an SDK background
  service like FTP:
  - add `"moonlight"` to the `sdk.services` whitelist in `sdk/host/runtime.cjs`;
  - start a stage next to `ftp-service.cjs` in `start-launcher.cjs`;
  - give the service the app's `privateStorage.mapped` address.

### Console side (`apps/moonlight`)

- Private storage (binding 1) holds three 64 KiB slots. A slot is the HBV1
  header (magic, sequence, size, payload bytes), the macroblocks, and the
  sequence number repeated in the last word of the last exchange used. The host
  writes slot `sequence % 3`.
- The fragment shader picks the newest slot whose header and trailer match. A
  slot is either complete or ignored. The displayed slot is overwritten only two
  writes later, so three slots are enough at one write per frame.
- Selection happens per pixel, in the fragment shader. That keeps the compute
  shader testable with `game-compute-check`, at the cost of a possible tear
  line when a new slot completes during scan-out. If that shows on the console,
  move the selection to the compute shader (write the slot index to `c.game`).
- Shader cost per pixel: 3 header checks, 14 luma and 2x5 chroma terms, each a
  bit extract plus two cosines. That is cheap for 1920x1080, but it is untested
  on console. The fallback is a `computeSequence` pass that decodes into a pixel
  plane once per frame.
- Initial memory holds a test-card frame, so launching the app without a stream
  still shows that decode works.

### Latency estimate (best session)

| Stage | Time |
|---|---|
| Sunshine encode and network | ~5-10 ms |
| PC decode | ~3 ms |
| HBV1 encode | ~5 ms with workers |
| One exchange | ~13 ms |
| Wait for the next 60 Hz scan-out | up to 16.7 ms |
| **Total** | **about 40-50 ms**, plus the controller path |

## 4. What needs a live console session

1. **Sustained exchange rate during rendering.** Measure one 32 KiB write per
   frame for a minute with the app running: ms per exchange, jitter, and whether
   the render loop's cycle interval stays at 1.000 s.
2. **HBV1 on the console GPU.** Check visually, then confirm the fragment cost
   keeps 60 Hz at 1080p (cycle intervals in the loop report).
3. **Private-storage writes visible to the GPU without a flush.** Check the
   memory type flags in `privateStorage.memoryFlags` for HOST_COHERENT, and
   watch for tearing or stale slots.
4. **Bridge `pair` with data.** Write the video slot and read `raw[]` in one
   exchange, and confirm the input bytes arrive.
5. **Continuous PCM through the game-audio path.** Measure underruns and
   latency with 100 ms buffers.
6. **Wi-Fi variance.** The two recorded sessions differ by 7x. Decide the
   frame-dropping policy, and whether to fall back to 30 fps or BC1 320x180
   automatically.

## 5. Files

- `tools/moonlight/hbv.cjs`: HBV1 constants, encoder, shader-equivalent decoder,
  and the GLSL generator (single source of truth).
- `tools/moonlight/reference.cjs`: BC1, YUV420, bilinear upscale, PSNR, changed
  blocks.
- `tools/moonlight/evaluate.cjs CLIP [--frames N] [--json OUT]`: the tables
  above.
- `tools/moonlight/encode.cjs CLIP OUT.hbv [--size WxH]`: the slot stream the
  host would write.
- `tools/moonlight/hbv.test.cjs`: layout, bit extraction, torn-slot rejection,
  and a check that the generated GLSL matches.
- `apps/moonlight/`: the app. `build.cjs` regenerates `shaders/hbv.glsl`,
  `shaders/ring.glsl`, and the test-card memory. `check.cjs` runs the desktop
  Vulkan check.

Reproduce:

```
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=60 -t 3 -pix_fmt yuv420p -c:v libx264 -crf 12 testsrc2.mp4
node tools/moonlight/evaluate.cjs testsrc2.mp4 --frames 10
node apps/moonlight/check.cjs testsrc2.mp4
```

Shader build note: `sdk/build.cjs` needs `glslangValidator`, which this PC does
not have. The committed SPIR-V was compiled with
`glslc --target-env=vulkan1.0 -O` and passes
`spirv-val --target-env vulkan1.0`. Rebuild with glslangValidator once it is
installed, so the package matches the SDK toolchain.
