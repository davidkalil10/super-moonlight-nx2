# src/streamer/protocol

`hbmoonlight`, the Moonlight protocol client (C, GPLv3) on moonlight-common-c and libgamestream.
README.md (hbmoonlight) has its commands and options. It decodes nothing: a stream writes every
access unit to `--raw-fd` and the console decodes it, so the helper needs no FFmpeg.

- `build.sh [BUILD]` builds natively with the -devel packages, else in the rootless podman
  image from `Containerfile`. `fetch.sh` pins the upstream commits. BUILD defaults to
  `/media/storage2/builds/moonlight/helper`; give each build its own directory.
- `build.sh BUILD --bundle` (container only) also links `bundle-build/` and copies every
  library `ldd` lists, `ld-linux` included, into `bundle/`.
- The dev repo's `src/streamer/protocol/test/` holds input-routing, app-order, stream-codec
  (`args.c`) and negotiated-codec (`video-codec.c`, setup refuses a different codec) checks.
  `DEV_DIR` defaults to that directory beside the app (build.sh passes it, `MOONLIGHT_DEV`
  overrides); CMake warns when it has no tests, and `ctest` in the build dir runs them.
- Client keys live in `$XDG_CONFIG_HOME/moonlight-nx2`; while that directory is missing,
  `session.c` keeps using an existing `hblauncher/moonlight`, so a pairing made before the
  rename still works.
- `session/protocol-binary.js` pins the binary the streamer runs. Bump that pin with
  each helper build; binaries differ by the build-dir path in libgamestream, so compare the
  source tree, not the hash.
