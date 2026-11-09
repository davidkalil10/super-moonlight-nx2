#!/usr/bin/env python3

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import subprocess
import threading
import time

from t3 import capture, request


def normalized(text):
    return re.sub(r"[^a-z0-9]", "", text.lower())


def start_command(line, host, arity):
    matched = re.search(r"V=START\(([0-9,]+)\)", line)
    if not matched:
        return None
    values = [int(value) for value in matched.group(1).split(",")]
    expected = [39380, *[int(part) for part in host.split(".")]]
    if arity == 9:
        expected += [0, 0, 0, 0]
    if values != expected:
        raise RuntimeError("The starter printed a START command for another host or BASIC arity")
    return matched.group(0)


def verify_bundle(bundle):
    manifest = json.loads((bundle / "manifest.json").read_text())
    if manifest.get("version") != 1 or not isinstance(manifest.get("files"), dict):
        raise ValueError("Unsupported testship package manifest")
    for name, expected in manifest["files"].items():
        path = bundle / name
        try:
            path.resolve().relative_to(bundle.resolve())
        except ValueError:
            raise ValueError("Package manifest leaves its directory") from None
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Package file is missing or linked: {name}")
        checksum = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(block)
        actual = checksum.hexdigest()
        if actual != expected:
            raise ValueError(f"Package file changed: {name}")
    return manifest


class Starter:
    def __init__(self, bundle, host, arity, log, node, trace=None):
        self.events = queue.Queue()
        self.log = log
        env = dict(os.environ, NS2_BASIC_ARITY=str(arity))
        if trace:
            preload = Path(__file__).resolve().with_name("trace-hello.cjs")
            env["NS2_HELLO_TRACE_FILE"] = str(trace)
            env["NODE_OPTIONS"] = env.get("NODE_OPTIONS", "") + " --require " + json.dumps(str(preload))
        self.process = subprocess.Popen(
            [str(node), str(bundle / "ns2jb/hen.cjs"), host],
            cwd=bundle / "ns2jb", env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        threading.Thread(target=self.read_lines, daemon=True).start()

    def read_lines(self):
        for line in self.process.stdout:
            self.log.write(line)
            self.log.flush()
            print(line, end="", flush=True)
            self.events.put(line)
        self.events.put(None)

    def wait(self, predicate, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                line = self.events.get(timeout=min(1, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if line is None:
                raise RuntimeError(f"Testship starter exited ({self.process.poll()}); keep the run logs")
            result = predicate(line)
            if result:
                return result
        raise TimeoutError("Testship startup timed out; do not repeat REMOVE in this process")

    def close(self):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGTERM)
            try:
                self.process.wait(timeout=300)
            except subprocess.TimeoutExpired:
                raise RuntimeError("Testship cleanup did not finish; inspect the run before another attempt") from None


def wait_screen(args, text, absent=(), timeout=20):
    expected = normalized(text)
    if not expected:
        raise ValueError("Screen checks require nonempty text")
    forbidden = [normalized(item) for item in absent]
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        image = capture(args.capture_url, args.evidence / f"{time.time_ns()}.jpg")
        result = subprocess.run([args.tesseract, str(image), "stdout", "--psm", str(getattr(args, "ocr_psm", 11))],
                                capture_output=True, text=True, check=True, timeout=20)
        image.with_suffix(".txt").write_text(result.stdout)
        observed = normalized(result.stdout)
        if expected in observed and not any(item in observed for item in forbidden):
            return image
        time.sleep(0.5)
    raise TimeoutError(f"Screen did not show {text!r}; inspect {args.evidence}")


def launch(args):
    args.bundle = args.bundle.resolve()
    verify_bundle(args.bundle)
    ipaddress.IPv4Address(args.host)
    if not args.tesseract:
        raise RuntimeError("tesseract is needed for screen verification")
    node = args.node or args.bundle / "node/bin/node"
    version = subprocess.check_output([str(node), "--version"], text=True).strip()
    match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (22, 12, 0):
        raise RuntimeError("The testship requires Node.js 22.12 or newer")
    request(args.socket, {"op": "status"})
    args.evidence.mkdir(parents=True, exist_ok=False)
    journal = args.evidence / "steps.jsonl"

    def record(stage, state):
        with journal.open("a") as stream:
            stream.write(json.dumps({"time": time.time(), "stage": stage, "state": state}) + "\n")

    def type_line(text):
        record(text, "sending")
        request(args.socket, {"op": "type", "text": text, "enter": True})
        record(text, "sent")

    wait_screen(args, args.direct_text)
    record("direct-screen", "observed")
    request(args.socket, {"op": "sequence", "steps": [
        {"buttons": ["l", "r"], "ms": 500}, {"buttons": [], "ms": 300},
    ]})
    record("controller", "L+R claimed input")
    with (args.evidence / "hen.log").open("x", buffering=1) as log:
        starter = Starter(args.bundle, args.host, args.arity, log, node, args.hello_trace)
        try:
            command = starter.wait(lambda line: start_command(line, args.host, args.arity), 30)
            if not args.loaded:
                type_line('LOAD "TXT:NS2"')
                wait_screen(args, args.load_prompt)
                request(args.socket, {"op": "pad", "buttons": ["a"], "ms": 300})
                wait_screen(args, args.direct_text, absent=[args.load_prompt])
                time.sleep(2)
            else:
                record("bootstrap-file", "already loaded; RUN and REMOVE not yet issued")
            type_line("RUN")
            wait_screen(args, "BOOT READY")
            time.sleep(1.5)
            type_line("REMOVE NSR,&H60000000,&H3FFFFFFF")
            wait_screen(args, "of memory")
            type_line(command)
            starter.wait(lambda line: line.startswith("HEN PID "), args.startup_timeout)
            record("hen-startup", "verified")
            print("HEN started. Close SmileBASIC normally through HOME, then use an R-held native game launch.", flush=True)
            print("This launcher stays open until SmileBASIC closes. Use t3.py for observed menu navigation.", flush=True)
            code = starter.process.wait()
            record("starter-exit", code)
            if code:
                raise RuntimeError("Starter ended with an error; inspect hen.log before another attempt")
        except BaseException:
            record("launch", "stopped; no automatic retry")
            starter.close()
            raise


def main():
    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    parser = argparse.ArgumentParser(description="Screen-verified testship acquisition through the T3 controller")
    parser.add_argument("--bundle", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--host", required=True, help="exploit host IPv4 address reachable from the console")
    parser.add_argument("--node", type=Path, help="host Node.js when launching from a separate wired PC")
    parser.add_argument("--evidence", type=Path, required=True, help="new run directory")
    parser.add_argument("--direct-text", required=True, help="text observed specifically on the Direct-mode screen")
    parser.add_argument("--load-prompt", default="Are you sure")
    parser.add_argument("--arity", type=int, choices=(5, 9), default=9)
    parser.add_argument("--loaded", action="store_true", help="NS2 was loaded, and RUN/REMOVE have not yet been sent")
    parser.add_argument("--hello-trace", type=Path, help="record the first console greeting for diagnosis")
    parser.add_argument("--capture-url", default="http://127.0.0.1:8765/frame.jpg")
    parser.add_argument("--tesseract", default=shutil.which("tesseract"))
    parser.add_argument("--ocr-psm", type=int, choices=(6, 11), default=6,
                        help="6 for the monospaced Direct screen, 11 for sparse labels")
    parser.add_argument("--startup-timeout", type=int, default=35 * 60)
    launch(parser.parse_args())


if __name__ == "__main__":
    main()
