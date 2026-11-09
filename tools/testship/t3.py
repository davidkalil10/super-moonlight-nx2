#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
import queue
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.request


NEUTRAL_KEY = "K 0000000000000000 0"
NEUTRAL_PAD = "P 0000088080808000 0"
BUTTONS = {
    "y": 0, "b": 1, "a": 2, "x": 3, "l": 4, "r": 5,
    "zl": 6, "zr": 7, "minus": 8, "plus": 9,
    "left-stick": 10, "right-stick": 11, "home": 12, "capture": 13,
}
HATS = {"up": 0, "up-right": 1, "right": 2, "down-right": 3,
        "down": 4, "down-left": 5, "left": 6, "up-left": 7, "neutral": 8}
KEYS = {"enter": 40, "escape": 41, "backspace": 42, "tab": 43,
        "capslock": 57, "right": 79, "left": 80, "down": 81, "up": 82}
PUNCTUATION = {
    " ": (44, 0), "-": (45, 0), "_": (45, 2), "=": (46, 0), "+": (46, 2),
    "[": (47, 0), "{": (47, 2), "]": (48, 0), "}": (48, 2),
    "\\": (49, 0), "|": (49, 2), ";": (51, 0), ":": (51, 2),
    "'": (52, 0), '"': (52, 2), "`": (53, 0), "~": (53, 2),
    ",": (54, 0), "<": (54, 2), ".": (55, 0), ">": (55, 2),
    "/": (56, 0), "?": (56, 2), "\t": (43, 0), "\n": (40, 0),
}


def integer(value, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"Expected an integer between {minimum} and {maximum}")
    return value


def keyboard(usage, modifier=0, milliseconds=55):
    report = bytes((modifier, 0, usage, 0, 0, 0, 0, 0)).hex()
    return f"K {report} {milliseconds}"


def text_commands(text, milliseconds=55, enter=False):
    if not isinstance(text, str) or len(text) > 1024 or "\r" in text:
        raise ValueError("Expected at most 1024 characters of US keyboard text without CR")
    integer(milliseconds, 20, 1000)
    if not isinstance(enter, bool):
        raise ValueError("enter must be true or false")
    if (len(text) + int(enter)) * milliseconds * 2 > 120000:
        raise ValueError("A typing request may last at most two minutes")
    commands = []
    for character in text + ("\n" if enter else ""):
        if "a" <= character <= "z":
            usage, modifier = ord(character) - ord("a") + 4, 0
        elif "A" <= character <= "Z":
            usage, modifier = ord(character) - ord("A") + 4, 2
        elif "1" <= character <= "9":
            usage, modifier = ord(character) - ord("1") + 30, 0
        elif character == "0":
            usage, modifier = 39, 0
        elif character in "!@#$%^&*()":
            index = "!@#$%^&*()".index(character)
            usage, modifier = 30 + index, 2
        elif character in PUNCTUATION:
            usage, modifier = PUNCTUATION[character]
        else:
            raise ValueError(f"Unsupported keyboard character U+{ord(character):04X}")
        commands.extend((keyboard(usage, modifier, milliseconds), f"K 0000000000000000 {milliseconds}"))
    return commands


def pad_command(buttons, hat="neutral", milliseconds=200):
    if not isinstance(buttons, list) or len(buttons) > len(BUTTONS):
        raise ValueError("buttons must be a list of controller button names")
    if any(not isinstance(name, str) or name not in BUTTONS for name in buttons):
        raise ValueError("Unknown controller button")
    if not isinstance(hat, str) or hat not in HATS:
        raise ValueError("Unknown controller direction")
    integer(milliseconds, 0, 30000)
    mask = 0
    for name in buttons:
        mask |= 1 << BUTTONS[name]
    report = bytes((mask & 255, mask >> 8, HATS[hat], 128, 128, 128, 128, 0)).hex()
    return f"P {report} {milliseconds}"


