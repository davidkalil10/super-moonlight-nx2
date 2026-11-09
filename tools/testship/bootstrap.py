#!/usr/bin/env python3

import argparse
import hashlib
import json
from pathlib import Path

from launch import wait_screen
from t3 import capture, request, text_commands


def expression(text):
    parts = []
    literal = ""
    for character in text:
        if character in ('"', '\n'):
            if literal:
                parts.append('"' + literal + '"')
                literal = ""
            parts.append(f"CHR$({ord(character)})")
        else:
            literal += character
    if literal:
        parts.append('"' + literal + '"')
    return "+".join(parts) or '""'


def chunks(source):
    current = ""
    for character in source:
        candidate = current + character
        if len(expression(candidate)) > 160:
            yield current
            current = character
        else:
            current = candidate
    if current:
        yield current


def checksum(source):
    value = 0
    for character in source:
        value = (value * 65599 + ord(character)) % 2147483647
    return value


def verify_command(source, marker):
    return ('H#=0:FOR J=0 TO LEN(C$)-1:H#=H#*65599+ASC(MID$(C$,J,1)):'
            'H#=H#-FLOOR(H#/2147483647)*2147483647:NEXT:CLS:'
            f'IF H#=={checksum(source)} && LEN(C$)=={len(source)} THEN PRINT "{marker}"')


def part_marker(index):
    alphabet = "ABCDEFGHJKMNPQRSTUVWX"
    letters = ""
    while index:
        index, digit = divmod(index, len(alphabet))
        letters = alphabet[digit] + letters
    return "TRANSFER " + letters.rjust(2, "A") + " VERIFIED"


def transfer(args):
    source = args.source.read_text(encoding="ascii")
    if not source or len(source) > 65536 or not source.endswith("\n"):
        raise ValueError("Expected an ASCII bootstrap ending in LF, at most 64 KiB")
    pieces = list(chunks(source))
    if not 0 <= args.resume_chunks <= len(pieces):
        raise ValueError("Invalid completed chunk count")
    for piece in pieces:
        text_commands(piece)
    args.evidence.mkdir(parents=True, exist_ok=False)
    (args.evidence / "source.bas").write_text(source, encoding="ascii")
    metadata = {"source_sha256": hashlib.sha256(source.encode()).hexdigest(),
                "characters": len(source), "checksum": checksum(source),
                "slot_changed": False, "saved": False}
    (args.evidence / "transfer.json").write_text(json.dumps(metadata, indent=2) + "\n")
    wait_screen(args, "OK")
    journal = args.evidence / "steps.jsonl"

    def line(command, expected, verify=True):
        if len(command) > 240:
            raise ValueError("Direct-mode commands must fit the observed 256-character input limit")
        with journal.open("a") as stream:
            stream.write(json.dumps({"command": command, "state": "sending"}) + "\n")
        request(args.socket, {"op": "type", "text": command, "enter": True, "key_ms": 20})
        request(args.socket, {"op": "sequence", "steps": [{"wait": 700}]})
        if verify:
            wait_screen(args, expected, timeout=12)
        else:
            capture(args.capture_url, args.evidence / (expected.replace(" ", "-") + ".jpg"))
        with journal.open("a") as stream:
            stream.write(json.dumps({"command": command, "state": "verified" if verify else "acknowledged"}) + "\n")
        print(expected, flush=True)

    prefix = "".join(pieces[:args.resume_chunks])
    if prefix:
        line(verify_command(prefix, "RESUME VERIFIED"), "RESUME VERIFIED")
    else:
        line('C$="":CLS:IF LEN(C$)==0 THEN PRINT "TRANSFER BEGUN"', "TRANSFER BEGUN")
    length = len(prefix)
    for index in range(args.resume_chunks, len(pieces)):
        chunk = pieces[index]
        length += len(chunk)
        marker = part_marker(index)
        line('C$=C$+' + expression(chunk) + f':CLS:IF LEN(C$)=={length} THEN PRINT "{marker}"', marker, verify=False)
        if (index + 1) % 10 == 0:
            line(verify_command(source[:length], "PREFIX VERIFIED"), "PREFIX VERIFIED")
    line(verify_command(source, "CHECKSUM VERIFIED"), "CHECKSUM VERIFIED")
    print("Bootstrap string verified. Save C$ with SAVEV, then verify a LOADV round trip before RUN.", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Transfer the supplied bootstrap to a checked Direct-mode string")
    parser.set_defaults(ocr_psm=6)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--capture-url", required=True)
    parser.add_argument("--tesseract", required=True)
    parser.add_argument("--resume-chunks", type=int, default=0,
                        help="verify the retained prefix before continuing; never replay a chunk")
    transfer(parser.parse_args())


if __name__ == "__main__":
    main()
