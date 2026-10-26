#!/usr/bin/env python3
"""Rasteriser for the console UI pages (tools/moonlight/ui-raster.js).

Reads one JSON request per line on stdin and answers each with an 8-byte header (width,
height as little-endian u32) followed by the pixels: alpha-8 for a text strip, RGBA8 for a
tile. Layout stays in ui-pages.js; this process only paints, with the same PIL + DejaVu as
apps/moonlight/assets.py.

  {"kind":"text","text":"Desktop","size":36,"width":960}        -> alpha strip, width x line height
  {"kind":"tile","png":"/path/cover.png","width":160,"height":90} -> RGBA tile, cover fitted inside
  {"kind":"letters","text":"Desktop","width":160,"height":90}    -> RGBA tile, initials on a hue
"""
import colorsys
import hashlib
import json
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
]
FONT_PATH = next(f for f in FONTS if Path(f).exists())
MAX_STRIP_HEIGHT = 96
ELLIPSIS = "…"
fonts = {}


def font(size):
    if size not in fonts:
        fonts[size] = ImageFont.truetype(FONT_PATH, size)
    return fonts[size]


def fit(text, face, width):
    """The text, shortened with an ellipsis until it fits the width."""
    while text and face.getlength(text) > width:
        kept = text[:-1] if text.endswith(ELLIPSIS) else text
        text = kept[:-1].rstrip() + ELLIPSIS if len(kept) > 1 else ""
    return text


def text_strip(request):
    face = font(request["size"])
    width = int(request["width"])
    ascent, descent = face.getmetrics()
    height = min(MAX_STRIP_HEIGHT, ascent + descent)
    label = fit(request["text"], face, width)
    strip = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(strip)
    x = 0
    if request.get("align") == "center":
        x = (width - face.getlength(label)) / 2
    elif request.get("align") == "right":
        x = width - face.getlength(label)
    draw.text((x, 0), label, font=face, fill=255)
    return strip


def tile(request):
    width, height = int(request["width"]), int(request["height"])
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    try:
        with Image.open(request["png"]) as source:
            cover = ImageOps.contain(source.convert("RGBA"), (width, height), Image.LANCZOS)
    except (OSError, ValueError):
        return out
    out.paste(cover, ((width - cover.width) // 2, (height - cover.height) // 2))
    return out


def letters(request):
    width, height = int(request["width"]), int(request["height"])
    name = request["text"].strip() or "?"
    hue = int(hashlib.sha256(name.encode()).hexdigest()[:4], 16) / 65535
    r, g, b = colorsys.hls_to_rgb(hue, 0.32, 0.45)
    out = Image.new("RGBA", (width, height), (int(r * 255), int(g * 255), int(b * 255), 255))
    initials = "".join(word[0] for word in name.split()[:2]).upper() or name[0].upper()
    face = font(int(height * 0.5))
    draw = ImageDraw.Draw(out)
    box = draw.textbbox((0, 0), initials, font=face)
    draw.text(
        ((width - (box[2] - box[0])) / 2 - box[0], (height - (box[3] - box[1])) / 2 - box[1]),
        initials,
        font=face,
        fill=(240, 246, 250, 255),
    )
    return out


PAINTERS = {"text": text_strip, "tile": tile, "letters": letters}


def main():
    out = sys.stdout.buffer
    for line in sys.stdin:
        request = json.loads(line)
        image = PAINTERS[request["kind"]](request)
        out.write(struct.pack("<II", image.width, image.height))
        out.write(image.tobytes())
        out.flush()


if __name__ == "__main__":
    main()
