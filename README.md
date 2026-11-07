# moonlight-nx2

Moonlight for the Switch 2: stream PC games from Sunshine to the console. It runs inside the
CivSwitch loader (Civ7): `src/streamer/civ7/` is the console backend, packaged with the host
helper as one payload by `src/streamer/payload/`. The console decodes H.264 with its movie
decoder and AV1 with the lower decoder service, and draws through the Civ7 renderer
(`src/renderer/civ7/`). The PC keeps `hbmoonlight` and the Sunshine session. CLAUDE.md
has the decisions, measurements and research.

```
Sunshine (rig, 192.168.8.245)
   | RTSP/ENet/RTP, AV1 or H.264 + Opus
hbmoonlight (PC)          pairing, app list, quit, stream: raw units on --raw-fd 4, PCM on 3
serve.js (PC, TCP 39380)  relays units over UDP or TCP, PCM, and the console's input records
moonlight.js (console)    UI, settings, decode, present, AudioOut, input sampling
```

## Layout

- `src/renderer/civ7/`: the console renderer: GLSL sources, `build.js` and the committed
  `prebuilt/` SPIR-V the bundle ships; see [Renderer](#renderer).
- `src/streamer/civ7/`: the console backend (src/streamer/civ7/README.md).
- `src/streamer/payload/`: the bundle builder, `launch.js` and the helper `serve.js`
  (src/streamer/payload/README.md).
- `src/streamer/protocol/`: `hbmoonlight`, the Moonlight protocol client (C, GPLv3).
- `src/streamer/session/`: `h264-stream.js`, `h264-sps.js` and `av1-stream.js` (the helper's
  access-unit pipe), `native-decoder.js` (`movie::Decoder`), `bitrate.js`, and
  `protocol-binary.js`, which pins the `hbmoonlight` binary.
- `src/streamer/input/`: `controller.js`, `touch.js`, `input-record.js`.
- `src/streamer/ui/`: the console UI's PC half (see Console UI).
- `src/streamer/shared/ring.js`: the private memory layout; `test-support/`: shared test code.
- `src/streamer/console-api/`: the native symbol tables the backend and probes verify.
- `src/streamer/loopback/flip-window.py`: the patch flipper for the latency film.

## Running

Build a bundle with `src/streamer/payload/build.js` (src/streamer/payload/README.md), then,
with the CivSwitch loader listening on TCP 9026:

```sh
node bundle/launch.mjs CONSOLE_IP   # starts serve.mjs in the background, sends moonlight.js
```

Everything after that happens on the Switch: host, app and settings in the Moonlight UI.
L+R+Minus+Plus stops the stream; SIGINT on the helper stops it in order, a second signal
exits at once. Bitrate defaults to Auto (`bitrate.js` from size and fps). Steady 1080p60 is
measured; 120 fps and end-to-end latency are open.

## Build

```sh
src/streamer/protocol/build.sh [BUILD]   # hbmoonlight into BUILD/build/ (default /media/storage2/builds/moonlight/helper)
node src/renderer/civ7/build.js --directory BUILD --install   # renderer SPIR-V into prebuilt/
```

The renderer build needs glslc and `spirv-val` (src/renderer/civ7/README.md); a bundle build
needs neither, as it ships `prebuilt/`.

`build.sh` compiles natively when the -devel packages are present, otherwise inside a rootless
podman `quay.io/fedora/fedora:44` image (`src/streamer/protocol/Containerfile`). Native
packages:

```sh
sudo dnf install gcc gcc-c++ cmake openssl-devel libcurl-devel expat-devel libuuid-devel opus-devel
```

`fetch.sh` pins the GPLv3 upstreams, never copied into this repo: moonlight-embedded
(libgamestream: pairing, app list, launch; `discover.c` left out) at `f32e415`,
moonlight-common-c at `b126e481` (has `LiSendTouchEvent`) and its enet at `dea6fb5`. A
published `hbmoonlight` is GPLv3. The C tests build from `test/` (`DEV_DIR` in
`CMakeLists.txt`).
`src/streamer/session/protocol-binary.js` finds the binary: `$HBMOONLIGHT`, else the pinned build.

## Renderer

`src/renderer/civ7/` displays the NV12 frames the console decodes into the app's private
storage, and the UI pages the PC paints, with per-slot command buffers recorded once at
startup. `bundle.js` loads `prebuilt/` and packs the asset blob (`payload/asset-blob.js`) that
console startup uploads; src/renderer/civ7/README.md has the design.

### AV1 and UDP

Defaults since settings version 4: Codec AV1, Transport UDP (an older save moves to them once;
H.264 and TCP stay selectable in Settings). AV1 decodes through the console's lower decoder
service rather than the public movie API (`src/streamer/civ7/README.md`, "AV1"), at 720p60 or
1080p60, into the same NV12 present path; Auto bitrate is 0.7x H.264's. The pinned helper
(`20261107T200357Z-19b4f09-helper`) streams AV1 and is `build.js`'s `--helper`
default, and `--transport` defaults to `udp`:

```sh
node src/streamer/payload/build.js --directory BUNDLE_DIR --host 192.168.8.245 \
  --inspector PREVIOUS_BUNDLE/bin/nx2-modules
```

A start that fails on AV1 (Sunshine refuses it, the open fails, or AV1 is refused after a
failed cleanup until the console app restarts) runs on H.264 with the badge "AV1 ▸ H.264"; a
UDP start that gets no hello or fails to receive before the first unit runs on TCP with
"UDP ▸ TCP" (`src/streamer/civ7/README.md`, "Fallbacks").

## hbmoonlight

Status and errors are one JSON object per line on stderr.

| Command                                                                                                   | Output                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pair HOST [--timeout 120]`                                                                               | `{"event":"pin","pin":"NNNN","url":...}`, then `{"event":"paired"}` once the PIN is entered in Sunshine's web UI |
| `list HOST [--covers DIR]`                                                                                | `{"currentGame":N,"uniqueid":..,"apps":[{"id":..,"name":..}]}`; with `--covers`, box art from `/appasset`        |
| `quit HOST`                                                                                               | quits the running app (`/cancel`)                                                                                |
| `unpair HOST`                                                                                             | `{"event":"unpaired","already":bool}`; the PC forgets this client                                               |
| `stream HOST APP --raw-fd FD [--codec h264\|hevc\|av1] [--size 1920x1080] [--fps 60] [--bitrate 20000] [--audio-fd FD] [--quit] [--sops] [--local-audio]` | every access unit unchanged on FD                                                                      |

- Keys and the unique id live in `$XDG_CONFIG_HOME/moonlight-nx2` (mode 0700); while that is
  missing, an existing `hblauncher/moonlight` is used. Never commit them.
- `--codec` (default `h264`) is the only format offered; a negotiated fallback to another codec
  is refused. AV1 selects Main8. Raw AV1 carries OBUs, H.264/HEVC carry Annex B, and each IDR
  starts with its parameter sets. Writes block, nothing is dropped, and each unit is announced
  on stderr as `{"type":"au","seq":N,"frame":N,"bytes":N,"keyframe":bool,"pts":us}`. Sunshine
  is asked for 4 slices per frame.
- `--sops` lets Sunshine change the PC display to the stream shape; `--local-audio` keeps
  the sound playing on the PC as well.
- Input: stdin JSON lines (controller, touch) and `request-idr` for a keyframe.
- Audio: Opus decoded to 48 kHz stereo s16le on `--audio-fd`, non-blocking; packets the reader
  cannot take are dropped (`audioDropped`).
- Stop: SIGINT/SIGTERM or stdin EOF, then `LiStopConnection`; `--quit` also quits the host app.
  A `stats` line each second reports units written, failed units and `audioDropped`.
- Covers: only a real PNG of at most 4 MiB and 4096 px a side, fetched under a 5 s alarm.
- Options are read only after HOST (and APP for `stream`). A numeric option without a value,
  not a number or out of range (`--timeout` 1..600, `--fps` 1..240, `--bitrate` 1..1000000)
  exits 2 with a `bad option value` error.
- Timeouts: connect 15 s; `list` app list and host uniqueid 15 s, then covers start only within
  10 s, each under 5 s; `unpair` 15 s; `quit` `/cancel` 30 s plus a reconnect; `pair` waits
  `--timeout` for the PIN. The UI service kills a helper 5 s after that worst case
  (`HELPER_TIMEOUT_MS` in `src/streamer/ui/service.js`: list 50 s, unpair 35 s, quit 65 s,
  pair 140 s).

## Private memory (binding 1)

`src/streamer/shared/ring.js` is the source of truth; `src/renderer/civ7/layout.js` reads it.

```
control 0x000000  64 KiB: shader words, native publication, written[8160] at 0x400 (ends 0x8380),
                  UI block at 0xC000
ring    0x010000  8 x 294,912, unused since the HBV formats went; kept so the offsets hold
frames  0x250000  3 x 12,533,760 (3840x2176 NV12 / 4:2:0); frames 0 and 1, badge pixels in 2
spare   0x262b000 4 KiB
ui      0x262c000 2 x 4 MiB page buffers        MEMORY_BYTES 48,418,816
```

Every frame area fits a 2160p frame, so a 1080p or 1440p stream uses the start of its area and
the slot words carry the real size. The storage buffer is one Vulkan allocation; `pipelines.js`
caps those at 64 MiB.

Control words (`ring.CONTROL`): `applied` 0, `applyCount` 4, `mode` 8 (0 none, 3 native),
`current` 12, `size` 16, `nativeReady` 24, `nativeApplied` 32,
`currentStride/SliceHeight/Color` 64..72. The host's native publication starts at byte 256
(`nativeSequence`, index, width, height, stride, slice height, color, commit at 284), so GPU
words (first 128 bytes) and host words never share a cache line. `NATIVE_ABI` `0x484e5633`
rejects older shaders.

### Console UI block (0xC000, one u32 each)

| Offset | Word          | Owner   | Meaning                                                                                   |
| ------ | ------------- | ------- | ----------------------------------------------------------------------------------------- |
| +0     | `uiMagic`     | host    | `0x49554248` ('HBUI') once attached; 0 shows the static splash                            |
| +4     | `uiEpoch`     | host    | nonzero service epoch (start time in s); a new one resets `uiApplied`, cursor and overlay |
| +8     | `uiSequence`  | host    | newest published page, nonzero, +1 per publish, written last                              |
| +12    | `uiPage`      | host    | page buffer (0/1) holding `uiSequence`                                                    |
| +16    | `uiApplied`   | compute | sequence the shader validated and draws; 0 none                                           |
| +20    | `uiCursor`    | compute | index into the applied page's items                                                       |
| +24    | `uiOverlay`   | compute | 1 while the overlay is raised over video (L+R hold); game input stops                     |
| +28    | `uiTouchItem` | compute | last item a tap selected                                                                  |
| +32    | `cmdSequence` | compute | nonzero, +1 per command, wraps past 0                                                     |
| +36    | `cmdOp`       | compute | 1 A, 2 B, 3 X, 4 Y, 5 ADJUST, 6 CHORD (L+R held 60 frames)                                |
| +40    | `cmdItem`     | compute | cursor item `id` for A/X/Y/ADJUST; 0 for B and CHORD                                      |
| +44    | `cmdValue`    | compute | ADJUST: 1 right, 0xffffffff left; else 0                                                  |
| +48    | `cmdPage`     | compute | `uiApplied` at the press                                                                  |
| +52    | `cmdEpoch`    | compute | `uiEpoch` at the press                                                                    |
| +56    | `uiShown`     | compute | buffer the shader draws from; the host does not read it                                   |
| +64    | `hostAck`     | host    | last `cmdSequence` taken; the cursor pulses while it differs                              |
| +68    | `hostBusy`    | host    | nonzero during a helper call; the shader draws a spinner                                  |

The shader is the only console writer of +16..+63 and never writes host words; the host reads
+16..+55 in one 40-byte read and writes +0..+15 and +64..+71. The shader writes
`cmdItem`/`cmdValue`/`cmdPage`/`cmdEpoch`, then `cmdOp`, then `cmdSequence`, with a barrier
between; the host takes a command only when its epoch and page are current. One press makes
one command; the host's state machine gives it meaning.

### Page format (`UI_OFFSET + page * 4 MiB`, `src/streamer/ui/page.js`)

| Offset | Content                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0x000  | header, 16 u32: magic `0x47504248` ('HBPG'), epoch, sequence, flags, itemCount <= 32, textCount <= 48, imageCount <= 24, bodyBytes <= 4 MiB - 0x1000, background RGBA8, cursorHome, checksum, 5 zero |
| 0x040  | items, 32 x 8 u32: `id` (nonzero), x, y, w, h, flags, 2 zero                                                                                                                                         |
| 0x440  | texts, 48 x 8 u32: x, y, w, h, body offset, color RGBA8, 2 zero                                                                                                                                      |
| 0xA40  | images, 24 x 8 u32: x, y, w, h, body offset, format (1 RGBA8), 2 zero                                                                                                                                |
| 0x1000 | body: alpha-8 strips (4-aligned, w <= 1920, h <= 96) and RGBA8 images (w <= 320, h <= 180)                                                                                                           |

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

## Console UI

The console owns screen transitions, settings, input gating and the page header
(`civ7/console-ui.js`); `civ7/application.js` runs `ui/service.js`'s `createService` inside the
helper with the console machine. The PC composes each page from the console's snapshot, writes
it with write-raw and runs helper requests (`list`, `pair`, `quit`). src/streamer/ui/CLAUDE.md
has the rules.

- `model.js`: the state machine the console runs; item ids per screen are in `ITEM`.
- `hosts.js`: the host list in `hosts.json` (`$XDG_CONFIG_HOME/moonlight-nx2/`) and the
  helper's app list.
- `settings.js`: the settings catalog and `streamArgs`; Civ7 stores settings in the game's save
  data and the PC file only seeds migration.
- `pages.js`, `page-composer.js`, `page-encode.js`, `page.js`: layouts, composition, encoding
  and the page serializer and validator, the mirror of the shader.
- `raster.js` + `glyph-raster.js`: paint strips, cover tiles and letter tiles from the glyph
  atlas `fonts/glyphs.bin`; `glyphs.py` rebuilds it through `text.py` (Pillow, build time only).
- `discover.js`: mDNS for `_nvstream._tcp.local`, merged into the host list.

## Tests

Tests, fixtures and their generators, test support and the component READMEs live in the
sibling repo `moonlight-nx2-dev`, at the same `src/...` paths. Its `link-app.cjs` links this
checkout's sources beside each `test/` before a run; `MOONLIGHT_APP` picks the checkout
(default `../moonlight-nx2`, then `../hbl-moonlight`). From this repo's root:

```sh
npm install                  # once, here and in ../moonlight-nx2-dev: TypeScript and @types/node
npm test                     # the dev repo's whole suite against this checkout
npm run typecheck            # tsc --checkJs over the modules in tsconfig.json
npm run typecheck:strict     # the strict file list
```

The helper's C tests also live there; `build.sh` passes them as `DEV_DIR` (`MOONLIGHT_DEV`
overrides the dev repo path) and `ctest` in the build directory runs them
(src/streamer/protocol/CLAUDE.md). `ui/glyphs.py reference` writes the raster fixture into the
dev repo (`--out` for another path).
