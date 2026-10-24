#!/bin/sh
# Writes the decoder event probe's offline clips into $1: an I/P stream like Sunshine's
# low-latency output and a two-B-frame stream that reorders. Each clip.h264 comes with
# clip.json (per-AU display index in decode order) and clip-reference.nv12 (display order).
set -eu
out=${1:?usage: make-decoder-clips.sh <directory>}
mkdir -p "$out"
source="testsrc2=size=128x96:rate=60:duration=1"
encode() {
  name=$1
  shift
  ffmpeg -v error -y -f lavfi -i "$source" -pix_fmt yuv420p -c:v libx264 "$@" \
    -video_track_timescale 60 "$out/$name.mp4"
  ffmpeg -v error -y -i "$out/$name.mp4" -c copy -bsf:v h264_mp4toannexb -f h264 "$out/$name.h264"
  ffmpeg -v error -y -i "$out/$name.h264" -f rawvideo -pix_fmt nv12 "$out/$name-reference.nv12"
  ffprobe -v error -select_streams v -show_entries packet=pts -of csv=p=0 "$out/$name.mp4" |
    node -e '
      const pts = require("fs").readFileSync(0, "utf8").trim().split("\n").map(Number);
      const first = Math.min(...pts);
      console.log(JSON.stringify({width: 128, height: 96, display: pts.map(p => p - first)}));
    ' >"$out/$name.json"
}
encode ip -preset veryfast -tune zerolatency -bf 0 -g 30
encode b2 -preset veryfast -bf 2 -g 30 -x264-params b-pyramid=0
