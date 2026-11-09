#!/usr/bin/env python3

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys


APP = Path(__file__).resolve().parents[2]
BUILDS = Path("/media/storage2/builds/moonlight")
FOUNDATION = "/Users/azkali/claude-builds/moonlight/20261109T060400Z-ae67243-rust-foundation"
SDK = "/Users/azkali/claude-builds/moonlight/20261109T020739Z-ae67243-testship-native/sdk"
ALIAS = "/Users/azkali/claude-builds/moonlight/20261109T141228Z-ae67243-sdk-backing-runtime/alias"
DOCKER_IMAGE = "sha256:1fc388c3a0d34bd2045a6dadcb1020e069d5f876a187fd705de14b4440c00282"
SDK_SHA256 = "0dd4be44ad73471969aac593ca1b03179f90e2014e1583c6c6249da4eeeeead7"
ALIAS_SHA256 = "b33546d8f616e135257a27b5606992a2b8a9708dc8d11e8343b55faa34176531"
UPSTREAM = "/media/storage2/builds/moonlight/20261107T200357Z-19b4f09-helper/upstream"
UPSTREAM_BUILD = "/media/storage2/builds/moonlight/20261109T080033Z-ae67243-worker2-upstream-pic/build"
NATIVE_LIBS = "/media/storage2/builds/moonlight/20261109T085525Z-ae67243-worker2-not-paired-full/native-lib"
NATIVE_INCLUDES = "/media/storage2/builds/moonlight/20261109T081906Z-ae67243-worker2-opus-headers/include"
TARGETS = ("production", "frontend", "native-decode", "ref-replay", "audio-cue", "io")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def output(command, logfile, timeout):
    logfile.parent.mkdir(parents=True, exist_ok=True)
    with logfile.open("wb") as log:
        try:
            return subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                                  timeout=timeout, check=False).returncode
        except subprocess.TimeoutExpired:
            return 124


def remote(host, command, logfile, timeout):
    return output(["ssh", host, command], logfile, timeout)


def fetch(host, source, destination, logfile):
    destination.parent.mkdir(parents=True, exist_ok=True)
    return output(["scp", f"{host}:{source}", str(destination)], logfile, 120)


def quote(values):
    return " ".join(shlex.quote(str(value)) for value in values)


