# Console UI host service

`tools/moonlight/ui-service.js` is the PC half of the console Moonlight UI. The console draws
pages the host publishes into the app's private storage and sends back A/B/X/Y/ADJUST/CHORD
with the id of the cursor item; the host owns every screen. The memory contract (UI block at
`0xC000`, two 4 MiB page buffers, page format, flags) is `docs/moonlight/CONSOLE-UI.md` in
`moonlight-dev`.

    node tools/moonlight/ui-service.js RUN_DIR

`RUN_DIR` is the launcher session directory from the `SESSION READY` line (the newest one when
omitted). The service refuses an app whose private storage is smaller than `MEMORY_BYTES`
(package 1.0.0: "predates HBV2"). The helper is `HBMOONLIGHT` or the `build.sh` default.

## Pieces

| File | Role |
| --- | --- |
| `ui-model.js` | Pure state machine: `reduce(model, event)` returns the next model and intents (`list`, `pair`, `launch`, `quitHost`, ...). Item ids per screen are `ITEM`. |
| `ui-settings.js` | The settings catalog (size, fps, bitrate, codec, audio, present rate), `settings.json` beside `hosts.json`, `streamArgs` for `live.js`. |
| `ui-pages.js` | One layout per screen as items, text strips and images; strips and tiles cached by text and size. |
| `ui-raster.js` + `ui-text.py` | A long-lived PIL child painting alpha-8 strips, cover tiles and letter tiles. |
| `ui-page.js` | Serializer, validator and parser of the page format, shared with the console shader. |
| `ui-discover.js` | mDNS query, DNS answer parser, host candidates and the merge into the manual list. |
| `ui-service.js` | Attach, publish, command poll, children (helper `list`/`pair`/`quit`, `live.js` for the stream), exit. |

## Host rules

- Attach writes magic 0, reads the stale `uiApplied` and seeds the first sequence after it;
  the epoch is the start time in seconds. Commands written before attach are not replayed.
- A page is republished only when its bytes change, so raising or hiding the overlay with the
  chord or B costs no sequence and keeps the console's cursor.
- Every command is acked in `hostAck`; it is taken only when its epoch and page match the
  current ones, otherwise logged as `command-dropped`.
- `hostBusy` is 1 around helper calls; a helper is killed after 20 s and reported as timed out.
- While streaming only the overlay page is published. Input to the game stops while the
  console holds `uiOverlay` at 1: `input-feeder.js` reads that word every 100 ms and
  releases what is held the frame it goes up. No signal travels from the service.
- Return to apps stops `live.js` (SIGINT, SIGKILL after 10 s) and relists; the host game
  stays current. Quit host app stops the stream, waits for it, then runs `hbmoonlight quit`
  (`/cancel`) and relists; the result is the subtitle of the app grid ("Quit confirmed" or
  "Quit failed: ...") since the frozen UI block has no status word.
- Covers come from `hbmoonlight list HOST --covers DIR` (`/appasset`, cached under
  `$XDG_CACHE_HOME/hblauncher/moonlight/covers` by host and app id). The helper keeps only a
  real PNG of at most 4 MiB and 4096 px a side, fetched under a 5 s alarm; a bad or missing
  cover never fails the list, the app draws the letter tile for it.
- Hosts: `hosts.json` is the manual source. At attach and on Y the service asks for
  `_nvstream._tcp.local` over mDNS (`ui-discover.js`, Node dgram, 1.5 s window) and appends
  hosts it did not know, saved once through a rename; manual names and addresses are never
  touched and nothing is removed for being absent from one scan.
- The service exits when `app-runtime.json` names another active app, or on SIGINT/SIGTERM,
  and writes magic 0 last so the console shows the static splash.

## Records

Each run writes `/media/storage2/builds/HBLauncher/ui-service/<timestamp>-<session>/` with
`manifest.json` (session, revision, builder, command) and `events.jsonl`: `attach`,
`published`, `command`, `command-dropped`, `helper` (a failed one carries the helper's error
line; its `stage` names the step that timed out), `stream-event` (every JSON line the stream
child relays: `log`, `connected`, `error`), `stream-exit`, `quit` (cancelled, exit code),
`app-gone`, `detach`.

## Tests

`moonlight-dev/tools/moonlight/ui-*.test.cjs` and `input-feeder.test.cjs`: the model, the
discovery parser against a recorded Sunshine answer (`fixtures/mdns-sunshine.bin`), the
settings, the pages through serialize/validate/parse, the rasteriser (PIL tests skip without
PIL) and the service against a fake console that applies pages like the shader, with fake
children for the helper and `live.js`.
