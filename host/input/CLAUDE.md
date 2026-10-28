# host/input

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
   never closed (host/stream/CLAUDE.md).

## Test

From `tests/`: `node --test tools/moonlight/input.test.cjs`. The push tests run the real native
TCP listener on port 0 against a fake console client.
