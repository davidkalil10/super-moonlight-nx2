#!/usr/bin/env python3
"""Build-time generator for the UI glyph atlas and the raster test reference.

  python3 src/streamer/ui/glyphs.py atlas       writes fonts/glyphs.bin
  python3 src/streamer/ui/glyphs.py reference [--out FILE]   writes the raster test fixture
    (default: moonlight-nx2-dev beside the app, src/streamer/ui/test/fixtures/)

Glyphs are painted through text.py's own faces, so the atlas draws what text.py draws. Needs
Pillow; the developer runs it once, the runtime reads only the atlas (format in CLAUDE.md, Text).
"""
import argparse
import io
import json
import math
import struct
import sys
import tempfile
import zlib
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

import text

HERE = Path(__file__).resolve().parent
ATLAS = HERE / "fonts" / "glyphs.bin"
REFERENCE = (HERE.parents[3] / "moonlight-nx2-dev" / "src" / "streamer" / "ui" / "test" / "fixtures"
             / "raster-reference.bin")
VERSION = 1

# Without a CJK font text.py draws DejaVu's missing-glyph box for what no face maps: that is
# the atlas fallback, and the reference is made the same way on every PC.
text.CJK_PATH = None

UI_SYMBOLS = "…‹›◂▸‘’“”–—•●€™œŒŸ−"
# Modern Greek and the Cyrillic of Russian, Ukrainian, Belarusian, Serbian, Macedonian and
# Bulgarian; M PLUS Rounded has them, DejaVu is the fallback otherwise, so DejaVu draws them, as text.py does.
GREEK = "ΆΈΉΊΌΎΏΐ" + "".join(chr(c) for c in range(0x391, 0x3CF) if c != 0x3A2)
CYRILLIC = "".join(chr(c) for c in range(0x400, 0x460)) + "Ґґ"
CHARSET = [chr(c) for c in range(0x20, 0x7F)] + [chr(c) for c in range(0xA0, 0x100)]
CHARSET += [c for c in UI_SYMBOLS + GREEK + CYRILLIC if c not in CHARSET]
# Letter tiles draw initials, which are upper-cased first.
INITIALS = [c for c in CHARSET if c.upper() == c]

# Every size and weight pages.js asks for, then the letter tile face (half a 135 px and a 300 px cover).
COMBOS = [
    (18, 700, CHARSET), (22, 600, CHARSET), (24, 500, CHARSET), (24, 600, CHARSET),
    (26, 500, CHARSET), (26, 600, CHARSET), (26, 700, CHARSET), (28, 500, CHARSET),
    (28, 600, CHARSET), (32, 700, CHARSET), (36, 700, CHARSET), (40, 700, CHARSET),
    (48, 700, CHARSET), (56, 700, CHARSET), (72, 700, CHARSET), (67, 700, INITIALS), (150, 700, INITIALS),
    (28, 700, CHARSET), (32, 500, CHARSET), (32, 600, CHARSET), (40, 500, CHARSET),
    (44, 500, CHARSET), (50, 700, CHARSET),
]
LEGEND_SIZES = [26]

FACE_SORA, FACE_DEJAVU = 0, 1
FALLBACK_KEY = 0
LIGATURE_KEY_BASE = 0xE000
KERN_REFERENCE_SIZE = 1000
# A pair is a ligature when its shaped mask strays this far from its glyphs drawn apart.
LIGATURE_PROBE_SIZE = 26
LIGATURE_THRESHOLD = 40

HEADER = struct.Struct("<4sHHHHI")
COMBO = struct.Struct("<HHhhIIII")
TABLE = struct.Struct("<HHII")
RING = struct.Struct("<HHHHI")
GLYPH = struct.Struct("<HBB3HHhhHHI")
KERN = struct.Struct("<HHh")


def js_round(value):
    """Math.round, so the corrections match what glyph-raster.js computes."""
    return math.floor(value + 0.5)


def mask_image(face, piece):
    """The piece's mask and its offset from the anchor, as draw.text makes it."""
    mask, offset = face.getmask2(piece, "L")
    return Image.frombytes("L", mask.size, bytes(mask)), offset


def length64(face, piece):
    return round(face.getlength(piece) * 64)


def drawn_apart(face, pieces):
    """The pieces shaped together, and drawn one by one on whole pixels at their pens."""
    whole, origin = mask_image(face, "".join(pieces))
    apart = Image.new("L", whole.size, 0)
    so_far = ""
    for piece in pieces:
        so_far += piece
        x = js_round(face.getlength(so_far) - face.getlength(piece))
        glyph, offset = mask_image(face, piece)
        apart.paste(255, (x + offset[0] - origin[0], offset[1] - origin[1]), glyph)
    return whole, apart