def main():
    parser = argparse.ArgumentParser(description="Build a clean-HEAD Rust and host health matrix")
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--m4", default="m4")
    parser.add_argument("--rig", default="rig")
    parser.add_argument("--timeout", type=int, default=3600)
    args = parser.parse_args()

    revision = subprocess.check_output(
        ["git", "-C", str(APP), "rev-parse", "--verify", f"{args.revision}^{{commit}}"],
        text=True).strip()
    short = revision[:7]
    created = datetime.datetime.now(datetime.timezone.utc)
    build_id = f"{created.strftime('%Y%m%dT%H%M%S%fZ')}-{short}-build-matrix"
    root = BUILDS / build_id
    root.mkdir(parents=True, exist_ok=False)
    archive = root / "source.tar"
    with archive.open("wb") as target:
        subprocess.run(["git", "-C", str(APP), "archive", "--format=tar", revision],
                       stdout=target, check=True)

    branch = subprocess.check_output(
        ["git", "-C", str(APP), "branch", "--show-current"], text=True).strip() or "detached"
    record = {
        "created_at": created.isoformat(),
        "revision": revision,
        "branch": branch,
        "archive_sha256": sha256(archive),
        "archive_bytes": archive.stat().st_size,
        "builder": {"m4": args.m4, "rig": args.rig},
        "targets": {},
    }
    (root / "SOURCE.json").write_text(json.dumps({key: record[key] for key in
        ("created_at", "revision", "branch", "archive_sha256", "archive_bytes")}, indent=2) + "\n")

    m4root = f"/Users/azkali/claude-builds/moonlight/{build_id}/m4"
    rigroot = f"/home/azkali/claude-builds/moonlight/{build_id}/rig"
    m4archive = f"{m4root}/source.tar"
    rigarchive = f"{rigroot}/source.tar"
    for host, build_root in ((args.m4, m4root), (args.rig, rigroot)):
        if remote(host, f"mkdir -p {shlex.quote(build_root)}",
                  root / f"{host}-prepare.log", 30):
            raise RuntimeError(f"Could not prepare build directory on {host}")
    for host, destination, logfile in (
        (args.m4, m4archive, root / "m4-copy.log"),
        (args.rig, rigarchive, root / "rig-copy.log"),
    ):
        code = output(["scp", str(archive), f"{host}:{destination}"], logfile, 120)
        if code:
            raise RuntimeError(f"Could not copy clean source archive to {host}; see {logfile}")

    for host, base in ((args.m4, m4root), (args.rig, rigroot)):
        source = f"{base}/source"
        code = remote(host, f"mkdir {shlex.quote(source)} && tar -xf {shlex.quote(base + '/source.tar')} -C {shlex.quote(source)}",
                      root / f"{host}-extract.log", 120)
        if code:
            raise RuntimeError(f"Could not unpack clean archive on {host}; see {root / (host + '-extract.log')}")

    sdk_check = (
        f"test \"$(shasum -a 256 {SDK}/ounce-sdk.tar.xz | awk '{{print $1}}')\" = {SDK_SHA256}"
        f" && test \"$(shasum -a 256 {ALIAS}/libouncevk.a | awk '{{print $1}}')\" = {ALIAS_SHA256}"
        f" && test \"$(/usr/local/bin/docker image inspect devkitpro/devkita64:20260219 --format '{{{{.Id}}}}')\" = {DOCKER_IMAGE}"
    )
    if remote(args.m4, sdk_check, root / "m4-prerequisites.log", 60):
        raise RuntimeError("Pinned SDK, alias archive or Docker image failed its m4 check")

    m4_python = "/usr/bin/python3"
    rust_bin = f"{FOUNDATION}/rustup/toolchains/nightly-2026-02-09-aarch64-apple-darwin/bin"
    cargo_home = f"{FOUNDATION}/cargo"
    env = (f"env RUSTUP_HOME={shlex.quote(FOUNDATION + '/rustup')} "
           f"CARGO_HOME={shlex.quote(cargo_home)} "
           f"CARGO_NET_GIT_FETCH_WITH_CLI=true MOONLIGHT_BUILDER=m4 "
           f"PATH={shlex.quote(rust_bin)}:$PATH")
    source = f"{m4root}/source"
    for diagnostic in TARGETS:
        target_root = f"{m4root}/{diagnostic}"
        if remote(args.m4, f"mkdir {shlex.quote(target_root)}",
                  root / f"m4-{diagnostic}-prepare.log", 30):
            record["targets"][diagnostic] = {"status": "FAIL", "stage": "prepare", "exit_code": 1}
            print(f"FAIL {diagnostic} (prepare)", flush=True)
            continue
        rust_dir = f"{target_root}/rust"
        nro_dir = f"{target_root}/nro"
        rust_cmd = [m4_python, "-B", f"{source}/src/rust/build.py", "rust",
                    "--directory", rust_dir, "--cargo-home", cargo_home,
                    "--revision", revision, "--branch", branch,
                    "--diagnostic", diagnostic]
        rust_line = f"{env} {quote(rust_cmd)}"
        rust_status = remote(args.m4, rust_line, root / f"m4-{diagnostic}-rust.log", args.timeout)
        rust_receipt = root / "receipts" / "m4" / diagnostic / "rust"
        for name in ("BUILD-INFO.json", "build.log"):
            fetch(args.m4, f"{rust_dir}/{name}", rust_receipt / name,
                  root / f"m4-{diagnostic}-rust-{name}.copy.log")
        if rust_status:
            record["targets"][diagnostic] = {"status": "FAIL", "stage": "rust", "exit_code": rust_status}
            print(f"FAIL {diagnostic} (rust)", flush=True)
            continue

        nro_args = ["python3", "-B", "/work/source/src/rust/build.py", "nro",
                    "--directory", f"/work/{diagnostic}/nro",
                    "--rust-directory", f"/work/{diagnostic}/rust",
                    "--revision", revision, "--branch", branch,
                    "--diagnostic", diagnostic]
        if diagnostic == "native-decode":
            nro_args.extend(["--sdk-backing-library-dir", "/alias"])
        shell = (f"tar -xJf /sdk/ounce-sdk.tar.xz -C /opt/devkitpro && "
                 f"{quote(nro_args)}")
        docker_cmd = ["/usr/local/bin/docker", "run", "--rm", "--network=none",
                      "-e", "MOONLIGHT_BUILDER=m4", "-v", f"{m4root}:/work",
                      "-v", f"{SDK}:/sdk:ro", "-v", f"{ALIAS}:/alias:ro",
                      DOCKER_IMAGE, "sh", "-c", shell]
        nro_status = remote(args.m4, quote(docker_cmd), root / f"m4-{diagnostic}-nro.log", args.timeout)
        nro_receipt = root / "receipts" / "m4" / diagnostic / "nro"
        for name in ("BUILD-INFO.json", "build.log", "moonlight-nx2-rust.nro"):
            fetch(args.m4, f"{nro_dir}/{name}", nro_receipt / name,
                  root / f"m4-{diagnostic}-nro-{name}.copy.log")
        status = "PASS" if nro_status == 0 else "FAIL"
        artifact = None
        info_path = nro_receipt / "BUILD-INFO.json"
        if info_path.is_file():
            info = json.loads(info_path.read_text())
            artifact = info.get("artifact")
        record["targets"][diagnostic] = {
            "status": status,
            "stage": None if nro_status == 0 else "nro",
            "exit_code": nro_status,
            "nro": artifact,
            "receipts": {
                "rust": str(rust_receipt.relative_to(root)),
                "nro": str(nro_receipt.relative_to(root)),
            },
        }
        print(f"{status} {diagnostic}", flush=True)

    rig_source = f"{rigroot}/source"
    manifest = f"{rig_source}/src/rust/Cargo.toml"
    host_test = quote(["cargo", "test", "--manifest-path", manifest,
                       "-p", "moonlight-nx2-host", "--offline", "--locked"])
    test_status = remote(args.rig, host_test, root / "rig-host-test.log", args.timeout)
    record["targets"]["host-test"] = {"status": "PASS" if not test_status else "FAIL",
                                      "exit_code": test_status}
    print(f"{'PASS' if not test_status else 'FAIL'} host-test", flush=True)

    clippy_env = ["env", f"MOONLIGHT_UPSTREAM_DIR={UPSTREAM}",
                  f"MOONLIGHT_UPSTREAM_BUILD={UPSTREAM_BUILD}",
                  f"MOONLIGHT_NATIVE_LIB_DIR={NATIVE_LIBS}",
                  f"MOONLIGHT_NATIVE_INCLUDE_DIR={NATIVE_INCLUDES}"]
    worker_clippy = quote([*clippy_env, "cargo", "clippy", "--manifest-path", manifest,
                           "-p", "moonlight-nx2-host", "--bin", "moonlight-nx2-upstream-worker",
                           "--features", "upstream-worker", "--all-targets", "--offline", "--locked",
                           "--", "-D", "warnings"])
    clippy_status = remote(args.rig, worker_clippy, root / "rig-worker-clippy.log", args.timeout)
    record["targets"]["worker-clippy"] = {"status": "PASS" if not clippy_status else "FAIL",
                                           "exit_code": clippy_status}
    print(f"{'PASS' if not clippy_status else 'FAIL'} worker-clippy", flush=True)

    record["status"] = "PASS" if all(item["status"] == "PASS" for item in record["targets"].values()) else "FAIL"
    (root / "MATRIX.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"MATRIX {record['status']} {root}")
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"build_matrix: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1) from error
