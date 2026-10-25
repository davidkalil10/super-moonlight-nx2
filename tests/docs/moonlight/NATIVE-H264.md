# Native H.264 decoding

`live.cjs --codec h264` feeds Sunshine's compressed video to the console's
`movie::Decoder` API in the loaded `nnCompat` module. Its implementation is
`movie::VideoDecoder`. These are the exported names found on the DUT; the public
entry points do not have an `nn::` prefix.

Launch the rebuilt Moonlight app, then run from the repository root:

```sh
HBMOONLIGHT=/path/to/current/hbmoonlight node tools/moonlight/live.cjs \
  runs/launcher-SESSION --moonlight HOST Desktop --codec h264 \
  --size 1920x1080 --fps 30 --bitrate 8000
```

Build the helper from the current source so stdin understands `request-idr`:

```sh
build=/media/storage2/builds/HBLauncher/moonlight-helper/$(date -u +%Y%m%dT%H%M%SZ)
bash tools/moonlight/helper/build.sh "$build"
```

The helper uses three independent channels:

| Channel | Contents | Consumer |
| --- | --- | --- |
| FD 4 | Annex-B H.264 access units | `native-decoder.cjs` |
| FD 3 | 48 kHz stereo s16le PCM | Existing `audio-stream.cjs` and console AudioOut |
| stdin | Controller, touch and keyframe requests as JSON lines | Existing helper input handling |

Audio, controller and touch are enabled by default. `--no-audio` and
`--no-input` disable their respective paths. Hold Plus and Minus together for
one second to return to the launcher. Single B/Minus presses reach the PC.
An audio/input process failure ends the native stream and reports the error.

## Video path

The raw pipe is drained before matching its stderr metadata because the helper
announces an access unit only after writing its complete payload. Pipe writes
are not frame boundaries. The reader validates lengths, sequence numbers and
EOF, and bounds its memory. When the live queue fills, it discards complete
units and waits for an independent keyframe. It never resumes on a dependent
P frame after dropping its reference chain.

The first IDR supplies bare SPS/PPS NALs to
`CreateH264DecoderConfigurationData`. The verified decoder configuration uses
H.264 type 1 and CPU-copy output format 4 (NV12). Each complete access unit is
copied into an acquired native input buffer, then submitted with its PTS.
Decoded output is copied by the console SDK directly into the inactive mapped
Vulkan frame buffer. Decoded pixels do not travel through the PC.

By default, the host publishes dimensions, stride, slice height, color space and
a sequence number. With `--split-decoder --native-publish`, the output worker
publishes those fields after fetching into one of three surfaces. The host
checks the acquired output index before opening the fetch gate and reserves a
surface the GPU is not reading. The compute shader checks the metadata checksum
and acknowledges the sequence after selecting that surface; the fragment
shader samples NV12 with limited-range BT.709 conversion and aspect-ratio
borders. Host request fields start at byte 256 and GPU-written fields occupy
the first 128 bytes, avoiding writes by both processors to the same cache line.
ABI marker `0x484e5633` rejects older shaders.

The adapter verifies the loaded module's symbol names, offsets, sizes and
instruction signatures before making native calls. It uses the current
session's module base and retains allocations until the SmileBASIC session
ends. Failed worker jobs are not reused or destructed while they may still run.
The profile is in `sdk/native/movie-functions.json`; the full captured catalog
is documented in [CATALOG.md](../../sdk/native/CATALOG.md).

## Validation and current limits

On SmileBASIC 4.4.9 / Switch 2 system software 23.0.1, the DUT decoded a 128x96
H.264 test frame into NV12, copied it into the Vulkan surface, and displayed it.
The user confirmed the pattern. A 1920x1080 Sunshine stream also reached the
native renderer, and the user confirmed sound. Desktop Vulkan checks cover
NV12 publication, black/white levels, borders, existing HBV1/HBV2 decoding and
the exit chord. Unit tests cover access-unit ordering, overflow recovery,
module qualification, surface ownership, audio recycling, controller and touch.

