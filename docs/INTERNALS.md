# Implementation notes

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
bit0 greyed, bit1 current (running app), bit2 adjustable (A edits it), bit3 pending (pulse even
after the ack), bit4 editing (the cursor stays on it, left/right send ADJUST). `checksum` is FNV-1a (basis 2166136261, prime 16777619) over header
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

