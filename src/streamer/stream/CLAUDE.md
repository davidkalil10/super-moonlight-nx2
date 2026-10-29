# src/streamer/stream

The video path: Sunshine through the helper into the console's `movie::Decoder`, scheduled by the
host one access unit (AU) at a time. Root CLAUDE.md has the decoder facts and measurements; this
file has the contract the code must keep. Code comments point here instead of restating it.

## Pipeline

```
Sunshine ──RTP──> hbmoonlight (protocol-binary.js, $HBMOONLIGHT) ──AU pipe──> native-h264.js
                                                         AccessUnits, h264-sps, stats, stop
                                                                       │
                                                      staggered-live.js: skip, gate, lag
                                         rpc writes │ (control page)  │ native TCP (native-tcp.js)
                                                    v                 v
 input worker:   [length gate]* → receive N → [decode gate N] → signal fetch gate → [ack N-1] → SendInput N
 output worker:  [decoder event] → acquire → stamp → ack → [fetch gate] → copy to ring surface → publish
                                                                         shader reads the descriptor ─┘
 * gate on receive only
```

The first frame stays host-driven (it sets up the output layout); every later one runs on the two
staggered workers (staggered-worker.js runs the frames of staggered-input-plan.js and
staggered-output-plan.js). Their status words are read by staggered-status.js.

## Console contract (staggered workers)

- Control page: decode gate 0x00, ignored fetch gate 0x10, fetch gate 0x20, acquire ack 0x30,
  length gate 0x80, dispatch words 0x40-0x7f, descriptors 0x100-0x2ff, decoder output event
  0x400 and its registration 0x440.
- All gates are auto-clear events: two signals before one wait merge into one wake.
- Every frame consumes itself as it runs, so it ends by restoring both of its slot's frames from
  their snapshots, then jumps through a dispatch word to the other frame.
- One host gate write covers the current and the next descriptor.
- Whenever a worker may still run, or a gate write may have half landed, the native objects are
  **retained**. Nothing is finalized, and SmileBASIC has to be restarted.

## Invariants (keep these true; comments may cite the number)

1. Prime N only after N-2 is submitted: they share a descriptor slot.
2. A prime for N+1 before the console took N's length-gate wake merges both wakes, so
   `admit(N)` waits for N-1 received (gate-queue.js).
3. The fetch gate is one auto-clear event: at most one fetch signal is outstanding.
4. A descriptor the worker can reach before its checked gate write names the ignored fetch
   gate, so a stop wake cannot open a fetch.
5. Submit N only after N-1's acquire ack. Release N-2 first. The ack starts signalled for N=1,
   standing in for the host-decoded IDR.
6. Stop rewrites the dispatches to the exit frame before it signals, so a stop wake never
   reaches SendInput.
7. A worker or job that may still run is retained, never closed (contract above).
8. Sequences restart per generation; the gate queue lives with the held unit.
9. The bridge runs each rpc POST in arrival order, not call order, so prime and gate writes
   go through one chain (`inOrder`). Reads stay outside it.
10. A queued gate write covers both descriptors: it carries the primed unit, never zeroes it.
11. A drain also stamps the next output's placeholder, so the last tail output acquires under
    its own sequence, not the one its slot held two AUs earlier.
12. The output worker acks only after its stamps, so the next SendInput can't race the
    host-visible acquire status.
13. `current` is stored before `nativeApplied`: retry a torn status read once; a repeat means
    a wrong surface.
14. Native TCP accepts only the connection that presents the token, and nothing closes while a
    console job may still use the socket.
15. A backlog while the console is silent is the console's: past CONSOLE_STALL_MS the stream
    stops (`console-stalled`) instead of asking Sunshine for a keyframe.

## Flags (stream-options.js checkFlags; live.js passes them through)

| flag                         | does                                                         | default                           |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------- |
| `--output-lag 1\|2`          | fetch each output 1/2 gates after its decode opened          | 1 at 60 Hz, else 2                |
| `--skip-backlog N\|off`      | skip an output once more than N units are queued             | 1 at 60 Hz or under vsync, else 2 |
| `--skip-rule backlog\|vsync` | publish by backlog, or by the predicted vsync                | backlog                           |
| `--trim-backlog-ms N`        | skip one output after 3 gates whose unit in hand is N ms old | off                               |
| `--drain-gates N`            | skip one output after N gates with units waiting at the gate | off                               |
| `--gate-on-receive`          | prime and gate N when it arrives, not on N+1 (60 Hz)         | off                               |
| `--gate-queue`               | run those gates off push(), at most one unit primed ahead    | off                               |
| `--decode-wait`              | sleep through a pending acquire (vsync rule only)            | off                               |
| `--receive-wait`             | sleep through a predicted receive (receive-wait.js)          | off                               |
| `--avoid-window B-A`         | keep status reads out of a span around the predicted vsync   | off                               |
| `--present-hz 60\|120`       | present rate                                                 | 60                                |

