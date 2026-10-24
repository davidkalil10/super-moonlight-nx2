#!/usr/bin/env bash
# glslangValidator -V -Os -g0 --target-env vulkan1.0 SRC -o OUT, via glslc.
src= out=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --target-env) shift 2 ;;
    -*) shift ;;
    *) src=$1; shift ;;
  esac
done
exec glslc -Os --target-env=vulkan1.0 "$src" -o "$out"
