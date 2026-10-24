#!/usr/bin/env bash
# Builds hbmoonlight into BUILD (default ~/claude-builds/HBLauncher/moonlight-helper).
# Uses the host toolchain when the -devel packages are installed, otherwise a
# rootless podman Fedora 44 container with the same library versions.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
moonlight=$(dirname "$here")
build=${1:-$HOME/claude-builds/HBLauncher/moonlight-helper}
mkdir -p "$build"
build=$(cd "$build" && pwd -P)
"$here/fetch.sh" "$build/upstream"

compile='cmake -S "$0" -B "$1/build" -DUPSTREAM_DIR="$1/upstream" -DCMAKE_BUILD_TYPE=Release \
  && cmake --build "$1/build" -j"$(nproc)"'
packages='libavcodec libswscale opus libcurl expat uuid openssl'

if pkg-config --exists $packages 2>/dev/null; then
  bash -c "$compile" "$here" "$build"
else
  podman build -q -t hbmoonlight-build -f "$here/Containerfile" "$here" >/dev/null
  podman run --rm --userns=keep-id --security-opt label=disable \
    -v "$moonlight:$moonlight:ro" -v "$build:$build" \
    hbmoonlight-build bash -c "$compile" "$here" "$build"
fi
echo "$build/build/hbmoonlight"
