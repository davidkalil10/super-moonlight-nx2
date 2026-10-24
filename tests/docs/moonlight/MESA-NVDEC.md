# Moonlight: what Mesa (NVK) and mesa-switch tell us about NVDEC

Background: `RESEARCH.md` (Q1/Q5). The idea it leads to is a "struct compiler" on the PC: the PC
parses the stream, builds the NVDEC picture-setup struct and the command stream for each frame,
and the console only runs a fixed native chain that submits them.

Sources read (both shallow clones under `~/claude-builds/mesa-research/`, so no per-file history):
- Mesa main `1f9035d9c04c` (VERSION `27.0.0-devel`), gitlab.freedesktop.org/mesa/mesa
- mesa-switch `0ff52079ca9e` (README: "Based on Mesa 26.2.4"), github.com/danfromtico/mesa-switch
- Linux 7.4 `drivers/gpu/drm/tegra/nvdec.c` (local tree `/media/storage2/builds/pocketds-v7.4-min-src`)

Paths below are relative to the repo they belong to.

---

## 1. Does NVK do Vulkan Video decode?

**H.264 decode only, experimental and off by default. NVK has no HEVC or AV1 decode.**

| What | Where |
|---|---|
| Vulkan entry points (thin C shims into Rust) | `src/nouveau/vulkan/nvk_cmd_video.c` |
| Session plus scratch buffers (coloc, mbhist, history: sizes and binding) | `src/nouveau/vulkan/nvk_video_session.c` (lines 39-53) |
| Codec dispatch and decode-state init (SET_OBJECT) | `src/nouveau/vulkan/rust/video/decode/mod.rs` |
| **H.264 picture setup and pushbuffer** | `src/nouveau/vulkan/rust/video/decode/h264.rs` (780 lines) |
| Picture-setup struct layouts, all codecs | `src/nouveau/headers/nvidia/video/nvdec_drv.h` (NVIDIA, MIT) |
| NVDEC class headers | `src/nouveau/headers/nvidia/classes/clc5b0.h`, `clc6b0.h`, `clc7b0.h`, `clc9b0.h` |
| NVDEC channel and subchannel allocation | `src/nouveau/winsys/nouveau_context.c` `nouveau_ws_video_context_init()` |
| Enable gate | `src/nouveau/winsys/nouveau_device.c:606-612`, `src/nouveau/vulkan/nvk_physical_device.h:89` |

How to turn it on: you need all three of `NVK_EXPERIMENTAL=video` (`nvk_instance.c:108`), the
`-Dvideo-codecs=h264dec` build option (a patent codec, `meson.build:457`), and a nouveau kernel
interface ≥ 1.4.3 that can create a VDEC context (`has_video`). When all three are met, NVK
exposes `VK_KHR_video_queue`, `video_decode_queue`, `video_decode_h264` and `video_maintenance1/2`,
for NV12 output only (`nvk_physical_device.c:117-227`, `nvk_image.c:192`).