The first protocol-2 live test presented roughly 1–2 frames/s and dropped audio
buffers under the combined RPC load. Protocol 3 reduces request padding and
allows larger compressed uploads; it requires replacing saved NS2 and a fresh
connection, as described in [PROTOCOL3.md](PROTOCOL3.md).

## Per-frame call budget and worker modes

The console loop, not the link, is the ceiling (~412 exchanges/s on the best
recorded wired session), so the frame rate tracks exchanges per frame.
`tools/moonlight/native-decoder.test.cjs` drives the real client, module and
worker against an in-process console that walks every worker frame through a
gadget-level emulator, and counts each wire exchange.

Live streams always use the persistent decoder worker, fed through a second
authenticated console connection over TCP, with destination acquisition
overlapped with decode. The first frame still uses the host-driven path to
establish the output layout, then the worker takes over. TCP needs a launcher
session created by this revision, because the session records the host address
for that connection. The host-driven and RPC data paths remain only inside the
decoder module, for the staged probes.

### Host-driven (default)

One finite worker runs `SendInputBufferForDecode` (six args),
`AcquireOutputBufferIndex` (five args) and the next frame's
`AcquireInputBufferIndex` in a single frame. `SendInput`'s index is read from a
module control slot (`{u32}`) that the tail `AcquireInput` refills, so the index
is pipelined one frame ahead; the host validates it and never lets `-1` reach
`SendInput`. The host writes the AU, reads the control block once, and pairs
`bufferSetData` with `getOutput`.

| Step | Exchanges |
| --- | --- |
| AU write | 1 |
| finite worker: frame write, create, handle read, tryWait, result read, join | 5 |
| control-block read (input/output index, PTS, flags) | 1 |
| paired `bufferSetData` + `getOutput` | 1 |
| `releaseOutput` | 1 |
| **steady-state submit + receive (mock-measured)** | **10** |

