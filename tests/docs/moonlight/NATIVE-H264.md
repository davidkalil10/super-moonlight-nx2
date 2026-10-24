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

The host publishes dimensions, stride, slice height, color space and a sequence
number. The compute shader acknowledges the sequence after selecting that
surface; the fragment shader samples NV12 with limited-range BT.709 conversion
and aspect-ratio borders. Host request fields start at byte 256 and GPU-written
fields occupy the first 128 bytes, avoiding writes by both processors to the
same cache line. ABI marker `0x484e5632` rejects older shaders.

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

## Per-frame call budget

The console loop, not the link, is the ceiling (~412 exchanges/s on the best
recorded wired session), so the frame rate tracks exchanges per frame. The
steady-state `submit`+`receive` budget is measured by
`tools/moonlight/native-decoder.test.cjs`, which drives the real client, module
and worker against an in-process console and counts every wire exchange.

| Step | Before (ec56ec2) | After |
| --- | --- | --- |
| `submit`: acquireInput + AU write + sendInput worker | 2 + 1 + 8 = 11 | 1 + 1 + 6 = 8 |
| `receive`: acquireOutput worker + metadata + bufferSetData + getOutput + release | 8 + 1 + 1 + 1 + 1 = 12 | 6 + 1 + 1 + 1 + 1 = 10 |
| **submit + receive (mock-measured)** | **23** | **18** |
| redundant empty `receive` poll | ~9 | 0 |
| presentation (wait + query + two writes + explicit wait) | 5 | 3 |
| **per frame, incl. presentation** | **~37** | **~21** |

What changed:

- `acquireInput` points its out-pointers at the RPC output region, so the index
  comes back in the reply (one fewer read).
- The six-argument worker returns the pthread handle and exit value in the
  create/join replies (two fewer reads per worker call), and flushes its record
  file at most once a second instead of on every status change.
- `receive` is pulled once per submitted unit, draining extra only for genuine
  backlog, so a decoder with up to one frame of pipeline latency never pays for a
  known-empty `acquireOutput`. The budget above assumes that ≤1-frame latency.
- The explicit presentation wait is gone: the next `destination()` already waits
  for the GPU to apply the previous frame, so submit of N+1 is not blocked on it.
- The frame destination query is cached per surface and re-verified once a
  second rather than on every frame.

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
