# Moonlight input feed

How the Switch 2 controller and touchscreen reach the Sunshine host as one
stream of input events for `hbmoonlight`.

## Pieces

- `tools/moonlight/controller.cjs` — console NpadState -> Moonlight gamepad
  fields (unchanged; reused).
- `tools/moonlight/touch.cjs` — console touch screen -> normalized multi-touch,
  with a tracker that turns per-frame points into down/move/up transitions.
- `tools/moonlight/input-feeder.cjs` — attaches to a session, reads the mapped
  state once per frame and writes tagged JSON lines to stdout.
- `tools/moonlight/helper/src/input.c` — parses those lines and calls
  `LiSendMultiControllerEvent` / `LiSendTouchEvent`.

## Touch in the state buffer

Touch shares binding 0 with the controller (std430 ABI 1). The `touch` uint[]
begins at `STATE.touch` (byte 128) and is a verbatim `nn::hid::TouchScreenState<16>`:

```
word 0..1  samplingNumber (u64)
word 2     count
word 3     reserved
then 16 TouchState entries, 10 words each, entry i at word 4 + i*10:
  +0..1  deltaTime (u64)
  +2     attributes   (bit 1 = finger lifted this frame)
  +3     fingerId
  +4     x
  +5     y
  +6..9  diameterX, diameterY, rotationAngle, reserved
```

This matches the launcher shader, which reads `c.touch[2]` as the count and
`c.touch[8]`/`c.touch[9]` as point 0 x/y and tests `c.touch[6]&2u` for the lift
(`homebrew-launcher/shaders/launcher.comp`).

## Coordinate range (derived)

The shader scales raw touch by **1.5** onto the 1920x1080 screen
(`launcher.comp`: `vec2 p=vec2(c.touch[8],c.touch[9])*1.5`). `1280*1.5 = 1920`
and `720*1.5 = 1080`, so the panel reports **1280x720** coordinates.
`launcher-check.js` corroborates it: its tap at `[1107,119]` lands on the
refresh button the shader places at `(1660,179)` (`[1107,119]*1.5 ≈ (1660,179)`).

`LiSendTouchEvent` wants normalized device coordinates (0.0 top-left to 1.0
bottom-right of the video). `touch.cjs` normalizes `x/1280`, `y/720`, clamps to
`[0,1]` and rounds to 4 decimals so float noise does not defeat change
detection.

**Assumption to revisit:** this maps the panel straight onto the full video
rect. If `apps/moonlight` ever letterboxes its frames inside 16:9, a rect-aware
mapping would be needed; the panel aspect (1.778) already matches 16:9, so the
only risk is a future non-full-frame layout.

## Pointer tracking

The native `fingerId` is the pointer id — slots compact when a finger lifts, so
the slot index is not stable. Per frame the tracker compares the reported ids to
the active set:

- id present, not active -> **down**
- id active, x/y changed -> **move** (unchanged -> nothing, keeps the feed quiet)
- `attributes` End bit set -> **up** immediately, id dropped
- active id absent from the frame -> **up**

The panel reports no pressure, so down/move carry `0.0`, which the API documents
as "pressure unknown"; contact area is `0.0/0.0` and rotation `LI_ROT_UNKNOWN`.
HOVER is never emitted (the panel cannot hover). On app close or exit the feeder
flushes an up for every still-active id.

## Wire protocol (stdin, one JSON object per line)

```
{"type":"controller","connected":true,"buttonFlags":4096,"leftTrigger":0,...}
{"type":"touch","events":[{"id":1,"action":"down","x":0.5,"y":0.5,"pressure":0}]}
```

An untyped line is treated as a controller line (backward compatible with
`controller-watch.cjs`). Lines are compact (no whitespace) because the C parser
matches keys by substring.

The helper queries `LiGetHostFeatureFlags() & LI_FF_PEN_TOUCH_EVENTS` on the
first touch line and prints `{"event":"touch","supported":bool}`. If touch is
unsupported (or a send returns `LI_ERR_UNSUPPORTED`) it stops sending touch and
says so once, rather than falling back to mouse; the controller feed is
unaffected. `moonlight-common-c` is pinned at `b126e481` in `fetch.sh`, which
already has `LiSendTouchEvent` — no pin bump was needed.

## One read per frame

The pad (bytes 0..40) and the touch block (bytes 128..784) are contiguous in the
mapped buffer, so the feeder does a single `rpc.read(mapped, 784)` and parses
both out of it. That halves the console exchanges that compete with the video
sender versus reading each field separately. `--sources` (the extra pad sources
far outside that window) is intentionally not supported in the feeder.

## Wiring into live.cjs (for the coordinator)

`live.cjs` spawns `hbmoonlight` in `moonlight()` with a free `stdin`. Pipe the
feeder into it by adding, right after `const helper = spawn(...)` in that
function:

```js
spawn(process.execPath, [path.join(__dirname, 'input-feeder.cjs')], {
  stdio: ['ignore', helper.stdin, 'inherit']
});
```

The feeder finds the newest `runs/launcher-*` session itself, so no directory
argument is needed.

## Needs a live console test

- Confirm the Moonlight app's frame loop actually writes `GetTouchScreenState`
  into its mapped state buffer (the launcher loop does; the app path is
  unverified here).
- Confirm `fingerId` is populated distinctly for simultaneous fingers on the
  real panel.
- End-to-end: multi-touch reaching Sunshine, up events landing promptly.
