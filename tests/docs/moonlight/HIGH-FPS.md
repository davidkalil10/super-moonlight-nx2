# 120 fps in Moonlight and the launcher

Scope: the console Vulkan path (present, compute, frame loop) and the bridge
budget. Video decoding beyond the HBV2 compute shader is out of scope. All console
numbers below come from recorded sessions in `runs/`. All desktop numbers were
measured on rig with `apps/moonlight/check.cjs`. Nothing here was run live.

Short answer: to reach 120 fps end to end, three things have to hold together:

1. The panel runs at 120 Hz.
2. A GPU frame takes under 8.3 ms.
3. The bridge feeds 120 slots per second.

None of the three is true today, and only the second can be fixed in this tree
without first running a probe. The probes in `sdk/tools/` decide which branch
of the plan applies.

## 1. Correction to RESEARCH.md Q3

RESEARCH Q3 (`RESEARCH.md:79-85`) says HBLauncher reuses SmileBASIC's swapchain,
so changing the present mode would mean recreating a swapchain we don't own.
That is no longer true. The display stage opens its own `nn::vi` layer and
builds the surface and swapchain itself:

- `vulkan-copy.cjs:98-121`: `OpenDefaultDisplay`, then `Layer::Open` on a
  1920x1080 "default" layer.
- `vulkan-copy.cjs:144-175`: `vkCreateViSurfaceNN` plus a capabilities query.
  The recorded surface reports min 2 and max 3 images, transform 256 and
  usage 159 (`runs/launcher-2yWWh8/vulkan-display.json`).
- `vulkan-copy.cjs:238-258`: `vkCreateSwapchainKHR` with `minImageCount` (offset
  32) set to the surface minimum (2) and `presentMode` (offset 88) hard-coded to
  2 (FIFO). Present modes are never queried.

So changing the present mode is a two-word change at creation time. Only the
answer to "is anything but FIFO offered" is missing, and `probe-present.cjs`
supplies it.

## 2. How a frame is paced today

The 60-frame program `launcher-loop.cjs:218-240` runs on a console thread. Each
frame calls, in order:

1. GetNpadState and touch.
2. `vkAcquireNextImage2KHR` (infinite timeout).
3. Two command-buffer lookups.
4. `vkQueueSubmit`.
5. `vkQueuePresentKHR`.
6. `vkQueueWaitIdle`.

The host polls the loop only every 50 ms and makes no per-frame round trips.
That means:

- **FIFO plus WaitIdle quantizes to whole vblanks.** A frame that misses a vblank
  waits a full period, which halves the rate.
- **Interval = 60 x max(vsync, GPU time + submit overhead).** The heartbeat
  (`batches[].interval`) records this directly.
- **A single `acquired` semaphore is reused** (`launcher-loop.cjs:155-164`). It
  is only safe because WaitIdle drains the queue every frame. Removing WaitIdle
  needs per-image fences and semaphores (item 6 below).

`sdk/tools/present-rate.cjs runs/` summarizes every recorded session:

| Session  | What ran | min / p5 / median Hz | seconds < 59 Hz |
| -------- | -------- | -------------------- | --------------- |
| 2yWWh8, 6cuEwx, idrgtq, pp9ci0, TJ2SqH | menu, idle apps | 59.9 / 60.0 / 60.0 | 0 |
| kTCkLD   | ftpd app | 30.0 / 60.0 / 60.0 | 1 |
| gw7PCW   | Moonlight, HBV1 `pan.hbv` (fragment decode) | 8.6 / 30.0 / 60.0 | 38, mostly exactly 30.00 |
| bXVJxN   | Moonlight HBV2 with audio | 27.6 / 46.1 / 58.6 | 168 of 300 |

- **gw7PCW** proves the halving: whole seconds at exactly 30.00 Hz, so every
  frame in those seconds missed vblank and waited two.
- **bXVJxN** mixes 1-vblank and 2-vblank frames. HBV2 decode already misses
  16.7 ms on the console at 60 Hz.

