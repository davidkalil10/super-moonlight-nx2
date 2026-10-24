# Fake console

A stand-in for a running Moonlight app so `live.cjs` and `feed.cjs` can be
developed and their resync path tested without a console. `shared/rpc.cjs`
simulates the bridge: one serial link of 32 KiB exchanges at `RATE` bytes/s
whose concurrent writes interleave at random, and a 60 Hz dispatch that runs the
real JS HBV2 decoder over the ring and writes back `applied`.

```sh
# Steady state on the measured 5.7 MB/s link
node tools/moonlight/live.cjs tools/moonlight/fake-console \
  --input clip.mp4 --codec hbv2 --budget 64

# Force a 1.5 s stall at t=4 s and watch the sender resync with a keyframe
STALL=1500@4000 node tools/moonlight/live.cjs tools/moonlight/fake-console \
  --input clip.mp4 --codec hbv2 --budget 64
```

Env: `RATE` (link bytes/s, default 5.7e6), `STALL=ms@at` (pause the dispatch
once), `DECODE=1` (run the full pixel decode instead of the light apply). This
is a host-side test harness only; it is not the console RPC.
