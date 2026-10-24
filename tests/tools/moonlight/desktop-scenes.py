#!/usr/bin/env python3
"""Synthetic 1920x1080 desktop sequences for codec tests, as raw RGB24 frames.

  desktop-scenes.py SCENE FRAMES OUT [--wallpaper IMAGE] [--text FILE]

SCENE: typing (static desktop, a terminal gaining characters), scroll (an
editor scrolling 3 px per frame), drag (a window dragged across the
wallpaper) or pan (the wallpaper panning 4 px per frame). The wallpaper is
decoded with ffmpeg, so .jxl works; without one a gradient is used.
"""
import argparse
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1920, 1080
MONO = "/usr/share/fonts/liberation-mono-fonts/LiberationMono-Regular.ttf"
SANS = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf"


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def wallpaper(path, width, height):
    if path:
        raw = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path, "-vf",
             f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height}",
             "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
            check=True, capture_output=True).stdout
        return Image.frombytes("RGB", (width, height), raw)
    image = Image.new("RGB", (width, height))
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = (30 + x * 60 // width, 60 + y * 80 // height, 120 + (x + y) * 60 // (width + height))
    return image


def window(size, title, lines, dark, text_font, scroll=0):
    image = Image.new("RGB", size, (30, 30, 34) if dark else (250, 250, 248))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, size[0], 34), fill=(48, 48, 54) if dark else (225, 225, 228))
    draw.text((14, 8), title, font=font(SANS, 17), fill=(220, 220, 220) if dark else (40, 40, 40))
    color = (200, 220, 200) if dark else (25, 25, 30)
    line_height = 22
    first = scroll // line_height
    for row in range(size[1] // line_height + 2):
        index = first + row
        y = 44 + row * line_height - scroll % line_height
        if y < 36 or index >= len(lines):
            continue
        draw.text((14, y), lines[index], font=text_font, fill=color)
    draw.rectangle((0, 0, size[0] - 1, size[1] - 1), outline=(90, 90, 96))
    return image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("scene", choices=["typing", "scroll", "drag", "pan"])
    parser.add_argument("frames", type=int)
    parser.add_argument("out")
    parser.add_argument("--wallpaper")
    parser.add_argument("--text", default=__file__)
    args = parser.parse_args()
    lines = Path(args.text).read_text(errors="replace").expandtabs(4).splitlines() * 8
    mono, sans = font(MONO, 15), font(SANS, 16)
    background = wallpaper(args.wallpaper, WIDTH + 4 * args.frames if args.scene == "pan" else WIDTH, HEIGHT)
    editor = window((1100, 900), "hbv2.cjs - Editor", lines, False, sans)
    with open(args.out, "wb") as out:
        for t in range(args.frames):
            if args.scene == "pan":
                frame = background.crop((4 * t, 0, 4 * t + WIDTH, HEIGHT))
            else:
                frame = background.copy()
            if args.scene == "typing":
                typed = lines[: 3 + t // 30] + [lines[3 + t // 30][: (t % 30) * 2]]
                frame.paste(editor, (60, 80))
                frame.paste(window((900, 640), "Terminal", typed, True, mono), (980, 380))
            elif args.scene == "scroll":
                frame.paste(window((1800, 1000), "hbv2.cjs - Editor", lines, False, sans, scroll=3 * t), (60, 40))
            elif args.scene == "drag":
                frame.paste(editor, (40 + 13 * t % 900, 60 + 5 * t % 150))
            out.write(frame.tobytes())
    sys.stderr.write(f"{args.frames} frames of {args.scene} written to {args.out}\n")


if __name__ == "__main__":
    main()