At 120 Hz the same mechanism drops to 60 as soon as a frame exceeds 8.3 ms.

## 3. Budgets at 120 fps

| Stage | Budget at 120 | Today | Source |
| ----- | ------------- | ----- | ------ |
| Present cadence | 8.33 ms | 16.7 ms (60 Hz in every idle session) | `present-rate.cjs` |
| HBV2 decode, 1080p P frame | < ~7 ms (leave room for draw and present) | Console unknown; misses 16.7 ms in bXVJxN. Rig, LOCAL_SIZE 1024: 6.5-9.8 ms (Navi31), 16.7-17.5 ms (Raphael iGPU) | `check.cjs`, `probe-hbv2-decode.cjs` |
| HBV2 catch-up (3 slots in one dispatch) | same frame | Rig: 15.4-17.9 ms (Navi31), 35.5 ms (Raphael) | `check.cjs` |
| Preview copy, 1920x1080x4 per frame | 0 | 8.3 MB copy plus two layout transitions every frame, every app | `launcher.cjs:392-397`, `gpu-app.cjs:355-360` |
| Bridge exchanges | about 470/s needed | about 412/s wired ceiling | `DESIGN.md:584-588`, `launcher-TJ2SqH` |
| Host encode plus helper decode | 8.3 ms per stage (pipelined) | HBV2 encode 2.4-6.5 ms; helper decode 3-8 ms (VAAPI 6.4-7.6) | DESIGN.md |

**Bridge arithmetic.** Each exchange is 32 KiB (`ring.cjs` `EXCHANGE_BYTES`).

- Video: an HBV2 frame at `--budget 96` is 3 exchanges, so 120 fps needs 360/s.
- Input: the input feeder reads about 60/s.
- Audio: 80 ms buffers at 3-4 calls each, about 40-50/s.

That is about 470/s against the 412/s wired ceiling, before any retries.
Wi-Fi delivered about 59 fps at depth 2. **120 fps does not fit the current
protocol**, so item 5 below is required, not optional.

## 4. HBV2 decode cost: what was measured on rig

All runs were bit-exact against the JS decoder (`check.cjs`, planes compared).
Times are `computeMs` from GPU timestamps in `tools/moonlight/gpu-check.c`. The
1080p P-frame figure is the steady P frames of the chain; catch-up is the last
dispatch, which applies two frames.

| Variant | Navi31 (7900 XTX) P / catch-up | Raphael iGPU P / catch-up | VGPRs / spilled (Navi31, Raphael) |
| ------- | ------------------------------ | ------------------------- | --------------------------------- |
| baseline, `HBV2_LOCAL_SIZE` 1024 | 6.5-9.8 / 15.4-17.9 | 16.7-17.5 / 35.5 | 96 / 191, 64 / 983 |
| **LOCAL_SIZE 512 (committed)** | 8.8-10.6 / 17.9 | **7.3-7.7 / 15.8** | 192 / 13, 128 / 116 |
| LOCAL_SIZE 256 | 12.4-14.6 / 24.2 | 9.9-10.3 / 21.4 | n/a |
| zero-row IDCT plus sparse clear | 10.9-13.0 / 21.1-22.4 | 24.0-25.0 / 50.5 | n/a |
| sparse clear only | 8.9-10.7 / 18.5 | 19.8-20.6 / 41.8 | n/a |

**Why LOCAL_SIZE matters.** One invocation decodes one 8-macroblock chunk with
three private `int[64]` arrays (`hbv2.glsl`). At 1024 invocations per workgroup,
the compiler must fit every invocation's registers in one CU. RADV caps the
shader at 64 VGPRs and spills the arrays to scratch: 983 spilled VGPRs on
Raphael (RADV_DEBUG=shaderstats). At 512 the cap doubles, and spilling almost
disappears.

Ampere has the same limit: 65536 registers per SM / 1024 threads = 64 registers
per thread. The console's single SM is therefore very likely spilling today.
256 is worse than 512 because 1020 chunks over 256 invocations means four
chunks in series per invocation.

