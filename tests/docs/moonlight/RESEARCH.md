# Moonlight-on-HBLauncher: feasibility research

Goal: decide what must be *proven on the console* before attempting to port a
Moonlight client into HBLauncher (SmileBASIC 4.4.9, Switch 2 fw 23.0.1, userland
bridge; no console CPU code). Target stream: 1080p120, HEVC/H.264, Sunshine on LAN.

Scope note that governs everything below: HBLauncher runs no arbitrary CPU on the
console. The host (Node) drives qualified native functions over the Wi-Fi RPC
bridge, and per-frame work is a *fixed, branchless* repeating native call chain
(`hbl-platform/sdk/native/repeating.js`, `homebrew-launcher/launcher-loop.js`). Any decode
path therefore has to be expressed as constant native calls with host-prepared
arguments, not as a decoder running on the console. All Switch-1 facts cited are
documented for Switch 1 firmware and are only hypotheses for T239 / 23.0.1.

---

## Q1. NVDEC access (service, nodes, ioctl sequence)

Documented for Switch 1 (switchbrew NV_services; averne nvtegra userspace driver):

- Service variant for an application process is `nvdrv`. Its NvDrvPermission mask
  is `0xA83B` [11.0.0+] (`0xA82B` [3.0.0-10.x]). Decoding these bits:
  bit5 = **VideoDecoder → `/dev/nvhost-nvdec`** is set; bit3 (VIC,
  `/dev/nvhost-vic`) and bit4 (VideoEncoder) also set at 11.0.0+. So on Switch 1
  an application has been permitted to open NVDEC and VIC since ~3.0.0. GPU/nvmap
  nodes (bits 0/1: `/dev/nvhost-gpu`, `nvhost-as-gpu`, `nvhost-ctrl`, `/dev/nvmap`)
  are also in the application set.
- Two gates, not one: (a) `nvdrv` IPC `Initialize` (needs a transfer-memory handle
  + process handle passed as copy/pid handles) must succeed; (b) the per-node
  permission bit must be set. The mask is useless if `Initialize` can't be issued.
- Decode flow (averne / libnx NV ioctls): `nvmap` CREATE→ALLOC (inout, Nintendo
  variant 0xC0200104) for bitstream + surfaces; open `nvhost-nvdec` channel;
  SET_NVMAP_FD; MAP_CMD_BUFFER (pins nvmap handles → device addresses, calls
  nvmap_pin); GET_SYNCPOINT; build a host1x command buffer that programs the NVDEC
  falcon class with a per-frame picture-setup struct (SPS/PPS/VPS + slice params);
  SUBMIT (cmdbufs, relocs, syncpt_incrs) → returns fence thresholds; SYNCPT_WAITEX
  on that threshold; output surface is NV12/P010. The picture-setup struct and
  command buffer are exactly the kind of fixed-shape blob a host can precompute.
- averne's backend is a *userspace* NVDEC driver (can't link NVIDIA libs on HOS),
  built on these same nvmap/nvhost/host1x ioctls; only T210 was tested by the
  author, newer Tegra "should work" but unverified, and 12-bit HEVC is unimplemented.

Known: application nvdrv mask includes NVDEC/VIC/nvmap on Switch 1; full ioctl +
syncpoint recipe is public (averne source + switchbrew).
Unknown: whether any of this holds on T239 / 23.0.1; the T239 NVDEC class revision;
whether `Initialize`'s transfer-memory + handle passing is qualified in this bridge.
Probe needed: (0) IPC handle/transfer-memory path; (1) `nvdrv` Open of `/dev/nvhost-nvdec`,
inspect `Err`.

Local evidence (good): `hbl-platform/sdk/native/ipc.js` `encode()` already supports `send_pid`
and up to 8 copy handles; `sdk/native/ipc-functions.json` has qualified `send`,
`transfer`, `copy`. So IPC-with-handles exists; a transfer-memory primitive looks
reachable. `hbl-platform/sdk/native/ipc.js` is explicitly "an investigation interface, not
exposed to GPU packages" — opening nvdrv is a bridge-level probe, not an app API.

---

