#!/usr/bin/env python3
"""Verify a final static PIE linked against the four-alias libouncevk.a (README.md).

Checks the aliases against the true SDK locals, the SDK lock functions against the original
vulkan.o, every input object's alias relocations against the linked instructions, the lock paths of
the query, and the dynamic section. Symbols and addresses are resolved from the inputs, never pinned.
Exit 0 when every check passes, 1 when any check fails, 2 on usage or tool errors.
"""
import argparse
import hashlib
import os
import re
import struct
import subprocess
import sys
import tempfile

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")
sys.path.insert(0, LIB)
from elfraw import ET_DYN, SHN_ABS, Elf  # noqa: E402
from lockpaths import QUERY, Callee, describe, parse, walk  # noqa: E402
from pins import (ALIAS_ARCHIVE_SHA, ALIASES, FINAL_BINDING, INPUT_RELOCS, LOCK_ALIAS,  # noqa: E402
                  MEMBER, MEMBER_SHA, SDK_ARCHIVE_SHA, SDK_CALLS, UNLOCK_ALIAS)

RELOC_TYPES = {275: "R_AARCH64_ADR_PREL_PG_HI21", 277: "R_AARCH64_ADD_ABS_LO12_NC",
               282: "R_AARCH64_JUMP26", 283: "R_AARCH64_CALL26"}
DERIVED_SECTIONS = {".nx-module-name", ".note.gnu.build-id"}
SHF_ALLOC = 2
SHF_WRITE = 1
SHF_EXECINSTR = 4
EM_AARCH64 = 183
ET_REL = 1
failures = 0


def check(name, ok, detail=""):
    global failures
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")
    if not ok:
        failures += 1


def run(*args, cwd=None):
    return subprocess.run(list(args), check=True, capture_output=True, text=True, cwd=cwd).stdout


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def unique(rows, name, kind=None):
    found = [r for r in rows if r["name"] == name and (kind is None or r["type"] == kind)]
    return found[0] if len(found) == 1 else None


def word(data, offset):
    return int.from_bytes(data[offset:offset + 4], "little")


def signed(value, bits):
    return value - (1 << bits) if value >> (bits - 1) else value


def decode(insn, pc):
    """Returns (kind, value) for the instruction forms an alias relocation may resolve to."""
    if insn & 0xfc000000 == 0x94000000:
        return "bl", pc + 4 * signed(insn & 0x3ffffff, 26)
    if insn & 0xfc000000 == 0x14000000:
        return "b", pc + 4 * signed(insn & 0x3ffffff, 26)
    if insn & 0x9f000000 in (0x90000000, 0x10000000):
        imm = signed(((insn >> 5) & 0x7ffff) << 2 | (insn >> 29) & 3, 21)
        if insn & 0x80000000:
            return "adrp", (pc & ~0xfff) + (imm << 12)
        return "adr", pc + imm
    if insn & 0xffc00000 == 0x91000000:
        return "add", (insn >> 10) & 0xfff
    return "other", None


def resolves(kind, insn, pc, address):
    form, value = decode(insn, pc)
    if kind == "R_AARCH64_ADR_PREL_PG_HI21":
        return form in ("adrp", "adr") and value == address & ~0xfff
    if kind == "R_AARCH64_ADD_ABS_LO12_NC":
        return form == "add" and value == address & 0xfff
    if kind == "R_AARCH64_CALL26":
        return form == "bl" and value == address
    return False


def same_instruction(kind, original, linked):
    masks = {"R_AARCH64_ADR_PREL_PG_HI21": 0x60ffffe0,
             "R_AARCH64_ADD_ABS_LO12_NC": 0x003ffc00,
             "R_AARCH64_CALL26": 0x03ffffff}
    mask = masks.get(kind, 0)
    return original & ~mask == linked & ~mask


def original_member(tools, archive, scratch):
    check("SDK archive hash", sha256(archive) == SDK_ARCHIVE_SHA, sha256(archive))
    members = run(tools["ar"], "t", archive).split()
    check(f"SDK archive holds only {MEMBER}", members == [MEMBER], " ".join(members))
    run(tools["ar"], "x", os.path.abspath(archive), MEMBER, cwd=scratch)
    path = os.path.join(scratch, MEMBER)
    check("SDK member hash", sha256(path) == MEMBER_SHA, sha256(path))
    return Elf(path)


