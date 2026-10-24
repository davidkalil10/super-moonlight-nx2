#!/usr/bin/env bash
# Fetches the pinned upstream sources (GPLv3) the helper links against.
# Usage: fetch.sh DEST
set -euo pipefail

dest=${1:?usage: fetch.sh DEST}

checkout() {
  local url=$1 commit=$2 dir=$3
  if [ ! -d "$dir/.git" ]; then
    git clone -q --no-checkout "$url" "$dir"
  fi
  if ! git -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null; then
    git -C "$dir" fetch -q origin
  fi
  git -C "$dir" checkout -q --detach "$commit"
}

mkdir -p "$dest"
checkout git@github.com:moonlight-stream/moonlight-embedded.git \
  f32e415aea6797d261d6b470dcf8bf18727341c2 "$dest/moonlight-embedded"
checkout git@github.com:moonlight-stream/moonlight-common-c.git \
  b126e481a195fdc7152d211def17190e3434bcce "$dest/moonlight-common-c"
checkout git@github.com:cgutman/enet.git \
  dea6fb5414b180908b58c0293c831105b5d124dd "$dest/moonlight-common-c/enet"
