# src/streamer/input

Controller and touch from the PC to the console. input-feeder.js feeds hbmoonlight's stdin;
controller.js maps buttons and touch.js maps the panel. Root CLAUDE.md ("Input and audio") has
the panel and read-size facts.

## Two paths

- **Pull (default):** the host reads one 784-byte pad+touch window per frame over the bridge.
- **Push (`--input-push`):** a console worker (input-push-worker.js, frames in
  input-push-plan.js) sends pad, touch and UI words over native TCP, so input costs no bridge
  exchange. The feeder reads them with `--push`, and `--input-hz` defaults to 120 under push.
  pad-age.js measures record age and stalls.

## Rules

1. The worker sends state and UI words in one send and sleeps last. A short send shifts every
   later record, so the reader checks `uiMagic` once a record carried it, and keeps that latch
   until the next attach.
2. More than 4 records queued: keep the newest, after lifting any touches. 250 ms of silence
   sends the pad back to neutral.
3. The + button alone stops SmileBASIC, so Start reaches the PC only from the chord
   (`--start-chord`, default `stickL+stickR`).
4. No record for 2 s after the attach (SILENT_MS) fails the push. At the end the feeder writes
   {stopped, retained, error}; like every native worker, one that may still run is retained,
   never closed (src/streamer/stream/CLAUDE.md).

## Feeder

`node src/streamer/input/input-feeder.js [runs/launcher-XXXX] [--hz 60] [--labels]
[--counts-fd N] [--push] [--start-chord stickL+stickR]`

- Attaches to the newest (or named) runs/launcher-\* session. Lines out:
  `{"type":"controller",...}` on change and `{"type":"touch","events":[...]}` when touch changes.
- Pad (bytes 0..40) and touch (128..784) are contiguous, so one 784-byte read covers both and
  halves the exchanges competing with video. `--sources` is unsupported: those pads sit outside
  that window.
- Each change of console + or - goes to stderr with the wall time, to match a hang to a press.
- `HBL_PROBE_PRESS_MS=N` (src/streamer/loopback/): the pad is not read. D-pad Up is pressed
  every N ms (plus up to 16 ms of jitter) and held 100 ms, and each change logs a `probe-press`
  line with its wall time on stderr. Pull mode only; unset or empty leaves the feeder as is.
- `--counts-fd N`: once a second `{exchanges, bridgeMs, pad}` (stats stage "input"); under push
  `{exchanges, bridgeMs, pushed, dropped, gapMaxMs}`, then the final report of rule 4.

## Controller (controller.js)

- The launcher writes the selected NpadState to binding 0 each frame, plus five pad sources at
  0x7f0000 + 640 (HBLauncher/sdk/host/hardware.js). Output is Limelight.h `*_FLAG` bits,
  triggers 0 or 255 (ZL/ZR are digital) and int16 sticks with Y up.
- Layout `position` (default) maps by place (Nintendo B to A_FLAG, A to B, Y to X, X to Y);
  `labels` maps by printed letter. HOME and Capture are not in NpadState, so SPECIAL_FLAG is
  never set.
- While every button of the start chord is held (`none` disables it), the PC sees Start
  instead of those buttons.

## Touch (touch.js)

- The block at STATE.touch (byte 128) is nn::hid::TouchScreenState<16>: u64 sampling number,
  u32 count, u32 pad, then sixteen 40-byte entries {deltaTime u64, attributes, fingerId, x, y,
  diameterX, diameterY, rotationAngle, reserved}. Coordinates are 1280x720; the launcher shader
  (HBLauncher/homebrew-launcher/shaders/launcher.comp) scales point 0 by 1.5 onto 1920x1080.
  Attributes bit 1 means the finger lifted this frame: ATTR_END, the bit the shader tests as
  `touch[6]&2u`.
- fingerId is the pointer id, since slots compact when a finger lifts. The panel has no
  pressure, so down/move send 0.0 ("pressure unknown").

## Pad age (pad-age.js)

The logic shader bumps STATE.frames once per launcher frame right after the pad copy: no step
between reads is a stall, more than one is missed frames. The time service words (clockMs,
frameIndex) stay zero under service version 1, which Moonlight uses. Age is the read's end minus
frames x period, relative to the freshest read since the last take. It assumes the launcher runs at
the period, so take once per stats row to keep a stall to one row.

## Push worker (input-push-plan.js, input-push-worker.js)

- Each pass copies state and UI blocks side by side and sends them as one record (the console
  socket has no TCP_NODELAY), counts it in a console word read back at stop, then sleeps. Sleep
  is last because a repeating frame reads its selector only after its calls: a stop written
  during the sleep ends the thread at the loop tail, so a stop wake never reaches send.
  Without a UI address the state buffer is sent directly.
- The frame cannot branch, so checkedPush checks the last pass's send count at stop, like the
  audio recycle check.
- create() verifies code, copy and sync functions, opens the TCP link (console to host here),
  allocates counter and worker; start() spawns. stop() points the worker at its exit, and since it
  only sleeps it leaves within one period; the host keeps reading until the join so a send
  never blocks. If the worker may still hold the socket
  it is retained: host end dropped, console descriptor open, SmileBASIC needs a restart.

## Test

From the repo root: `node --test src/streamer/input/test/input.test.cjs`. The push tests run the real native
TCP listener on port 0 against a fake console client.
