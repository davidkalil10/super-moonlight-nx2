# hbl-moonlight

Moonlight for HBLauncher: stream PC games from Sunshine to the Switch 2. The console runs
the Moonlight HB package (`apps/moonlight/`), the PC runs the host side (`host/`,
`tools/moonlight/`): the `hbmoonlight` client, the stream senders and the console UI
service. Tests and simulators live in `tests/` ([Tests](#tests)); CLAUDE.md has the decisions,
measurements and research.

```
Sunshine (rig, 192.168.8.245)
   | RTSP/ENet/RTP, H.264 or HEVC + Opus
hbmoonlight (PC)                    pairing, app list, covers, quit, stream
   | --raw-h264-fd 4 | RGB24 stdout | PCM --audio-fd 3 | input on stdin
live.js / native-h264.js (PC)       ring writes over the bridge, or native TCP
   | 32 KiB (protocol 1/2) or up to 252 KiB (protocol 3) exchanges
apps/moonlight (console GPU)        compute picks/decodes, fragment draws
```

## Layout

- `apps/moonlight/`: the HB package (`manifest.json`, `assets/`, `backends/hblauncher.gpu-app/`,
  `build.js`); see [Package](#package).
- `host/stream/`: `live.js` (sender), `native-h264.js` (console decoder route), the
  staggered workers and `helper.js` (finds the `hbmoonlight` binary).
- `host/audio/`: `audio-stream.js` and the socket audio worker.
- `host/input/`: `input-feeder.js`, `controller.js`, `touch.js`.
- `host/ui/`: the console UI service (see Console UI service).
- `tools/moonlight/`: `ring.js`, the HBV formats, `feed.js`, `frames.js`, `reference.js` and
  `helper/` (`hbmoonlight`, C, GPLv3).
- `sdk/native/movie-functions.json`, `movie-event-functions.json`: the native symbols only
  Moonlight uses.
- `tests/`: tests, simulators and offline tools; nothing there ships to users.

It needs `hbl-platform` beside it (bridge, `sdk/host`, `sdk/native`, `sdk/build.js`; `tests/`
also uses its `tests/` mocks) and, for `tests/`, `HBLauncher`; the layout is in
[hbl-platform's README](../hbl-platform/README.md), Sibling checkouts. Launcher sessions
live in `hbl-platform/runs/launcher-*`; every tool takes a session directory as its first
argument and uses the newest one when it is omitted.

## Build

```sh
tools/moonlight/helper/build.sh [BUILD]   # hbmoonlight into BUILD/build/ (default ~/claude-builds/HBLauncher/moonlight-helper)
node apps/moonlight/build.js              # package shaders and memory image
node ../hbl-platform/sdk/build.js --check apps/moonlight  # check the package, write nothing
```

`build.js` needs glslc 2026.1 (Fedora 44) and `spirv-val`. It rewrites the package in place,
so it refuses any argument, and it refuses a glslc other than the 2026.1 build behind the
committed SPIR-V; both refusals write nothing. It always compiles through
`tools/moonlight/glslang-shim.sh`, which maps the platform's `glslangValidator -V ... SRC -o OUT`
call onto `glslc -Os --target-env=vulkan1.0`. `GLSLC` picks the glslc for both the version check
and the shim; a `GLSLANG` setting is ignored with a notice.

`build.sh` compiles natively when the -devel packages are present, otherwise inside a rootless
podman `quay.io/fedora/fedora:44` image (`helper/Containerfile`); rig and m5 run the same
Fedora 44 sonames, so the container binary runs on m5 as is. Native packages:

```sh
sudo dnf install gcc gcc-c++ cmake openssl-devel libcurl-devel expat-devel libuuid-devel \
  opus-devel libavcodec-free-devel libavutil-free-devel libswscale-free-devel
```

`fetch.sh` pins the GPLv3 upstreams, never copied into this repo: moonlight-embedded
(libgamestream: pairing, app list, launch; `discover.c` left out) at `f32e415`,
moonlight-common-c at `b126e481` (has `LiSendTouchEvent`) and its enet at `dea6fb5`. A
published `hbmoonlight` is GPLv3. The input test builds from `tests/` (`DEV_DIR` in
`helper/CMakeLists.txt`).
`host/stream/helper.js` finds the binary: `$HBMOONLIGHT`, else the default build path.

## Package

`apps/moonlight/` displays the frames the host writes into the app's private storage. The live
route is the helper's raw H.264, decoded through the console's native movie API into NV12
surfaces. The ring also takes HBV1 (`tools/moonlight/hbv.js`, fixed-size intra slots drawn
straight from the ring) and HBV2 (`tools/moonlight/hbv2.js`, inter-coded variable-rate slots
that the compute shader decodes into a persistent 1080p frame). Without a sender the app shows
the built-in HBV2 test card.

The app is an HB package (`manifest.json`, see the package spec in hbl-platform's README):
`assets/` holds the icon and text atlas and `backends/hblauncher.gpu-app/` the shaders
with their includes, the SPIR-V and the state and memory images. The compute and fragment
shaders read the frame ring, so the package has no portable entry and no `src/` yet.
`build.js` regenerates `hbv.glsl`, `hbv2-tables.glsl`, `ring.glsl`, `state.bin` and
`memory.bin` under `backends/hblauncher.gpu-app/`, and `assets.py` the text atlas and
`text.glsl`; do not edit those by hand. Private memory (`manifest.json` `memory.bytes`) is
laid out in [Private memory](#private-memory-binding-1); the two UI page buffers came with 1.1.0.

The console UI (`ui.glsl`, included by `app.comp` and `app.frag`) draws the pages the host
service publishes: text strips and images at the positions the host laid out, a cursor the
console moves by geometry on the frame of the press, and one forwarded command per press
(A/B/X/Y, left/right on an adjustable item, L+R held one second). A page replaces the video
unless it is an overlay, which shows over the dimmed stream while raised. Plus and Minus held
together still exit to HBLauncher from any screen.

`assets/icon.png` is the Moonlight logo: the 256x256 frame of `app/moonlight.ico` from
[moonlight-qt](https://github.com/moonlight-stream/moonlight-qt) at commit ac29686,
GPL-3.0 like the helper's upstreams, exported as RGBA PNG with Pillow and otherwise unchanged.

## Run

On the console, from a fresh SmileBASIC session (`./start.sh --app moonlight` in HBLauncher),
wait for the HBV2 test card. `live.js` refuses a session whose app private storage is smaller
than `ring.MEMORY_BYTES` (20,217,856): the console still runs an older package, so tap
Refresh in the launcher and relaunch. Hold Plus and Minus together for one second to return
to the launcher; single B and Minus presses reach the PC.

```sh
node host/stream/live.js [RUN_DIR] --moonlight 192.168.8.245 Desktop --codec h264 --fps 60
# console UI: the console picks the host and app
node host/ui/service.js [RUN_DIR]
```

### live.js flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--moonlight HOST APP` | | stream from Sunshine through `hbmoonlight`; APP is a name (case-insensitive) or an id from `list` |
| `--codec h264` | `h264` | the only route left: the console decoder |
| `--size WxH` | `1920x1080` | stream and frame size |
| `--fps N` | `60` | requested frame rate |
| `--bitrate KBPS\|auto` | `auto` | Moonlight's table: interpolated by pixels, linear in fps to 60, square root above; 500 to 150000 |
| `--no-input` / `--no-audio` | on | skip `input-feeder.js` / the audio path |

### h264 flags (`native-h264.js`)

| Flag | Default | Meaning |
| --- | --- | --- |
| `--staggered` | always | lag-2 input and output workers, one status read and one gate write per frame; the only route, so the flag is a no-op |
| `--present-hz 60\|120` | `60` | staggered: display refresh the pacer starts from |
| `--skip-backlog N\|off` | `2`, `1` with vsync | staggered: units queued before outputs go off screen |
| `--skip-rule backlog\|vsync` | `backlog` | staggered: skip by backlog, or keep one publication pending per vsync |
| `--decode-wait` | off | sleep to the predicted acquire (needs `--skip-rule vsync`) |
| `--trim-backlog-ms N` | off | staggered, backlog rule, `--skip-backlog` 1 or more: skip one output once the unit in hand is N ms old with a unit queued, at 3 gates in a row, at most once per 6 gates; counted as `trimmed`. Pick N above the default run's `au.gateAgeMs` plus a margin |
| `--gate-on-receive` | off | staggered, 60 Hz only: open decode N when unit N arrives instead of on N+1 |
| `--output-lag 1\|2` | `2` | staggered: fetch each output 1 or 2 gates after its decode |
| `--receive-wait` | off | sleep to the predicted receive |
| `--avoid-window B-A` | off | keep status reads out of B ms before to A ms after a predicted event (needs a wait flag) |
| `--queue N` | `8` | host access-unit queue, 1 to 16 |
| `--input-hz N` | `60` | input feeder rate, 10 to 120 |
| `--audio-frames N` | `960` on protocol 3, else `1920` | AudioOut buffer, multiple of 240 (up to 3840 with socket audio) |
| `--socket-audio` / `--socket-audio-tone` | off | PCM, or a 500 Hz tone, over native TCP to a console audio worker |
| `--duration S` / `--warmup S` | none / `3` | run length; rows skipped before scoring |
| `--expect fps=30,dropped=0,idr=0,trimmed=0` | dropped and IDR fail | limits for the PASS/FAIL verdict |

The native route needs `--moonlight` and a launcher session from the current revision (the
session records the host address for the TCP connection). Each run writes a source/build
manifest, `events.jsonl`, the stats rows and `summary.json` under
`/media/storage2/builds/HBLauncher/native-h264/` (`HB_BUILDS` moves the root,
`HB_NATIVE_LOG_DIR` picks the directory). Per-second rows (`{"codec":"h264",...}`):
`decoded` and `presented` climb toward the requested fps, `dropped` falls to 0, `resyncs` stays
0, `idr` counts keyframe requests (at most one per second). A `native-resync` record carries
`message` and `result`; `native-error` is a fatal decoder status. A hung worker shows as
`Native job wait timed out; allocation remains in use` or `Repeating worker did not stop;
resources retained`; the decoder then latches failed and the stream ends rather than reuse a
thread that may still run. `HB_PIPELINE` does not help the decoder: the bridge serializes every
command except raw write chunks.

## hbmoonlight

Status and errors are one JSON object per line on stderr.

| Command | Output |
| --- | --- |
| `pair HOST [--timeout 120]` | `{"event":"pin","pin":"NNNN","url":...}`, then `{"event":"paired"}` once the PIN is entered in Sunshine's web UI |
| `list HOST [--covers DIR]` | `{"currentGame":N,"apps":[{"id":..,"name":..}]}`; with `--covers`, box art from `/appasset` |
| `quit HOST` | quits the running app (`/cancel`) |
| `stream HOST APP [--size 1920x1080] [--fps 60] [--bitrate 20000] [--codec h264\|hevc] [--software] [--audio-fd FD] [--quit]` | raw RGB24 frames of exactly WxH on stdout |
| `stream ... --raw-h264-fd FD \| --raw-hevc-fd FD [--rgb]` | every access unit in order as Annex B on FD; no RGB unless `--rgb` |

- Keys and the unique id live in `$XDG_CONFIG_HOME/hblauncher/moonlight` (mode 0700). Never
  commit them.
- Video: libavcodec with VAAPI first (`--software` forces CPU), `sws_scale` to RGB24. Three
  buffers rotate between decoder, a one-frame mailbox and a writer thread; a frame still pending
  when the next one decodes is dropped and counted. Sunshine is asked for 4 slices per frame.
- Raw mode pins Sunshine to the codec. Each IDR starts with SPS/PPS (VPS for HEVC). Writes
  block, nothing is dropped, and each unit is announced on stderr as
  `{"type":"au","seq":N,"frame":N,"bytes":N,"keyframe":bool,"pts":us}`.
- Input: stdin JSON lines (below) and `request-idr` for a keyframe.
- Audio: Opus decoded to 48 kHz stereo s16le on `--audio-fd`, non-blocking; packets the reader
  cannot take are dropped (`audioDropped`).
- Stop: SIGINT/SIGTERM or stdin EOF, then `LiStopConnection`; `--quit` also quits the host app.
  A `stats` line each second reports decoded, written, dropped, failed and decode+convert ms.
- Covers: only a real PNG of at most 4 MiB and 4096 px a side, fetched under a 5 s alarm.

## Private memory (binding 1)

`tools/moonlight/ring.js` is the source of truth; `build.js` generates `ring.glsl` from it.

```
control 0x000000  64 KiB: shader words, native publication, written[8160] at 0x400 (ends 0x8380),
                  UI block at 0xC000
ring    0x010000  8 slots x 294,912 (9 exchanges); the host writes slot sequence % 8
frames  0x250000  3 x 3,133,440 (1920x1088 NV12 / 4:2:0); HBV2 uses the first two
spare   0xb47000  4 KiB
ui      0xb48000  2 x 4 MiB page buffers        MEMORY_BYTES 20,217,856
```

Control words (`ring.CONTROL`): `applied` 0, `applyCount` 4, `mode` 8 (0 none, 1 hbv1,
2 hbv2, 3 native), `current` 12, `size` 16, `hbv1Slot` 20, `nativeReady` 24, `nativeApplied` 32,
`currentStride/SliceHeight/Color` 64..72. The host's native publication starts at byte 256
(`nativeSequence`, index, width, height, stride, slice height, color, commit at 284), so GPU
words (first 128 bytes) and host words never share a cache line. `NATIVE_ABI` `0x484e5633`
rejects older shaders. The staggered workers stamp status groups at 0x200 (receive), 0x220
(input), 0x260 (acquire) and 0x2a0 (fetch); one read from `current` (12) to 0x2bc returns all
of them.

### HBV1 and HBV2 slots

- HBV1 (`hbv.js`, magic `0x31564248`): 16x16 macroblocks of exactly 9 words (four 8x8 luma DCT
  blocks of 56 bits, Cb and Cr of 32 bits, 1.125 bpp), header magic, sequence, size, payload
  bytes. Fixed rate, intra only; the fragment shader decodes per pixel.
- HBV2 (`hbv2.js`, magic `0x32564248`): 8-word header (magic, sequence, `w | h<<16`, payload
  bytes, reference sequence or 0 for a keyframe, `qp | chromaQp<<8`, chunk count, 0), a chunk
  list (index in the low 11 bits, bit offset above) and one LSB-first bitstream. A chunk is 8
  macroblocks; unchanged chunks are omitted. Per macroblock `1` skip, `00` inter (MV, 6-bit
  cbp, residual) or `01` DC-predicted intra, with an integer IDCT shared by JS, C and GLSL. At
  most 8 exchanges (256 KiB).
- Both repeat the sequence in the last word of the last exchange used; a mismatch is a torn
  slot and is ignored.
- Decoder rules: a P frame is eligible only when its reference equals `applied`, the mode is
  HBV2 and the size matches; keyframes and HBV1 always are. Pick the newest eligible
  independent slot if it is newer than the oldest eligible P frame, else that P frame. Up to 3
  slots apply per dispatch, into `current ^ 1`. Skips copy from the reference only when their
  chunk is not coded. The compute workgroup is 512 invocations (`ring.LOCAL_SIZE`).

### Console UI block (0xC000, one u32 each)

| Offset | Word | Owner | Meaning |
| --- | --- | --- | --- |
| +0 | `uiMagic` | host | `0x49554248` ('HBUI') once attached; 0 shows the static splash |
| +4 | `uiEpoch` | host | nonzero service epoch (start time in s); a new one resets `uiApplied`, cursor and overlay |
| +8 | `uiSequence` | host | newest published page, nonzero, +1 per publish, written last |
| +12 | `uiPage` | host | page buffer (0/1) holding `uiSequence` |
| +16 | `uiApplied` | compute | sequence the shader validated and draws; 0 none |
| +20 | `uiCursor` | compute | index into the applied page's items |
| +24 | `uiOverlay` | compute | 1 while the overlay is raised over video (L+R hold); game input stops |
| +28 | `uiTouchItem` | compute | last item a tap selected |
| +32 | `cmdSequence` | compute | nonzero, +1 per command, wraps past 0 |
| +36 | `cmdOp` | compute | 1 A, 2 B, 3 X, 4 Y, 5 ADJUST, 6 CHORD (L+R held 60 frames) |
| +40 | `cmdItem` | compute | cursor item `id` for A/X/Y/ADJUST; 0 for B and CHORD |
| +44 | `cmdValue` | compute | ADJUST: 1 right, 0xffffffff left; else 0 |
| +48 | `cmdPage` | compute | `uiApplied` at the press |
| +52 | `cmdEpoch` | compute | `uiEpoch` at the press |
| +56 | `uiShown` | compute | buffer the shader draws from; the host does not read it |
| +64 | `hostAck` | host | last `cmdSequence` taken; the cursor pulses while it differs |
| +68 | `hostBusy` | host | nonzero during a helper call; the shader draws a spinner |

The shader is the only console writer of +16..+63 and never writes host words; the host reads
+16..+55 in one 40-byte read and writes +0..+15 and +64..+71. The shader writes
`cmdItem`/`cmdValue`/`cmdPage`/`cmdEpoch`, then `cmdOp`, then `cmdSequence`, with a barrier
between; the host takes a command only when its epoch and page are current. One press makes
one command; the host's state machine gives it meaning.

### Page format (`UI_OFFSET + page * 4 MiB`, `host/ui/page.js`)

| Offset | Content |
| --- | --- |
| 0x000 | header, 16 u32: magic `0x47504248` ('HBPG'), epoch, sequence, flags, itemCount <= 32, textCount <= 48, imageCount <= 24, bodyBytes <= 4 MiB - 0x1000, background RGBA8, cursorHome, checksum, 5 zero |
| 0x040 | items, 32 x 8 u32: `id` (nonzero), x, y, w, h, flags, 2 zero |
| 0x440 | texts, 48 x 8 u32: x, y, w, h, body offset, color RGBA8, 2 zero |
| 0xA40 | images, 24 x 8 u32: x, y, w, h, body offset, format (1 RGBA8), 2 zero |
| 0x1000 | body: alpha-8 strips (4-aligned, w <= 1920, h <= 96) and RGBA8 images (w <= 320, h <= 180) |

Page flags: bit0 overlay (drawn over video only while `uiOverlay` is 1; otherwise the page
replaces the video whenever no native or HBV frame is current), bit1 hide cursor. Item flags:
bit0 greyed, bit1 current (running app), bit2 adjustable (left/right send ADJUST), bit3 pending
(pulse even after the ack). `checksum` is FNV-1a (basis 2166136261, prime 16777619) over header
words 0..9 and the three tables. The cursor moves by geometry to the nearest non-greyed item in
the pressed direction, no wrap, and stays on the same `id` across pages, else `cursorHome`. A
tap inside an item moves the cursor there and sends A.

The host writes body, tables, then header into the buffer not shown, then `uiSequence` and
`uiPage`. The shader checks magic, epoch, sequence, counts, every rect inside 1920x1080 with its
bytes inside `bodyBytes`, and the checksum before it sets `uiApplied`. The host publishes the
next page only after `uiApplied` reached the last one, so the free buffer is always the unshown
one.

## Console UI service

`node host/ui/service.js [RUN_DIR]` is the PC half of the console UI (`RUN_DIR`
from the `SESSION READY` line, else the newest). The console draws the pages the service
publishes and sends back commands; the host owns every screen.

- `model.js`: pure state machine; `reduce(model, event)` returns the next model and intents.
  Item ids per screen are in `ITEM`.
- `hosts.js`: the host list in `hosts.json` (`$XDG_CONFIG_HOME/hblauncher/moonlight/`) and the
  helper's app list.
- `settings.js`: the settings catalog (size, fps, bitrate, codec, audio, present rate),
  `settings.json` beside `hosts.json`, and `streamArgs` for `live.js`.
- `pages.js`: one layout per screen; strips and tiles are cached by text and size.
- `raster.js` + `text.py`: a long-lived PIL child painting strips, cover tiles and letter tiles,
  in Sora from `fonts/`.
- `page.js`: page serializer, validator and parser, the mirror of the shader.
- `discover.js`: mDNS for `_nvstream._tcp.local`, the answer parser, merging into the host list.
- `service.js`: attach, publish, command poll, children (helper `list`/`pair`/`quit`,
  `live.js`), exit.

- Attach writes magic 0, reads the stale `uiApplied` and seeds the next sequence after it.
  Commands written before attach are not replayed. A page is republished only when its bytes
  change, so raising or hiding the overlay costs no sequence and keeps the cursor.
- Every taken command is acked in `hostAck`; one for another epoch or page is logged as
  `command-dropped`. `hostBusy` is 1 around helper calls; a helper is killed after 20 s. A page
  not applied in 5 s is logged with its header.
- While streaming only the overlay page is published. `input-feeder.js` reads `uiOverlay` every
  100 ms and releases held input the frame it goes up; no signal comes from the service.
- Return to apps stops `live.js` (SIGINT, SIGKILL after 10 s) and relists. Quit host app stops
  the stream, runs `hbmoonlight quit` and relists; the result is the app grid subtitle ("Quit
  confirmed" or "Quit failed: ...").
- Covers come from `list --covers`, cached under `$XDG_CACHE_HOME/hblauncher/moonlight/covers`;
  a missing cover never fails the list, the app draws a letter tile.
- Hosts: `hosts.json` is the manual list (default Sunshine at 192.168.8.245). At attach and on Y
  the service queries mDNS for 1.5 s and appends unknown hosts, saved through a rename; manual
  entries are never changed and nothing is removed for missing a scan.
- It exits when `app-runtime.json` names another active app, or on SIGINT/SIGTERM, writing
  magic 0 last so the console shows the splash.

Each run writes `/media/storage2/builds/HBLauncher/ui-service/<timestamp>-<session>/`
(`HBL_UI_RUNS` moves it) with `manifest.json` and `events.jsonl`: `attach`, `published`,
`header-rewrite`, `apply-timeout`, `command`, `command-dropped`, `helper` (a failure carries the
helper's error line and `stage`), `stream-event`, `stream-exit`, `quit`, `app-gone`, `detach`.

## Input and audio

`input-feeder.js [RUN_DIR] [--hz 60]` reads the pad (bytes 0..40) and touch (128..784) of the
mapped state in one 784-byte read per frame and writes compact JSON lines for the helper's stdin:

```
{"type":"controller","connected":true,"buttonFlags":4096,"leftTrigger":0,...}
{"type":"touch","events":[{"id":1,"action":"down","x":0.5,"y":0.5,"pressure":0}]}
```

An untyped line is a controller line. The helper parses keys by substring, so lines carry no
whitespace. Controller fields go to `LiSendMultiControllerEvent` as gamepad 0 (an Xbox pad with
analog triggers; missing fields keep their value). Touch is a verbatim
`nn::hid::TouchScreenState<16>` (count at word 2, entry i at word 4 + i*10: attributes, fingerId,
x, y); the panel reports 1280x720, normalized to 0..1 and rounded to 4 decimals. `fingerId` is
the pointer id: new id down, moved id move, End bit or absent id up; pressure 0 (unknown), no
hover; every live id gets an up on exit. The helper checks `LI_FF_PEN_TOUCH_EVENTS` on the first
touch line, prints `{"event":"touch","supported":bool}` and stops sending touch, without a mouse
fallback, when unsupported.

`audio-stream.js [RUN_DIR] [--fd N | --file PATH] [--buffer-frames 3840] [--queue 3] [--prime 2]
[--stats]` plays helper PCM (stdin by default) on the console AudioOut: 8 descriptors at
`base+0x400+i*0x40`, 8 PCM slots of 0x4000 at `base+0x10000`; a buffer is one write, with its
append in the same exchange when the rpc supports it. It primes `prime` buffers, starts, and
keeps at most `queue` in flight; added latency is about queue x buffer + one exchange (3 x 80 ms
by default). Releases are predicted on a host playhead, so the release poll stays near one call
per buffer. Pending input beyond (queue + 2) buffers drops the oldest whole buffers (`overruns`,
`droppedBytes`); a starved queue counts `underruns` and resumes; an EOF tail is padded with
silence. On exit it writes `moonlight-audio-<ts>.json` into the session. The h264 route runs it
with `--queue 2 --prime 2` and 960-frame (20 ms) buffers on protocol 3, 1920 (40 ms) otherwise.

## Tests

`tests/` holds the tests, simulators and offline tools. They import the runtime one level up, so
a worktree tests its own code. From `tests/`:

```sh
npm install                        # once: TypeScript and @types/node
npm test                           # node --test over every tracked *.test.cjs
npm run typecheck                  # tsc --checkJs over the modules listed in tsconfig.json
node apps/moonlight/check.cjs [CLIP]
```

`check.cjs` renders the real Moonlight shaders on desktop Vulkan through
`tools/moonlight/gpu-check.c` (compute and draw per frame, like the launcher): exit handling,
the waiting screen, the HBV2 test card, an HBV1 slot, and an HBV2 P chain with a torn slot, a
stray reference and a catch-up dispatch, all bit-exact against the JS decoder. With CLIP it
also streams the clip through the native encoder. It builds under
`$HB_MOONLIGHT_CHECK_BUILDS` (default `~/claude-builds/HBLauncher/gpu-check`) and needs a GPU,
`cc`, the Vulkan headers, `glslangValidator` and `spirv-val`. A test clip:

```sh
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=60 -t 3 -pix_fmt yuv420p -c:v libx264 -crf 12 testsrc2.mp4
```

GPU and PIL tests skip with the reason when their tools are missing. `tests/sdk/desktop-vulkan/`
is HB package backend two (offscreen Vulkan); [its README](tests/sdk/desktop-vulkan/README.md)
is read by `desktop-vulkan.test.cjs`.

### Tools

- `tests/tools/moonlight/request-budget.cjs`: offline request budget for the staggered native
  H.264 host loop, a virtual-clock model of its gate cycle.
- `tests/tools/moonlight/encode.cjs CLIP OUT.hbv [--size 640x352] [--frames N]`: the HBV1 slot
  stream the host would write; `tools/moonlight/feed.js` replays it into a live ring.
- `tests/tools/moonlight/desktop-scenes.py SCENE FRAMES OUT`: synthetic 1920x1080 desktop
  sequences (typing, scroll, drag, pan) as raw RGB24.
- `tests/tools/moonlight/controller-watch.cjs [RUN_DIR] [--hz 60] [--labels] [--sources]`:
  prints the console controller as Moonlight gamepad state.
- `tests/tools/moonlight/helper/tests/input.c`: the helper input-routing test, built by the
  helper CMake project (`tools/moonlight/helper/`).

### Fake console

`tests/tools/moonlight/fake-console` stands in for a running Moonlight app, so `feed.js` can be
developed without a console. `shared/rpc.cjs` simulates the bridge: one serial link of 32 KiB
exchanges whose concurrent writes interleave at random, and a 60 Hz dispatch that runs the JS
HBV2 decoder over the ring and writes back `applied`. From the repo root:

```sh
# HBV1 slots of a clip, fed on the measured 5.7 MB/s link
node tests/tools/moonlight/encode.cjs clip.mp4 clip.hbv --size 1920x1088
node tools/moonlight/feed.js tests/tools/moonlight/fake-console clip.hbv
# a 1.5 s stall at t=4 s
STALL=1500@4000 node tools/moonlight/feed.js tests/tools/moonlight/fake-console clip.hbv
```

Env: `RATE` (link bytes/s, default 5.7e6), `STALL=ms@at` (pause the dispatch once), `DECODE=1`
(full pixel decode instead of the light apply).

`bridge.cjs DIR [--pad]` serves the same fake console through the real
`hbl-platform/smilebasic/engine/lib/bridge.js` and writes a run directory, so `live.js` or
`input-feeder.js` pay the same HTTP, JSON and base64 costs as on a
console. It also simulates the sound-memory allocation and an AudioOut that plays appended
buffers in real time (underruns counted); `--pad` cycles a scripted controller and touch state
every 500 ms. `HB_PIPELINE` works as on the launcher.

```sh
HB_PIPELINE=2 RATE=12e6 node tests/tools/moonlight/fake-console/bridge.cjs /tmp/fake --pad &
node host/input/input-feeder.js /tmp/fake
```

`shared/console.cjs` is a separate byte-level model of the `bootstrap.bas` `RPC()` loop for
protocols 1, 2 and 3 (header and data recv, response framing, memmove/read/QueryMemory) over a
flat memory buffer; `formats.test.cjs` round-trips the real `native.js` through it.

### Live test pass

Only with the user at the console (`DEVICE-RULES.md` in hbl-notes). From `hbl-moonlight`,
against a fresh `./start.sh --app moonlight` session showing the HBV2 test card, in order:

1. Video: `node host/stream/live.js --moonlight 192.168.8.245 Desktop --codec h264 --staggered --no-input --no-audio`
   (the h264 flags are above).
2. Input: drop `--no-input`. Sticks and taps move the host cursor; touch is native multi-touch.
3. Audio: drop `--no-audio`. If `OpenDefaultAudioOut` fails, the audio process prints a hint
   and exits while video and input keep running.
4. A real game from `hbmoonlight list 192.168.8.245` in place of `Desktop`.

### Protocol 3 write test

The A/B for the open Protocol 3 question in CLAUDE.md. Start two sessions with
`HB_WRITE_CHUNK=32768 ./start.sh` and `HB_WRITE_CHUNK=258048 ./start.sh` in HBLauncher
(the latter is the protocol 3 default). In each, the gap in
`hbl-platform/runs/<session>/launcher-auto-operations.jsonl` between `vkMapMemory2` and the next
`vkCreateBuffer` is the launcher's startup write (8 MiB of zeros, the state, the text atlas and
the catalog raster: 14,681,088 bytes in the 2026-10-24 sessions); divide to get MB/s. Capture a
protocol 2 session too if small exchanges dominate the workload.
