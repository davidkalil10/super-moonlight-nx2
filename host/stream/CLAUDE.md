# host/stream

The video path: Sunshine through the helper into the console's `movie::Decoder`, scheduled by the
host one access unit (AU) at a time. Root CLAUDE.md has the decoder facts and measurements; this
file has the contract the code must keep. Code comments point here instead of restating it.

## Pipeline

```
Sunshine ──RTP──> hbmoonlight (helper.js, $HBMOONLIGHT) ──AU pipe──> native-h264.js
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
4. Lag 0: N-1 is acquired and fetched before gate N opens. A decoder-wait timeout stops the
   run (`lag0-timeout`) instead of falling back to another lag mid-run.
5. A descriptor the worker can reach before its checked gate write names the ignored fetch
   gate, so a stop wake cannot open a fetch.
6. Submit N only after N-1's acquire ack. Release N-2 first. The ack starts signalled for N=1,
   standing in for the host-decoded IDR.
7. Stop rewrites the dispatches to the exit frame before it signals, so a stop wake never
   reaches SendInput.
8. A worker or job that may still run is retained, never closed (contract above).
9. Sequences restart per generation; the gate queue lives with the held unit.
10. The bridge runs each rpc POST in arrival order, not call order, so prime and gate writes
    go through one chain (`inOrder`). Reads stay outside it.
11. A queued gate write covers both descriptors: it carries the primed unit, never zeroes it.
12. A drain also stamps the next output's placeholder, so the last tail output acquires under
    its own sequence, not the one its slot held two AUs earlier.
13. The output worker acks only after its stamps, so the next SendInput can't race the
    host-visible acquire status.
14. `current` is stored before `nativeApplied`: retry a torn status read once; a repeat means
    a wrong surface.
15. Native TCP accepts only the connection that presents the token, and nothing closes while a
    console job may still use the socket.
16. A backlog while the console is silent is the console's: past CONSOLE_STALL_MS the stream
    stops (`console-stalled`) instead of asking Sunshine for a keyframe.
17. Lag 0 needs a stream that cannot reorder: the SPS (h264-sps.js, E.2.1) or a B slice
    refuses it (`lag0-reorder`). An unreadable SPS refuses too.

## Flags (native-h264.js checkFlags; live.js passes them through)

| flag                         | does                                                         | default           |
| ---------------------------- | ------------------------------------------------------------ | ----------------- |
| `--output-lag 0\|1\|2`       | fetch each output 0/1/2 gates after its decode opened        | 2                 |
| `--skip-backlog N\|off`      | skip an output once more than N units are queued             | 2 (1 under vsync) |
| `--skip-rule backlog\|vsync` | publish by backlog, or by the predicted vsync                | backlog           |
| `--trim-backlog-ms N`        | skip one output after 3 gates whose unit in hand is N ms old | off               |
| `--gate-on-receive`          | prime and gate N when it arrives, not on N+1 (60 Hz)         | off               |
| `--gate-queue`               | run those gates off push(), at most one unit primed ahead    | off               |
| `--decode-wait`              | sleep through a pending acquire (vsync rule only)            | off               |
| `--receive-wait`             | sleep through a predicted receive (receive-wait.js)          | off               |
| `--avoid-window B-A`         | keep status reads out of a span around the predicted vsync   | off               |
| `--present-hz 60\|120`       | present rate                                                 | 60                |
| `--surface-check K`          | hash every Kth fetched surface; a torn re-read fails the run | 0 (off)           |

Refusals: lag 0 with `--gate-on-receive`, `--gate-queue` or 120 Hz; `--gate-queue` without
`--gate-on-receive`; `--gate-on-receive` at 120 Hz.

## Build and test

No build step. From `tests/`:

```sh
npm test                                         # whole suite; no test binds 39380
node --test tools/moonlight/staggered-plans.test.cjs tools/moonlight/staggered-live.test.cjs \
  tools/moonlight/native-h264.test.cjs tools/moonlight/stream.test.cjs tools/moonlight/h264-sps.test.cjs
npm run typecheck                                # tsc -p tsconfig.json
```

The fake console (auto-clear events, descriptor slots) lives in the staggered-plans and
staggered-live tests; contract tests go there. Live runs need the user at the console (`DEVICE-RULES.md` in hbl-notes).
