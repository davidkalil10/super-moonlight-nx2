#!/usr/bin/env python3
"""Makes Sora.ttf from the upstream Sora variable font so that l and I are told apart from 1.

Upstream draws l and I as plain stems; its stylistic alternates l.salt and I.salt carry a tail
and serifs. This swaps those outlines into the default glyphs, so the whole UI gets them and
every other glyph is left as upstream has it. Needs fontTools.

  python3 unambiguous-l.py UPSTREAM-Sora.ttf Sora.ttf
"""
import sys

from fontTools.ttLib import TTFont

SWAPPED = ["l", "I"]


def swap(table, first, second):
    table[first], table[second] = table[second], table[first]


def main():
    font = TTFont(sys.argv[1])
    pairs = [(name, f"{name}.salt") for name in SWAPPED]
    variations = font["gvar"].variations
    loaded = {name: variations[name] for pair in pairs for name in pair}
    for name, tuples in loaded.items():
        variations[name] = tuples
    for name, alternate in pairs:
        swap(font["glyf"].glyphs, name, alternate)
        swap(variations, name, alternate)
        swap(font["hmtx"].metrics, name, alternate)
    font.save(sys.argv[2])


main()
