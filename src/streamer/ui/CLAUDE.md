# src/streamer/ui

The PC half of the console Moonlight UI. README.md, "Console UI service", has the file map,
the runtime behaviour and the run log; this file keeps the design rules the code headers point
at. Tests: `src/streamer/ui/test/` in moonlight-nx2-dev.

- Ownership: Civ7 ships `createMachine` and the settings rules to the console.
  `civ7/console-ui.js` consumes shader commands, owns screen transitions, settings, input
  gating and the page header (epoch, sequence, apply watch). The PC composes
  (`page-composer.js`), paints (`glyph-raster.js`, covers included), encodes (`page-encode.js`)
  and writes every page with write-raw, then sends `ui-show`: console script byte loops run at
  ~0.3 MB/s, so a 380 KB page took ~1230 ms to store from the console, against ~15 ms over
  write-raw (civ7/README.md, "Console UI"). The PC also keeps `hostBusy`.
- Item ids (model.js `ITEM`): fixed ids for the buttons, then one range per row kind (host
  10000, app 20000, setting 30000), so a command names a host, an app or a setting without the
  console knowing what a row is.
- Page format (page.js): text strips (alpha-8, painted by glyph-raster.js from the glyph atlas) and
  RGBA8 images at absolute screen positions, plus the item rects. The shader makes the same
  checks as `validate()` before it draws. Contract: team note `moonlight-ui-design.md`,
  "Memory and words".
- Page writes (device runs: write-raw ~5 MB/s, a 1.37 MB settings page took 257 ms on average,
  up to 4 s): strips are trimmed to their ink plus one clear pixel, strips sharing a bitmap share
  its bytes, and the service encodes each page over what its buffer held (`encodeOver`: kept
  bitmaps stay at their offsets) and writes only the changed ranges. A settings page went from
  1.66 MB to ~0.23 MB; a value step writes ~30 KB in 3 requests. The first change after a
  screen opens rewrites the older buffer.
- Settings (settings.js): only values the console path has run are offered (team note
  `ui-settings-catalog.md`). A `locked` row has one value; an `unbacked` row has no host plumbing
  yet and stays greyed, so the page shows it without pretending it works.
  Resolution's `docked` values (2560x1440, 3840x2160, added 2026-11-08 for G4) are stepped onto
  only after the console reported docked (`operationMode` event); a save holding one stays when
  handheld and the launch falls back to 1080p with a badge (civ7/README.md, "Fallbacks"). They
  are not yet proven end to end on the console. Handheld, the settings page carries "1440p and
  4K are only available when docked" bottom right, drawn only while the cursor is on Resolution
  (a text strip with `cursorItem`, which the shader shows against the live cursor).
  Selecting 4K forces 60 fps and locks the frame-rate card. `fpsBefore4k` keeps the previous
  60/120 preference in the save; stepping back to a smaller size restores it and removes the
  field. Older 4K120 saves are clamped while retaining 120 for the next smaller size.
  Settings are edited with A (user decision, Round 6): the D-pad moves across both columns, A on
  an adjustable card starts an edit, left/right then step it, A or B ends the edit. The shader
  owns the edit (`uiEdit` word, EDIT command), so Right straight after A steps; the model's
  `editing` follows it. A dock change keeps the edit; adjust() steps by the new mode. Locked
  and unbacked rows never edit.
  Only the edited value shows arrows, `‹` and `›` only where adjust() would change it in the
  current mode, so a handheld 1080p has no `›`. The composer paints the whole `‹   value   ›`
  and clears the arrows not shown, so the value stays where it is in and out of an edit.
  Saves carry `version`; a save without the current version has its `formerDefaults` (the old
  20 Mbps bitrate default) replaced by today's fallback, so it gets Auto. Bump the version
  whenever a default changes. The frame rate is also the display rate; there is no present-rate row.
  Version 5 (2026-11-07) drops 30 fps (a save of 30 falls back to 60) and adds host audio,
  button layout and the stream info badge; SOPS and quit-on-return became real.
  Stream info on keeps "1080p120 · AV1 · UDP · 30 Mbps" (plus any fallback note) on the top
  right badge for the whole stream at every layer size; off, the badge shows fallbacks for 4 s.
  Left out: surround (helper and console audio are stereo), touch as mouse (the helper sends
  touch events only), pacing toggles (the deferred wait is automatic) and a live stats
  overlay (the rate badge is a start-of-stream badge).
- Hosts (`hosts.json`, `{hosts, removed}`; an older plain array still loads): a typed or found
  host is saved once `list` succeeds on it, so a cancelled or failed pairing leaves the file
  alone. The list also gives the host's `uniqueid`, which is saved with it; a known uniqueid
  listed at a new address moves that entry there (a new DHCP lease). Remove drops the host and
  puts it on `removed`, which discovery skips; listing it again (typed in) takes it off.
  Unpair asks the helper and keeps the host.
- Discovery (discover.js): mDNS yields candidates only (instance name, SRV target and port, A
  address); pairing and /serverinfo judge what a host is. A candidate is the same PC by
  uniqueid when both sides know one, else by address, never by name: two PCs may share one.
  A removed host that mDNS reports at a new address comes back, since mDNS has no uniqueid.
- A failed operation on an idle screen (hosts, keypad, host options, settings) is dropped; a
  launch waits for a stream that is still stopping. Unpair or Remove while that stream stops
  is not blocked (review P2, left).

## Settings storage

Civ7 stores settings in the game's own save data (`save:` mount) through verified SDK filesystem functions.
`civ7/settings-store.js` alternates two checked generations; a partial write leaves the
previous one usable. The PC file seeds migration only when no valid console settings exist.
Storage errors remain visible in the settings page.

## Text

`glyph-raster.js` paints what `text.py` paints, from `fonts/glyphs.bin`; `glyphs.py atlas`
rebuilds it with Pillow and `glyphs.py reference` rebuilds the test fixture in moonlight-nx2-dev
(`--out` for another path). Rerun both after changing a font, a size or weight in pages.js
(`COMBOS`), or the character set.

- Pillow puts every glyph on the whole pixel nearest its pen and drops row fractions, so one
  bitmap per glyph reproduces it; two subpixel phases measured worse. Alpha is 4-bit, so strips
  differ from text.py by at most 8 levels.
- Only the listed size and weight pairs exist; another one throws. Characters: ASCII, Latin-1,
  the UI symbols, modern Greek and Cyrillic U+0400-045F plus Ґґ (both through DejaVu); anything
  else draws DejaVu's missing-glyph box, as text.py does without a CJK font. Greek and Cyrillic
  took the atlas from 323 KB to 519 KB deflated (1.4 to 2.4 MB inflated).
- Kerning is one pair list per face and weight in 1/64 px at 1000 px, scaled with Math.round,
  plus a signed byte per pair and size for HarfBuzz's own rounding. Sora's f-ligatures are
  found by rendering every pair and stored as glyphs.
- Format (little-endian, then zlib): header `HBGA`, version 1, combo, table and ring counts;
  24-byte combos (size, weight, ascent, descent, glyph count, records, corrections); 12-byte
  kern tables (face, weight, count, entries); 12-byte legend rings; 24-byte glyphs (key, face,
  sequence of up to three UTF-16 units, advance in 1/64 px, mask offset, size, bitmap); 6-byte
  kern entries; correction bytes; 4-bit bitmaps, high nibble first.
- `createGlyphRaster` is shipped by toString(): everything it uses is inside it (the test checks
  with TypeScript), it takes the inflated atlas and an optional zlib inflate for covers, and
  uses no Buffer or TextEncoder.