def check_locals(rows):
    addresses = {}
    for alias, (local, kind, size, _, _, section, visibility) in ALIASES.items():
        target = unique(rows, local)
        mine = unique(rows, alias)
        targetOk = target is not None and target["bind"] == "LOCAL" and target["type"] == kind
        targetOk = targetOk and target["size"] == size and target["vis"] == visibility
        targetOk = targetOk and target["section"] == section
        check(f"{local} unique LOCAL {visibility} {kind} size {size:#x} in {section}", targetOk, str(target))

        bind, vis = FINAL_BINDING[kind]
        aliasOk = mine is not None and mine["bind"] == bind and mine["vis"] == vis
        aliasOk = aliasOk and mine["type"] == kind and mine["size"] == 0
        check(f"{alias} unique {bind} {vis} {kind} size 0", aliasOk, str(mine))
        if target is None or mine is None:
            continue

        check(f"{alias} value equals {local}", mine["value"] == target["value"],
              f"{mine['value']:#x} vs {target['value']:#x}")
        check(f"{alias} section-relative in {local}'s section",
              mine["shndx"] == target["shndx"] and mine["shndx"] != SHN_ABS, f"ndx {mine['shndx']}")
        addresses[alias] = target["value"]
    return addresses


def external_targets(listing, start, end):
    targets = []
    for line in listing.splitlines():
        match = re.match(r"\s*[0-9a-f]+:\s+(\S+)\s+([0-9a-f]+) <", line)
        if match is None or match.group(1) not in ("b", "bl"):
            continue
        address = int(match.group(2), 16)
        if match.group(1) == "bl" or not start <= address < end:
            targets.append((match.group(1), address))
    return targets


def check_sdk_functions(tools, path, final, rows, member):
    for local, (op, callee) in SDK_CALLS.items():
        row = unique(rows, local, "FUNC")
        callee_row = unique(rows, callee, "FUNC")
        if row is None or callee_row is None:
            check(f"{local} and {callee} resolved", False)
            continue
        start, end = row["value"], row["value"] + row["size"]

        listing = run(tools["objdump"], "-d", "--no-show-raw-insn", f"--disassemble={local}", path)
        targets = external_targets(listing, start, end)
        check(f"{local} external calls are exactly [{op} {callee}]", targets == [(op, callee_row["value"])],
              " ".join(f"{o} {t:#x}" for o, t in targets))

        index = member.index(f".text.{local}")
        original = member.body(index) if index is not None else b""
        linked = final.read(start, row["size"]) or b""
        differing = [i for i in range(0, row["size"], 4) if linked[i:i + 4] != original[i:i + 4]]
        expected = [i for i in range(0, len(linked), 4)
                    if decode(word(linked, i), start + i)[1] == callee_row["value"]]
        check(f"{local} linked bytes equal the SDK vulkan.o except its one {op}",
              len(expected) == 1 and differing == expected and len(original) == row["size"],
              f"differing offsets {[hex(i) for i in differing]}")


def object_users(path):
    """Collects the functions of one input object that reference an alias."""
    obj = Elf(path)
    check(f"{os.path.basename(path)} is an AArch64 relocatable object",
          obj.ehdr[1] == ET_REL and obj.ehdr[2] == EM_AARCH64)
    rows = obj.symbol_rows()
    names = [r["name"] for r in rows]
    references = [r for r in rows if r["name"] in ALIASES]
    check(f"{os.path.basename(path)} references aliases only as UND GLOBAL HIDDEN",
          bool(references) and all(r["shndx"] == 0 and r["bind"] == "GLOBAL" and r["vis"] == "HIDDEN"
                                   for r in references),
          f"{len(references)} references")

    relocated, users = {}, {}
    for section, offset, symbol, kind, addend in obj.relocations():
        relocated.setdefault(section, set()).add(offset)
        alias = names[symbol] if symbol < len(names) else None
        if alias not in ALIASES:
            continue

        type_name = RELOC_TYPES.get(kind, str(kind))
        container = [r for r in rows if r["type"] == "FUNC" and r["shndx"] == section
                     and r["value"] <= offset < r["value"] + r["size"]]
        allowed = INPUT_RELOCS[ALIASES[alias][1]]
        check(f"{os.path.basename(path)} {type_name} to {alias} at {obj.names[section]}+{offset:#x} "
              "is direct, addend 0, inside one function",
              type_name in allowed and addend == 0 and len(container) == 1)
        if len(container) != 1:
            continue
        function = container[0]
        user = users.setdefault(function["name"], dict(obj=obj, row=function, refs=[]))
        user["refs"].append((offset - function["value"], type_name, alias))

    for user in users.values():
        row = user["row"]
        user["relocated"] = {o - row["value"] for o in relocated.get(row["shndx"], ())}
    return users


