#!/bin/sh
# Writes the decoder event probe's offline clips into $1:
#   ip      128x96, an I/P stream like Sunshine's low-latency output
#   b2      128x96, two B-frames, so the decoder reorders
#   ip1080  1920x1080 High, no B-frames, single-frame VBV at 20 Mbps like Sunshine,
#           zooming fractal with grain so every frame carries motion and detail
#   ip1080-120  the same source and settings at 120 fps over two seconds (level 5.1),
#           one x264 thread so the bytes repeat (sliced threads with VBV do not)
# Each clip.h264 comes with clip.json (picture size, frame rate, per-AU display index in
# decode order) and clip-reference.nv12 (display order). The 1080p references hold only
# every tenth frame and the last one, listed in clip.json as references.
# Extra arguments pick clips by name; the default writes all of them.
set -eu
out=${1:?usage: make-decoder-clips.sh <directory> [clip...]}
shift
mkdir -p "$out"
small="testsrc2=size=128x96:rate=60:duration=1"
large="mandelbrot=size=1920x1080:rate=60,noise=alls=6:allf=t,trim=end_frame=120"
large120="mandelbrot=size=1920x1080:rate=120,noise=alls=6:allf=t,trim=end_frame=240"

wanted() {
  [ $# -eq 0 ] && return 0
  name=$1
  shift
  for pick; do [ "$pick" = "$name" ] && return 0; done
  return 1
}

encode() {
  name=$1
  source=$2
  pick=$3
  rate=$4
  shift 4
  ffmpeg -v error -y -f lavfi -i "$source" -pix_fmt yuv420p -c:v libx264 "$@" \
    -video_track_timescale "$rate" "$out/$name.mp4"
  ffmpeg -v error -y -i "$out/$name.mp4" -c copy -bsf:v h264_mp4toannexb -f h264 "$out/$name.h264"
  ffmpeg -v error -y -i "$out/$name.h264" -vf "select='$pick'" -fps_mode passthrough \
    -f rawvideo -pix_fmt nv12 "$out/$name-reference.nv12"
  size=$(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 \
    "$out/$name.mp4")
  ffprobe -v error -select_streams v -show_entries packet=pts -of csv=p=0 "$out/$name.mp4" |
    PICK="$pick" SIZE="$size" RATE="$rate" node -e '
      const pts = require("fs").readFileSync(0, "utf8").trim().split("\n").map(Number);
      const first = Math.min(...pts);
      const display = pts.map(p => p - first);
      const [width, height] = process.env.SIZE.split(",").map(Number);
      const result = {width, height, fps: Number(process.env.RATE), display};
      if (process.env.PICK !== "1") {
        const last = display.length - 1;
        result.references = display
          .map((_, n) => n)
          .filter(n => n % 10 === 0 || n === last);
      }
      console.log(JSON.stringify(result));
    ' >"$out/$name.json"
}

wanted ip "$@" && encode ip "$small" 1 60 -preset veryfast -tune zerolatency -bf 0 -g 30
wanted b2 "$@" && encode b2 "$small" 1 60 -preset veryfast -bf 2 -g 30 -x264-params b-pyramid=0
wanted ip1080 "$@" && encode ip1080 "$large" 'not(mod(n\,10))+eq(n\,119)' 60 -profile:v high \
  -preset veryfast -tune zerolatency -bf 0 -g 30 -x264-params scenecut=0 -b:v 20M -maxrate 20M \
  -bufsize 333k
wanted ip1080-120 "$@" && encode ip1080-120 "$large120" 'not(mod(n\,10))+eq(n\,239)' 120 \
  -profile:v high -preset veryfast -tune zerolatency -bf 0 -g 60 -x264-params scenecut=0 \
  -b:v 20M -maxrate 20M -bufsize 167k -threads 1
true