What `h264.rs::Decoder::decode()` does for each frame:
1. It fills `nvdec_h264_pic_s` (bindgen'd from `nvdec_drv.h`) from the Vulkan `StdVideoH264*`
   SPS/PPS and picture info. The fields it sets are: the explicit EOS marker (16-byte `EOS_ARRAY`),
   `stream_len` (source range plus 16), `slice_count`, MB dimensions, `tileFormat=1`, `gob_height`
   (from the NIL tiling), luma and chroma pitches and bottom offsets, `HistBufferSize`, MBAFF and
   field flags, POC, `frame_num`, flat 0x10 scaling lists, `gptimer_timeout_value=81000000`
   ("matches the blob"), and `CurrPicIdx/CurrColIdx`.
2. It fills a `u32[256]` slice-offset table holding `sliceCount+1` entries. The extra last entry
   is the end of the stream.
3. It runs DPB bookkeeping that maps each Vulkan slot to a `pic_idx`/`dpb_idx` and tracks the
   field/frame state (`set_reference_frames`, `set_current_picture_slot`, ~lines 198-486). This
   produces `luma_base[17]` and `chroma_base[17]`.
4. It uploads the pic struct, the slice offsets and a 4 KiB status buffer into the command
   buffer's upload heap. Each one is 256-byte aligned.
5. It emits these methods: `SET_APPLICATION_ID=H264(3)`, `SET_CONTROL_PARAMS` (gptimer/ec/mbtimer
   on, `error_frm_idx`), `SET_DRV_PIC_SETUP_OFFSET`, `SET_IN_BUF_BASE_OFFSET`, `SET_PICTURE_INDEX`,
   `SET_SLICE_OFFSETS_BUF_OFFSET`, `SET_COLOC_DATA_OFFSET`, `SET_HISTORY_OFFSET`,
   `SET_NVDEC_STATUS_OFFSET`, `SET_PICTURE_LUMA_OFFSET0..16`, `SET_PICTURE_CHROMA_OFFSET0..16`,
   `H264_SET_MBHIST_BUF_OFFSET`, then `EXECUTE`. Every address value is `addr >> 8`
   (`addr_hi()`, which asserts 256-byte alignment).
6. The header of `rust/video/mod.rs` credits averne's NVDEC tracer. The struct values were
   reverse-engineered from blob traces, the same way averne's FFmpeg nvtegra backend was built.

**Class revisions.** The headers ship `NVC5B0`, `NVC6B0`, `NVC7B0` and `NVC9B0` (conventionally
Turing, GA100, GA10x Ampere and Ada; the headers themselves do not name the chips). The meson class list generates Rust and C method bindings only for
c5b0, c7b0 and c9b0 (`src/nouveau/headers/meson.build`). The winsys binds whatever `*b0` class the
kernel reports on the NVDEC channel. However, the Rust code always emits `NVC5B0` method structs,
and `nvk_push_video_decode_state_init()` hard-codes `NVC5B0_VIDEO_DECODER` in SET_OBJECT. That
works because every method NVK uses has the same offset in all four headers (checked:
APPLICATION_ID 0x200, EXECUTE 0x300, CONTROL_PARAMS 0x400, PIC_SETUP 0x404, IN_BUF 0x408,
STATUS 0x424, LUMA0 0x430, CHROMA0 0x474, H264_MBHIST 0x500). C7B0 is a superset of C5B0. It adds
`NEW_H264` (app id 8) together with `nvdec_new_h264_pic_s`, plus semaphore and fence methods.
NVK still uses the legacy app id 3 and the old struct.

**Ampere / Orin / T239 coverage.**
- Desktop Ampere: plausible through the C7B0-compatible path, but it is gated on the kernel and
  on an experimental flag.
- Orin (GA10B, chipset `0x17b`, SM 8.7): NVK knows the 3D side (`nouveau_device.c:65,244`) but
  marks every Tegra as non-conformant (`nvk_physical_device.c:89`). NVK has no Tegra NVDEC path.
- On Tegra, NVDEC is not behind the GPU FIFO. It is a **host1x client**: `HOST1X_CLASS_NVDEC = 0xF0`
  (`include/linux/host1x.h`), with a separate falcon/RISC-V engine. In Linux, `nvdec_t234_config`
  sets `.has_riscv = true` and has no `.firmware`, so the Orin NVDEC boots from its BootROM.
  T210 instead loads `nvidia/tegra210/nvdec.bin` (`drivers/gpu/drm/tegra/nvdec.c:382-410`).
- So for T239 (Orin-like, so a hypothesis), Mesa gives us **method offsets and struct layouts**,
  not a working transport. Which class revision and which picture-struct revision (old vs
  NEW_H264; HEVC v1/v2/v3 extensions) the T239 firmware accepts is still an on-device probe.

**HEVC/AV1.** `nvdec_drv.h` defines `nvdec_hevc_pic_s` (plus `_v1/_v2/_v3` extensions,
`hevc_slice_info_s`) and `nvdec_av1_pic_s`, but no Mesa code fills them. Our target stream is
HEVC, so the reference for the HEVC filler has to be averne's nvtegra (FFmpeg) and not Mesa.

**Transport difference (most important design point).** On desktop, nouveau allocates a FIFO
channel with `tt_ctxdma_handle = NOUVEAU_FIFO_ENGINE_NVDEC` and `nv_push` encodes NV906F GPFIFO
method headers (subchannel 4 for `*b0`). On Tegra, the same `(method, value)` pairs travel through
host1x opcodes (SETCLASS 0xF0, then writes to the engine's THI method registers, as averne does).
So **what we can reuse from Mesa is the list of `(method, value)` pairs plus the pic-struct
bytes**, not `nv_push`. The host generator needs its own small host1x encoder. The THI register
offsets have to come from averne's driver or the L4T/nvgpu sources; I have not verified them
here.

---

## 2. mesa-switch vs upstream

- **Scope:** Tegra X1 GM20B only (README), Vulkan (NVK, loaderless static `libvulkan.a`) plus
  Gallium NVC0/Zink GL and an EGL frontend, all linked statically into an NRO.
- **Submission:** it adds a new Horizon backend `src/nouveau/horizon/` written against libnx, and
  removes the nouveau DRM path. Work goes through **nvhost-gpu GPFIFO**: `nvGpuChannelCreate`,
  `nvGpuChannelAppendEntry`, `nvGpuChannelKickoff`, with fences from
  `nvGpuChannelGetSyncpointId/IncrFence/GetFence` (`nouveau_horizon_channel.c:852,1030,1311-1323,
  1532-1566`). The GM20B fence and barrier pushbuffer snippets are in `nouveau_horizon_gm20b.c`.
  NVK talks to this backend through `src/nouveau/vulkan/nvkmd/switch/` and Gallium through
  `src/gallium/winsys/nouveau/switch/`.
- **Memory model:** unified memory. The CPU allocates the backing with `memalign`, and then
  `nvMapCreate(addr, size, align, NvKind, cached)` wraps it. Cache maintenance is explicit
  (`armDCacheClean/Flush`). There is a BO cache, and `nvMapLoadRemote` imports other buffers
  (`nouveau_horizon_memory.c:488-672,754`). GPU VA comes from a fixed-address allocator using
  `nvAddressSpaceAllocFixed/MapFixed` and `nvioctlNvhostAsGpu_MapBufferEx`
  (`nouveau_horizon_vm.c`). If GPU completion is unknown, a resource stays quarantined and is not
  recycled.
- **Video:** none. Upstream tag `mesa-26.2.4` (`3c479d6a`) has no `nvk_cmd_video.c` or
  `rust/video/` either, so NVK video landed after 26.2 and mesa-switch did not drop it. The class headers
  (`clc5b0..c9b0.h`, `nvidia/video/`) come along with the header import, but nothing uses them.
  The only mention is a comment in `nouveau_horizon.h:~230` saying video channels "must stay
  disabled" for mapped completion. Its GPU channel is also the wrong channel type for NVDEC, which
  needs `/dev/nvhost-nvdec` (host1x SUBMIT with cmdbufs, relocs and syncpt incrs).
- **What carries over for us:** the patterns, not the code path. That means nvmap creation with an
  explicit cache policy, flushing before the device reads, syncpoint fence waits, and
  fail-closed reuse. These match the nvmap CREATE/ALLOC and pin steps that the NVDEC flow in
  `RESEARCH.md` Q1 needs.

---

## 3. Host-side vs on-device split

**Pure data (runs on the PC and can be tested offline):**
- Annex-B NAL split, emulation-prevention handling, SPS/PPS/VPS and slice-header parsing.
- POC/frame_num derivation, reference-list and DPB slot state machine (the h264.rs `Decoder`
  logic is stateful, but nothing in it needs the device).
- Filling `nvdec_h264_pic_s` / `nvdec_hevc_pic_s` byte-for-byte, the slice-offset table and the EOS
  padding.
- Building the method list `[(method, value | reloc)]` and encoding it as host1x words.
- Scratch-buffer sizing (`compute_opaque_buffer_sizes` / `nvk_video_session.c:39-42`).

**Device-bound (needs the console):**
- Every device address: nvmap pin/MAP_CMD_BUFFER results go into the `>>8` method values and into
  `luma_base/chroma_base`. Surface pitch, `gob_height` and the block-linear layout depend on how
  the console allocated the surface.
- `nvdrv` Initialize, opening `/dev/nvhost-nvdec`, SUBMIT, SYNCPT_WAITEX, and reading status.
- Which firmware and struct revision T239 accepts (the probe from section 1).

So the host should emit **the struct bytes, the command words, and a relocation table** (for each
word: which buffer it refers to, the offset inside it, and the shift). The console chain then
applies the relocations. nvhost SUBMIT already takes relocs, which fits the fixed, branchless chain
in `RESEARCH.md`. Alternatively, all buffers are pinned once at fixed IOVAs and the host
precomputes everything.

**Proposed layout** (Node `.cjs` to match `sdk/native/`; a C helper only for layout extraction):

```
tools/nvdec/
  CLAUDE.md               scope, struct-revision notes, sources and licenses
  layout/
    dump-layout.c         offsetof/sizeof/bitfield dump of nvdec_drv.h -> JSON
    nvdec_h264_pic_s.json generated, committed (source of truth for Node)
    nvdec_hevc_pic_s.json
  src/
    bitreader.cjs         exp-Golomb, RBSP unescape
    annexb.cjs            NAL split
    h264/{sps,pps,slice,dpb,picsetup}.cjs
    hevc/{vps,sps,pps,slice,dpb,picsetup}.cjs
    struct.cjs            pack(fields, layout.json) -> Buffer
    methods.cjs           method ids (from clc5b0/clc7b0) + reloc records
    host1x.cjs            SETCLASS/INCR/NONINCR encoder (THI offsets TBD)
    frame.cjs             DECODE_UNIT -> {picStruct, sliceOffsets, cmdWords, relocs}
  test/
    fixtures/             small H.264 + HEVC clips (CC0/self-generated with x264/x265)
    golden/               per-frame .bin dumps from the Mesa oracle
    run.cjs               node:test, byte-compares against golden
```

**Do not hand-port struct offsets into JS.** `nvdec_h264_pic_s` uses C bitfields. Compile
`dump-layout.c` on the host against `nvdec_drv.h`, write the offsets and bit positions to JSON, and
let `struct.cjs` pack from that JSON. Add a test that rebuilds the JSON and diffs it.

**Offline oracle (H.264), "what Mesa would produce":**
- NVK can't be used directly on a PC without an NVIDIA GPU. drm-shim reports nouveau 1.3.1
  (`src/nouveau/drm-shim/nouveau_noop.c:559-560`), which is below 1.4.3, so `has_video` is false.
  `nv_push_dump`/`vk_push_print` also only know the 3D, compute, M2MF, 2D and copy subchannels, and
  never print the upload-heap pic struct.
- Option A, cheapest: copy `h264.rs`'s field-fill logic into a small Rust or C harness with stubbed
  addresses, feed it the same parsed SPS/PPS/picture info, and dump `nvdec_h264_pic_s` bytes and
  method pairs. The harness has to stay MIT and keep Mesa's notices.
- Option B, highest fidelity: patch drm-shim to report 1.4.3 and to return a `0xc7b0` class on the
  NVDEC channel. Then run NVK with `NVK_EXPERIMENTAL=video NVK_DEBUG=push` under a Vulkan video
  client (FFmpeg `-hwaccel vulkan` or GStreamer `vulkanh264dec`), and add a dump hook in
  `upload_to_the_gpu()`.
- Either way, the golden data is per frame: the pic struct with address fields masked, the
  slice-offset table, and the ordered method list with relocs in symbolic form.
- HEVC has no Mesa oracle. For HEVC, use averne's nvtegra as the reference, or check semantic
  fields against `ffprobe -show_frames` and the HM reference decoder's syntax dump. Byte-exact
  output only becomes provable on the device.

---

## 4. License notes

- NVK C and Rust (`nvk_cmd_video.c`, `rust/video/**`): `SPDX-License-Identifier: MIT`, ©
  Collabora / Red Hat. Copying or porting is allowed as long as the copyright and permission
  notice is kept with the derived file.
- `nvdec_drv.h`, `nvenc_drv.h`, `cl*b0.h`: NVIDIA copyright, MIT (SPDX header in the file).
  `update-from-open-gpu-doc.py` syncs the class dirs but has no `video/` mapping, so confirm the
  upstream source of `nvdec_drv.h` before vendoring. Keep the files unmodified, with their headers.
- mesa-switch `src/nouveau/horizon/*`: MIT ("Mesa Switch port contributors"). The repo also ships
  `licenses/` with GPL/Apache/BSL texts for other Mesa parts, so take only MIT-tagged files.
- averne's nvtegra lives in FFmpeg (LGPL-2.1+). Using it as a reference is fine. Copying its code
  into a Node tool would make that part LGPL, so prefer reimplementing from the MIT headers and the
  specs.
- Patent note: Mesa puts `h264dec`/`h265dec` behind `video-codecs` because of codec patents. That
  is relevant only if we redistribute binaries.

---

## Summary

1. NVK (Mesa main `1f9035d9`) has **experimental H.264-only** Vulkan Video decode
   (`NVK_EXPERIMENTAL=video`, `-Dvideo-codecs=h264dec`, nouveau ≥ 1.4.3). It has no HEVC or AV1.
2. The struct fill and pushbuffer live in `src/nouveau/vulkan/rust/video/decode/h264.rs`, with the
   layouts in `headers/nvidia/video/nvdec_drv.h`.
3. Class headers C5B0/C6B0/C7B0/C9B0 are present. NVK always emits C5B0 methods, which works
   because all the methods it uses have identical offsets through C9B0. C7B0 adds NEW_H264.
4. Orin (0x17b) is known only for 3D. Tegra is non-conformant in NVK and there is no Tegra NVDEC
   path. Linux shows Orin NVDEC is a RISC-V host1x client (class 0xF0).
5. So Mesa gives us **method offsets, struct layouts and field semantics**. The transport (host1x
   opcodes and THI) has to come from averne or L4T sources.
6. mesa-switch (26.2.4 base) replaces DRM with a libnx Horizon backend (nvhost-gpu GPFIFO, nvmap
   over memalign, fixed VA, syncpoint fences). It has **no video at all**.
7. Its reusable value is the nvmap, cache and syncpoint patterns, not its submission path. NVDEC
   needs `/dev/nvhost-nvdec` host1x SUBMIT.
8. The PC can build everything except device addresses. So it should emit struct bytes, command
   words and a reloc table, and the console patches or pins them.
9. Proposed `tools/nvdec/` in Node, using a C-generated layout JSON and golden per-frame dumps
   from a Mesa-derived H.264 oracle. HEVC can only be checked semantically offline.
10. Everything we would reuse is MIT (keep the notices). averne's FFmpeg code is LGPL, so use it
    as a reference only.
