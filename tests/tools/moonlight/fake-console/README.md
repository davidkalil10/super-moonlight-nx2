# Fake console

A stand-in for a running Moonlight app so `live.js` and `feed.js` can be
developed and their resync path tested without a console. `shared/rpc.cjs`
simulates the bridge: one serial link of 32 KiB exchanges at `RATE` bytes/s
whose concurrent writes interleave at random, and a 60 Hz dispatch that runs the
real JS HBV2 decoder over the ring and writes back `applied`.

```sh
# Steady state on the measured 5.7 MB/s link
node ../hbl-moonlight/tools/moonlight/live.js tools/moonlight/fake-console \
  --input clip.mp4 --codec hbv2 --budget 64

# Force a 1.5 s stall at t=4 s and watch the sender resync with a keyframe
STALL=1500@4000 node ../hbl-moonlight/tools/moonlight/live.js tools/moonlight/fake-console \
  --input clip.mp4 --codec hbv2 --budget 64
```

Env: `RATE` (link bytes/s, default 5.7e6), `STALL=ms@at` (pause the dispatch
once), `DECODE=1` (run the full pixel decode instead of the light apply). This
is a host-side test harness only; it is not the console RPC.

`shared/console.cjs` is a separate, byte-level model: it mirrors the
`bootstrap.bas` `RPC()` loop for console protocols 1/2/3 (header + data recv,
response framing, `memmove`/read/QueryMemory dispatch) over a flat memory
buffer, so the real host (`native.cjs` over a `Connection`) can be round-tripped
without a console. `../protocol3.test.cjs` drives it.

## Over HTTP (`bridge.cjs`)

`bridge.cjs DIR` serves the same fake console through the real bridge
(`hbl-platform/smilebasic/engine/lib/bridge.js`) and writes a run directory there, so tools
that speak the bridge protocol (the native `hbmoonlight-host`, or `live.js` /
`input-feeder.js` through a copy of the real `shared/rpc.cjs`) pay the same
HTTP, JSON and base64 costs as on a console. It also simulates the sound-memory
allocation and an AudioOut that plays appended buffers in real time (underruns
are counted), and `--pad` cycles a scripted controller + touch state.

```sh
HB_PIPELINE=2 RATE=12e6 node tools/moonlight/fake-console/bridge.cjs /tmp/fake --pad &
node ../hbl-moonlight/tools/moonlight/live.js /tmp/fake --input clip.mp4 --codec hbv2 --budget 64
```
