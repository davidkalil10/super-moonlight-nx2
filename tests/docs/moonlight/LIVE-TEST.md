# Moonlight live-console test pass

Everything below is the PC-decode route: `hbmoonlight` decodes the Sunshine
stream on m5, `live.cjs` re-encodes to HBV2 and writes the ring, and the app
on the console shows it. Console-side hardware decode is a separate, unbuilt
path (see the raw-H.264 feed note at the end).

## Prebuilt artifacts (rebuild only if the source changed)

- Helper: `/media/storage2/builds/HBLauncher/moonlight-helper/build/hbmoonlight`
  — rebuild: `ssh rig 'rm -rf ~/claude-builds/HBLauncher/moonlight-helper/build && cd /media/storage/own/HBLauncher && bash tools/moonlight/helper/build.sh'`
- HBV2 encoder: `~/claude-builds/HBLauncher/hbv2enc/hbv2enc`
  — rebuild: `ssh rig 'cd /media/storage/own/HBLauncher && bash tools/moonlight/build-hbv2enc.sh'`
- App shaders (HBV2): `apps/moonlight/*.spv`, memory 8,695,808 bytes
  — rebuild: `ssh rig 'cd /media/storage/own/HBLauncher && SPIRV_VAL=true GLSLANG=tools/moonlight/glslang-shim.sh node apps/moonlight/build.cjs'`

## On the console

1. Fully close and reopen SmileBASIC, then `./start.sh --app moonlight`
   (optionally `HB_PIPELINE=4`). The app now needs 8.5 MB of private memory;
   `live.cjs` refuses the session if it sees the old smaller app, which means
   the console is still running a pre-HBV2 build — tap **Refresh** in the
   launcher and relaunch, or reinstall the app.
2. Wait for the HBV2 test card, then the steps below from m5.

## Tests (m5, in order)

### 1. HBV2 video, desktop
```
node tools/moonlight/live.cjs --moonlight 192.168.8.245 Desktop --codec hbv2 --budget 96 --no-input --no-audio
```
Look at the console. Desktop text should be sharp (not the HBV1 blur). Per-second
stats print `kib`, `qp`, `encodeMs`, `applied`. Expected ~59 fps on the wired link.

**If the app fails to launch or the screen stays on the test card:** the compute
shader uses `HBV2_LOCAL_SIZE=1024`, which may exceed the console's
`maxComputeWorkGroupInvocations`. Rebuild the app with 512 and relaunch:
```
ssh rig 'cd /media/storage/own/HBLauncher && SPIRV_VAL=true GLSLANG=tools/moonlight/glslang-shim.sh HBV2_LOCAL_SIZE=512 node apps/moonlight/build.cjs'
```
(the build reads `HBV2_LOCAL_SIZE` from ring.cjs; set it in the env or edit
`apps/moonlight/shaders/ring.glsl` line 13.)

### 2. Add input (controller + touch)
```
node tools/moonlight/live.cjs --moonlight 192.168.8.245 Desktop --codec hbv2 --budget 96 --no-audio
```
Move the sticks / tap the screen; the cursor on the host desktop should follow.
Touch is sent as native multi-touch. **Caveat:** B or Minus still exits the app
(the app's compute shader returns to the launcher on those), so avoid them until
that is changed.

### 3. Add audio
```
node tools/moonlight/live.cjs --moonlight 192.168.8.245 Desktop --codec hbv2 --budget 96
```
Sound should play. **Caveat:** `start-launcher.cjs` already runs `game-audio.cjs`,
which holds one AudioOut open; this opens a second. If `OpenDefaultAudioOut`
fails, the audio-stream process prints a hint and exits but video+input keep
running. If so, we run the Moonlight route without the effects stage.

### 4. A real game
Pick a game from `hbmoonlight list 192.168.8.245` (Steam Big Picture, Kameo, …)
and swap it for `Desktop` above. Expect ~59 fps at a steady budget; raise
`--budget`/`--cap` for sharper stills at the cost of fps on a slower link.

## Known follow-ups (not blockers)
- B/Minus exit: change the app's exit chord (needs a shader rebuild).
- After launch/resync the picture sharpens over ~8 s as refresh chunks heal
  static blocks; raise `--refresh` to speed it.
- Two concurrent AudioOut (above).

## Console hardware decode (separate, unbuilt)
`hbmoonlight stream HOST APP --raw-h264-fd 3 3>feed.h264` emits the raw Annex-B
H.264 bitstream (SPS/PPS first, each access unit tagged on stderr) with no PC
decode. That is the feed for a console-side video-decode path; the decode calls
and their wiring into the app are not part of this repo.