**Negative results; don't retry these.** Skipping zero rows in the IDCT, or
clearing only the touched rows, is bit-exact but adds live state and
data-dependent indexing into private arrays. Spilling then gets worse and both
variants run slower everywhere. Per-invocation micro-optimizations lose to
register pressure. The lever is structural (item 1).

`HBV2_LOCAL_SIZE` 512 is committed (7e9e16d). Both GPUs are bit-exact. Raphael
gets 2.3x faster; Navi31 is flat to slightly slower. 512 is also safe for any
`maxComputeWorkGroupInvocations` NVIDIA reports. Console confirmation is
pending `probe-hbv2-decode.cjs`.

## 5. Ranked changes

Gain estimates are relative to the frame budget. The risk column covers both
the risk to a running session and the code risk. Items 1, 2, 3 and 6 touch
`homebrew-launcher/*.cjs`, which is about to be restructured. They are
proposed as diffs here and not applied.

| # | Change | Expected gain | Risk | Gate |
| - | ------ | ------------- | ---- | ---- |
| 1 | Wide HBV2 dispatch through `computeSequence` | Decode spreads from one workgroup (one SM) to several; the largest single win (est. 2-4x on decode) | Medium: needs a pick / decode / commit split in the shader | none |
| 2 | Drop the per-frame preview copy | ~8 MB of writes and two layout transitions per frame; frees bandwidth on a shared-memory SoC | Low | none |
| 3 | Present mode and image count at swapchain creation | Removes the vblank-halving cliff (MAILBOX or IMMEDIATE), or adds a third image for overlap | Low to medium | `probe-present` lists more than FIFO, or max images >= 3 |
| 4 | Extended swap interval or display mode for 120 Hz | Required for any 120 Hz present | Unknown | `probe-present --vi` shows the vi rate, `probe-swap-interval` shows an effect |
| 5 | Bridge protocol 3: input piggybacked on video writes, bigger requests (PLAN 2.11) | Gets 120 slots/s under the exchange ceiling | Medium | none; required for 120 |
| 6 | Per-image fences instead of `vkQueueWaitIdle` | Overlaps CPU submit with GPU work and lets a frame finish after vblank without a full stall; lower latency | Medium: semaphore reuse must change too | after 3 |

### 1. Wide dispatch (proposal)

Today `vkCmdDispatch(…, 1, 1, 1)` is hard-coded (`gpu-app.cjs:287, 331, 342`),
so the decode uses one workgroup on one SM. 1080p is 1020 chunks, which is
enough for 2-8 workgroups of 128-512 invocations.

HBV2 cannot simply use more workgroups in one dispatch. Picking a slot,
decoding it and committing it need a barrier between them, and workgroups
cannot synchronize. The manifest's `computeSequence` (`gpu-app.cjs:275-296`)
already records `computeBegin`, then `repeat` x (`compute`, `computeAfter`) with
a barrier after each. That maps directly onto:

- `computeBegin` = pick: one workgroup, as today.
- `compute` = decode chunks: N workgroups.
- `computeAfter` = commit: one workgroup.
- `repeat` = `HBV2_CATCH_UP`.

The one-line launcher change is the dispatch width:

```diff
--- hbl-platform/homebrew-launcher/gpu-app.js (secondary recording, ~287)
-        await call('vkCmdDispatch', secondary, 1, 1, 1);
+        const width = (stage === 'compute' && app.manifest.computeSequence.groups) || 1;
+        await call('vkCmdDispatch', secondary, width, 1, 1);
```

The app then sets `"computeSequence": {"repeat": 3, "groups": 8}` and splits
`hbv2Step` into three entry points. That split is shader work in
`apps/moonlight/` only, and `check.cjs` verifies it on rig. It also needs
`gpu-check.c` to replay `computeSequence` the same way.

Expected effect: decode time drops roughly with the number of SMs used. Public
specs give T239 12 SMs (not verified here), and today one workgroup can only
ever occupy one of them. Measure with `probe-hbv2-decode.cjs` before and after.
Smaller workgroups also leave each invocation more registers, which section 4
shows matters.

