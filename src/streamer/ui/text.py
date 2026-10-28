#!/usr/bin/env python3
"""Rasteriser for the console UI pages (src/streamer/ui/raster.js).

Reads one JSON request per line on stdin and answers each with an 8-byte header (width,
height as little-endian u32) followed by the pixels: alpha-8 for a text strip, RGBA8 for a
tile. Layout stays in pages.js; this process only paints. Text is Sora (fonts/, OFL) at
the asked weight; a character Sora lacks falls back to DejaVu, then to a CJK font when the PC
has one.

Requests and what each answers with:

  {"kind":"text","text":"Desktop","size":36,"width":960,"weight":600,"tracking":0}
      alpha strip, width x line height
  {"kind":"legend","keys":[["A","Launch"]],"size":26,"width":1200}
      alpha strip, ringed keys and their labels
  {"kind":"tile","png":"/path/cover.png","width":240,"height":135}
      RGBA tile, the cover over its own blur; 0 x 0 when the PNG is not usable
  {"kind":"letters","text":"Desktop","width":240,"height":135}
      RGBA tile, the initials on a hue
"""
import colorsys
import hashlib
import json
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

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

# A code point no font maps; its mask is the face's missing-glyph box.
UNMAPPED = "͸"
# The tallest strip a page carries (MAX_TEXT in page.js).
MAX_STRIP_HEIGHT = 96
# Covers with a longer side are refused rather than decoded.
MAX_COVER_SIDE = 4096
ELLIPSIS = "…"
# How much of the blurred cover shows through the black behind the fitted cover.
FILL_LEVEL = 0.35
# Legend spacing: between a key's ring and its label, and between entries.
KEY_GAP = 12
ENTRY_GAP = 44

# Loaded faces by (size, weight), (size, None) for DejaVu, or (size, "cjk", weight).
fonts = {}
# Per face, by id: which characters it really draws.
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
    for face in faces:
        if all(has_glyph(face, char) for char in text):
            return face
    return faces[-1]


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

    # Neighbouring characters drawn by the same face share a run, unless tracked apart.
    pieces = []
    for char in text:
        face = face_for(faces, char)
        if tracking or not pieces or pieces[-1][1] is not face:
            pieces.append([char, face])
        else:
            pieces[-1][0] += char

    placed = []
    x = 0.0
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
    """Draws the runs from x with their baselines on `baseline`."""
    for offset, piece, face in placed:
        ascent = face.getmetrics()[0]
        draw.text((x + offset, baseline - ascent), piece, font=face, fill=255)


def text_strip(request):
    """One line of text, fitted to the width and aligned in it, as an alpha strip."""
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
    top = (height - ring) / 2
    outline = max(2, size // 9)

    x = 0
    for key, label in request["keys"]:
        draw.ellipse((x, top, x + ring - 1, top + ring - 1), outline=255, width=outline)
        placed, length = runs(key, size, 700, 0)
        draw_runs(draw, x + (ring - length) / 2, baseline, placed)
        x += ring + KEY_GAP

        placed, length = runs(label, size, 600, 0)
        draw_runs(draw, x, baseline, placed)
        x += length + ENTRY_GAP
    return strip


def tile(request):
    """The cover fitted whole inside the tile, over a blurred, darkened fill of itself."""
    width, height = int(request["width"]), int(request["height"])
    try:
        with Image.open(request["png"]) as source:
            if source.format != "PNG" or max(source.size) > MAX_COVER_SIDE:
                return None
            art = source.convert("RGBA")
    except (OSError, ValueError, Image.DecompressionBombError):
        return None

    out = ImageOps.fit(art, (width, height), Image.LANCZOS)
    out = out.filter(ImageFilter.GaussianBlur(height / 12))
    black = Image.new("RGBA", out.size, (0, 0, 0, 255))
    out = Image.blend(black, out, FILL_LEVEL)
    out.putalpha(255)

    cover = ImageOps.contain(art, (width, height), Image.LANCZOS)
    out.alpha_composite(cover, ((width - cover.width) // 2, (height - cover.height) // 2))
    return out


def letters(request):
    """Up to two initials of the name, centred on a hue hashed from the name."""
    width, height = int(request["width"]), int(request["height"])
    name = request["text"].strip() or "?"

    hue = int(hashlib.sha256(name.encode()).hexdigest()[:4], 16) / 65535
    r, g, b = colorsys.hls_to_rgb(hue, 0.32, 0.45)
    out = Image.new("RGBA", (width, height), (int(r * 255), int(g * 255), int(b * 255), 255))

    initials = "".join(word[0] for word in name.split()[:2]).upper() or name[0].upper()
    face = face_for(chain(int(height * 0.5), 700), initials)
    draw = ImageDraw.Draw(out)
    left, top, right, bottom = draw.textbbox((0, 0), initials, font=face)
    x = (width - (right - left)) / 2 - left
    y = (height - (bottom - top)) / 2 - top
    draw.text((x, y), initials, font=face, fill=(240, 246, 250, 255))
    return out


PAINTERS = {"text": text_strip, "legend": legend, "tile": tile, "letters": letters}


def main():
    """Answers each request line in order until stdin closes."""
    if not CJK_PATH:
        print("text.py: no CJK font found, CJK names draw as boxes", file=sys.stderr)
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