## Q2. Switch 2 (T239) differences

- No public documentation maps Switch-1 nvdrv/NVDEC/VI/display behavior onto T239
  or fw 23.0.1. switchbrew's NV_services, Display and Socket pages are Switch-1
  content; the Switch-2-era system-version pages add no NV/VI detail.
- Hardware background only (press/teardown, treat as rumor): T239 is Ampere-class,
  12 SM, LPDDR5X; it carries an Orin-generation NVDEC (newer class than T210's),
  which is *why* averne's T210-era class programming may not match bit-for-bit.
- Nintendo is known to have added silicon-level security on Switch 2; nothing
  public describes nvdrv permission masks or node availability on 23.0.1.

Known: Switch-1 NV/VI ABI is well documented. Unknown: everything T239-specific.
Probe needed: treat each Switch-1 fact as a hypothesis; the Open/ioctl probes in Q1
are the only way to confirm the mask, node set and class on this build.

---

## Q3. Display at 120 Hz

- libnx/VI selects a layer/display; present interval and refresh come from the
  swapchain / the `vi`+`nvdisp` layer config, historically 1080p60 on Switch 1.
- Decisive constraint from this repo: HBLauncher does **not** create its swapchain.
  `launcher-loop.js` reuses SmileBASIC's existing `device/queue/swapchain` objects
  (`prepared.resources`) and the repeating frame calls `vkAcquireNextImage2KHR →
  vkQueueSubmit → vkQueuePresentKHR → vkQueueWaitIdle` over a fixed 60-call cycle.
  Present mode / refresh is whatever SmileBASIC chose at swapchain creation (very
  likely FIFO 60 Hz); we have no `vkCreateSwapchainKHR` and no VI layer control.
- So selecting 120 Hz would require either recreating the swapchain (not qualified;
  would fight SmileBASIC's renderer) or a documented VI present-interval call we
  do not have. 1080p120 present is, on current evidence, **not reachable**; 60 Hz
  present of a 120 fps source (decode 2, present 1) is the realistic ceiling.

Known: present path is fixed at SmileBASIC's swapchain, `vkQueueWaitIdle`-paced,
60-frame cycle. Unknown: SmileBASIC's actual present mode/refresh; whether Switch 2
exposes 120 Hz at all to this process. Probe needed: (2) measure real present rate
in the existing loop; grep the ~188 `vi` defs for refresh/rate/interval symbols.

---

## Q4. Network throughput

- switchbrew Sockets: the BSD service is backed by transfer memory sized from a
  config (TCP send/recv + max, UDP send ~0x2400, UDP recv ~0xA500 ≈ 42 KB, buffer
  count 1-8). Undersized transfer memory collapses TCP to ZeroWindow (~1 B/s).
  Later firmware: `RegisterClient` / `RegisterClientShared`, work buffer 0x1000-0x13F000.
- The config is fixed by **SmileBASIC's** socket init, not by us. Default UDP recv
  ~42 KB ≈ ~4-5 ms of an 80 Mbps stream: receiving Sunshine's UDP video *directly
  on the console* risks drops at 1080p120 bitrates, and we cannot resize the buffer
  without owning socket init. The qualified calls are `socket`, `sendto`, `recv`,
  `close` (`sdk/native/service-functions.json`); `recv` takes a flags arg (bridge
  already uses `MSG_DONTWAIT`). No getsockopt/setsockopt is qualified.
- Wi-Fi also carries the RPC bridge, so console socket traffic competes with it.

Known: default buffers are small and fixed; TCP/UDP send/recv/close are qualified.
Unknown: actual SO_RCVBUF on this build; sustained console recv throughput.
Probe needed: (3) measure console TCP recv MB/s for a fixed-size blob; check whether
any setsockopt/buffer-config symbol is qualifiable.

Design consequence: prefer **TCP** from the PC to the console for the video blob,
not console-side UDP from Sunshine. The PC terminates Sunshine's UDP+FEC.

---

## Q5. Moonlight protocol split (host vs console)

moonlight-common-c (Limelight.h) cleanly separates transport from rendering:
the library handles RTSP handshake, ENet control stream, RTP video reassembly +
Reed-Solomon FEC, Opus audio + FEC, and input encryption; the client supplies
`DECODER_RENDERER_CALLBACKS` (setup/start/stop/cleanup/`submitDecodeUnit(PDECODE_UNIT)`)
and `AUDIO_RENDERER_CALLBACKS` (`decodeAndPlaySample`). A `DECODE_UNIT` is a linked
list of buffers tagged PICDATA/SPS/PPS/VPS — i.e. ready-to-decode NAL units.

Proposed split (to validate, not a verdict): **all of moonlight-common-c stays on
the PC** (HBLauncher already requires a Linux host). The PC also runs averne's
per-codec logic as a *struct compiler*: bitstream/DPB/ref tracking, NVDEC
picture-setup struct and host1x command buffer are all built on the PC from each
`DECODE_UNIT`. The PC ships one fixed-size, padded blob per frame
`[cmdbuf | picsetup | bitstream]` over TCP. The console's per-frame chain is then
fully constant: `recv(fixed len)` into a pinned nvmap buffer → channel SUBMIT with
constant args (relocs → a fixed surface ring) → SYNCPT_WAITEX → VIC/convert →
present. Input and audio also terminate on the PC.

Known: the library/callback boundary is exactly where a "PC does logic, console
does fixed decode" split wants to cut. Unknown: whether a branchless chain can
express variable bitstream length (needs fixed-size padded blobs + constant reloc
layout). Probe needed: confirm `recv` with MSG_WAITALL-style fixed read inside the
repeating worker, and that per-frame reloc/cmdbuf layout can be held constant.

---

## Q6. Per-frame budget sketch, 1080p120

8.33 ms/frame at 120 fps (16.67 ms at 60 Hz present). Per frame, the console chain:

1. TCP `recv` of the padded blob (cmdbuf+picsetup+bitstream). HEVC 1080p120 at
   ~40-80 Mbps ≈ 40-85 KB/frame → ~0.3-0.7 ms at LAN rates *if* recv keeps up (Q4).
2. NVDEC channel SUBMIT + SYNCPT_WAITEX. NVDEC on this class decodes 1080p well
   above 120 fps; wait is the real cost, overlappable with next recv.
3. NV12 → RGBA for the swapchain image. NV12 1080p ≈ 3.1 MB; RGBA ≈ 8 MB. Two
   candidates: (a) VIC convert+scale into a pinned surface (preferred, no CPU);
   (b) qualified `memcpy` from pinned NV12 into a `vkMapMemory`'d staging buffer +
   `vkCmdCopyBufferToImage` (~8 MB/frame; feasible on A78 but costs bandwidth).
4. Present via the existing `vkQueueSubmit`/`vkQueuePresentKHR`/`vkQueueWaitIdle`.

The whole chain must be the same branchless `repeating.cjs` frame every time: fixed
addresses, fixed call list, result stores read by the host without pausing. Because
present is SmileBASIC's FIFO swapchain (Q3), realistic target is **decode-120 /
present-60**, or 1080p60 end-to-end first. The frame→Vulkan-image handoff (step 3)
is the least-documented link and the main technical risk.

Known / Unknown / Probe needed: the chain shape is expressible; the NV12→Vulkan
image bridge is undocumented (nvmap handle vs Vulkan-owned allocation). Probe needed:
(4) get decoded/pinned memory into a swapchain image and measure the copy/convert.

---

## Moonlight-Switch (XITRIX) as reference, and audio

Moonlight-Switch is a Switch-1 homebrew client (devkitA64/libnx). Mapping onto HBLauncher:

- **Decode**: FFmpeg with averne's nvtegra/NVDEC fork; output NV12/P010/YUV420P.
  *Maps conceptually* — same NVDEC ioctls — but must be driven as host-prepared
  fixed chains, not FFmpeg running on-console. averne's per-frame struct building
  is the reusable asset; it runs on the PC in our model.
- **Renderer**: **deko3d** (NVIDIA low-level 3D), with FSR1 upscaling, UI via
  Borealis. *Does not map* — HBLauncher presents through SmileBASIC's Vulkan
  swapchain; the deko3d renderer and Borealis UI are not reusable. Only the
  decoded-surface→present idea carries over.
- **Streaming**: "streaming code lent from" Rock88's Moonlight-NX, which wraps
  moonlight-common-c. In our model that whole layer lives on the PC.
- **Audio**: Opus decoded on-console (libopus) → libnx audout/audren. *Does not map*:
  no CPU on console means no on-console Opus decode. Alternative that **does** map:
  decode Opus → PCM on the PC and stream PCM to the console's existing
  `nn::audio` AudioOut path. `homebrew-launcher/game-audio.js` already proves this
  path works — it opens `OpenDefaultAudioOut` (48 kHz, stereo, int16), uploads PCM
  buffers from host files, and uses `AppendAudioOutBuffer`/`GetReleasedAudioOutBuffer`.
  Today it's built for short effects (8 descriptors, 50 ms polling), not continuous
  low-latency streaming; a streaming variant with a steady PCM queue and buffer
  recycling is plausible but unproven for A/V-sync and underrun behavior.

Known: averne decode logic and the moonlight-common-c split are reusable; an
on-console PCM AudioOut path already exists. Unknown: continuous-stream AudioOut
latency/underrun; A/V sync with a 60 Hz present clock. Probe needed: (5) stream
continuous host PCM through a game-audio-style worker and measure latency/glitching.

---

## Ranked go/no-go probes (run on console first, in order)

0. **IPC handle + transfer-memory path (repo only, no console).** Confirm
   `ipc.cjs` can issue an `nvdrv` `Initialize` (pid + copy handle + transfer-memory
   handle). If the bridge can't pass these, NVDEC is unreachable — blocker.
1. **`nvdrv` Open `/dev/nvhost-nvdec` → inspect `Err`.** Cheapest decisive no-go:
   if denied on 23.0.1 there is no software fallback without console CPU code →
   project is **no-go**. Also Open nvmap, nvhost-as-gpu, nvhost-ctrl.
2. **Present-rate + VI probe.** Measure the existing loop's real present rate;
   grep `vi` defs for refresh/interval. Decides 120 vs 60 present ceiling.
3. **Socket throughput.** Measure console TCP recv MB/s; find any buffer-config
   symbol. Decides TCP-blob transport viability at target bitrate.
4. **Pinned-memory → Vulkan image.** Prove decoded/pinned NV12 reaches a swapchain
   image (VIC path or memcpy+copyBufferToImage) and time it.
5. **One hand-built HEVC I-frame.** Build cmdbuf+picsetup on PC, SUBMIT +
   SYNCPT_WAITEX, read back a decoded surface. Proves the decode chain end-to-end.
6. **Continuous PCM audio.** Stream host-decoded PCM through a game-audio-style
   AudioOut worker; measure latency/underrun and A/V sync against the present clock.

If probe 1 fails, stop: no on-console decode is possible under this model.

---

## Sources

- switchbrew NV services: https://switchbrew.org/wiki/NV_services
- switchbrew Display services: https://switchbrew.org/wiki/Display_services
- switchbrew Sockets services: https://switchbrew.org/wiki/Sockets_services
- averne nvtegra FFmpeg backend (cover letter): https://ffmpeg.org/pipermail/ffmpeg-devel/2024-May/328549.html
- averne nvtegra h264 patch: https://ffmpeg.org/pipermail/ffmpeg-devel/2024-May/328563.html
- moonlight-common-c: https://github.com/moonlight-stream/moonlight-common-c
- Limelight.h (callbacks/stream config): https://github.com/moonlight-stream/moonlight-common-c/blob/master/src/Limelight.h
- Moonlight-Switch (XITRIX): https://github.com/XITRIX/Moonlight-Switch
- libnx HID/NV references: https://github.com/switchbrew/libnx
- Repo (read-only): `homebrew-launcher/launcher-loop.js`, `hbl-platform/sdk/native/repeating.js`,
  `hbl-platform/sdk/native/ipc.js`, `sdk/native/service-functions.json`, `homebrew-launcher/game-audio.js`
