# src/streamer/protocol

`hbmoonlight`, the Moonlight protocol client (C, GPLv3) on moonlight-common-c and libgamestream.
README.md (hbmoonlight) has its commands and options.

- `build.sh [BUILD]` builds natively with the -devel packages, else in the rootless podman
  image from `Containerfile`. `fetch.sh` pins the upstream commits.
- `test/` holds the input-routing and app-order checks; CMake builds them when `DEV_DIR` has
  them, and `ctest` in the build dir runs them.
- `stream/session/protocol-binary.js` pins the binary the streamer runs. Bump that pin with
  each helper build; binaries differ by the build-dir path in libgamestream, so compare the
  source tree, not the hash.