def check_user(name, user, final, rows, addresses):
    row = unique(rows, name, "FUNC")
    origin = user["row"]
    check(f"{name} linked once with its object size {origin['size']:#x}",
          row is not None and row["size"] == origin["size"], str(row))
    if row is None:
        return

    body = user["obj"].body(origin["shndx"])[origin["value"]:origin["value"] + origin["size"]]
    linked = final.read(row["value"], row["size"]) or b""
    differing = {i for i in range(0, len(body), 4) if linked[i:i + 4] != body[i:i + 4]}
    check(f"{name} linked bytes equal its object except relocated words",
          len(linked) == len(body) and differing <= user["relocated"],
          f"unexplained offsets {[hex(i) for i in sorted(differing - user['relocated'])][:8]}")

    wrong = []
    for offset, kind, alias in user["refs"]:
        pc = row["value"] + offset
        original_word, linked_word = word(body, offset), word(linked, offset)
        if not same_instruction(kind, original_word, linked_word):
            wrong.append(f"{offset:#x} {kind} changed instruction/register bits")
        elif not resolves(kind, linked_word, pc, addresses.get(alias, -1)):
            wrong.append(f"{offset:#x} {kind} {alias}")
    check(f"{name} {len(user['refs'])} alias relocations resolve to the SDK locals", not wrong, " ".join(wrong))


def check_query(tools, path, query, rows, addresses, expect_sites):
    listing = run(tools["objdump"], "-d", "--no-show-raw-insn", f"--disassemble={query}", path)
    code = parse(listing, query)
    lock = Callee(addresses={addresses.get(LOCK_ALIAS, -1)})
    unlock = Callee(addresses={addresses.get(UNLOCK_ALIAS, -1)})
    problems, stats = walk(code, lock, unlock)
    if stats and expect_sites is not None and stats["unlocks"] != expect_sites:
        problems.append(f"expected {expect_sites} unlock sites, found {stats['unlocks']}")
    check(f"{query} lock paths ({describe(stats)})", not problems, "; ".join(problems))


def check_dynamic(tools, path, final):
    check("ELF is a PIE (ET_DYN)", final.ehdr[1] == ET_DYN, str(final.ehdr[1]))
    check("ELF machine is AArch64", final.ehdr[2] == EM_AARCH64, str(final.ehdr[2]))
    dynamic = run(tools["readelf"], "-dW", path)
    check("no TEXTREL", "TEXTREL" not in dynamic)
    check("no NEEDED", "NEEDED" not in dynamic)
    relocations = run(tools["readelf"], "-rW", path)
    symbolic = [k for k in ("R_AARCH64_ABS64", "GLOB_DAT", "JUMP_SLOT", "R_AARCH64_NONE") if k in relocations]
    check("no symbolic or placeholder dynamic relocations", not symbolic, " ".join(symbolic))
    dynsym = run(tools["readelf"], "--dyn-syms", "-W", path)
    names = list(ALIASES) + [spec[0] for spec in ALIASES.values()]
    check("aliases and locals absent from .dynsym", not [n for n in names if n in dynsym])

    targets, unsupported = [], []
    for section in final.sections:
        if not section[2] & SHF_ALLOC:
            continue
        if section[1] == 4:
            for offset in range(section[4], section[4] + section[5], 24):
                address, info, _ = struct.unpack_from("<QQq", final.data, offset)
                if info != 1027:
                    unsupported.append((hex(address), info))
                targets.append(address)
        elif section[1] == 19:
            base = None
            for offset in range(section[4], section[4] + section[5], 8):
                entry = struct.unpack_from("<Q", final.data, offset)[0]
                if entry & 1 == 0:
                    targets.append(entry)
                    base = entry + 8
                elif base is None:
                    unsupported.append(("RELR bitmap before address", entry))
                else:
                    targets.extend(base + bit * 8 for bit in range(63) if entry >> (bit + 1) & 1)
                    base += 63 * 8
        elif section[1] == 9:
            unsupported.append(("SHT_REL", section[5]))
    check("allocated dynamic relocations use only AArch64 RELATIVE or RELR",
          not unsupported, str(unsupported[:8]))

    invalid = []
    for address in targets:
        containing = [s for s in final.sections if s[2] & SHF_ALLOC and s[3] <= address
                      and address + 8 <= s[3] + s[5]]
        writable = len(containing) == 1 and containing[0][2] & SHF_WRITE
        executable = any(s[2] & SHF_EXECINSTR for s in containing)
        if address & 7 or not writable or executable:
            invalid.append(hex(address))
    check("all dynamic relocation targets are aligned writable data, never executable",
          not invalid, f"{len(targets)} targets; invalid {invalid[:8]}")


