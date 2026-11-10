#!/usr/bin/env python3
"""Reference clips for decoder bring-up (runtime feature diagnostic-ref-replay).

generate: encodes a short 1080p60 testsrc2 clip (moving pattern with a frame clock) as H.264
          and AV1, decodes it with ffmpeg into reference NV12 frames and writes per frame
          CRC-32s of the displayed luma and chroma planes. The .mlrc files and sums are what
          the runtime embeds from runtime/refclip/.
sums:     rewrites the sums of existing .mlrc clips without encoding them again.
          --size, --frames and --fps make a clip of another shape, named like h264_2160p
          or av1_1440p120.
          The sdk-modes diagnostics replay those; a session named av1_2160p_in1 is
          checked against the av1_2160p sums.
compare:  checks the 'ref:' lines of a DUT log against the sums, and optionally an HDMI
          capture (any image ffmpeg reads) against the reference frames by PSNR.

The SDK video decoder returns exact luma, but its chroma comes back filtered along each row:
floor((left + 6 * sample + right) / 8) per U and V, edges repeated. The last sums column is the
CRC-32 of the chroma plane after that filter, and `compare --decoder sdk` expects it.

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


def packets(path, fps=FPS):
    """(pos, size, pts_us) per packet in decode order, as ffprobe's parser splits the stream."""
    probe = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                 "packet=pos,size", "-of", "json", str(path)], capture_output=True, text=True)
    result = json.loads(probe.stdout)["packets"]
    return [(int(p["pos"]), int(p["size"]), index * 1_000_000 // fps)
            for index, p in enumerate(result)]


def sdk_chroma(chroma, width):
    """The interleaved chroma plane as the SDK video decoder returns it."""
    out = bytearray()
    for start in range(0, len(chroma), width):
        row = chroma[start:start + width]
        left = row[:2] + row[:-2]
        right = row[2:] + row[-2:]
        out += bytes((a + 6 * b + c) >> 3 for a, b, c in zip(left, row, right))
    return bytes(out)


def sums(frame, width, height):
    luma = frame[:width * height]
    chroma = frame[width * height:]
    return zlib.crc32(luma), zlib.crc32(chroma), zlib.crc32(sdk_chroma(chroma, width))


def write_sums(out, name, suffix, stream, pts, width=WIDTH, height=HEIGHT, fps=FPS):
    """Decodes an elementary stream into <name>-nv12.yuv and writes <name>.sums."""
    reference = out / f"{name}-nv12.yuv"
    run(["ffmpeg", "-v", "error", "-y", "-f", suffix, "-i", str(stream),
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "nv12", str(reference)])
    data = reference.read_bytes()
    frame_bytes = width * height * 3 // 2
    if len(data) != len(pts) * frame_bytes:
        raise ValueError(f"{name}: decoded {len(data)} bytes")
    lines = [f"# {name} {width}x{height}@{fps} NV12; "
             "frame pts_us y_crc32 uv_crc32 uv_sdk_crc32"]
    for index, pts_us in enumerate(pts):
        frame = data[index * frame_bytes:(index + 1) * frame_bytes]
        y, uv, uv_sdk = sums(frame, width, height)
        lines.append(f"{index} {pts_us} {y:08x} {uv:08x} {uv_sdk:08x}")
    (out / f"{name}.sums").write_text("\n".join(lines) + "\n")


def generate(out, only=None, width=WIDTH, height=HEIGHT, frames=FRAMES, fps=FPS, named=None):
    """Clips are named after their codec, then their height and rate when not 1080 and 60."""
    out.mkdir(parents=True, exist_ok=True)
    source = ["-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate={fps}",
              "-frames:v", str(frames), "-pix_fmt", "yuv420p",
              "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
              "-color_range", "tv"]
    for codec_name, (codec, suffix, encoder) in CODECS.items():
        if only and codec_name != only:
            continue
        name = codec_name
        if (height, fps) != (HEIGHT, FPS):
            name += f"_{height}p" + (str(fps) if fps != FPS else "")
        name = named or name
        stream = out / f"{name}.{suffix}"
        run(["ffmpeg", "-v", "error", "-y", *source, *encoder, str(stream)])
        raw = stream.read_bytes()
        units = packets(stream, fps)
        if len(units) != frames:
            raise ValueError(f"{name}: {len(units)} packets, expected {frames}")
        clip = bytearray(b"MLRC" + struct.pack("<6I", 1, codec, width, height, fps, len(units)))
        for pos, size, pts_us in units:
            clip += struct.pack("<IQ", size, pts_us) + raw[pos:pos + size]
        (out / f"{name}.mlrc").write_bytes(clip)
        write_sums(out, name, suffix, stream, [pts_us for _, _, pts_us in units], width, height,
                   fps)
        largest = max(size for _, size, _ in units)
        print(f"{name}: {len(clip)} bytes clip, largest unit {largest},"
              f" sums in {out / (name + '.sums')}")


def resum(clips, out):
    """Sums of the clips already in `clips`, from the access units they hold."""
    out.mkdir(parents=True, exist_ok=True)
    for name, (codec, suffix, _) in CODECS.items():
        clip = (clips / f"{name}.mlrc").read_bytes()
        header = struct.unpack("<6I", clip[4:28])
        if clip[:4] != b"MLRC" or header != (1, codec, WIDTH, HEIGHT, FPS, FRAMES):
            raise ValueError(f"{name}: unexpected clip header {header}")
        stream, pts, offset = bytearray(), [], 28
        while offset < len(clip):
            size, pts_us = struct.unpack_from("<IQ", clip, offset)
            stream += clip[offset + 12:offset + 12 + size]
            pts.append(pts_us)
            offset += 12 + size
        path = out / f"{name}.{suffix}"
        path.write_bytes(stream)
        write_sums(out, name, suffix, path, pts)
        print(f"{name}: sums in {out / (name + '.sums')}")


def load_sums(path, decoder=None):
    """(pts_us, y, uv) per frame; `decoder` sdk takes the filtered chroma column."""
    rows = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            index, pts, y, *uv = line.split()
            if decoder == "sdk" and len(uv) < 2:
                raise ValueError(f"{path} has no SDK chroma sums; run refclip.py sums")
            rows[int(index)] = (int(pts), y, uv[1] if decoder == "sdk" else uv[0])
    return rows


LOG_LINE = re.compile(r"ref: (\w+) frame (\d+) pts_us=(\d+) y=([0-9a-f]{8}) uv=([0-9a-f]{8})")


def compare_log(log, reference, required=(), decoder=None, only=None):
    passed = True
    seen = {}
    for match in LOG_LINE.finditer(log.read_text(errors="replace")):
        codec, index, pts, y, uv = match.groups()
        if only in (None, codec):
            seen.setdefault(codec, []).append((int(index), int(pts), y, uv))
    if not seen:
        print("log: no 'ref:' frame lines")
        return False
    for codec in required:
        if codec not in seen:
            print(f"{codec}: no frame lines")
            passed = False
    for codec, frames in seen.items():
        clip = re.match(r"[a-z0-9]+(_\d+p\d*)?", codec).group(0)
        path = reference / f"{clip}.sums"
        if not path.exists():
            print(f"{codec}: no reference sums at {path}")
            passed = False
            continue
        expected = load_sums(path, decoder)
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
    make.add_argument("--size", default=f"{WIDTH}x{HEIGHT}", help="WIDTHxHEIGHT")
    make.add_argument("--frames", type=int, default=FRAMES)
    make.add_argument("--fps", type=int, default=FPS)
    make.add_argument("--name", help="clip name, with --codec, instead of the one made up")
    again = commands.add_parser("sums")
    again.add_argument("--clips", type=Path, required=True, help="directory of .mlrc clips")
    again.add_argument("--out", type=Path, required=True)
    check = commands.add_parser("compare")
    check.add_argument("--reference", type=Path, required=True,
                       help="directory written by generate")
    check.add_argument("--log", type=Path)
    check.add_argument("--capture", type=Path, help="HDMI capture frame of the replay")
    check.add_argument("--codec", choices=CODECS,
                       help="the only codec to check in the log; the capture's codec (h264)")
    check.add_argument("--expect-codec", choices=CODECS, action="append", default=[])
    check.add_argument("--psnr", type=float, default=30.0)
    check.add_argument("--decoder", choices=["sdk"],
                       help="sdk: expect the chroma the SDK video decoder returns")
    args = parser.parse_args()
    if args.command == "generate":
        width, height = map(int, args.size.split("x"))
        generate(args.out, args.codec, width, height, args.frames, args.fps, args.name)
        return 0
    if args.command == "sums":
        resum(args.clips, args.out)
        return 0
    passed = True
    if args.log:
        required = args.expect_codec or ([args.codec] if args.codec else [])
        passed &= compare_log(args.log, args.reference, required, args.decoder, args.codec)
    if args.capture:
        passed &= compare_capture(args.capture, args.reference, args.codec or "h264", args.psnr)
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
