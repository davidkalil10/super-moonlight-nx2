"""Check the four pinned OunceVK definitions inside vulkan.o, before or after aliasing.

Usage: objident.py <readelf> <vulkan.o> original|aliased
Exit 0 when every check passes, 1 otherwise.
"""
import hashlib
import os
import subprocess
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


def symbols(readelf, path):
    rows = []
    for line in subprocess.check_output([readelf, "-sW", path], text=True).splitlines():
        parts = line.split()
        if len(parts) == 8 and parts[0][:-1].isdigit():
            rows.append(dict(value=int(parts[1], 16), size=int(parts[2], 0), type=parts[3], bind=parts[4],
                             vis=parts[5], ndx=parts[6], name=parts[7]))
    return rows


def check_alias(rows, alias, local, kind, mode):
    found = [r for r in rows if r["name"] == alias]
    if mode == "original":
        check(f"{alias} not yet defined", not found)
        return

    ok = len(found) == 1
    ok = ok and found[0]["bind"] == "GLOBAL" and found[0]["type"] == kind
    ok = ok and found[0]["ndx"] == local["ndx"] and found[0]["value"] == 0
    check(f"{alias} GLOBAL {kind} at {local['name']}", ok, str(found))


def main():
    if len(sys.argv) != 4 or sys.argv[3] not in ("original", "aliased"):
        sys.exit("usage: objident.py <readelf> <vulkan.o> original|aliased")
    readelf, path, mode = sys.argv[1:4]
    elf = Elf(path)
    rows = symbols(readelf, path)

    for alias, (local, kind, size, section, digest, _, _) in ALIASES.items():
        found = [r for r in rows if r["name"] == local]
        check(f"{local} unique", len(found) == 1, f"{len(found)} rows")
        if len(found) != 1:
            continue
        row = found[0]

        index = int(row["ndx"]) if row["ndx"].isdigit() else -1
        label = elf.names[index] if 0 <= index < len(elf.names) else "?"
        section_size = elf.sections[index][5] if 0 <= index < len(elf.sections) else 0
        check(f"{local} LOCAL {kind} size {size:#x}",
              row["bind"] == "LOCAL" and row["type"] == kind and row["size"] == size,
              f"{row['bind']} {row['type']} {row['size']:#x} {row['vis']}")
        check(f"{local} alone at offset 0 of {section}",
              label == section and row["value"] == 0 and section_size == size,
              f"{label} +{row['value']:#x} size {section_size:#x}")

        if digest is None:
            check(f"{local} section is NOBITS", index >= 0 and elf.nobits(index))
        else:
            got = hashlib.sha256(elf.body(index) if index >= 0 else b"").hexdigest()
            check(f"{local} section bytes sha256", got == digest, got)

        check_alias(rows, alias, row, kind, mode)

    print(f"{'PASS' if failures == 0 else 'FAIL'}: {failures} failure(s)")
    sys.exit(1 if failures else 0)


main()