### 2. Preview copy (proposal)

The preview buffer is read once, after the first present (`launcher.cjs:450`).
Yet every command buffer copies the full swapchain image into it:
`launcher.cjs:391-399` and `gpu-app.cjs:354-362`, with transitions to
`TRANSFER_SRC` and on to `PRESENT`.

Record the transition straight to `PRESENT`, and keep a separate one-shot
capture command buffer for screenshots:

```diff
--- hbl-platform/homebrew-launcher/gpu-app.js (~354)
-      await barrier(2, 6, 0x400, 0x100, 0x1000, 0x800);
-      await put(0x1400, ...);
-      await put(0x1500, ...);
-      await call('vkCmdCopyImageToBuffer2', command, p + 0x1500);
-      await memoryBarrier(0x1000, 0x1000, 0x4000, 0x2000);
-      await barrier(6, 1000001002, 0x1000, 0x800, 0, 0);
+      await barrier(2, 1000001002, 0x400, 0x100, 0, 0);
```

`launcher.js` gets the same change, keeping the copy only in the first-present
command buffer.

### 3. Present mode and image count (proposal, gated)

```diff
--- homebrew-launcher/vulkan-copy.js (238-258)
-            32: report.surface.minImages,
+            32: Math.min(3, report.surface.maxImages || 3),
 ...
-            88: 2,
+            88: presentMode, // from vkGetPhysicalDeviceSurfacePresentModesKHR
```

- MAILBOX (1) keeps tear-free output without the stall.
- IMMEDIATE (0) is what mesa-switch maps to swap interval 0
  (`wsi_common_switch.c`).
- FIFO (2) stays the fallback.

The launcher allocates per-image command buffers from `resources.images`, so a
third image only changes the count. With three images under FIFO, a slow frame
no longer forces the next one to wait a whole extra period.

### 4. 120 Hz display (gated)

Nothing in HBLauncher sets a display mode. nnSdk's vi service is not
initialized in this process (`display-inspection.json`: `sdkServiceIsNull:
true`). SmileBASIC is a Switch 1 title running under the compat layer, which
may hold the panel at 60 Hz whatever we ask for.

What the catalog shows:

- `nn::vi::SetLayerExtendedSwapInterval(Layer*, int, int)` (nnCompat 2481616) is
  a tail call to `Layer::SetLayerNextExtendedSwapInterval(int, int)`.
- That function steps to the embedded InternalLayer (`add x0, x0, #8`).
- InternalLayer's swap-interval functions forward through a table the compat
  layer fills at runtime: `x0 = *(nnCompat + 0x404e108)`, with the function at
  +0xa8 (swap interval), +0x1f0 (extended) and +0x1f8 (clear).
- The meaning of the two ints can't be recovered offline. Switch 2's 120 Hz
  titles use cadences like 40 fps, so a numerator/denominator pair is plausible
  but unconfirmed.
- `GetLatestFrameNumber` and `ListFrameHistory` ignore their Layer argument. They
  read a global `LayerWithHistory` in nnCompat BSS (+0x5456558), which may be
  SmileBASIC's layer or nobody's. `probe-present --vi` checks that it is
  initialized before calling.

How to read the probes:

- **The vi frame number cannot prove a 60 Hz panel.** If the global
  `LayerWithHistory` is initialized, it is almost certainly SmileBASIC's own
  layer, and SmileBASIC presents 60 times a second whether the panel runs at 60
  or 120 Hz. A reading of about 60, or a skipped reading, leaves the panel rate
  unknown.
- **vi frames/s clearly above 60:** the panel runs at least that fast, and
  something (the compat layer or the WSI's swap interval) holds our FIFO
  presents to every other vblank. Go to item 3, then `probe-swap-interval`.
- **The decisive test available now is `probe-swap-interval --apply`:** if the
  loop heartbeat ever goes above 60 fps under some pair, the panel is faster
  than 60.
- **`probe-swap-interval` shows no change:** this is the expected outcome, not
  proof of a bad call. The symbol is `SetLayerNext…`, and the Vulkan WSI sets
  the native window's swap interval itself on every present (mesa-switch does
  exactly that). In that case the lever is the present mode (item 3), not vi.

