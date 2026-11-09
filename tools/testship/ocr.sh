#!/bin/sh
set -eu
image=${T3_OCR_IMAGE:-localhost/moonlight-t3-ocr:20261109}
directory=$(dirname -- "$1")
name=$(basename -- "$1")
shift
exec podman run --rm --network=none --read-only --tmpfs /tmp \
    -v "$directory:/input:ro" "$image" "/input/$name" "$@"