def compile_request(request):
    if not isinstance(request, dict):
        raise ValueError("Expected a JSON object")
    operation = request.get("op")
    if operation == "status":
        return ["S"]
    if operation == "neutral":
        return [NEUTRAL_KEY, NEUTRAL_PAD]
    if operation == "key":
        name = request.get("name")
        if not isinstance(name, str) or name not in KEYS:
            raise ValueError("Unknown keyboard key")
        duration = integer(request.get("ms", 80), 20, 1000)
        return [keyboard(KEYS[name], milliseconds=duration), NEUTRAL_KEY]
    if operation == "type":
        return text_commands(request.get("text"), request.get("key_ms", 55), request.get("enter", False))
    if operation == "pad":
        return [pad_command(request.get("buttons", []), request.get("hat", "neutral"), request.get("ms", 200))]
    if operation != "sequence":
        raise ValueError("Expected op status, neutral, key, type, pad or sequence")
    steps = request.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 128:
        raise ValueError("Expected 1 to 128 controller steps")
    commands = []
    total = 0
    for step in steps:
        if not isinstance(step, dict):
            raise ValueError("Invalid controller step")
        if set(step) == {"wait"}:
            duration = integer(step["wait"], 0, 30000)
            commands.append(f"W {duration}")
        else:
            if set(step) - {"buttons", "hat", "ms"}:
                raise ValueError("Unknown controller step field")
            duration = integer(step.get("ms", 200), 0, 30000)
            commands.append(pad_command(step.get("buttons", []), step.get("hat", "neutral"), duration))
        total += duration
    if total > 60000:
        raise ValueError("A controller sequence may last at most 60 seconds")
    return commands


class Driver:
    def __init__(self, executable, log, dry_run=False):
        self.log = log
        self.sequence = 0
        self.failed = False
        self.events = queue.Queue()
        self.process = subprocess.Popen(
            [str(executable), "--control"] + (["--dry-run"] if dry_run else []),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1,
        )
        self.reader = threading.Thread(target=self.read_events, daemon=True)
        self.reader.start()
        try:
            self.wait_for("ready", 0, 40)
        except BaseException:
            self.close()
            raise

    def read_events(self):
        try:
            for line in self.process.stdout:
                self.log.write(line)
                self.log.flush()
                self.events.put(json.loads(line))
        except (ValueError, OSError) as error:
            self.events.put({"event": "error", "message": str(error)})
        finally:
            self.events.put({"event": "closed"})

    def wait_for(self, event, sequence, seconds):
        deadline = time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("T3 command completion is uncertain; restart the controller")
            try:
                response = self.events.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError("T3 driver timed out; the command must not be replayed") from None
            if response.get("event") in ("error", "closed"):
                raise RuntimeError(f"T3 driver stopped: {response}")
            if response.get("event") == event and response.get("sequence", 0) == sequence:
                return response

    def exchange(self, command):
        if self.failed:
            raise RuntimeError("T3 controller is retired after an uncertain command")
        self.sequence += 1
        try:
            self.process.stdin.write(command + "\n")
            self.process.stdin.flush()
            milliseconds = int(command.rsplit(" ", 1)[-1]) if command[0] in "KPW" else 0
            return self.wait_for("done", self.sequence, milliseconds / 1000 + 12)
        except BaseException:
            self.failed = True
            try:
                self.process.stdin.close()
            except OSError:
                pass
            raise

    def execute(self, request):
        commands = compile_request(request)
        before = self.exchange("S")
        if request.get("op") == "type" and before.get("leds", 0) & 2:
            raise RuntimeError("Caps Lock is enabled; clear it before typing")
        try:
            result = before
            for command in commands:
                result = self.exchange(command)
            return {"ok": True, "commands": len(commands), "sequence": self.sequence, "status": result}
        finally:
            if not self.failed:
                self.exchange(NEUTRAL_KEY)
                self.exchange(NEUTRAL_PAD)

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
            except OSError:
                pass
            try:
                self.process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=12)
        self.reader.join(timeout=2)
        self.process.stdout.close()


