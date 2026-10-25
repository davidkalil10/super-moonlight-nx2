# Moonlight on-device menu

`tools/moonlight/menu.cjs` gives the Switch 2 Moonlight app a menu driven
entirely from the PC host: pick a PC, pair with a PIN, see its games, launch one,
and quit, without typing a command for normal use.

## The one idea: no new shader

The menu is **not** a new console screen. It is a PC-rendered picture shown
through the **same frame ring the video stream uses**. Nothing changes on the
console.

```
menu-render.py  (PIL) -> 1920x1080 RGB24 screen
   -> HBV2 encoder     -> one keyframe slot
   -> rpc.write         -> app ring slot (sequence % 8), exactly like live.cjs
Switch 2 app.frag/app.comp: decode the ring, show the frame  (unchanged)
```

Input comes back the same way video input already does: `controller.cjs` and
`touch.cjs` read the app's binding-0 state buffer (the `mapped` address in
`game-audio-source.json`) and move a selection. So the whole display and input
path is reused with zero console-side change — the app shaders, `app.comp`,
`app.frag` and the ring format are all untouched.

## State machine

```
            A                A on host (not paired)        PIN entered on PC
 splash --------> hosts --------------------------> pair -------------------> games
                   |  ^          A on host (paired)                             |
         A on Exit |  | B / Back  ------------------------------------------->  |  A on game
                   v  |                                                         v
            exitRequest=1                                             streaming (live.cjs)
            (launcher tears                                                     |
             the app down)                                   hold L+R ~1 s  /  child exits
                                                                               |
                                                                      back to games
```

Pure transitions live in `menu.cjs` and are unit-tested in `menu.test.cjs`:
`navigate` (up/down/wrap), `activate` (A), `back` (B), `hostListed`,
`pinReceived`, `toGames`, `streamEnded`, `errored`. `main()` only carries out the
side effects (spawn `hbmoonlight`, spawn `live.cjs`, write the ring) and folds
their results back into the model.

### Screens

- **splash** — title while attaching to the session.
- **hosts** — the hosts from `~/.config/hblauncher/moonlight/hosts.json` plus an
  **Exit to HBLauncher** row. Adding a host by IP is out of scope for v1; edit
  `hosts.json` (seeded with the default Sunshine host `192.168.8.245`). Pairing
  state is not stored per host (libgamestream keeps only client-side keys), so it
  is queried live on open.
- **pair** — shown when `hbmoonlight list HOST` reports `not paired`. `menu.cjs`
  runs `hbmoonlight pair HOST`, reads the `{"event":"pin"}` line and draws the PIN
  big with "enter this at https://HOST:47990/pin". On `{"event":"paired"}` it
  lists the games.
- **games** — the app list from `hbmoonlight list HOST`, plus a **Back** row.
- **streaming** — menu rendering is paused and `live.cjs` owns the ring.

## Launch and return

Selecting a game spawns:

```
node tools/moonlight/live.cjs <session> --moonlight HOST "GAME" --codec hbv2 --budget 96
```

which already does video + input + audio. The menu pauses its ring writes while
it runs. During streaming `menu.cjs` polls the controller at ~10 Hz for a
**RETURN chord — hold L + R together for ~1 s** — and on it sends SIGINT to the
`live.cjs` child, waits for its `exit` (so no trailing P-frame lands after the
menu keyframe), resyncs the ring sequence and resumes the menu.

Two exits exist, by design:

- **Hold L + R (~1 s)** while streaming → stop the game, return to the menu.
- **Hold + and − (~1 s)** anywhere → the app's own `app.comp` calls `hbExit()`
  and hard-exits to the launcher. (Note: L + R while streaming is also forwarded
  to the game as LB + RB by the input feeder.)

## Exit to HBLauncher

The **Exit to HBLauncher** row writes `1` to `STATE.exitRequest` (byte 1016 of
the binding-0 state buffer) over the bridge, then stops. Verified against
`hbl-platform/homebrew-launcher/app-runtime.js`: `afterAppBatch` reads byte 1016 each batch
boundary and, when non-zero, calls `returnToMenu()`, which tears the app down.
The app shader only ever writes that byte via `hbExit()` on a held +/-
(`apps/moonlight/shaders/app.comp` → `hb.glsl`), so a host write of `1` is never
clobbered and survives to the next batch boundary.

## Rendering cost

Menu screens are near-static. `menu.cjs` encodes a screen **once, when it
changes**, and then only **re-stamps** that cached keyframe with a fresh sequence
and rewrites it at a low heartbeat rate (`--rate`, default 2 Hz). The heartbeat
exists only so a reopened app — whose ring is wiped by `assets/memory.bin` —
picks the menu up again; it watches `CONTROL.applied` and, if it goes backwards
(a reset) or the storage `mapped` changes, recomputes `nextSequence`. A full
12 Hz re-encode would saturate the ~77 exchange/s Wi-Fi budget for no benefit on
a static screen, so it is avoided.

## Running it

```
# On the console: start.sh --app moonlight  (the HBV2 build; see LIVE-TEST.md)
# On m5, once the app shows its test card:
node tools/moonlight/menu.cjs
```

Flags: `[runs/launcher-XXXX]` (default: newest), `--host IP` (add to hosts.json),
`--budget 96` (streamed game budget), `--qp 8` (menu keyframe quality), `--rate 2`
(Hz heartbeat), `--js` (pure-JS encode, no native binary), `--no-input`, and
`--script up,down,a,...` (offline driver). Navigation is native Switch: physical
**A** selects, **B** backs; a touch tap selects a row. B on the pair screen
cancels the pairing wait.

## Offline verification

- `node --test tools/moonlight/menu.test.cjs` — the pure parts: host-list
  load/save/seed, list-JSON parsing, navigation (up/down/wrap, A, B), the RETURN
  chord detector, the state machine, `screenSpec`, and `restampSlot` on a real
  keyframe.
- Against the fake console (ring + `applied` stand-in), no console or native
  binary needed:

  ```
  node tools/moonlight/menu.cjs tools/moonlight/fake-console --js --no-input --script a,down,down,up
  ```

  `applied` advances to the menu's keyframe sequence, proving the write path.

## Needs a live console session

- The app's frame loop must write `GetTouchScreenState`/the pad into its state
  buffer (the launcher loop does; the app path is unverified — see INPUT.md).
- Confirm the menu keyframe shows, selection moves from the pad, the PIN pairs,
  a game launches, L + R returns, and **Exit to HBLauncher** tears the app down.
- Both `menu.cjs` (chord poll) and `live.cjs`'s input-feeder read the state
  buffer while streaming; the extra reads compete for exchanges — watch for jitter.
