#!/usr/bin/env bash
# Builds hbmoonlight into BUILD (default /media/storage2/builds/moonlight/helper).
# Uses the host toolchain when the -devel packages are installed, otherwise a
# rootless podman Fedora 44 container with the same library versions.
# --bundle (always in the container) also writes BUILD/bundle: the binary, every library it
# loads and the dynamic loader, started by BUILD/bundle/hbmoonlight on any x86_64 Linux without
# podman.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
dev=${MOONLIGHT_DEV:-$(dirname "$repo")/moonlight-nx2-dev}
tests=$dev/src/streamer/protocol/test
mounts=(-v "$repo:$repo:ro")
if [ -d "$tests" ]; then
  tests=$(cd "$tests" && pwd)
  mounts+=(-v "$dev:$dev:ro")
else
  echo "build.sh: no helper tests at $tests (set MOONLIGHT_DEV)" >&2
  tests=
fi
build=${1:-/media/storage2/builds/moonlight/helper}
bundle=${2:-}
if [ -n "$bundle" ] && [ "$bundle" != --bundle ]; then
  echo "usage: build.sh [BUILD] [--bundle]" >&2
  exit 2
fi
mkdir -p "$build"
build=$(cd "$build" && pwd -P)
"$here/fetch.sh" "$build/upstream"

compile='cmake -S "$0" -B "$1/build" -DUPSTREAM_DIR="$1/upstream" -DCMAKE_BUILD_TYPE=Release \
  ${2:+-DDEV_DIR="$2"} && cmake --build "$1/build" -j"$(nproc)"'
if [ -n "$bundle" ]; then
  compile+=' && cmake -S "$0" -B "$1/bundle-build" \
     -DUPSTREAM_DIR="$1/upstream" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
  && cmake --build "$1/bundle-build" -j"$(nproc)" --target hbmoonlight \
  && rm -rf "$1/bundle" && mkdir -p "$1/bundle/bin" "$1/bundle/lib" \
  && cp "$1/bundle-build/hbmoonlight" "$1/bundle/bin/" && strip "$1/bundle/bin/hbmoonlight" \
  && ldd "$1/bundle/bin/hbmoonlight" | awk "/=> \\//{print \$3} /^\\t\\//{print \$1}" \
     | xargs -I{} cp -L {} "$1/bundle/lib/" \
  && loader=$(cd "$1/bundle/lib" && ls ld-linux-*.so.*) \
  && printf "%s\n" "#!/bin/sh" "root=\$(CDPATH= cd -- \"\$(dirname -- \"\$0\")\" && pwd)" \
     "exec \"\$root/lib/$loader\" --library-path \"\$root/lib\" \"\$root/bin/hbmoonlight\" \"\$@\"" \
     > "$1/bundle/hbmoonlight" \
  && chmod 755 "$1/bundle/hbmoonlight"'
fi
packages='opus libcurl expat uuid openssl'

if [ -z "$bundle" ] && pkg-config --exists $packages 2>/dev/null; then
  bash -c "$compile" "$here" "$build" "$tests"
else
  podman build -q -t hbmoonlight-build -f "$here/Containerfile" "$here" >/dev/null
  podman run --rm --userns=keep-id --security-opt label=disable \
    "${mounts[@]}" -v "$build:$build" \
    hbmoonlight-build bash -c "$compile" "$here" "$build" "$tests"
fi
if [ -n "$bundle" ]; then
  echo "$build/bundle/hbmoonlight"
else
  echo "$build/build/hbmoonlight"
fi