def check_map(map_path, alias_archive):
    check("alias archive hash", sha256(alias_archive) == ALIAS_ARCHIVE_SHA, sha256(alias_archive))
    linked = set(re.findall(r"(\S*libouncevk\.a)\(" + re.escape(MEMBER) + r"\)", open(map_path).read()))
    want = os.path.realpath(alias_archive)
    check(f"map links {MEMBER} only from the alias archive",
          bool(linked) and all(os.path.realpath(p) == want for p in linked), " ".join(sorted(linked)))


def compare_placeholder(path, final, rows, users):
    other = Elf(path)
    layout = lambda elf: {n: (s[3], s[5], s[1]) for n, s in zip(elf.names, elf.sections) if s[3]}
    mine, theirs = layout(final), layout(other)
    check("layout identical to the unmodified-archive placeholder link", mine == theirs,
          " ".join(sorted(str(i) for i in set(mine.items()) ^ set(theirs.items()))[:6]))

    key = lambda r: (r["name"], r["value"], r["size"], r["type"], r["bind"], r["vis"], r["section"] or "")
    rest = lambda table: sorted(key(r) for r in table if r["name"] not in ALIASES)
    check("every non-alias symbol identical to placeholder", rest(rows) == rest(other.symbol_rows()))

    allowed = set()
    for name in users:
        row = unique(rows, name, "FUNC")
        if row:
            allowed |= set(range(row["value"], row["value"] + row["size"], 4))
    changed, unexpected = 0, []
    for index, section in enumerate(final.sections):
        name = final.names[index]
        if not section[2] & SHF_ALLOC or final.nobits(index) or other.index(name) is None:
            continue
        a, b = other.body(other.index(name)), final.body(index)
        for offset in range(0, len(b), 4):
            if a[offset:offset + 4] == b[offset:offset + 4]:
                continue
            changed += 1
            if section[3] + offset not in allowed and name not in DERIVED_SECTIONS:
                unexpected.append((name, hex(section[3] + offset)))
    check("allocated bytes differ from placeholder only in alias users and link notes", not unexpected,
          f"{changed} changed words, unexpected {unexpected[:8]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--tool-prefix", required=True, help="e.g. /opt/devkitpro/devkitA64/bin/aarch64-none-elf")
    parser.add_argument("--sdk-archive", required=True, help="the unmodified SDK libouncevk.a")
    parser.add_argument("--elf", required=True, help="the final linked ELF")
    parser.add_argument("--query", default=QUERY)
    parser.add_argument("--expect-unlock-sites", type=int, default=10)
    parser.add_argument("--placeholder", help="same link against the unmodified archive, aliases --defsym'd")
    parser.add_argument("--map", required=True, help="linker map of --elf")
    parser.add_argument("--alias-archive", required=True, help="the prepared libouncevk.a passed to the link")
    parser.add_argument("objects", nargs="+", help="every input object that references an alias")
    args = parser.parse_args()
    if args.expect_unlock_sites < 1:
        parser.error("--expect-unlock-sites must be positive")
    tools = {t: f"{args.tool_prefix}-{t}" for t in ("readelf", "objdump", "ar")}

    final = Elf(args.elf)
    rows = final.symbol_rows()
    with tempfile.TemporaryDirectory() as scratch:
        member = original_member(tools, args.sdk_archive, scratch)
    addresses = check_locals(rows)
    check_sdk_functions(tools, args.elf, final, rows, member)

    users = {}
    for path in args.objects:
        for name, user in object_users(path).items():
            check(f"{name} defined in one input object", name not in users)
            users[name] = user
    referenced = {alias for user in users.values() for _, _, alias in user["refs"]}
    check("inputs reference all four aliases", referenced == set(ALIASES), " ".join(sorted(referenced)))
    lockers = sorted(n for n, u in users.items() if {LOCK_ALIAS, UNLOCK_ALIAS} & {a for _, _, a in u["refs"]})
    check(f"only {args.query} calls the owner lock", lockers == [args.query], " ".join(lockers))
    for name, user in sorted(users.items()):
        check_user(name, user, final, rows, addresses)

    check_query(tools, args.elf, args.query, rows, addresses, args.expect_unlock_sites)
    check_dynamic(tools, args.elf, final)
    check_map(args.map, args.alias_archive)
    if args.placeholder:
        compare_placeholder(args.placeholder, final, rows, users)

    print(f"{'PASS' if failures == 0 else 'FAIL'}: {failures} failure(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, IndexError, StopIteration, struct.error,
            subprocess.CalledProcessError) as error:
        print(f"ERROR {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(2)
