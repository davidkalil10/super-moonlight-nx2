# Moonlight audio: continuous PCM to the console AudioOut

`tools/moonlight/audio-stream.cjs` plays the Moonlight helper's audio on the
console. It is the audio counterpart of `live.cjs` (video) and lives beside it
in `tools/moonlight/` as a manual tool driven against a session dir, not a
`start-launcher.js` stage. See `DESIGN.md` section 4 item 5 for the live check
this feeds.

## What it does

It reuses `game-audio.js`'s console path exactly: the same sound-memory
allocation call (`rpc.call(5732112, ...)`), the same function resolution
(`audio-symbols.json` + `hbl-platform/smilebasic/reference/sdk-checks.js` `verify-function`),
and the same AudioOut sequence (InitializeAudioOutParameter at 48000 Hz / 2 ch,
OpenDefaultAudioOut, Start/Stop, SetAudioOutBufferInfo, AppendAudioOutBuffer,
GetReleasedAudioOutBuffer, FlushAudioOutBuffers, GetAudioOutBufferCount,
CloseAudioOut). Unlike `game-audio.js`, which plays short pre-uploaded effects
triggered by a shader counter, this keeps a ring of AudioOut buffers
continuously fed from a byte stream.

## Interface

```
node tools/moonlight/audio-stream.cjs [runs/launcher-XXXX] [--fd N | --file PATH]
     [--buffer-frames 3840] [--queue 3] [--prime 2]
```

- Session dir: first positional arg, else the newest `runs/launcher-*`.
- Input (interleaved 48 kHz stereo s16le): `--fd N` reads an inherited fd,
  `--file PATH` reads a file (offline test), default is stdin. stdin is the
  simplest fit for how `live.cjs` spawns a child, so it is the default.
- On exit it writes `moonlight-audio-<ts>.json` in the session dir with the
  stat counters below (feed.cjs-style timestamped name, so it is re-runnable).

Programmatic: `stream({rpc, input, bufferFrames, queue, prime, maxPending,
sleep, now})` returns `{done, stop, stats}`. `done` resolves with the stats when
the input ends or `stop()` is called; `stop()` tears down cleanly.

## Buffer and latency scheme

- A buffer is `bufferFrames` frames; default 3840 frames = 15360 bytes =
  **80 ms** (the task's "20 ms" label is wrong; 3840 frames at 48 kHz is 80 ms).
- 8 descriptors at `base+0x400+i*0x40`, 8 PCM slots at `base+0x10000+i*0x4000`.
  Slot stride is 16384 (0x1000-aligned, as nn::audio requires for the buffer
  pointer and `bufferSize`); `SetAudioOutBufferInfo` registers bufferSize 16384,
  dataSize 15360. A 15360-byte write is one 32 KiB RPC exchange; the module
  asserts the buffer stays within one exchange and the slot stays page aligned.
- `SetAudioOutBufferInfo` is called once per descriptor at init, never per
  append: descriptor i always points at slot i with a constant size, so each
  cycle is just one write (fresh PCM into the slot) plus one append, ~12.5
  buffers/s x 2 = ~25 exchanges/s. The loop also polls
  GetReleasedAudioOutBuffer, but buffers are modelled as releasing sequentially
  (`releaseAt` is cumulative, not `now + bufferMs`) and the idle wait is floored
  at `bufferMs / 8`, so polling stays near one call per buffer (~40 total for 20
  buffers in the test) instead of spinning once per round trip. Total audio load
  is therefore ~35 exchanges/s, within DESIGN.md's budget.
- Priming: queue `prime` buffers, then StartAudioOut once. Steady state keeps at
  most `queue` buffers in flight. Added latency is about
  `queue x bufferMs + one exchange` (3 x 80 + ~13 = ~250 ms by default; drop
  `--queue`/`--buffer-frames` to trade robustness for latency).
- Host ring cap `maxPending = (queue + 2) x bufferBytes`. The reader is never
  paused; when the helper floods faster than the console drains, the oldest
  whole buffers are dropped (`overruns`, `droppedBytes`) to bound latency. When
  the reader starves after Start, `underruns` counts each gap (one per episode);
  playback resumes automatically when PCM returns. A short tail at EOF is padded
  with silence and flushed.

Stats: `appended, released, written, underruns, overruns, droppedBytes, tail,
receivedBytes`.

## Spawning alongside the helper

`live.cjs` already spawns `hbmoonlight` for video. Audio is a sibling process.
Do not edit `live.cjs`; the intended wiring (an audio pipe on an extra stdio
slot, piped to this module's stdin) is:

```js
const helper = spawn(HELPER, ['stream', host, app, '--audio-fd', '3', /* ... */],
  {stdio: ['pipe', 'pipe', 'pipe', 'pipe']});
spawn(process.execPath, ['tools/moonlight/audio-stream.cjs', dir],
  {stdio: [helper.stdio[3], 'inherit', 'inherit']});
```

Standalone, with a FIFO:

```
mkfifo /tmp/hbaudio
hbmoonlight stream HOST APP --audio-fd 3 3>/tmp/hbaudio &
node tools/moonlight/audio-stream.cjs runs/launcher-XXXX < /tmp/hbaudio
```

## Not yet tested on a live console

- AudioOut ownership. `game-audio.js` opens AudioOut on the first effect and
  closes it when the running package has none, so with Moonlight in front this
  module should be the only owner. Whether the console allows two concurrently
  is still unverified (DESIGN.md section 4 item 1). On a non-zero
  OpenDefaultAudioOut the module prints a hint naming `game-audio.js`.
- Underrun/latency with real Wi-Fi jitter and the real helper's drop behaviour
  (DESIGN.md section 4 item 5), sharing the exchange budget with video. The
  `underruns` counter is a host-side proxy (in-flight hitting 0 at poll time)
  and under-counts gaps shorter than a poll; the honest live measurement is
  GetAudioOutBufferCount reaching 0 or GetAudioOutPlayedSampleCount deltas.

Offline, verified with `tools/moonlight/audio-stream.test.cjs`: priming and
start order, back-to-back in-order appends across ring wraparound, descriptor
recycling via GetReleasedAudioOutBuffer, a descriptor never re-appended while
queued, bounded host ring + overrun counting under flood, underrun counting and
recovery under starvation, silence-padded tail at EOF, and clean SIGINT/EOF
teardown (Stop, Flush, drain, GetAudioOutBufferCount 0, Close).
