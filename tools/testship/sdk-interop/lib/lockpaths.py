"""Walks every path of one function in an `objdump -d[r] --no-show-raw-insn` listing.

Fails unless the function has one owner_lock call whose bool result is tested at once, the refused
path never unlocks, every path that holds the lock calls owner_unlock exactly once before it
returns, no path leaves the function, and nothing else is called anywhere in it.
Ported from the C2 dev/sdk-backing lock_paths.py; it also walks from the entry, so an unlock
reachable without the lock is caught.

CLI (object listing, calls matched by alias name):
  lockpaths.py <listing> [--function NAME] [--expect-unlock-sites N]
Exit 0 and LOCK-PATHS-OK on pass, 1 and LOCK-PATHS-FAIL otherwise, 2 on usage errors.
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pins import LOCK_ALIAS, UNLOCK_ALIAS  # noqa: E402

QUERY = "moonlightSdkBackingQuery"
CONDITIONAL = re.compile(r"b\.\w+|cbz|cbnz|tbz|tbnz")
FORBIDDEN = ("blr", "br", "svc", "brk", "hvc", "smc", "eret")
LINE = re.compile(r"^\s+([0-9a-f]+):\s+(\S+)\s*(.*)$")
TARGET = re.compile(r"([0-9a-f]+) <([^>+]+)(?:\+0x[0-9a-f]+)?>")


class Callee:
    """Matches a call target by linked address or, in an object listing, by its label."""

    def __init__(self, addresses=(), names=()):
        self.addresses = set(addresses)
        self.names = set(names)

    def __call__(self, target, label):
        return target in self.addresses or label in self.names


def parse(text, function):
    code, inside = {}, False
    for line in text.splitlines():
        if line.rstrip().endswith(f"<{function}>:"):
            if code:
                raise ValueError(f"{function} listed twice")
            inside = True
            continue
        if inside and line.strip() == "":
            break
        match = LINE.match(line) if inside else None
        if match and not match.group(2).startswith("R_AARCH64"):
            operands = match.group(3).split("//")[0].strip()
            code[int(match.group(1), 16)] = (match.group(2), operands)
    return code


def target(operands):
    match = TARGET.search(operands)
    if match is None:
        return None, None
    return int(match.group(1), 16), match.group(2)


def lock_test(code, following, address):
    """Returns (problem, test address) for the instructions between the lock call and its test."""
    while address in code and not CONDITIONAL.fullmatch(code[address][0]):
        mnemonic, operands = code[address]
        if mnemonic in ("b", "bl", "ret") or mnemonic in FORBIDDEN:
            return f"lock result not tested before {mnemonic} at {address:#x}", None
        writes_w0 = re.match(r"[wx]0\b", operands)
        if writes_w0 and not mnemonic.startswith(("str", "stp", "stur", "cmp", "tst")):
            return f"w0 clobbered at {address:#x}", None
        address = following.get(address)
    if address not in code:
        return "lock result not tested before the end of the function", None

    mnemonic, operands = code[address]
    if mnemonic == "tbz" and re.match(r"w0, #0,", operands):
        return None, address
    if mnemonic == "cbz" and re.match(r"w0,", operands):
        return None, address
    return f"lock result not tested at {address:#x}", None


def walk(code, is_lock, is_unlock):
    """Returns (problems, stats)."""
    order = sorted(code)
    following = dict(zip(order, order[1:]))
    calls = [a for a in order if code[a][0] == "bl"]
    locks = [a for a in calls if is_lock(*target(code[a][1]))]
    unlocks = [a for a in calls if is_unlock(*target(code[a][1]))]
    others = [a for a in calls if a not in locks and a not in unlocks]
    forbidden = [a for a in order if code[a][0] in FORBIDDEN]

    problems = []
    if not code:
        problems.append("function not found or empty")
    if len(locks) != 1:
        problems.append(f"expected one lock call, found {len(locks)}")
    if not unlocks:
        problems.append("no unlock call")
    if others:
        problems.append(f"other calls: {[hex(a) for a in others]}")
    if forbidden:
        problems.append(f"indirect branches or traps: {[hex(a) for a in forbidden]}")
    if problems:
        return problems, None

    pending = [(order[0], "free")]
    seen, returns = set(), {"free": 0, "refused": 0, "released": 0}
    while pending:
        address, state = pending.pop()
        if (address, state) in seen:
            continue
        seen.add((address, state))
        if address is None:
            problems.append(f"falls off the end of the function in state {state}")
            continue
        if address not in code:
            problems.append(f"branch leaves the function to {address:#x} in state {state}")
            continue
        mnemonic, operands = code[address]

        if address in locks:
            if state != "free":
                problems.append(f"second lock at {address:#x} in state {state}")
                continue
            problem, test = lock_test(code, following, following.get(address))
            if problem:
                problems.append(problem)
                continue
            refused, _ = target(code[test][1])
            pending.extend([(refused, "refused"), (following.get(test), "held")])
            continue
        if address in unlocks:
            if state != "held":
                problems.append(f"unlock in state {state} at {address:#x}")
                continue
            state = "released"

        if mnemonic == "ret":
            if state == "held":
                problems.append(f"return while held at {address:#x}")
            else:
                returns[state] += 1
            continue
        if mnemonic == "b":
            pending.append((target(operands)[0], state))
        elif CONDITIONAL.fullmatch(mnemonic):
            pending.extend([(target(operands)[0], state), (following.get(address), state)])
        else:
            pending.append((following.get(address), state))

    stats = dict(lock=locks[0], unlocks=len(unlocks), states=len(seen), returns=returns,
                 released=sum(1 for _, s in seen if s == "released"))
    if returns["released"] == 0:
        problems.append("no path releases the lock and returns")
    return problems, stats


def describe(stats):
    if stats is None:
        return "no walk"
    r = stats["returns"]
    return (f"lock at {stats['lock']:#x}; {stats['unlocks']} unlock sites; {stats['states']} reachable states; "
            f"returns free {r['free']} refused {r['refused']} released {r['released']}")


def main():
    parser = argparse.ArgumentParser(description="Check owner lock paths in an objdump listing.")
    parser.add_argument("listing")
    parser.add_argument("--function", default=QUERY)
    parser.add_argument("--expect-unlock-sites", type=int)
    args = parser.parse_args()

    code = parse(open(args.listing).read(), args.function)
    problems, stats = walk(code, Callee(names={LOCK_ALIAS}), Callee(names={UNLOCK_ALIAS}))
    sites = args.expect_unlock_sites
    if stats and sites is not None and stats["unlocks"] != sites:
        problems.append(f"expected {sites} unlock sites, found {stats['unlocks']}")

    print(describe(stats))
    for problem in problems:
        print("FAIL", problem)
    print("LOCK-PATHS-OK" if not problems else "LOCK-PATHS-FAIL")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
