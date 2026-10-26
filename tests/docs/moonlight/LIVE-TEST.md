# Moonlight live-console test pass

Everything below is the PC-decode route: `hbmoonlight` decodes the Sunshine
stream on m5, `live.js` re-encodes to HBV2 and writes the ring, and the app
on the console shows it. The implemented console decoder path has its own
[native H.264 guide and validation results](NATIVE-H264.md).

## Prebuilt artifacts (rebuild only if the source changed)

- Helper: `/media/storage2/builds/HBLauncher/moonlight-helper/build/hbmoonlight`
  — rebuild: `ssh rig 'rm -rf ~/claude-builds/HBLauncher/moonlight-helper/build && cd /media/storage/own/HBLauncher && bash tools/moonlight/helper/build.sh'`
- HBV2 encoder: `~/claude-builds/HBLauncher/hbv2enc/hbv2enc`
  — rebuild: `ssh rig 'cd /media/storage/own/HBLauncher && bash tools/moonlight/build-hbv2enc.sh'`
- App shaders (HBV2): `apps/moonlight/backends/hblauncher.gpu-app/*.spv`, memory 8,695,808 bytes
  — rebuild: `ssh rig 'cd /media/storage/own/HBLauncher && SPIRV_VAL=true GLSLANG=tools/moonlight/glslang-shim.sh node apps/moonlight/build.js'`

## On the console

1. Fully close and reopen SmileBASIC, then `./start.sh --app moonlight`
   (optionally `HB_PIPELINE=4`). The app now needs 8.5 MB of private memory;
   `live.js` refuses the session if it sees the old smaller app, which means
   the console is still running a pre-HBV2 build — tap **Refresh** in the
   launcher and relaunch, or reinstall the app.
2. Wait for the HBV2 test card, then the steps below from m5.

## Tests (m5, in order)

### 1. HBV2 video, desktop

```
node tools/moonlight/live.js --moonlight 192.168.8.245 Desktop --codec hbv2 --budget 96 --no-input --no-audio
```

Look at the console. Desktop text should be sharp (not the HBV1 blur). Per-second
stats print `kib`, `qp`, `encodeMs`, `applied`. Expected ~59 fps on the wired link.

**If the app fails to launch or the screen stays on the test card:** the compute
shader uses `HBV2_LOCAL_SIZE=512` (`LOCAL_SIZE` in hbl-moonlight's
`tools/moonlight/ring.js`). NVIDIA drivers report a
`maxComputeWorkGroupInvocations` of 1024, so the size is unlikely to be the
cause; `docs/moonlight/HIGH-FPS.md` explains why 512 and not 1024.

### 2. Add input (controller + touch)

```
node tools/moonlight/live.js --moonlight 192.168.8.245 Desktop --codec hbv2 --budget 96 --no-audio
```

Move the sticks / tap the screen; the cursor on the host desktop should follow.
Touch is sent as native multi-touch. B and Minus reach the game; hold Plus and
Minus together for one second to return to the launcher.

### 3. Add audio

```
node tools/moonlight/live.js --moonlight 192.168.8.245 Desktop --codec hbv2 --budget 96
```

Sound should play. `game-audio.js` opens AudioOut only for a package with
effects and closes it otherwise, so the stream owns the device while Moonlight
runs. If `OpenDefaultAudioOut` still fails, the audio-stream process prints a
hint and exits but video+input keep running.

### 4. A real game

Pick a game from `hbmoonlight list 192.168.8.245` (Steam Big Picture, Kameo, …)
and swap it for `Desktop` above. Expect ~59 fps at a steady budget; raise
`--budget`/`--cap` for sharper stills at the cost of fps on a slower link.

## Known follow-ups (not blockers)

- After launch/resync the picture sharpens over ~8 s as refresh chunks heal
  static blocks; raise `--refresh` to speed it.
- AudioOut sharing with game-audio is untested live (above).

## Console native decode

`live.js --moonlight HOST APP --codec h264` connects raw H.264 on FD 4 to the
console movie decoder. PCM audio stays on FD 3 and controller/touch JSON stays
on stdin. See [NATIVE-H264.md](NATIVE-H264.md) for setup and current limits.
