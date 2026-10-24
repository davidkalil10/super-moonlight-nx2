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

The protocol-2 live test presented roughly 1–2 frames/s and dropped audio
buffers under the combined RPC load. This is an experimental implementation;
it has not demonstrated a playable frame rate or synchronized A/V playback.
The host still performs multiple native calls per frame, including short-lived
workers for calls with five or six arguments. Batching those calls on the
console is the next performance step. Protocol 3 reduces request padding and
allows larger compressed uploads; it requires replacing saved NS2 and a fresh
connection, as described in [PROTOCOL3.md](PROTOCOL3.md).

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