Refusals: `--gate-queue` without `--gate-on-receive`; `--gate-on-receive` at 120 Hz.

`--no-plus-guard` turns off the + guard (stream-plus-guard.js on platform sdk/host/plus-guard.js).
It is on by default: zeroes SB4's VM context before the first unit, restores it after the
native objects are released. It never fails the run; the `plus-guard` event and summary say why
it did not arm. The saved pointer sits in `<run dir>/plus-guard.json` until restored, so the
next stream adopts it after a crash. `restored: false` adds a summary warning: restart SB4.
A new run dir without an SB4 restart finds ctx 0 and no saved pointer: `armed: inherited`, + stays
guarded until SB4 restarts. The build check reads SB4's GNU build-id before anything else.

## session/

Starts a run, feeds the AU stream in and scores it. Entry points are live.js (CLI) and
native-h264.js (`run()`); options in stream-options.js, the run record in stream-report.js,
the child processes in stream-children.js.

- Invocation: `node src/streamer/stream/session/live.js [runs/launcher-XXXX] --moonlight HOST APP [flags]`.
  Session flags: `--bitrate KBPS|auto`, `--codec h264`, `--size 1920x1080`, `--fps 60`,
  `--duration S`, `--warmup S`, `--expect fps=30,dropped=0,idr=0`, `--queue 8`, `--input-hz 60`,
  `--audio-frames 960`, `--socket-audio | --socket-audio-tone`; the stream flags are in the table above.
- `--moonlight` runs src/streamer/protocol's hbmoonlight (path from `$HBMOONLIGHT`, resolved in
  protocol-binary.js). Unless `--no-input` / `--no-audio`, it also feeds controller and touch into
  the helper's stdin (src/streamer/input/input-feeder.js) and plays its audio on the console
  (src/streamer/audio/audio-stream.js, or socket-audio-source.js with `--socket-audio`).
- `run()` spawns the helper with its H.264 and PCM pipes. The first frames take the host-driven
  decoder path, which is drained fully before the staggered workers take the rest.
- The run stops on SIGINT/SIGTERM, `--duration`, Moonlight leaving the console, or a console that
  stops answering (invariant 15).
- Run record: manifest.json, events.jsonl, stats.jsonl (one row per statsMs) and summary.json.
- Why the drain reads the reader at the gate: units step up during the status wait, so the
  push-time `backlog` the skip and trim rules read stays 0 at a standing step 2. A skipped
  output has no applied-ack, so the next gate skips one refresh wait and the step drains.
- A row's `au.gateAgeMs` is the age of the unit whose push ran the gate. Under the default gate
  that gate opens the unit before it, whose age is `au.ownGateMs` and includes the wait for N+1.
  Under `--gate-on-receive` the two are equal.
- run-summary.js: `summarize` averages the steady rows after the warmup, `parseExpect` reads the
  `--expect` limits, `verdict` checks them. Dropped frames and IDR requests fail a run unless
  `--expect` allows some. Backlog trims are intended skips: counted apart from drops, they fail a
  run only through an explicit `--expect trimmed=N`.
- h264-stream.js (`AccessUnits`) joins the helper's Annex-B pipe with its AU metadata channel
  (sequence, size, keyframe flag, timestamps) without blocking either pipe. It cuts the byte
  stream into AUs by the announced sizes. Buffering is bounded: by default it pauses the pipe
  when the queue is full; with `onBacklog` it drops the queued units and skips to the next
  keyframe instead.

## scheduler/

The host side of the staggered path: staggered-live.js decides per AU whether to skip, when to
gate and when to read again. The predictors and pacer only time its reads; they never change
what is written.

Steady state: the input worker receives each AU over native TCP; the output worker fetches the
unit two behind (one behind at lag 1). A steady frame costs one checked status read and one
combined gate write.

- **Skip (backlog rule):** with more than skipBacklog units queued on the host, an output is
  still decoded, fetched and released, but copied to a free surface behind a replay of the last
  applied publication. The shader keeps it off screen and the next gate does not wait for a
  present. At most MAX_SKIPS outputs in a row.
- **Trim** (`trimBacklogMs`, backlog rule only): skips one output the same way once the unit in
  hand has been older than trimBacklogMs, with another unit queued behind it, at TRIM_FRAMES
  gates in a row. It drops a standing delay at or below skipBacklog, so it needs skipBacklog
  of at least 1. With nothing queued the age is arrival phase, which a trim cannot lower. The
  TRIM_FRAMES gates after a trim do not count: at most one trim per 2 \* TRIM_FRAMES gates.
