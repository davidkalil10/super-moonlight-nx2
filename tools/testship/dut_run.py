#!/usr/bin/env python3

import argparse
from ftplib import FTP, error_perm
import hashlib
import json
from pathlib import Path, PurePosixPath
import queue
import re
import shutil
import subprocess
import threading
import time

from t3 import capture, request


NRO_PATH = "/switch/00-dut.nro"
STAR_PATH = "/switch/.00-dut.nro.star"
LOG_DIR = "/switch/moonlight-nx2/rust"


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def hash_remote(ftp, path):
    digest = hashlib.sha256()
    size = 0

    def collect(block):
        nonlocal size
        size += len(block)
        digest.update(block)

    ftp.retrbinary(f"RETR {path}", collect, blocksize=1024 * 1024)
    return {"bytes": size, "sha256": digest.hexdigest()}


def exists(ftp, path):
    try:
        ftp.size(path)
        return True
    except error_perm as error:
        if str(error).startswith("550"):
            return False
        raise


def list_names(ftp, directory):
    try:
        entries = ftp.nlst(directory)
    except error_perm as error:
        if str(error).startswith("550"):
            return []
        raise
    names = set()
    for entry in entries:
        name = PurePosixPath(entry.rstrip("/")).name
        if name and name != PurePosixPath(directory).name:
            names.add(name)
    return sorted(names)


def connect_ftp(args):
    ftp = FTP()
    try:
        ftp.connect(args.ftp_host, args.ftp_port, timeout=args.ftp_timeout)
        ftp.login(args.ftp_user, args.ftp_password)
        ftp.set_pasv(True)
    except BaseException:
        ftp.close()
        raise
    return ftp


def close_ftp(ftp):
    if ftp is not None:
        try:
            ftp.quit()
        except Exception:
            try:
                ftp.close()
            except Exception:
                pass


def capture_screen(args, evidence, sequence, label):
    image = evidence / f"capture-{sequence:03d}-{label}.jpg"
    capture(args.capture_url, image)
    result = subprocess.run(
        [str(args.tesseract), str(image), "stdout", "--psm", "6"],
        capture_output=True, text=True, check=True, timeout=15,
    )
    text_path = image.with_suffix(".txt")
    text_path.write_text(result.stdout)
    normalized = re.sub(r"[^a-z0-9]", "", result.stdout.lower())
    return image, result.stdout, normalized


def wait_for_screen(args, evidence, sequence, marker, timeout, label):
    expected = re.sub(r"[^a-z0-9]", "", marker.lower())
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        sequence += 1
        last = capture_screen(args, evidence, sequence, label)
        if expected in last[2]:
            return sequence, last
        time.sleep(min(args.capture_interval, max(0, deadline - time.monotonic())))
    raise TimeoutError(f"Timed out waiting for screen marker {marker!r}; last={last[1] if last else ''!r}")


def controller(args, run, message, label):
    result = request(args.socket, message, timeout=args.controller_timeout)
    run["inputs"].append({"label": label, "request": message, "response": result,
                          "utc": time.time()})
    return result


class Hook:
    def __init__(self, args, evidence, run):
        self.args = args
        self.process = None
        self.lines = queue.Queue()
        self.log = None
        if args.before_a_command is None:
            return
        command = [str(args.before_a_command), *args.before_a_arg]
        self.log = (evidence / "before-a-hook.log").open("x", buffering=1)
        self.process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1,
        )
        self.reader = threading.Thread(target=self.read_output, daemon=True)
        self.reader.start()
        deadline = time.monotonic() + args.hook_timeout
        marker = args.hook_ready_marker.lower()
        try:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError("Before-A hook exited before its ready marker")
                try:
                    line = self.lines.get(timeout=min(0.25, deadline - time.monotonic()))
                except queue.Empty:
                    continue
                if marker in line.lower():
                    run["hook"] = {"command": command, "ready": True,
                                   "ready_line": line.strip(), "utc": time.time()}
                    return
            raise TimeoutError("Before-A hook did not report readiness")
        except BaseException:
            self.close(run)
            raise

    def read_output(self):
        for line in self.process.stdout:
            self.log.write(line)
            self.log.flush()
            self.lines.put(line)
        self.lines.put("")

    def close(self, run):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            run["hook_exit"] = self.process.returncode
            self.process.stdout.close()
            self.reader.join(timeout=5)
        if self.log is not None:
            self.log.close()