def is_ligature(face, pieces):
    whole, apart = drawn_apart(face, pieces)
    return max(ImageChops.difference(whole, apart).tobytes() or b"\0") > LIGATURE_THRESHOLD


def find_ligatures(weight):
    """Sequences the UI face shapes into one glyph: pairs, then a pair and one more character."""
    face = text.font(LIGATURE_PROBE_SIZE, weight)
    faces = text.chain(LIGATURE_PROBE_SIZE, weight)
    sora = [c for c in CHARSET if not c.isspace() and text.face_for(faces, c) is face]

    pairs = [a + b for a in sora for b in sora if is_ligature(face, [a, b])]
    triples = [p + c for p in pairs for c in sora if is_ligature(face, [p, c])]
    return triples + pairs


def segment(piece, ligatures):
    """Ligatures longest first, left to right, as the shaper and glyph-raster.js apply them."""
    out = []
    i = 0
    while i < len(piece):
        match = next((lig for lig in ligatures if piece.startswith(lig, i)), piece[i])
        out.append(match)
        i += len(match)
    return out


def quantize(image):
    """Alpha-8 to 4 bits, two pixels a byte, high nibble first."""
    values = [(v * 15 + 127) // 255 for v in image.tobytes()]
    if len(values) % 2:
        values.append(0)
    return bytes((values[i] << 4) | values[i + 1] for i in range(0, len(values), 2))


def combo_glyphs(size, weight, chars, ligatures):
    """(piece, key, face, face id) for the characters, the ligatures and the fallback box."""
    sora = text.font(size, weight)
    dejavu = text.font(size, None)
    faces = text.chain(size, weight)

    glyphs = []
    for char in chars:
        face = text.face_for(faces, char)
        glyphs.append((char, ord(char), face, FACE_SORA if face is sora else FACE_DEJAVU))
    for lig in ligatures:
        if all(c in chars for c in lig):
            glyphs.append((lig, LIGATURE_KEY_BASE + ligatures.index(lig), sora, FACE_SORA))
    glyphs.append((text.UNMAPPED, FALLBACK_KEY, dejavu, FACE_DEJAVU))
    return glyphs


def combo_kerns(glyphs, ligatures):
    """Kerning in 1/64 px between neighbours drawn by the same face, by (face id, left, right)."""
    kerns = {}
    for face_id in (FACE_SORA, FACE_DEJAVU):
        members = [g for g in glyphs if g[3] == face_id and g[1] != FALLBACK_KEY]
        joins = ligatures if face_id == FACE_SORA else []
        lengths = {g[0]: length64(g[2], g[0]) for g in members}
        for left in members:
            for right in members:
                pair = left[0] + right[0]
                if segment(pair, joins) != [left[0], right[0]]:
                    continue

                kern = length64(left[2], pair) - lengths[left[0]] - lengths[right[0]]
                if kern:
                    kerns[(face_id, left[1], right[1])] = (kern, left[0], right[0])
    return kerns


def kern_tables(combos):
    """One pair list per face and weight, in 1/64 px at the reference size."""
    pairs = {}
    for combo in combos:
        for (face_id, left, right), (_, a, b) in combo["kerns"].items():
            weight = combo["weight"] if face_id == FACE_SORA else 0
            pairs.setdefault((face_id, weight), {})[(left, right)] = (a, b)

    tables = []
    for face_id, weight in sorted(pairs):
        face = text.font(KERN_REFERENCE_SIZE, weight or None)
        entries = []
        for (left, right), (a, b) in sorted(pairs[(face_id, weight)].items()):
            units = length64(face, a + b) - length64(face, a) - length64(face, b)
            entries.append((left, right, units))
        tables.append({"face": face_id, "weight": weight, "entries": entries})
    return tables


def corrections_for(combo, tables):
    """Per pair of each table the combo uses: its kerning less the scaled reference value."""
    out = bytearray()
    for table in tables:
        if table["face"] == FACE_SORA and table["weight"] != combo["weight"]:
            continue

        for left, right, units in table["entries"]:
            delta = 0
            if left in combo["keys"] and right in combo["keys"]:
                real = combo["kerns"].get((table["face"], left, right), (0,))[0]
                delta = real - js_round(units * combo["size"] / KERN_REFERENCE_SIZE)
            if not -128 <= delta <= 127:
                raise SystemExit(f"kern correction {delta} out of range")
            out += struct.pack("<b", delta)
    return bytes(out)


def legend_ring(size):
    """The ring text.py's legend draws around a key, as a mask as high as the legend strip."""
    return text.legend({"size": size, "width": round(size * 1.55), "keys": [["", ""]]})


def build_atlas():
    weights = sorted({weight for _, weight, _ in COMBOS})
    ligatures = {weight: find_ligatures(weight) for weight in weights}
    print("ligatures", ligatures, file=sys.stderr)

    combos = []
    for size, weight, chars in COMBOS:
        ascent, descent = text.font(size, weight).getmetrics()
        glyphs = combo_glyphs(size, weight, chars, ligatures[weight])
        images = []
        for piece, key, face, face_id in glyphs:
            image, offset = mask_image(face, piece)
            dy = offset[1] - face.getmetrics()[0]
            images.append((key, face_id, piece, length64(face, piece), offset[0], dy, image))
        combos.append({"size": size, "weight": weight, "ascent": ascent, "descent": descent,
                       "glyphs": images, "keys": {g[1] for g in glyphs},
                       "kerns": combo_kerns(glyphs, ligatures[weight])})
    tables = kern_tables(combos)
    for combo in combos:
        combo["corrections"] = corrections_for(combo, tables)
    rings = [(size, legend_ring(size)) for size in LEGEND_SIZES]

    records_at = (HEADER.size + COMBO.size * len(combos) + TABLE.size * len(tables)
                  + RING.size * len(rings))
    entries_at = records_at + GLYPH.size * sum(len(c["glyphs"]) for c in combos)
    corrections_at = entries_at + KERN.size * sum(len(t["entries"]) for t in tables)
    bitmaps_at = corrections_at + sum(len(c["corrections"]) for c in combos)

    bitmaps = bytearray()

    def bitmap(image):
        at = bitmaps_at + len(bitmaps)
        bitmaps.extend(quantize(image))
        return at

    out = bytearray(HEADER.pack(b"HBGA", VERSION, len(combos), len(tables), len(rings), 0))
    records = bytearray()
    corrections = bytearray()
    for combo in combos:
        out += COMBO.pack(combo["size"], combo["weight"], combo["ascent"], combo["descent"],
                          len(combo["glyphs"]), records_at + len(records),
                          corrections_at + len(corrections), 0)
        for key, face_id, piece, advance, dx, dy, image in combo["glyphs"]:
            sequence = ([ord(c) for c in piece] + [0, 0, 0])[:3]
            records += GLYPH.pack(key, face_id, len(piece), *sequence, advance, dx, dy,
                                  image.width, image.height, bitmap(image))
        corrections += combo["corrections"]

    entries = bytearray()
    for table in tables:
        out += TABLE.pack(table["face"], table["weight"], len(table["entries"]),
                          entries_at + len(entries))
        for entry in table["entries"]:
            entries += KERN.pack(*entry)
    for size, image in rings:
        out += RING.pack(size, image.width, image.height, 0, bitmap(image))

    out += records + entries + corrections
    assert len(out) == bitmaps_at
    sections = {"records": records, "kerns": entries, "corrections": corrections,
                "bitmaps": bitmaps}
    for name, data in sections.items():
        print(f"  {name}: {len(data)} bytes, {len(zlib.compress(bytes(data), 9))} deflated",
              file=sys.stderr)
    return bytes(out + bitmaps)


# What pages.js draws, plus kerning, ligatures, Latin-1, Greek, Cyrillic and the fallback box.
REFERENCE_TEXTS = [
    ("Desktop", 36, 400, "left", 700, 0),
    ("Choose a PC", 72, 1728, "left", 700, 0),
    ("2 PCs in hosts.json", 28, 1728, "left", 500, 0),
    ("MOONLIGHT", 24, 1728, "left", 600, 2.4),
    ("192.168.8.245", 24, 776, "left", 500, 0),
    ("Rig", 26, 300, "center", 600, 0),
    ("Applies to the next launch", 26, 700, "right", 600, 0),
    ("1080p60 is the reference shape", 24, 700, "right", 500, 0),
    ("‹  Previous", 32, 300, "center", 700, 0),
    ("Next  ›", 32, 300, "center", 700, 0),
    ("FRAME RATE", 22, 776, "left", 600, 1.76),
    ("RUNNING", 18, 112, "center", 700, 1.2),
    ("1920 × 1080", 40, 680, "center", 700, 0),
    ("4821", 72, 1728, "left", 700, 14.4),
    ("Waiting for a PIN…", 56, 1728, "left", 700, 0),
    ("Something went wrong", 48, 1728, "left", 700, 0),
    ("AVATAR Toy Wave fly", 26, 600, "left", 600, 0),
    ("office affiliate fjord", 36, 700, "left", 700, 0),
    ("Pokémon Ünïcödé ÀÉÎÕÜ ß ÿ", 26, 600, "left", 600, 0),
    ("A very long app name that cannot fit in the cover", 26, 240, "center", 600, 0),
    ("Cyberpunk 2077: Phantom Liberty", 72, 1728, "left", 700, 0),
    ("◂▸ arrows", 26, 400, "left", 600, 0),
    ("Ведьмак 3: Дикая Охота", 36, 700, "left", 700, 0),
    ("Їжак ґудзик Ђорђе Ўладзь", 26, 600, "left", 600, 0),
    ("Αθήνα Ελληνικά ΐΰ ς", 28, 700, "left", 500, 0),
    ("ΤΑΥ Vόλος AVтор", 26, 400, "left", 600, 0),
    ("box 原神 ͸", 26, 400, "left", 600, 0),
    ("", 26, 100, "left", 600, 0),
]
REFERENCE_LEGENDS = [
    ([["A", "Launch"], ["B", "PCs"], ["X", "Settings"], ["Y", "Quit host app"]], 26, 1200),
    ([["◂▸", "Change"], ["B", "Back"], ["Y", "Reset"]], 26, 1200),
]
REFERENCE_LETTERS = ["Elden Ring", "Hades", "steam big picture", "über ßeta", "原神", "ведьмак охота",
                     "ωμέγα"]


def reference_covers():
    """Synthetic covers in the PNG modes Sunshine box art comes in, as (name, PNG bytes)."""
    def art(size):
        image = Image.new("RGB", size, (200, 30, 30))
        draw = ImageDraw.Draw(image)
        w, h = size
        draw.rectangle((w // 8, h // 6, w // 2, h // 2), fill=(30, 160, 220))
        draw.ellipse((w // 3, h // 3, w - 4, h - 4), fill=(250, 220, 60))
        draw.line((0, h - 1, w - 1, 0), fill=(10, 10, 10), width=3)
        return image

    alpha = Image.linear_gradient("L").rotate(45).resize((320, 100))
    translucent = art((320, 100))
    translucent.putalpha(alpha)
    palette = art((90, 120)).quantize(16)
    palette.info["transparency"] = 3
    gray16 = Image.linear_gradient("L").resize((100, 150)).convert("I")
    gray16 = gray16.point(lambda v: v * 1.2)
    covers = [
        ("portrait-rgb", art((150, 200)), {}),
        ("wide-rgba", translucent, {}),
        ("palette-trns", palette, {"transparency": 3}),
        ("gray16", gray16.convert("I;16"), {}),
        ("exact-16x9", art((320, 180)), {}),
        ("tiny-gray", Image.linear_gradient("L").resize((7, 5)), {}),
    ]
    out = []
    for name, image, options in covers:
        buffer = io.BytesIO()
        image.save(buffer, "PNG", **options)
        out.append((name, buffer.getvalue()))
    return out


def build_reference():
    """text.py's own strips, letter tiles and cover tiles, in one file the raster tests compare
    against; the covers' PNG bytes ride along."""
    cases = []
    pixels = bytearray()

    def add(request, image):
        cases.append({**request, "w": image.width, "h": image.height, "at": len(pixels),
                      "channels": len(image.getbands())})
        pixels.extend(image.tobytes())

    for label, size, width, align, weight, tracking in REFERENCE_TEXTS:
        request = {"kind": "text", "text": label, "size": size, "width": width, "align": align,
                   "weight": weight, "tracking": tracking}
        fitted = text.fit(label, size, weight, tracking, width)
        request["fitted"] = fitted
        request["length"] = text.runs(fitted, size, weight, tracking)[1]
        add(request, text.text_strip(request))
    for keys, size, width in REFERENCE_LEGENDS:
        request = {"kind": "legend", "keys": keys, "size": size, "width": width}
        add(request, text.legend(request))
    for name in REFERENCE_LETTERS:
        request = {"kind": "letters", "text": name, "width": 200, "height": 300}
        add(request, text.letters(request))
    with tempfile.TemporaryDirectory() as directory:
        for name, png in reference_covers():
            path = Path(directory) / (name + ".png")
            path.write_bytes(png)
            request = {"kind": "tile", "name": name, "width": 160, "height": 90,
                       "png_at": len(pixels), "png_bytes": len(png)}
            pixels.extend(png)
            add(request, text.tile({**request, "png": str(path)}))

    header = json.dumps(cases, ensure_ascii=False).encode()
    return struct.pack("<I", len(header)) + header + zlib.compress(bytes(pixels), 9)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("what", choices=["atlas", "reference"])
    parser.add_argument("--out", type=Path, default=REFERENCE, help="reference fixture path")
    args = parser.parse_args()

    if args.what == "atlas":
        raw = build_atlas()
        ATLAS.write_bytes(zlib.compress(raw, 9))
        print(f"{ATLAS}: {len(raw)} bytes, {ATLAS.stat().st_size} deflated", file=sys.stderr)
    else:
        args.out.write_bytes(build_reference())
        print(f"{args.out}: {args.out.stat().st_size} bytes", file=sys.stderr)


if __name__ == "__main__":
    main()