- **Vsync rule:** at most one publication pending. The newest output is published once the
  previous one is applied; outputs in between go off screen. A gate waits for the pending
  publication only with at most skipBacklog units queued, or once it has been pending for two
  vsync periods (request-budget.cjs). With no free surface to discard into, it waits first.
- **decode-wait / receive-wait:** sleep through a pending acquire or receive to the time
  decode-wait.js / receive-wait.js predict, instead of rereading back to back.
- **Gate on receive:** by default gate N carries N+1's length, so it waits for N+1 to arrive.
  gateOnReceive primes each unit's descriptor in its own exchange as it arrives, sends it and
  gates it at once: decode N opens a frame earlier, for one more exchange per unit.
- **Gate queue** (gate on receive only): push() primes and sends a unit, queues its gate on
  gate-queue.js and returns, so a gate rereading a late receive no longer holds up the next
  unit. Every gate status read reports the console's receive sequence to the queue. The queue
  starts with unit 1 and goes at finish (invariant 8); queued gates carry the unit primed
  behind them (invariant 10).
- **Rereads:** a gate late on receive, input, acquire or fetch reads again at once, since a
  pause costs the frame its vsync slot (request-budget.cjs staggeredRetryWait). A gate waiting
  for the renderer to apply a publication sleeps to the vsync present-pacer.js predicts,
  since polling there only fills the bridge. The deadline bounds both.
- **Avoid window** (`avoid` = {beforeMs, afterMs}): a status read that would start inside that
  span around a predicted event is delayed to afterMs past it, so reads can be moved off the
  console's busy window once the exchange bins show where it is.

gate-queue.js contract (one producer, which awaits `admit()` before each `push()`):

- One task runs the queued gates in order.
- `admit(N)` waits until a status read saw N-1 received (invariant 2) and fewer than `depth`
  gates are queued or running.
- `push()` throws when the queue is full: a gate pushed without `admit()` could merge the
  console's wakes.
- The first gate error stops the queue: later gates never run, `admit()` and `drain()` reject
  with it, `push()` throws it.
- `clear()`, for a stop, rejects any waiting `admit()` and makes `push()` throw, so nothing is
  primed or queued after it.

Acquire waits (`createAcquireWaits`, staggered-checks.js), split by unit size. Reads are about
5 ms apart, so a wait is only known between two bounds; fetch waits are booked the same way.

| bin             | counts                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `bins`, `maxMs` | upper: start of the first pending read to end of the read that saw it done |
| `lowerBins`     | lower: end of the first pending read to start of the last; 0 if only one   |
| `immediate`     | acquires a gate's first read already found done                            |
| `reads`         | how many pending reads each wait took                                      |

Predictors (the host has no console timestamps; both learn from reads only):

- decode-wait.js: unit done at max(its gate, previous unit done) + a decode estimate; a unit is
  taken as done at the earlier of its prediction and the read that saw it.
- receive-wait.js: unit received at its send + a fixed estimate + size \* perKbMs. Only the
  fixed part learns, since most of a pending receive is the input thread still submitting the
  unit before, which does not scale with size. A sleep never exceeds maxSleepMs: a longer one
  loses the vsync slot anyway.
- Both: a read past the prediction that still finds it pending grows the estimate by growMs; a
  read that slept and then saw it done shrinks it by shrinkMs, so a faster console or link
  still shows. A gate's first read waits only while bound (the previous gate found it pending),
  so a gate that keeps up reads at once (request-budget.cjs staggeredDecodeWait, receiveWait).

exchange-timing.js bins every status read and gate write against the last gate, the last send,
and the predicted decode-done and receive-done (`counts.exchanges`). The offsets are against the
host's own model of the console, which is what the schedule can move. Counts and ms per 1 ms
bin, with `<` and `>` for the rest.

### present-pacer.js (pinned by scheduler/test/present-pacer.test.cjs)

Predicts the vsync on which the renderer applies a publication.

- **Bracket:** a read that finds the publication applied right after one that did not brackets
  a vsync and sets the phase.
- **Drift:** while reads keep succeeding on the first try, the phase is pulled earlier by
  driftMs, so a late estimate does not add latency for long.
- **Nudge:** a read far from any bracket still nudges the phase a little toward what it saw, so
  sparse reads keep the estimate honest.
- **Period:** starts at periodMs (the display refresh), but the console may apply only every
  other refresh (1/60 s on a 120 Hz panel). Every read that checks a publication votes once per
  publication, timed by the pacer or not:
  - started past the refresh it was due on and finds it not applied: the console skipped it;
  - finds it applied before the next even refresh: the console used the odd one.
- Enough skipped-refresh votes move the pacer to twice the period; MID_HITS odd-refresh votes in
  a row bring the short period back.
- On the long period one timed read in PROBE_EVERY aims at the odd refresh, so that vote gets a
  chance when the host reads only when it must.
