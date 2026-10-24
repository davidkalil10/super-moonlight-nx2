#!/usr/bin/env python3
"""Menu screen renderer for tools/moonlight/menu.cjs.

Reads one JSON screen spec per line on stdin and writes exactly width*height*3
RGB24 bytes per spec to stdout. All content and layout decisions are made in
menu.cjs (screenSpec); this process only paints what it is told, the same way
apps/moonlight/assets.py paints the app's text atlas with PIL + DejaVu.
"""
import json
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
]
FONT_PATH = next(f for f in FONTS if Path(f).exists())

BG = (14, 37, 58)
PANEL = (24, 65, 85)
ACCENT = (111, 246, 221)
OUTLINE = (64, 215, 224)
TEXT = (226, 238, 245)
MUTED = (150, 175, 190)


def font(size):
    return ImageFont.truetype(FONT_PATH, size)


def centered(draw, text, cx, y, face, fill):
    box = draw.textbbox((0, 0), text, font=face)
    draw.text((cx - (box[2] - box[0]) / 2, y), text, font=face, fill=fill)


def render(spec):
    w, h = spec["width"], spec["height"]
    im = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(im)
    lay = spec["layout"]

    centered(d, spec.get("title", "Moonlight"), w / 2, 120, font(92), ACCENT)

    screen = spec["screen"]
    if screen == "splash":
        centered(d, spec.get("message", ""), w / 2, h / 2, font(44), TEXT)
    elif screen == "pair":
        for i, line in enumerate(spec.get("lines", [])):
            centered(d, line, w / 2, 300 + i * 54, font(40), TEXT)
        centered(d, spec.get("pin", "----"), w / 2, 470, font(220), ACCENT)
    elif screen == "streaming":
        centered(d, spec.get("message", "Streaming"), w / 2, h / 2 - 40, font(52), TEXT)
    else:
        rows = spec.get("rows", [])
        cursor = spec.get("cursor", 0)
        top, rh = lay["listTop"], lay["rowHeight"]
        margin = 220
        for i, label in enumerate(rows):
            y = top + i * rh
            if i == cursor:
                d.rounded_rectangle(
                    (margin - 30, y - 8, w - margin + 30, y + rh - 24),
                    radius=16,
                    fill=PANEL,
                    outline=OUTLINE,
                    width=4,
                )
            d.text((margin, y), label, font=font(48), fill=TEXT if i == cursor else MUTED)
        note = spec.get("note", "")
        if note:
            centered(d, note, w / 2, top + len(rows) * rh + 40, font(30), MUTED)

    centered(d, spec.get("footer", ""), w / 2, h - 70, font(30), MUTED)
    return im.tobytes()


def main():
    out = sys.stdout.buffer
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        out.write(render(json.loads(line)))
        out.flush()


if __name__ == "__main__":
    main()