The proper panel-rate probe is a follow-up: count vsync events with
`nn::vi::GetDisplayVsyncEvent` (nnCompat 2480848) inside a wait-and-count job.
The open question is whether an event created by nnCompat's vi can be waited
with nnSdk's `WaitSystemEvent` (nnSdk 0x1255c0). The catalog shows nnCompat's
`nn::os::*SystemEvent` imports resolving to nnSdk definitions, which suggests
yes. Check the live import slots before writing that probe.

### 5. Bridge protocol 3

DESIGN section 1 already proposes piggybacking input on the video write. Add:

- Larger requests, so a 96 KiB frame is one exchange instead of three
  (PLAN 2.11, bootstrap retype).
- Audio buffers carried on the same exchange.

The target is no more than 2 exchanges per video frame including input, which
gives about 240/s at 120 fps. Protocol 3 does not exist in the tree yet. The
long-term alternative is console-side socket receive (PLAN 2.2), which takes
the bridge out of the video path.

### 6. Fences instead of WaitIdle (proposal)

Use one fence per swapchain image, and one acquire semaphore per frame in
flight. In the loop, replace `vkQueueWaitIdle` with `vkWaitForFences` on the
image about to be reused, then `vkResetFences`; the program must stay
4-argument calls. The repeating frame needs a per-frame slot index, so this
fits the coming refactor of `launcher-loop.js` better than a patch to it now.

## 6. Probes for the owner

Run them in this order. All of them write their JSON report into the session
directory (mode 600).

```sh
# 1. Host only: shown rate per session from loop heartbeats.
node sdk/tools/present-rate.cjs runs/

# 2. Read-only, loop may run: present modes, image counts, compute limits,
#    timestampPeriod, extensions, the vi forwarding table and history state.
node sdk/tools/probe-present.cjs runs/launcher-XXXX
# Then the vi frame-number rate (skipped automatically if uninitialized):
node sdk/tools/probe-present.cjs runs/launcher-XXXX --vi

# 3. HBV2 decode on the console, loop stopped, Moonlight prepared.
touch runs/launcher-XXXX/launcher-loop.stop      # wait for "HBLauncher stopped"
node sdk/tools/probe-hbv2-decode.cjs runs/launcher-XXXX
#    Compare summary.pMeanMs / catchUpMs with the rig table in section 4.
#    Private storage and app state are restored; copies are kept as
#    probe-hbv2-decode-{memory,state}.bin. Relaunch Moonlight afterwards.

# 4. Restart the loop, then the swap-interval dry run.
node sdk/tools/probe-swap-interval.cjs runs/launcher-XXXX
# Only if the dry run says "table callable: true". The pair is an example;
# the meaning of the two ints is unknown, so record what each pair does.
node sdk/tools/probe-swap-interval.cjs runs/launcher-XXXX --apply 1 2
```

What each answer decides:

- `presentModes`, plus `images` max >= 3, gates item 3.
- `maxComputeWorkGroupInvocations` and `timestampPeriod` confirm the 512 choice
  and the item 1 sizing.
- `viFramesPerSecond` above 60 proves a faster panel; about 60 proves nothing (see item 4).
- `probe-hbv2-decode`'s `pMeanMs` says whether 60 Hz is safe with 512, and how
  much item 1 must gain for 120: under 7 ms is needed.
- `probe-swap-interval`'s `applied` row against `before` shows whether the vi
  call does anything.

GPU timestamps were not used: `vkGetQueryPoolResults` takes 8 arguments and the
bridge passes 4. The decode probe instead times submit + WaitIdle on the console
with the SDK tick (31.25 MHz). This includes a small fixed submit cost, measured
by its `idle` row.
