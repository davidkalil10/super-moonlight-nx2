# src/streamer/ui

The PC half of the console Moonlight UI. README.md, "Console UI service", has the file map,
the runtime behaviour and the run log; this file keeps the design rules the code headers point
at. Tests: `node --test src/streamer/ui/test/*.test.cjs`.

- Ownership: the console owns the cursor, the overlay and the command words; service.js owns
  the pages, the epoch and sequence, `hostAck` and `hostBusy`. Layout is the host's: the console
  draws what it is given, moves the cursor over the item rects and forwards presses by item id.
- Item ids (model.js `ITEM`): fixed ids for the buttons, then one range per row kind (host
  10000, app 20000, setting 30000), so a command names a host, an app or a setting without the
  console knowing what a row is.
- Page format (page.js): text strips (alpha-8, painted on the PC by raster.js and text.py) and
  RGBA8 images at absolute screen positions, plus the item rects. The shader makes the same
  checks as `validate()` before it draws. Contract: team note `moonlight-ui-design.md`,
  "Memory and words".
- Settings (settings.js): only values the console path has run are offered (team note
  `ui-settings-catalog.md`). A `locked` row has one value; an `unbacked` row has no host plumbing
  yet and stays greyed, so the page shows it without pretending it works.
- Discovery (discover.js): mDNS yields candidates only (instance name, SRV target and port, A
  address); pairing and /serverinfo judge what a host is.
