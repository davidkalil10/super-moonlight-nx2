#!/usr/bin/env bash
# Builds the native HBV2 encoder. Output: $HBV2_BUILD (default
# ~/claude-builds/HBLauncher/hbv2enc)/hbv2enc plus build-info.txt.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${HBV2_BUILD:-$HOME/claude-builds/HBLauncher/hbv2enc}
cc=${CC:-gcc}
flags=(-O3 -march=native -fopenmp -Wall -Wextra)
mkdir -p "$out"
"$cc" "${flags[@]}" -o "$out/hbv2enc" "$here/hbv2enc.c" -lm
{
  echo "revision: $(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "command: $cc ${flags[*]} hbv2enc.c -lm"
  echo "arch: $(uname -m), builder: $(hostname), $(date -Iseconds)"
} >"$out/build-info.txt"
echo "$out/hbv2enc"
