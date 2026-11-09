# src/streamer/input

Controller and touch on the console, forwarded to the helper as input records. controller.js
maps buttons, touch.js maps the panel and input-record.js holds the record format. Root
CLAUDE.md ("Input and audio") has the panel facts.

## Console input records (civ7)

- `controllerMapping(NPAD)`, `touchMapping()` and `createInputRecorder(mapping)` are
  self-contained; civ7/payload.js ships them by `toString()` and the PC exports are built from
  the same functions. `civ7/test/payload-scope.test.cjs` fails on any outside name.
- The recorder maps the pad with `toMoonlight(state, [])` (no start chord, Plus is
  Start), steps the touch tracker and returns only changes. On `STOP_CHORD` (L+R+Minus+Plus) it
  sends one released pad, lifts the touches, sets `stop` and returns nothing after that.
- Wire: each video acknowledgement is the 16-byte unit header, a u32 length, then that many
  bytes of JSON `{v: 1, pad?, touch?, stop?: true}` (0 when nothing changed, at most
  `INPUT_RECORD.limit`). `pad` holds the eight LiSendMultiControllerEvent fields, `touch` 1 to
  32 `{id, action, x, y, pressure}`. `readInputRecord` refuses any other shape, version, key or
  range, and the channel fails the stream on one.
- `civ7/console-ui.js` owns `allowInput()`. The video loop consumes the shader command before
  recording input, so an overlay releases the pad and forwarded fingers on that frame. A
  raised overlay word counts as the chord when its command was overwritten. The recorder
  ignores fingers and buttons held across the overlay until they lift, so the B that closes
  it never reaches the game. The PC validates and
  forwards those records. A stop request always stops, overlay open or not.

## Controller (controller.js)

- `civ7/input.js` reads the NpadState (`NPAD_BYTES`, 40) from the console each sample; the
  `NPAD` bit table is copied from hbl-platform `sdk/host/npad.js`. Output is Limelight.h
  `*_FLAG` bits, triggers 0 or 255 (ZL/ZR are digital) and int16 sticks with Y up.
- Face buttons map by printed letter (the button printed A sends A_FLAG); there is no layout
  setting since settings version 7. HOME and Capture are not in NpadState, so SPECIAL_FLAG is
  never set.
- `toMoonlight` takes an optional start chord: while all of it is held, the PC sees Start
  instead of those buttons. The console recorder passes none, so Plus is Start.

## Touch (touch.js)

- The block at STATE.touch (byte 128) is nn::hid::TouchScreenState<16>: u64 sampling number,
  u32 count, u32 pad, then sixteen 40-byte entries {deltaTime u64, attributes, fingerId, x, y,
  diameterX, diameterY, rotationAngle, reserved}. Coordinates are 1280x720 and map straight
  onto the video rect. Attributes bit 1 means the finger lifted this frame: ATTR_END, the bit the shader tests as
  `touch[6]&2u`.
- fingerId is the pointer id, since slots compact when a finger lifts. The panel has no
  pressure, so down/move send 0.0 ("pressure unknown").

## Test

`src/streamer/input/test/input.test.cjs` in moonlight-nx2-dev; `npm test` from the app root runs it.
