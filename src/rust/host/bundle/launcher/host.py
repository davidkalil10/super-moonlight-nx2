"""Starts and tracks the host process. One host serves one console launch."""
import hashlib
import json
import os
import secrets
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from . import paths

HOST = "bin/moonlight-nx2-host"
WORKER = "bin/moonlight-nx2-upstream-worker"
READY_SECONDS = 8


class Failed(Exception):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(bundle):
    """Checks every bundle file against manifest.json; returns the manifest."""
    try:
        manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
        entries = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise Failed(f"cannot read the bundle manifest: {error}") from None
    for needed in (HOST, WORKER, "worker"):
        if needed not in entries:
            raise Failed(f"the manifest does not list {needed}")
    for relative, expected in entries.items():
        path = bundle / relative
        if not path.is_file() or sha256(path) != expected:
            raise Failed(f"{relative} is missing or differs from the manifest")
    return manifest


def runs_dir():
    return paths.state_dir() / "pc-runs"


def start_ticks(pid):
    """When the process started, as its identity; None once it is gone or only awaits reaping."""
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] == "Z" else int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def latest():
    runs = sorted(runs_dir().glob("*/RUN-INFO.json"))
    return json.loads(runs[-1].read_text()) if runs else None


def alive(info):
    return bool(info) and start_ticks(info["pid"]) == info["start_ticks"]


def stop(info, seconds=7):
    """Asks the host to end; it restores the display and stops the worker on the way out."""
    try:
        os.killpg(info["pid"], signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not alive(info):
            return True
        time.sleep(0.05)
    return False


def start(bundle, settings, timeout=None):
    """Starts a host; returns its process, run record and the session text for the console."""
    run = runs_dir() / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    run.mkdir(mode=0o700, parents=True)
    log_path = run / "server.log"
    command = [str(bundle / HOST), f"{settings['address']}:0", str(bundle / "worker")]
    if settings["match_display"]:
        command.append("--match-display")
    if timeout:
        command = ["timeout", "--signal=TERM", "--kill-after=5s", f"{timeout}s", *command]
    token = secrets.token_hex(32)
    environment = dict(os.environ, MOONLIGHT_NX2_WORKER=settings["worker"])
    with open(log_path, "xb") as log:
        os.chmod(log_path, 0o600)
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log,
                                   stderr=subprocess.STDOUT, env=environment,
                                   start_new_session=True)
    try:
        process.stdin.write(token.encode())
        process.stdin.close()
        port = None
        deadline = time.monotonic() + READY_SECONDS
        while port is None and time.monotonic() < deadline and process.poll() is None:
            for line in log_path.read_text(errors="replace").splitlines():
                if line.startswith("READY "):
                    port = int(line.split()[1])
            time.sleep(0.05)
        if port is None or process.poll() is not None:
            raise Failed(f"the host did not become ready; see {log_path}")
    except BaseException:
        process.kill()
        raise
    info = {
        "pid": process.pid,
        "start_ticks": start_ticks(process.pid),
        "port": port,
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "log": str(log_path),
    }
    (run / "RUN-INFO.json").write_text(json.dumps(info, indent=2) + "\n")
    session = (f"address={settings['address']}\nport={port}\ntoken={token}\n"
               f"host={settings['sunshine']}\n").encode()
    return process, info, session
