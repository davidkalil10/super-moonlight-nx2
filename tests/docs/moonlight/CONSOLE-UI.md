# Console UI pages

The console UI the Moonlight package draws (`ui.glsl`) and the host UI service publishes
(`tools/moonlight/ui-page.js`) meet on this contract, frozen 2026-10-26 (U2). The design around
it (screens, state machine, service loop) is the team note `research/moonlight-ui-design.md`.
Code: `tools/moonlight/ring.js` (`UI`, `UI_OFFSET`, `UI_PAGE_BYTES`), `ui-page.js` (the host
serializer and the mirror of the shader's validator), `apps/moonlight/check.cjs` (desktop scene).

## Memory and words

Private memory (binding 1) grows by a UI region after the spare page; the control page gains a
UI block. Nothing existing moves, so the ring, native frames and `written[]` keep their offsets.
Constants live in `tools/moonlight/ring.js` (`UI`, `UI_PAGE_BYTES`, `UI_OFFSET`) and are
generated into `ring.glsl` like the rest; `tools/moonlight/ui-page.js` is the host serializer
and the mirror of the shader's validator, and both halves import it.

```
control  0x0000  ring control words (applied, mode, native publication …)
         0x0400  written[8160]  (ends 0x8380)
         0xC000  UI block (below), 128 bytes
ring     0x10000  8 slots × 294,912
frames   0x250000 3 × 3,133,440 NV12
spare    0xb47000 4 KiB
ui       0xb48000 two page buffers × 4 MiB   (new; MEMORY_BYTES 11,829,248 → 20,217,856)
```

### UI block in the control page (offset 0xC000), one u32 per field

| Offset | Name          | Owner   | Meaning                                                                                                                                                           |
| ------ | ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| +0     | `uiMagic`     | host    | `0x49554248` ('HBUI') once the service attached; 0 → splash from the static atlas                                                                                 |
| +4     | `uiEpoch`     | host    | nonzero service epoch (epoch seconds at start); a new epoch resets `uiApplied`, cursor and overlay                                                                |
| +8     | `uiSequence`  | host    | newest published page sequence, nonzero, +1 per publish; written last                                                                                             |
| +12    | `uiPage`      | host    | page buffer (0/1) that holds `uiSequence`                                                                                                                         |
| +16    | `uiApplied`   | compute | page sequence the shader validated and draws; 0 = none                                                                                                            |
| +20    | `uiCursor`    | compute | index into the applied page's item table                                                                                                                          |
| +24    | `uiOverlay`   | compute | 1 while the overlay page is raised over video (L+R hold); the host drops pad input to the game while it is 1                                                      |
| +28    | `uiTouchItem` | compute | last item index a tap selected, for the host's log                                                                                                                |
| +56    | `uiShown`     | compute | page buffer (0/1) the shader draws `uiApplied` from; the host does not read it                                                                                    |
| +32    | `cmdSequence` | compute | nonzero, +1 per command, wraps past 0                                                                                                                             |
| +36    | `cmdOp`       | compute | 1 A, 2 B, 3 X, 4 Y, 5 ADJUST, 6 CHORD (L+R held 60 frames)                                                                                                        |
| +40    | `cmdItem`     | compute | `id` of the cursor item for A/X/Y/ADJUST; 0 for B and CHORD                                                                                                       |
| +44    | `cmdValue`    | compute | ADJUST: 1 right, 0xffffffff left; 0 otherwise                                                                                                                     |
| +48    | `cmdPage`     | compute | `uiApplied` at the press; the host ignores a command for a page it has since replaced                                                                             |
| +52    | `cmdEpoch`    | compute | `uiEpoch` at the press; the host ignores another epoch                                                                                                            |
| +64    | `hostAck`     | host    | last `cmdSequence` the host consumed; the cursor frame pulses while `cmdSequence != hostAck` on the applied page, so the host writes it on every command it takes |
| +68    | `hostBusy`    | host    | nonzero while a helper call runs; the shader draws a spinner top right                                                                                            |

Rules. The compute shader is the only console writer of +16..+63 and never writes the host
words; the host reads +16..+55 in one 40-byte read and writes +0..+15, +64..+71. The shader
writes `cmdItem`/`cmdValue`/`cmdPage`/`cmdEpoch`, then `cmdOp`, then `cmdSequence`, in one
invocation with a memory barrier between; the host accepts a command only when `cmdEpoch` is
its epoch and `cmdPage` is the sequence it last published; one press makes one command. The
console never interprets screens: A/B/X/Y/ADJUST/CHORD are forwarded and the host's state
machine gives them meaning per screen. Commands go through plain words, not the SDK mailbox,
because a pending mailbox request stops the native worker at the next 60-frame boundary
(services.md) and would hitch every press. These are the T224 kinds W13 "UI page" (H→C,
variable, body then tables then sequence) and W14 "UI words" (H→C, 16 + 8 bytes).

### Page format (one 4 MiB buffer at `UI_OFFSET + page × UI_PAGE_BYTES`)

| Offset | Content                                                                                                                                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0x000  | header, 16 u32: `magic 0x47504248 ('HBPG')`, `epoch`, `sequence`, `flags`, `itemCount` ≤ 32, `textCount` ≤ 48, `imageCount` ≤ 24, `bodyBytes` ≤ 4 MiB − 0x1000, `background` RGBA8, `cursorHome` item index, `checksum`, 5 reserved zero |
| 0x040  | item table, 32 × 8 u32: `id` (nonzero, host-defined), `x`, `y`, `w`, `h`, `flags`, 2 reserved                                                                                                                                            |
| 0x440  | text table, 48 × 8 u32: `x`, `y`, `w`, `h`, `offset` (body-relative), `color` RGBA8, 2 reserved                                                                                                                                          |
| 0xA40  | image table, 24 × 8 u32: `x`, `y`, `w`, `h`, `offset`, `format` (1 RGBA8), 2 reserved                                                                                                                                                    |
| 0x1000 | body: alpha-8 text strips (w × h bytes, offsets 4-aligned, w ≤ 1920, h ≤ 96) and RGBA8 images (w ≤ 320, h ≤ 180)                                                                                                                         |

Header `flags`: bit0 overlay (drawn over video only while `uiOverlay` is 1; without it the page
replaces the video area and the shader draws it whenever `uiApplied` is nonzero and no native
or HBV frame is current), bit1 hide cursor (status pages). Item `flags`: bit0 greyed (not
selectable; its colour comes from the host's strip, the shader does not dim), bit1 current
(running app mark), bit2 adjustable (left/right send ADJUST instead of moving the cursor),
bit3 pending (host override: pulses the cursor on it even after the ack). `checksum` is
FNV-1a (offset basis 2166136261, prime 16777619, as `nativeChecksum`) over header words 0..9
then the three tables in order, every word. Layout is the host's: the shader draws every text
strip and image at its absolute position (strips as alpha over `background` in `color`), draws
the cursor frame around the cursor item's rect and marks current ones. The
cursor moves by geometry: from the cursor item's centre, the nearest non-greyed item whose
centre lies in the pressed direction (dominant axis), no wrap; a new page keeps the cursor on
the item with the same `id` when present, else `cursorHome`. A tap inside an item rect moves
the cursor there and sends A.

Commit discipline mirrors W09: the host writes the body, then the tables and header, into the
buffer the shader is not showing, then `uiSequence` and `uiPage`. The shader validates magic,
`epoch == uiEpoch`, `sequence == uiSequence`, counts, every text and image rect inside
1920 × 1080 with its bytes inside `bodyBytes`, and the checksum; only then it sets `uiApplied`
and draws from that buffer. A page that fails stays unapplied and the host sees `uiApplied` not
advance (5 s timeout, like native publication, then a log line with the header). The host
publishes the next page only after `uiApplied` reached the last one, so the free buffer is
always the unshown one; a partial update rewrites only the changed strips and tables of that
buffer.

Sizes. 48 strips of 36 × 960 = 1.66 MB, 24 covers 160 × 90 = 1.38 MB: 3.0 MB of a 4 MiB page. A
full apps page is about 95 exchanges of 32 KiB, 0.3 s at the measured 3 ms; the cursor never
waits for it, and a status-only change is one strip.