- windowMs must cover marginMs plus one status read, or a slightly early estimate sleeps a whole
  frame (request-budget.cjs staggeredHostWait).

## worker/

The console side of the staggered path: the input and output worker plans, their status words
and the host's checked gate write.

- staggered-gate.js: one checked write covers the input and output descriptors, which sit
  together in the control block. It opens decode of N and names the outputs to handle next:
  N-2 (acquired, or a placeholder before it exists) and N-1.
- Input plan, per AU N: the receive frame reads N over native TCP and parks on the decode gate.
  Once the gate write opens it, it signals the descriptor's fetch gate (held output N-2, or the
  ignored gate before N=3), waits for the acquire ack of N-1, then jumps through sendDispatch to
  the send frame that submits N. So the auto-clear decoder event never carries two unacquired
  outputs (invariant 5).
- With a length gate (gate on receive) the receive frame waits on it first: the host primes N's
  descriptor and signals the gate when N arrives, so gate N does not need N+1. Its next
  descriptor is a placeholder. The length gate starts signalled for AU 1.
- Output plan: the fetch frame copies the held output into the descriptor's ring surface,
  releases it, publishes the descriptor's metadata (the native sequence last) and stamps the
  fetch status. The output worker acks once per acquired output (invariant 12).
- staggered-status.js: the workers stamp results and a sequence into the ring's control block
  (src/streamer/shared/ring.js), just past the shader's words, so one read from
  `ring.CONTROL.current` to the fetch sequence covers one AU:

  | stage   | stamps                                                                    |
  | ------- | ------------------------------------------------------------------------- |
  | receive | recv byte count, sequence received                                        |
  | input   | SendInput status, next AcquireInputBufferIndex status and index, sequence |
  | acquire | AcquireOutputBufferIndex status, index and PTS, sequence                  |
  | fetch   | SetDataAndCapacity, GetOutputBuffer, ReleaseOutputBufferIndex, sequence   |

- `check()` / `checkOutput()` errors carry `retryable` when the worker has not got there yet,
  and `pending` names what it waits for, so the scheduler knows whether to read again.
- publication-metadata.js: 32 bytes of surface index, frame geometry, color space, a checksum
  over all of them, and the sequence.

## native/

Wrappers over the console's native objects: decoder, output surfaces, native TCP and the bridge
call counter.

- native-decoder.js: `create()` checks the loaded movie module against the inspected build, then
  builds a decoder, two media objects (configuration, output format) and two buffers (input,
  output) in module memory. `configure()` turns SPS/PPS into a configuration and starts the
  decoder; `close()` destroys all of it in reverse.
  - `HBL_DECODER_MODE=0..2` (probe only, values unknown): builds through
    `Decoder(type, format, DecoderMode)` from movie-mode-functions.json. That table is checked
    and verified only when the flag is set, so unset verifies and calls exactly as before.
  - Host mode: one finite worker frame per AU carries SendInput, AcquireOutput and the next
    AcquireInput; `receive()` points the output buffer at the destination surface and fetches
    in one paired exchange. Input slots are pipelined: the host polls only when the slot came
    back empty.
  - Split mode: `configure()` also creates and registers the `splitWorkerFactory` workers,
    which take over after the host-driven first frame; `close()` stops and finalizes them
    (invariant 7 still applies).
- native-sink.js: the decoder writes each frame straight into a ring surface; the sink writes
  the publication metadata, then its sequence, into the control page.
  - Host publication: `destination()` alternates surfaces 0 and 1, `publish()` writes, `wait()`
    polls until the shader applied it.
  - Worker publication: `workerDestination()` reserves a free surface per sequence until the
    shader applied it, so the decoder never writes the surface on screen or one still queued.
  - Destinations are checked to be writable mapped memory before the decoder may write them.
- native-tcp.js: `create()` listens on the host, verifies the console's socket functions and
  writes a sockaddr_in plus a random token into a console allocation; the console connects and
  sends the token with finite native jobs (invariant 14). `receive()` hands on what the console
  sends after the token.
- bridge-counter.js: `instrument` books every call to the stage the caller is in when it starts;
  `take` returns the totals since the last take and resets them. Reads and writes count one
  exchange per chunk. `silentMs` is how long the console has kept a call waiting without
  settling any (invariant 15).

## Build and test

No build step. From the repo root:

```sh
npm test                                         # whole suite; no test binds 39380
node --test src/streamer/stream/*/test/*.test.cjs
npm run typecheck                                # tsc -p tsconfig.json
```

The fake console (auto-clear events, descriptor slots) lives in worker/test/staggered-plans and
scheduler/test/staggered-live; contract tests go there. Live runs need the user at the console (`DEVICE-RULES.md` in hbl-notes).
