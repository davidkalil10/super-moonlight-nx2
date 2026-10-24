#!/bin/sh
# Writes the decoder event probe's offline clips into $1:
#   ip      128x96, an I/P stream like Sunshine's low-latency output
#   b2      128x96, two B-frames, so the decoder reorders
#   ip1080  1920x1080 High, no B-frames, single-frame VBV at 20 Mbps like Sunshine,
#           zooming fractal with grain so every frame carries motion and detail
# Each clip.h264 comes with clip.json (per-AU display index in decode order) and
# clip-reference.nv12 (display order). ip1080's reference holds only every tenth frame and
# the last one, listed in clip.json as references.
set -eu
out=${1:?usage: make-decoder-clips.sh <directory>}
mkdir -p "$out"
small="testsrc2=size=128x96:rate=60:duration=1"
large="mandelbrot=size=1920x1080:rate=60,noise=alls=6:allf=t,trim=end_frame=120"

encode() {
  name=$1
  source=$2
  pick=$3
  shift 3
  ffmpeg -v error -y -f lavfi -i "$source" -pix_fmt yuv420p -c:v libx264 "$@" \
    -video_track_timescale 60 "$out/$name.mp4"
  ffmpeg -v error -y -i "$out/$name.mp4" -c copy -bsf:v h264_mp4toannexb -f h264 "$out/$name.h264"
  ffmpeg -v error -y -i "$out/$name.h264" -vf "select='$pick'" -fps_mode passthrough \
    -f rawvideo -pix_fmt nv12 "$out/$name-reference.nv12"
  ffprobe -v error -select_streams v -show_entries packet=pts -of csv=p=0 "$out/$name.mp4" |
    PICK="$pick" node -e '
      const pts = require("fs").readFileSync(0, "utf8").trim().split("\n").map(Number);
      const first = Math.min(...pts);
      const display = pts.map(p => p - first);
      const result = {display};
      if (process.env.PICK !== "1") {
        const last = display.length - 1;
        result.references = display
          .map((_, n) => n)
          .filter(n => n % 10 === 0 || n === last);
      }
      console.log(JSON.stringify(result));
    ' >"$out/$name.json"
}

encode ip "$small" 1 -preset veryfast -tune zerolatency -bf 0 -g 30
encode b2 "$small" 1 -preset veryfast -bf 2 -g 30 -x264-params b-pyramid=0
encode ip1080 "$large" 'not(mod(n\,10))+eq(n\,119)' -profile:v high -preset veryfast \
  -tune zerolatency -bf 0 -g 30 -x264-params scenecut=0 -b:v 20M -maxrate 20M -bufsize 333k
