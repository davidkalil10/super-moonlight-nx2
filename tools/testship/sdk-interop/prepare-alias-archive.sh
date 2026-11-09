#!/bin/sh
# Builds the four-alias libouncevk.a copy from the pinned SDK archive, fail closed (README.md).
# Exit 0: qualified archive published. 1: failed gate. 2: usage or invalid output path.
set -eu

usage() {
    echo "usage: prepare-alias-archive.sh --devkitpro <root> --out <new dir> [--archive <libouncevk.a>] [--tool-prefix <prefix>]" >&2
    exit 2
}

ROOT="" OUT="" ARCHIVE="" BIN=""
while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || usage
    case $1 in
        --devkitpro) ROOT=$2 ;;
        --out) OUT=$2 ;;
        --archive) ARCHIVE=$2 ;;
        --tool-prefix) BIN=$2 ;;
        *) usage ;;
    esac
    shift 2
done
[ -n "$ROOT" ] && [ -n "$OUT" ] || usage
ARCHIVE=${ARCHIVE:-$ROOT/portlibs/switch2/lib/libouncevk.a}
BIN=${BIN:-$ROOT/devkitA64/bin/aarch64-none-elf}
LIB=$(cd "$(dirname "$0")/lib" && pwd)
ARCHIVE=$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")
OUT=$(python3 -B - "$ROOT" "$ARCHIVE" "$OUT" <<'PY'
import os
import sys
from pathlib import Path

if os.path.lexists(sys.argv[3]):
    sys.exit(f"prepare: {sys.argv[3]} already exists")
sdk, archive, output = (Path(p).resolve() for p in sys.argv[1:])
protected = (sdk, archive.parent)
if any(output == p or p in output.parents for p in protected):
    sys.exit("prepare: output must be outside the SDK and archive directory")
if os.path.lexists(output):
    sys.exit(f"prepare: {output} already exists")
print(output)
PY
) || exit 2

if [ -e "$OUT" ]; then
    echo "prepare: $OUT already exists" >&2
    exit 2
fi
mkdir -p "$(dirname "$OUT")"
eval "$(python3 -B "$LIB/pins.py" --shell)"
WORK=$(mktemp -d "$OUT.work.XXXXXX")
LOGS=$WORK/logs
mkdir "$LOGS"

fail() {
    echo "prepare: FAIL $1 (logs kept in $LOGS)" >&2
    exit 1
}

sha_gate() {
    got=$(sha256sum "$1" | cut -d' ' -f1)
    echo "sha256 $1: got $got want $2" >> "$LOGS/hashes.txt"
    [ "$got" = "$2" ]
}

{
    echo "archive=$ARCHIVE"
    "$BIN-objcopy" --version | head -1
    "$BIN-ar" --version | head -1
    "$BIN-ranlib" --version | head -1
    "$BIN-readelf" --version | head -1
    python3 --version
} > "$LOGS/tools.txt" 2>&1 || fail "toolchain not runnable"
grep -q '^GNU objcopy' "$LOGS/tools.txt" || fail "objcopy is not GNU objcopy"
grep -q '^GNU ar' "$LOGS/tools.txt" || fail "ar is not GNU ar"
grep -q '^GNU ranlib' "$LOGS/tools.txt" || fail "ranlib is not GNU ranlib"
grep -q '^GNU readelf' "$LOGS/tools.txt" || fail "readelf is not GNU readelf"

sha_gate "$ARCHIVE" "$SDK_ARCHIVE_SHA" || fail "SDK archive hash"
(cd "$WORK" && "$BIN-ar" x "$ARCHIVE" "$MEMBER" && mv "$MEMBER" original.o) || fail "member extraction"
sha_gate "$WORK/original.o" "$MEMBER_SHA" || fail "original member hash"
python3 -B "$LIB/objident.py" "$BIN-readelf" "$WORK/original.o" original > "$LOGS/ident-original.txt" 2>&1 \
    || fail "original identity"

"$BIN-objcopy" $ADD_SYMBOLS "$WORK/original.o" "$WORK/$MEMBER" > "$LOGS/objcopy.txt" 2>&1 || fail "objcopy"
python3 -B "$LIB/objident.py" "$BIN-readelf" "$WORK/$MEMBER" aliased > "$LOGS/ident-aliased.txt" 2>&1 \
    || fail "alias identity"
python3 -B "$LIB/sectcmp.py" "$WORK/original.o" "$WORK/$MEMBER" > "$LOGS/sectcmp.txt" 2>&1 \
    || fail "symbol-only comparison"
sha_gate "$WORK/$MEMBER" "$ALIAS_MEMBER_SHA" || fail "alias member hash"

cp "$ARCHIVE" "$WORK/libouncevk.a"
(cd "$WORK" && "$BIN-ar" rD libouncevk.a "$MEMBER" && "$BIN-ranlib" -D libouncevk.a) > "$LOGS/ar.txt" 2>&1 \
    || fail "archive update"
mkdir "$WORK/check"
members=$("$BIN-ar" t "$WORK/libouncevk.a")
echo "members: $members" > "$LOGS/member.txt"
[ "$members" = "$MEMBER" ] || fail "archive members"
(cd "$WORK/check" && "$BIN-ar" x "$WORK/libouncevk.a" "$MEMBER") || fail "member round trip"
cmp "$WORK/check/$MEMBER" "$WORK/$MEMBER" >> "$LOGS/member.txt" 2>&1 || fail "member round trip"
sha_gate "$WORK/libouncevk.a" "$ALIAS_ARCHIVE_SHA" || fail "alias archive hash"
sha_gate "$ARCHIVE" "$SDK_ARCHIVE_SHA" || fail "SDK archive changed during preparation"

mkdir "$OUT"
mv "$WORK/libouncevk.a" "$LOGS" "$OUT/"
echo "working evidence retained at $WORK" > "$OUT/logs/working-directory.txt"
echo "prepare: OK $OUT/libouncevk.a $ALIAS_ARCHIVE_SHA"
