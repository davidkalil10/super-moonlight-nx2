#!/usr/bin/env python3
"""Reference clips for decoder bring-up (runtime feature diagnostic-ref-replay).

generate: encodes a short 1080p60 testsrc2 clip (moving pattern with a frame clock) as H.264
          and AV1, decodes it with ffmpeg into reference NV12 frames and writes per frame
          CRC-32s of the displayed luma and chroma planes. The .mlrc files and sums are what
          the runtime embeds from runtime/refclip/.
compare:  checks the 'ref:' lines of a DUT log against the sums, and optionally an HDMI
          capture (any image ffmpeg reads) against the reference frames by PSNR.

.mlrc layout (little endian): b"MLRC", u32 version=1, u32 codec (0 H.264, 1 AV1, 2 HEVC Main), u32 width,
u32 height, u32 fps, u32 units; then per access unit u32 bytes, u64 pts_us, bytes.
"""

import argparse
import json
import re
import struct
import subprocess
import sys
import zlib
from pathlib import Path

WIDTH, HEIGHT, FPS, FRAMES = 1920, 1080, 60, 16
CODECS = {
    "h264": (0, "h264", ["-c:v", "libx264", "-preset", "medium", "-profile:v", "high",
                         "-bf", "0", "-g", str(FRAMES), "-crf", "28", "-f", "h264"]),
    "hevc": (2, "hevc", ["-c:v", "libx265", "-preset", "medium", "-profile:v", "main",
                          "-x265-params", "pools=1:frame-threads=1:log-level=error",
                          "-bf", "0", "-g", str(FRAMES), "-crf", "28", "-f", "hevc"]),
    "av1": (1, "obu", ["-c:v", "libsvtav1", "-preset", "8", "-crf", "40", "-g", str(FRAMES),
                       "-svtav1-params", "pred-struct=1", "-f", "obu"]),
}
FRAME_BYTES = WIDTH * HEIGHT * 3 // 2


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def packets(path):
    """(pos, size, pts_us) per packet in decode order, as ffprobe's parser splits the stream."""
    probe = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                 "packet=pos,size", "-of", "json", str(path)], capture_output=True, text=True)
    result = json.loads(probe.stdout)["packets"]
    return [(int(p["pos"]), int(p["size"]), index * 1_000_000 // FPS)
            for index, p in enumerate(result)]


def sums(frame):
    luma = frame[:WIDTH * HEIGHT]
    chroma = frame[WIDTH * HEIGHT:]
    return zlib.crc32(luma), zlib.crc32(chroma)


def generate(out, only=None):
    out.mkdir(parents=True, exist_ok=True)
    source = ["-f", "lavfi", "-i", f"testsrc2=size={WIDTH}x{HEIGHT}:rate={FPS}",
              "-frames:v", str(FRAMES), "-pix_fmt", "yuv420p",
              "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
              "-color_range", "tv"]
    for name, (codec, suffix, encoder) in CODECS.items():
        if only and name != only:
            continue
        stream = out / f"{name}.{suffix}"
        run(["ffmpeg", "-v", "error", "-y", *source, *encoder, str(stream)])
        raw = stream.read_bytes()
        units = packets(stream)
        if len(units) != FRAMES:
            raise ValueError(f"{name}: {len(units)} packets, expected {FRAMES}")
        clip = bytearray(b"MLRC" + struct.pack("<6I", 1, codec, WIDTH, HEIGHT, FPS, len(units)))
        for pos, size, pts_us in units:
            clip += struct.pack("<IQ", size, pts_us) + raw[pos:pos + size]
        (out / f"{name}.mlrc").write_bytes(clip)
        reference = out / f"{name}-nv12.yuv"
        run(["ffmpeg", "-v", "error", "-y", "-i", str(stream), "-f", "rawvideo",
             "-pix_fmt", "nv12", str(reference)])
        data = reference.read_bytes()
        if len(data) != FRAMES * FRAME_BYTES:
            raise ValueError(f"{name}: decoded {len(data)} bytes")
        lines = [f"# {name} {WIDTH}x{HEIGHT}@{FPS} NV12; frame pts_us y_crc32 uv_crc32"]
        for index in range(FRAMES):
            y, uv = sums(data[index * FRAME_BYTES:(index + 1) * FRAME_BYTES])
            lines.append(f"{index} {units[index][2]} {y:08x} {uv:08x}")
        (out / f"{name}.sums").write_text("\n".join(lines) + "\n")
        print(f"{name}: {len(clip)} bytes clip, sums in {out / (name + '.sums')}")


def load_sums(path):
    rows = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            index, pts, y, uv = line.split()
            rows[int(index)] = (int(pts), y, uv)
    return rows


LOG_LINE = re.compile(r"ref: (\w+) frame (\d+) pts_us=(\d+) y=([0-9a-f]{8}) uv=([0-9a-f]{8})")


def compare_log(log, reference, required=()):
    passed = True
    seen = {}
    for match in LOG_LINE.finditer(log.read_text(errors="replace")):
        codec, index, pts, y, uv = match.groups()
        seen.setdefault(codec, []).append((int(index), int(pts), y, uv))
    if not seen:
        print("log: no 'ref:' frame lines")
        return False
    for codec in required:
        if codec not in seen:
            print(f"{codec}: no frame lines")
            passed = False
    for codec, frames in seen.items():
        path = reference / f"{codec}.sums"
        if not path.exists():
            print(f"{codec}: no reference sums at {path}")
            passed = False
            continue
        expected = load_sums(path)
        good = luma = chroma = 0
        for index, pts, y, uv in frames:
            want = expected.get(index)
            ok = want is not None and want == (pts, y, uv)
            good += ok
            luma += want is not None and want[1] == y
            chroma += want is not None and want[2] == uv
            if not ok:
                detail = "missing" if want is None else f"want y={want[1]} uv={want[2]}"
                print(f"{codec} frame {index}: y={y} uv={uv} {detail}")
        indices = [frame[0] for frame in frames]
        complete = len(frames) == len(expected) and set(indices) == set(expected)
        print(f"{codec}: {good}/{len(expected)} frames match"
              f" (luma {luma}/{len(expected)}, chroma {chroma}/{len(expected)})"
              + ("" if complete else f", {len(frames)} logged"))
        passed &= complete and good == len(expected)
    return passed


def compare_capture(capture, reference, codec, threshold):
    """Best PSNR of the capture against every reference frame; HDMI is limited-range BT.709."""
    frames = reference / f"{codec}-nv12.yuv"
    best = (0.0, -1)
    for index in range(FRAMES):
        result = run(["ffmpeg", "-v", "info", "-nostats", "-i", str(capture),
                      "-f", "rawvideo", "-pix_fmt", "nv12", "-s", f"{WIDTH}x{HEIGHT}",
                      "-ss", "0", "-i", str(frames),
                      "-lavfi", f"[1:v]select=eq(n\\,{index}),setpts=PTS-STARTPTS[r];"
                                f"[0:v]scale={WIDTH}:{HEIGHT}:out_color_matrix=bt709:out_range=tv,"
                                f"format=nv12,setpts=PTS-STARTPTS[c];[c][r]psnr",
                      "-frames:v", "1", "-f", "null", "-"], capture_output=True, text=True)
        match = re.search(r"PSNR y:([\d.inf]+)", result.stderr)
        if match:
            value = float("inf") if match.group(1) == "inf" else float(match.group(1))
            best = max(best, (value, index))
    print(f"capture: best luma PSNR {best[0]:.1f} dB at {codec} frame {best[1]}"
          f" (pass >= {threshold} dB)")
    return best[0] >= threshold


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    make = commands.add_parser("generate")
    make.add_argument("--out", type=Path, required=True)
    make.add_argument("--codec", choices=CODECS)
    check = commands.add_parser("compare")
    check.add_argument("--reference", type=Path, required=True,
                       help="directory written by generate")
    check.add_argument("--log", type=Path)
    check.add_argument("--capture", type=Path, help="HDMI capture frame of the replay")
    check.add_argument("--codec", choices=CODECS, default="h264")
    check.add_argument("--expect-codec", choices=CODECS, action="append", default=[])
    check.add_argument("--psnr", type=float, default=30.0)
    args = parser.parse_args()
    if args.command == "generate":
        generate(args.out, args.codec)
        return 0
    passed = True
    if args.log:
        passed &= compare_log(args.log, args.reference, args.expect_codec)
    if args.capture:
        passed &= compare_capture(args.capture, args.reference, args.codec, args.psnr)
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
