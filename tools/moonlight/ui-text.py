#!/usr/bin/env python3
"""Rasteriser for the console UI pages (tools/moonlight/ui-raster.js).

Reads one JSON request per line on stdin and answers each with an 8-byte header (width,
height as little-endian u32) followed by the pixels: alpha-8 for a text strip, RGBA8 for a
tile. Layout stays in ui-pages.js; this process only paints. Text is Sora (fonts/, OFL) at
the asked weight; a character Sora lacks falls back to DejaVu, then to a CJK font when the PC
has one.

  {"kind":"text","text":"Desktop","size":36,"width":960,"weight":600,"tracking":0}
                                                                  -> alpha strip, width x line height
  {"kind":"legend","keys":[["A","Launch"]],"size":26,"width":1200} -> alpha strip, ringed keys + labels
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

SORA = Path(__file__).resolve().parent / "fonts" / "Sora.ttf"
FALLBACKS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
]
FALLBACK_PATH = next(f for f in FALLBACKS if Path(f).exists())
CJK_FONTS = [
    "/usr/share/fonts/google-noto-sans-cjk-vf-fonts/NotoSansCJK-VF.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/google-droid-sans-fonts/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
]
CJK_PATH = next((f for f in CJK_FONTS if Path(f).exists()), None)
UNMAPPED = "͸"
MAX_STRIP_HEIGHT = 96
MAX_COVER_SIDE = 4096
ELLIPSIS = "…"
KEY_GAP = 12
ENTRY_GAP = 44
fonts = {}
glyphs = {}


def font(size, weight=600):
    """Sora at the weight, or DejaVu (weight None, or Sora missing)."""
    key = (size, weight if SORA.exists() else None)
    if key not in fonts:
        if key[1] is None:
            fonts[key] = ImageFont.truetype(FALLBACK_PATH, size)
        else:
            fonts[key] = ImageFont.truetype(str(SORA), size)
            fonts[key].set_variation_by_axes([weight])
    return fonts[key]


def chain(size, weight):
    """The faces tried in order for each character: Sora, DejaVu, then CJK if present."""
    faces = [font(size, weight), font(size, None)]
    if CJK_PATH:
        key = (size, "cjk", weight)
        if key not in fonts:
            fonts[key] = ImageFont.truetype(CJK_PATH, size)
            try:
                fonts[key].set_variation_by_axes([weight or 400])
            except OSError:
                pass
        faces.append(fonts[key])
    return faces


def face_for(faces, text):
    """The first face that draws every character of the text, else the last one tried."""
    return next((face for face in faces if all(has_glyph(face, c) for c in text)), faces[-1])


def has_glyph(face, char):
    """Whether the face draws the character itself rather than its missing-glyph box."""
    known = glyphs.setdefault(id(face), {})
    if char not in known:
        if UNMAPPED not in known:
            known[UNMAPPED] = bytes(face.getmask(UNMAPPED))
        known[char] = char.isspace() or bytes(face.getmask(char)) != known[UNMAPPED]
    return known[char]


def runs(text, size, weight, tracking):
    """The text as (x, piece, face) runs and its width; tracking spaces every character."""
    faces = chain(size, weight)
    pieces = []
    for char in text:
        face = face_for(faces, char)
        if tracking or not pieces or pieces[-1][1] is not face:
            pieces.append([char, face])
        else:
            pieces[-1][0] += char
    placed, x = [], 0.0
    for piece, face in pieces:
        placed.append((x, piece, face))
        x += face.getlength(piece) + tracking
    return placed, max(0.0, x - tracking)


def fit(text, size, weight, tracking, width):
    """The text, shortened with an ellipsis until it fits the width."""
    while text and runs(text, size, weight, tracking)[1] > width:
        kept = text[:-1] if text.endswith(ELLIPSIS) else text
        text = kept[:-1].rstrip() + ELLIPSIS if len(kept) > 1 else ""
    return text


def draw_runs(draw, x, baseline, placed):
    for offset, piece, face in placed:
        draw.text((x + offset, baseline - face.getmetrics()[0]), piece, font=face, fill=255)


def text_strip(request):
    size, width = request["size"], int(request["width"])
    weight, tracking = request.get("weight", 600), request.get("tracking", 0)
    ascent, descent = font(size, weight).getmetrics()
    height = min(MAX_STRIP_HEIGHT, ascent + descent)
    label = fit(request["text"], size, weight, tracking, width)
    placed, length = runs(label, size, weight, tracking)
    x = 0
    if request.get("align") == "center":
        x = (width - length) / 2
    elif request.get("align") == "right":
        x = width - length
    strip = Image.new("L", (width, height), 0)
    draw_runs(ImageDraw.Draw(strip), x, ascent, placed)
    return strip


def legend(request):
    """Button hints in one strip: each key in a ring, its label after it."""
    size, width = request["size"], int(request["width"])
    ascent, descent = font(size).getmetrics()
    ring = round(size * 1.55)
    height = min(MAX_STRIP_HEIGHT, max(ring, ascent + descent))
    strip = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(strip)
    baseline = (height + ascent - descent) / 2
    x = 0
    for key, label in request["keys"]:
        top = (height - ring) / 2
        draw.ellipse((x, top, x + ring - 1, top + ring - 1), outline=255, width=max(2, size // 9))
        placed, length = runs(key, size, 700, 0)
        draw_runs(draw, x + (ring - length) / 2, baseline, placed)
        x += ring + KEY_GAP
        placed, length = runs(label, size, 600, 0)
        draw_runs(draw, x, baseline, placed)
        x += length + ENTRY_GAP
    return strip


def tile(request):
    width, height = int(request["width"]), int(request["height"])
    out = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    try:
        with Image.open(request["png"]) as source:
            if source.format != "PNG" or max(source.size) > MAX_COVER_SIDE:
                return None
            cover = ImageOps.contain(source.convert("RGBA"), (width, height), Image.LANCZOS)
    except (OSError, ValueError, Image.DecompressionBombError):
        return None
    out.paste(cover, ((width - cover.width) // 2, (height - cover.height) // 2))
    return out


def letters(request):
    width, height = int(request["width"]), int(request["height"])
    name = request["text"].strip() or "?"
    hue = int(hashlib.sha256(name.encode()).hexdigest()[:4], 16) / 65535
    r, g, b = colorsys.hls_to_rgb(hue, 0.32, 0.45)
    out = Image.new("RGBA", (width, height), (int(r * 255), int(g * 255), int(b * 255), 255))
    initials = "".join(word[0] for word in name.split()[:2]).upper() or name[0].upper()
    face = face_for(chain(int(height * 0.5), 700), initials)
    draw = ImageDraw.Draw(out)
    box = draw.textbbox((0, 0), initials, font=face)
    draw.text(
        ((width - (box[2] - box[0])) / 2 - box[0], (height - (box[3] - box[1])) / 2 - box[1]),
        initials,
        font=face,
        fill=(240, 246, 250, 255),
    )
    return out


PAINTERS = {"text": text_strip, "legend": legend, "tile": tile, "letters": letters}


def main():
    if not CJK_PATH:
        print("ui-text.py: no CJK font found, CJK names draw as boxes", file=sys.stderr)
    out = sys.stdout.buffer
    for line in sys.stdin:
        request = json.loads(line)
        image = PAINTERS[request["kind"]](request)
        if image is None:
            out.write(struct.pack("<II", 0, 0))
        else:
            out.write(struct.pack("<II", image.width, image.height))
            out.write(image.tobytes())
        out.flush()


if __name__ == "__main__":
    main()
