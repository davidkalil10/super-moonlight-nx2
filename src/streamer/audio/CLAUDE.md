# src/streamer/audio

Moonlight PCM (48 kHz stereo s16le) to the console AudioOut; caveats in root CLAUDE.md ("Input
and audio"). Test from the repo root: `node --test src/streamer/audio/test/audio.test.cjs`.

## Two paths

- **Bridge (audio-stream.js):** the host writes each chunk into its slot over the bridge and
  appends it in the same exchange when the rpc can. Releases are not signalled: each buffer
  gets an expected release time on a host playhead, and GetReleasedAudioOutBuffer is polled
  only for buffers that should be done. It runs standalone on a run dir (stdin, `--fd N` or
  `--file PATH`; `--buffer-frames 3840 --queue 3 --prime 2 --stats`).
- **Socket (socket-audio-source.js, audio-socket-worker.js, audio-socket-plan.js):** PCM goes
  over native TCP and a console worker recvs it straight into two AudioOut slots.

## Rules

1. Prime: one recv per slot, then one append per slot only when both recvs were whole; a short
   recv never reaches AudioOut. start() runs once, since a failed prime may have queued a slot.
2. The recycle worker, per slot: wait for the release event, take the released buffer, recv
   into it, append it. It blocks in recv and in the wait, so stop() points it at its exit and
   sends two silent chunks before waiting and joining.
3. While a native job or the worker may still hold the AudioOut, or once the watched rpc saw
   the bridge go, the objects are retained, never closed; the report asks for a restart.
4. The source sends one chunk per chunk duration on its own clock, silence when the queue is
   dry, so the worker never starves. Past maxPending the oldest whole chunks drop; `tone`
   replaces the input with 500 Hz but still drains it.
5. A pacer stall longer than both slots refills them at once and skips the rest in whole chunks.
   That many chunks are later trimmed from the queue head on on-time sends with a spare chunk
   queued (within SETTLE_MS), so they are not kept as latency; they count in droppedBytes.