def upload_bytes(ftp, path, data):
    import io
    ftp.storbinary(f"STOR {path}", io.BytesIO(data), blocksize=1024 * 1024)


def stage(ftp, args, artifact_sha, artifact_bytes, run):
    if exists(ftp, STAR_PATH):
        marker = hash_remote(ftp, STAR_PATH)
        if marker["bytes"] != 0:
            raise RuntimeError(f"Refusing to replace nonempty persistent sort marker {STAR_PATH}")
        run["star_marker"] = {"state": "already-empty", **marker}
    else:
        upload_bytes(ftp, STAR_PATH, b"")
        marker = hash_remote(ftp, STAR_PATH)
        if marker["bytes"] != 0:
            raise RuntimeError("Star marker readback was not empty")
        run["star_marker"] = {"state": "created-and-verified", **marker}

    current = hash_remote(ftp, NRO_PATH) if exists(ftp, NRO_PATH) else None
    if current is not None and current["sha256"] != artifact_sha:
        expected = args.replace_existing_sha256
        if expected is None or current["sha256"] != expected:
            raise RuntimeError("Refusing to replace an NRO that is not the expected prior test artifact")
    if current is None or current["sha256"] != artifact_sha:
        with args.nro.open("rb") as source:
            ftp.storbinary(f"STOR {NRO_PATH}", source, blocksize=1024 * 1024)
        current = hash_remote(ftp, NRO_PATH)
        if current["sha256"] != artifact_sha or current["bytes"] != artifact_bytes:
            raise RuntimeError("Staged NRO readback did not match the pinned artifact")
        run["staged_nro"] = {"state": "uploaded-and-verified", **current}
    else:
        run["staged_nro"] = {"state": "already-matching", **current}
    run["remote_runtime_logs_before"] = list_names(ftp, LOG_DIR)


def collect_logs(ftp, evidence, before, args):
    after = list_names(ftp, LOG_DIR)
    new_logs = sorted(name for name in after - set(before)
                      if name.startswith("runtime-") and name.endswith(".log"))
    collected = []
    for name in new_logs:
        if not re.fullmatch(r"runtime-[A-Za-z0-9._-]+\.log", name):
            raise ValueError(f"Unexpected runtime log name: {name!r}")
        remote = f"{LOG_DIR}/{name}"
        local = evidence / name
        digest = hashlib.sha256()
        size = 0
        with local.open("xb") as output:
            def save(block):
                nonlocal size
                size += len(block)
                digest.update(block)
                output.write(block)
            ftp.retrbinary(f"RETR {remote}", save, blocksize=1024 * 1024)
        collected.append({"remote": remote, "local": name, "bytes": size,
                          "sha256": digest.hexdigest(),
                          "runtime_pass_marker": "runtime: result PASS" in local.read_text(errors="replace")})
    return {"new_entries": [f"{LOG_DIR}/{name}" for name in new_logs], "logs": collected}


