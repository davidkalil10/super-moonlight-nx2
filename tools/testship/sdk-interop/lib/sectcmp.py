"""Strict raw comparison of the original vulkan.o and its GNU objcopy --add-symbol copy.

Usage: sectcmp.py <original.o> <aliased.o>
Every section but .symtab/.strtab keeps its header (except sh_offset) and raw bytes, relocations
included. Every original symbol stays identical at its index; only the pinned aliases are appended,
GLOBAL DEFAULT with their local's type and st_shndx, value 0, size 0. Exit 0 on pass, 1 on failure.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from elfraw import Elf  # noqa: E402
from pins import ALIASES  # noqa: E402

failures = 0


def check(name, ok, detail=""):
    global failures
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    if not ok:
        failures += 1


def finish():
    print(f"{'PASS' if failures == 0 else 'FAIL'}: {failures} failure(s)")
    sys.exit(1 if failures else 0)


def compare_sections(first, second, symtab, strtab):
    header_diff, byte_diff, compared = [], [], 0
    for index, (a, b) in enumerate(zip(first.sections, second.sections)):
        if index in (symtab, strtab):
            continue
        if a[:4] + a[5:] != b[:4] + b[5:]:
            header_diff.append(first.names[index])
        if first.body(index) != second.body(index):
            byte_diff.append(first.names[index])
        compared += 1

    check("every other section header identical except sh_offset", not header_diff,
          f"{compared} sections; differing: {' '.join(header_diff[:5])}")
    check("every other section byte-identical, raw relocations included", not byte_diff,
          f"differing: {' '.join(byte_diff[:5])}")


def compare_alias(alias, local, rows, added):
    locals_ = [r for r in rows if r[0] == local]
    mine = [r for r in added if r[0] == alias]
    if len(locals_) != 1 or len(mine) != 1:
        check(f"{alias} once beside unique {local}", False, f"{len(mine)} / {len(locals_)}")
        return

    l, m = locals_[0], mine[0]
    bindingOk = m[1] >> 4 == 1 and l[1] >> 4 == 0 and m[2] == 0
    placeOk = m[1] & 0xf == l[1] & 0xf and m[3] == l[3]
    valueOk = m[4] == l[4] == 0 and m[5] == 0
    check(f"{alias} GLOBAL DEFAULT, type, st_shndx and value match LOCAL {local}, size 0",
          bindingOk and placeOk and valueOk,
          f"info {m[1]:#x} other {m[2]:#x} shndx {m[3]} value {m[4]:#x} vs local info {l[1]:#x} shndx {l[3]}")


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: sectcmp.py <original.o> <aliased.o>")
    first, second = Elf(sys.argv[1]), Elf(sys.argv[2])
    aliases = {alias: spec[0] for alias, spec in ALIASES.items()}

    e1, e2 = list(first.ehdr), list(second.ehdr)
    e1[6] = e2[6] = 0
    check("ELF header identical except e_shoff", e1 == e2)
    check("same section count and names", first.names == second.names, f"{len(first.names)} sections")
    if first.names != second.names:
        finish()
    if first.has_symtab_shndx() or second.has_symtab_shndx():
        check("no SHT_SYMTAB_SHNDX (not handled)", False)
        finish()

    symtab, rows1 = first.symbols()
    _, rows2 = second.symbols()
    strtab = first.sections[symtab][6]
    compare_sections(first, second, symtab, strtab)

    a, b = first.sections[symtab], second.sections[symtab]
    check(".symtab header identical except offset and size",
          (a[0], a[1], a[2], a[3], a[6], a[7], a[8], a[9]) == (b[0], b[1], b[2], b[3], b[6], b[7], b[8], b[9]),
          f"sh_info {a[7]} vs {b[7]}")
    check("every original symbol identical at the same index (all fields)", rows2[:len(rows1)] == rows1,
          f"{len(rows1)} original entries")

    added = rows2[len(rows1):]
    check("only the pinned aliases are appended", sorted(r[0] for r in added) == sorted(aliases),
          " ".join(r[0] for r in added))
    for alias, local in aliases.items():
        compare_alias(alias, local, rows1, added)
    finish()


main()