def validate_socket_path(path):
    if not path.is_absolute() or len(os.fsencode(path)) > 100:
        raise ValueError("Use a short absolute controller socket path, such as /run/moonlight-t3.sock")


def serve(args):
    validate_socket_path(args.socket)
    if args.socket.exists():
        raise RuntimeError("Controller socket already exists; inspect the active service first")
    args.socket.parent.mkdir(parents=True, exist_ok=True)
    args.log.parent.mkdir(parents=True, exist_ok=True)
    with args.log.open("x", buffering=1) as log:
        driver = Driver(args.driver, log, args.dry_run)
        try:
            class Handler(socketserver.StreamRequestHandler):
                def handle(self):
                    try:
                        self.request.settimeout(30)
                        raw = self.rfile.readline(262145)
                        if not raw.endswith(b"\n") or len(raw) > 262144:
                            raise ValueError("Invalid request size or framing")
                        result = driver.execute(json.loads(raw))
                    except Exception as error:
                        result = {"ok": False, "error": str(error), "uncertain": driver.failed}
                    self.wfile.write((json.dumps(result) + "\n").encode())

            with socketserver.UnixStreamServer(str(args.socket), Handler) as server:
                os.chmod(args.socket, 0o600)
                if os.getuid() == 0:
                    owner = int(os.environ.get("SUDO_UID", "0"))
                    os.chown(args.socket, owner, -1)
                server.timeout = 0.5
                stopping = threading.Event()
                for name in (signal.SIGINT, signal.SIGTERM):
                    signal.signal(name, lambda *_: stopping.set())
                print(json.dumps({"ready": True, "socket": str(args.socket)}), flush=True)
                while not stopping.is_set() and driver.process.poll() is None and not driver.failed:
                    server.handle_request()
        finally:
            driver.close()
            args.socket.unlink(missing_ok=True)


def request(socket_path, message):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(600)
        channel.connect(str(socket_path))
        channel.sendall((json.dumps(message) + "\n").encode())
        with channel.makefile("rb") as stream:
            line = stream.readline(262145)
        if not line.endswith(b"\n") or len(line) > 262144:
            raise RuntimeError("Truncated controller response; do not replay the request")
        result = json.loads(line)
        if not result.get("ok"):
            raise RuntimeError(result.get("error", "Controller request failed"))
        return result


def capture(url, destination):
    query = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(query, timeout=10) as response:
        image = response.read(8 * 1024 * 1024 + 1)
    if not image.startswith(b"\xff\xd8") or len(image) > 8 * 1024 * 1024:
        raise RuntimeError("HDMI capture did not return a bounded JPEG")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as output:
        output.write(image)
    return destination


def main():
    parser = argparse.ArgumentParser(description="Local T3 keyboard/gamepad and HDMI control")
    parser.add_argument("--socket", type=Path, default=Path("/run/moonlight-t3.sock"))
    sub = parser.add_subparsers(dest="operation", required=True)
    server = sub.add_parser("serve")
    server.add_argument("--driver", type=Path, required=True)
    server.add_argument("--log", type=Path, required=True)
    server.add_argument("--dry-run", action="store_true")
    client = sub.add_parser("request")
    client.add_argument("json", help="JSON request, or - to read stdin")
    snapshot = sub.add_parser("capture")
    snapshot.add_argument("destination", type=Path)
    snapshot.add_argument("--url", default="http://127.0.0.1:8765/frame.jpg")
    args = parser.parse_args()
    if args.operation == "serve":
        serve(args)
    elif args.operation == "request":
        message = json.load(sys.stdin) if args.json == "-" else json.loads(args.json)
        print(json.dumps(request(args.socket, message)))
    else:
        print(capture(args.url, args.destination))


if __name__ == "__main__":
    main()