def main():
    parser = argparse.ArgumentParser(description="Hash-pinned, single-launch hbmenu test runner")
    parser.add_argument("--nro", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--ftp-host", required=True)
    parser.add_argument("--ftp-port", type=int, default=5000)
    parser.add_argument("--ftp-user", default="anonymous")
    parser.add_argument("--ftp-password", default="")
    parser.add_argument("--ftp-timeout", type=int, default=10)
    parser.add_argument("--replace-existing-sha256")
    parser.add_argument("--socket", type=Path, required=True)
    parser.add_argument("--capture-url", default="http://127.0.0.1:8765/frame.jpg")
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--tesseract", type=Path, default=shutil.which("tesseract"))
    parser.add_argument("--screen-timeout", type=int, default=20)
    parser.add_argument("--launch-observation-timeout", type=int, default=8)
    parser.add_argument("--run-timeout", type=int, default=120)
    parser.add_argument("--capture-interval", type=float, default=1.0)
    parser.add_argument("--controller-timeout", type=int, default=20)
    parser.add_argument("--ftp-reconnect-timeout", type=int, default=20)
    parser.add_argument("--before-a-command", type=Path)
    parser.add_argument("--before-a-arg", action="append", default=[])
    parser.add_argument("--hook-ready-marker", default="READY")
    parser.add_argument("--hook-timeout", type=int, default=30)
    parser.add_argument("--menu-marker", required=True,
                        help="text that must appear in the selected NRO title before A")
    parser.add_argument("--remove-staged", action="store_true",
                        help="remove the verified NRO after collection; the star marker remains")
    args = parser.parse_args()

    if not args.nro.is_file() or args.nro.is_symlink():
        raise ValueError("--nro must be a regular, non-symlink file")
    expected = args.sha256.lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("--sha256 must be a lowercase or uppercase SHA-256 hex digest")
    actual = sha256_file(args.nro)
    if actual != expected:
        raise ValueError(f"NRO SHA-256 mismatch: expected {expected}, got {actual}")
    if args.tesseract is None:
        raise ValueError("Tesseract is required for screen-gated navigation")
    if not 1 <= args.run_timeout <= 900 or not 0.1 <= args.capture_interval <= 5:
        raise ValueError("Run timeout or capture interval is outside its bound")
    args.evidence.mkdir(parents=True, exist_ok=False)

    run = {
        "nro": str(args.nro.resolve()), "sha256": actual,
        "bytes": args.nro.stat().st_size, "remote_nro": NRO_PATH,
        "remote_star": STAR_PATH, "started_utc": time.time(), "inputs": [],
        "captures": [], "launcher": {"sent": False, "departed_hbmenu": False,
                                     "returned_hbmenu": False},
    }
    ftp = None
    hook = None
    launch_sent = False
    error = None
    final_capture = None
    collection = {"logs": [], "new_entries": []}
    cleanup = {"star_marker": "retained", "nro": "not-staged"}

    def save_run():
        (args.evidence / "run.json").write_text(json.dumps(run, indent=2) + "\n")

    try:
        ftp = connect_ftp(args)
        stage(ftp, args, actual, args.nro.stat().st_size, run)
        close_ftp(ftp)
        ftp = None

        controller(args, run, {"op": "status"}, "controller-preflight")
        controller(args, run, {"op": "neutral"}, "first-input-neutral")
        image, text, normalized = capture_screen(args, args.evidence, 1, "initial")
        run["captures"].append({"file": image.name, "text": text, "utc": time.time()})
        if "hbmenu" not in normalized:
            if "ftpd" not in normalized:
                raise RuntimeError("Initial screen is neither hbmenu nor FTpd; no launch attempted")
            controller(args, run, {"op": "pad", "buttons": ["plus"], "ms": 250}, "exit-ftpd")
            sequence, screen = wait_for_screen(args, args.evidence, 1, "hbmenu",
                                               args.screen_timeout, "hbmenu")
            run["captures"].append({"file": screen[0].name, "text": screen[1], "utc": time.time()})
        else:
            sequence = 1

        sequence += 1
        image, text, normalized = capture_screen(args, args.evidence, sequence, "switch-directory")
        run["captures"].append({"file": image.name, "text": text, "utc": time.time()})
        if "sdmcswitch" not in normalized:
            raise RuntimeError("hbmenu is not showing sdmc:/switch; refusing to guess a path")

        sequence += 1
        image, text, normalized = capture_screen(args, args.evidence, sequence, "top-selection")
        run["captures"].append({"file": image.name, "text": text, "utc": time.time()})
        expected_menu = re.sub(r"[^a-z0-9]", "", args.menu_marker.lower())
        if not expected_menu or expected_menu not in normalized:
            raise RuntimeError("hbmenu did not visibly select the expected starred NRO title; no launch attempted")

        hook = Hook(args, args.evidence, run)
        if hook.process is not None and hook.process.poll() is not None:
            raise RuntimeError("Before-A hook exited before the app launch")
        controller(args, run, {"op": "pad", "buttons": ["a"], "ms": 220}, "single-launch-a")
        launch_sent = True
        run["launcher"] = {"sent": True, "departed_hbmenu": False,
                           "returned_hbmenu": False, "sent_utc": time.time()}
        observation_deadline = time.monotonic() + args.launch_observation_timeout
        run_deadline = time.monotonic() + args.run_timeout
        sequence += 1
        while time.monotonic() < run_deadline:
            image, text, normalized = capture_screen(args, args.evidence, sequence, "run")
            sequence += 1
            run["captures"].append({"file": image.name, "text": text, "utc": time.time()})
            if "hbmenu" not in normalized:
                run["launcher"]["departed_hbmenu"] = True
            elif run["launcher"]["departed_hbmenu"]:
                run["launcher"]["returned_hbmenu"] = True
                final_capture = image
                break
            if (not run["launcher"]["departed_hbmenu"]
                    and time.monotonic() >= observation_deadline):
                raise TimeoutError("A was sent once, but hbmenu departure was not observed; no retry")
            time.sleep(min(args.capture_interval, max(0, run_deadline - time.monotonic())))
        if final_capture is None:
            run["launcher"]["timed_out"] = True
        else:
            run["launcher"]["return_utc"] = time.time()
        save_run()

        deadline = time.monotonic() + args.ftp_reconnect_timeout
        last_ftp_error = None
        while time.monotonic() < deadline and ftp is None:
            try:
                ftp = connect_ftp(args)
            except OSError as failure:
                last_ftp_error = str(failure)
                time.sleep(1)
        if ftp is None:
            raise RuntimeError(f"FTP did not reconnect for post-run collection: {last_ftp_error}")
        collection = collect_logs(ftp, args.evidence, run["remote_runtime_logs_before"], args)
        run["collection"] = collection
        if final_capture is not None:
            (args.evidence / "final-hbmenu.jpg").write_bytes(final_capture.read_bytes())
        if args.remove_staged:
            staged_now = hash_remote(ftp, NRO_PATH)
            if staged_now["sha256"] != actual:
                raise RuntimeError("Staged NRO changed during the run; refusing to delete it")
            ftp.delete(NRO_PATH)
            cleanup["nro"] = "removed-after-hash-check"
        else:
            cleanup["nro"] = "retained-for-next-run"
    except BaseException as failure:
        error = f"{type(failure).__name__}: {failure}"
        run["error"] = error
    finally:
        if hook is not None:
            hook.close(run)
        if ftp is not None and launch_sent and args.remove_staged and cleanup["nro"] == "not-staged":
            try:
                staged_now = hash_remote(ftp, NRO_PATH)
                if staged_now["sha256"] == actual:
                    ftp.delete(NRO_PATH)
                    cleanup["nro"] = "removed-after-hash-check"
                else:
                    cleanup["nro"] = "preserved-changed-file"
            except BaseException as failure:
                cleanup["nro"] = f"cleanup-failed: {failure}"
        elif run.get("staged_nro"):
            cleanup["nro"] = "retained-for-next-run"
        close_ftp(ftp)
        run["finished_utc"] = time.time()
        run["cleanup"] = cleanup
        save_run()
        (args.evidence / "collection.json").write_text(json.dumps(collection, indent=2) + "\n")
        (args.evidence / "cleanup.json").write_text(json.dumps(cleanup, indent=2) + "\n")
        log_pass = any(item.get("runtime_pass_marker") for item in collection.get("logs", []))
        returned = run["launcher"].get("returned_hbmenu", False)
        result = {
            "status": "incomplete" if error or not returned or not collection.get("logs") else "collected",
            "error": error,
            "launches": int(run["launcher"].get("sent", False)),
            "hbmenu_return_observed": returned,
            "runtime_pass_marker": log_pass,
            "runtime_logs": collection.get("logs", []),
            "cleanup": cleanup,
        }
        (args.evidence / "RESULT.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"evidence": str(args.evidence), **result}, indent=2))
    if error:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