This is down from 18 — two separate single-call six-argument workers for
`sendInput` and `acquireOutput` — and from the original ~23. One of the five
worker exchanges is `finite.spawn` reading the pthread handle, because it passes
`out = base` rather than `rpc.output`; passing `rpc.output` with `outputBytes: 8`
as `six.cjs` does would carry the handle in the reply and make it 9.
`createH264Configuration` (five args, cold path only) still runs through
`module.cjs`'s six-argument worker, so a configured decoder holds three worker
allocations (the module's six worker, the finite worker, and the module memory),
none freed until the session ends; a resync builds a fresh set.

### Original persistent worker design

The following records the original design. The implemented worker splits decode
and output fetch into separately gated frames. TCP mode adds a receive frame and
checks its byte count on the host before allowing decode to continue.

**Shape.** A repeating frame built through `repeating.cjs` `frame`/`prepare`
directly (so the program and its `verified` set stay reachable). Body:

```
WaitLightEvent(inputGate)
  -> [qualified exit stage]
  -> SendInputBufferForDecode        (index/len/PTS from control slots)
  -> WaitEvent(outputReady)
  -> AcquireOutputBufferIndex
  -> Buffer::SetDataAndCapacity      (destination pointer from a control slot)
  -> GetOutputBuffer
  -> ReleaseOutputBufferIndex
  -> publish results + copy submitted->completed sequence
  -> SignalLightEvent(done)
  -> restore / re-enter
```

All variable data flows through control slots the body loads dynamically
(`{u32}`/`{u64}`); the snapshot stays immutable (ABI part 8).

**Input index.** The host pre-acquires — the host-driven path's pipelined tail
`AcquireInput` already does exactly this — and writes the index into a control
slot before signalling the gate. An in-frame acquire that returned `-1` would
flow into `SendInput` and then park forever in `WaitEvent`; host validation is
the only place that branch can live.

**Output readiness.** Register a plain `nn::os::EventType` at `DecoderEvents+8`
through `RegisterClientEvents`, between `Configure` and `Start` — `configure()`
fuses the two today, so split it. The body waits with `WaitEvent`. Do not wait
on the lower-level VideoDecoder SystemEvent; the adapter's own thread consumes
it. Keep the 32-byte `DecoderEvents` struct and its event alive outside the
snapshot for the decoder's lifetime, with the other three pointers zero.

**Shutdown.** Two selectors. The loop-tail `longjmp` selector is unchanged. A
second selector gates a `longjmp({u64: resumeSelector})` placed immediately after
the gate; normally it points at a resume jmpbuf that re-enters the `SendInput`
stage (x21 = that stage's table, x25 = its x0, x30 = loadTable or the preamble
per the stage's arity, the wide x4/x5 handoff fields set, sp = that stage's `P`).
To stop, the host writes both selectors to the `exit` stop-frame, then
`SignalLightEvent(inputGate)` **and** `SignalEvent(outputReady)` (the worker may
be parked in either wait), tolerates whatever statuses the drained body returns,
and only then `wait` + `join`. Finalize events, finalize both LightEvents, `Stop`
and destroy strictly after the worker has exited and joined; a timed-out join
leaks the allocation and marks the worker unusable, exactly as finite/six do.

**Memory map** (module memory, all outside the 4 MiB repeating allocation and its
snapshot, results and selector regions):

| Offset | Field |
| --- | --- |
| `0x450` | AU-ready sequence (u64) |
| `0x458` | completed sequence (u64) |
| `0x460` | destination pointer (u64) |
| `0x468` | input index (i32) |
| `0x46c` | stop flag (u32) |
| `0x500` | input-gate LightEvent (16 B, auto-clear) |
| `0x510` | done LightEvent (16 B, auto-clear) |
| `0x540` | output-ready `EventType` (64 B) |
| `0x580` | `DecoderEvents` struct (32 B; +8 = `base+0x540`, rest zero) |

**Host per frame (≤4 exchanges).** Write the AU and control fields, then one
`writeAndCall` whose bundled call is `SignalLightEvent(inputGate)` — the combined
write is capped at 32 KiB, so an AU larger than that uploads its earlier 252 KiB
chunks first and signals only with the final bounded write. Collect with
`TryWaitLightEvent(done)`, then one control-block read. Budget: AU write (1) +
signal `writeAndCall` (1) + `TryWaitLightEvent` (1) + control read (1) = 4, plus
`ceil(len / 252 KiB) - 1` extra writes for an oversized AU.

**Open device questions (from the ABI answer, all blocking).** That the output
event fires and that a fired event implies a successful public acquire under the
stream settings; that one-AU-in / one-out does not deadlock on reordered or
delayed output (it may need an input-starvation / error / EOS / format-change
design, not just a timed wait); and GPU surface ownership before a destination is
overwritten.

Decoder calls stay strictly serial (one worker thread at a time, never reused or
freed while it may still run, fail-closed on timeout); `movie::Decoder`
thread-safety is unverified, so the gains come from fewer exchanges, not from
overlapping decoder calls. The remaining per-worker-call writes (the frame body)
and the output metadata read are the next targets and need on-device
verification before the frame layout is patched incrementally.

The native route uses 40 ms audio buffers with two queued on protocol 2, or
20 ms buffers with two queued on protocol 3. Those are queue targets, not
measured end-to-end latency. PCM writes and AudioOut append share one exchange
when supported by the host bridge. Audio statistics report dropped bytes,
overruns and underruns; video statistics report decoded/presented frames and
access units discarded while catching up.

Each run writes a source/build manifest and worker records below
`/media/storage2/builds/HBLauncher/native-h264/`. `HB_NATIVE_LOG_DIR` selects a
specific fresh output directory. The native route requires `--moonlight`;
`--screen` and `--input FILE` remain available through HBV1/HBV2.

## Live test (protocol 3)

The faster path assumes the protocol-3 bootstrap. Codex already pushed it to the
Flipper, so on the console load that bootstrap and start a **fresh** SmileBASIC
session (the re-typed loop negotiates protocol 3; an old session stays on 2).
Sunshine must be running on rig (192.168.8.245).

Run on rig from the repository root, substituting the live session directory
under `runs/`:

```sh
HBMOONLIGHT=/media/storage2/builds/HBLauncher/native-h264/20261024T152438Z-687a8f0/helper-build-final/hbmoonlight \
  node tools/moonlight/live.cjs runs/launcher-SESSION \
  --moonlight 192.168.8.245 Desktop --codec h264 \
  --size 1920x1080 --fps 30 --bitrate 8000
```

To rebuild the helper from the current source instead:

```sh
build=/media/storage2/builds/HBLauncher/moonlight-helper/$(date -u +%Y%m%dT%H%M%SZ)
bash tools/moonlight/helper/build.sh "$build"
HBMOONLIGHT="$build/hbmoonlight" node tools/moonlight/live.cjs runs/launcher-SESSION \
  --moonlight 192.168.8.245 Desktop --codec h264 --size 1920x1080 --fps 30 --bitrate 8000
```

Watch the per-second stats line (`{"codec":"h264",...}`): `decoded` and
`presented` should climb toward the requested fps, `dropped` should fall toward
0, and `resyncs` should stay 0. `IDR frame request sent` should now appear at
most about once a second, not several times. If audio under/overruns persist in
the `audio-stats` line, the link is still saturated: start with `--fps 30` and
`--bitrate 8000`, and try longer audio buffers before raising either.
`HB_PIPELINE` does not help the decoder: the bridge serializes every command
except raw write chunks, and the per-decoder calls are serialized again by the
module, so only the single AU write could overlap.

## Decoder-worker live-test plan

The live session is `runs/launcher-ItDehz` under `/media/storage/own/hbl-integration`
(protocol 3). Helper:
`/media/storage2/builds/HBLauncher/native-h264/20261024T152438Z-687a8f0/helper-build-final/hbmoonlight`.
Sunshine runs on rig (192.168.8.245). Run from the integration worktree root.

Test in this order; do not raise fps until the step before it is clean.

1. **Host-driven at `--fps 30`** (the default, shippable now):

   ```sh
   HBMOONLIGHT=/media/storage2/builds/HBLauncher/native-h264/20261024T152438Z-687a8f0/helper-build-final/hbmoonlight \
     node tools/moonlight/live.cjs runs/launcher-ItDehz \
     --moonlight 192.168.8.245 Desktop --codec h264 \
     --size 1920x1080 --fps 30 --bitrate 8000
   ```

2. Raise `--fps` to 60 only after the 30 fps run is stable. Leave out `--bitrate`
   to use Moonlight's default for the mode.

Watch the per-second stats line (`{"codec":"h264",...}`):

- `submitted` vs `decoded`: a steady gap of exactly 1 is the expected one-frame
  pipeline; a gap that grows every second means output is not draining.
- `decoded`/`presented` should climb toward the requested fps; `dropped` toward 0.
- `resyncs` stays 0. Each resync emits a `native-resync` record with `message`
  and `result`; `Decoder output queue returned 0x100e` arriving every frame means
  the one-frame latency is not being absorbed by `outstanding`.
- `native-error` with a `result` is a fatal decoder status; note the hex.

A **hung** worker shows as the finite worker's `Native job wait timed out;
allocation remains in use` (15 s) or, for persistent, the stop path's
`Repeating worker did not stop; resources retained` (5 s); after either, the
decoder's `failed` flag latches and every later call rejects — the stream ends
rather than reusing a thread that may still run. A **failed** worker surfaces as
a `movie::sendInput`/`getOutput`/`Decoder ... queue returned 0x...` error with a
`result` field.

Three facts must be confirmed on the host-driven path before the persistent
worker is built, because its branchless body assumes them and nothing offline can:

1. a `0x100e` (empty) `AcquireOutput` on frame N is followed by a successful
   acquire on N+1, at both 30 and 60 fps (the one-AU-in/one-out assumption);
2. `AcquireInput` never returns `-1` in steady state with the live input pool;
3. resync does not fire in a sustained run.
