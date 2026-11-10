#!/bin/sh
# Runs inside the build image: lists what the binaries load and copies those packages'
# licence texts. Usage: collect-notices.sh OUT BINARY...
set -eu
out=$1
shift
mkdir -p "$out/licenses"
: > "$out/libraries.tsv"
for binary in "$@"; do
  objdump -p "$binary" | awk '$1 == "NEEDED" {print $2}'
done | sort -u | while read -r library; do
  path=$(ldconfig -p | awk -v name="$library" '$1 == name {print $NF; exit}')
  package=$(rpm -qf --qf '%{NAME}' "$path")
  printf '%s\t%s\t%s\t%s\n' "$library" "$package" \
    "$(rpm -q --qf '%{VERSION}-%{RELEASE}' "$package")" "$(rpm -q --qf '%{LICENSE}' "$package")" \
    >> "$out/libraries.tsv"
  mkdir -p "$out/licenses/$package"
  rpm -qL "$package" | while read -r text; do
    [ -f "$text" ] && cp "$text" "$out/licenses/$package/"
  done
done
{
  for tool in rustc cargo bindgen clang cmake gcc; do
    printf '%s\t%s\n' "$tool" "$($tool --version | head -n 1)"
  done
} > "$out/toolchain.tsv"
