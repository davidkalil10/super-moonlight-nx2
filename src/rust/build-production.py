#!/usr/bin/env python3

import argparse
import json
from pathlib import Path
import re
import shlex
import subprocess

from build import BUILDS, SDK_DIAGNOSTICS, TRIALS, digest, git, utc_stamp, write_json


APP = Path(__file__).resolve().parents[2]
REMOTE_BUILDS = Path("/Users/azkali/claude-builds/moonlight")
FOUNDATION = REMOTE_BUILDS / "20261109T060400Z-ae67243-rust-foundation"
SDK = REMOTE_BUILDS / "20261110-sdk-viddec/sdk"
SDK_SHA256 = "7437e4f4b88f77e80ba0732b3f7bab3dcb05ef81c6b837129381fb4c1af024fb"
BUILDER_IMAGE = "sha256:1fc388c3a0d34bd2045a6dadcb1020e069d5f876a187fd705de14b4440c00282"


def m4(command, **kwargs):
    return subprocess.run(["ssh", "m4", command], check=True, **kwargs)


def nacp_version(description, revision):
    match = re.search(r"-(\d+)-g([0-9a-f]+)$", description)
    if match:
        return f"{match.group(1)}-g{match.group(2)[:8]}"
    compact = re.sub(r"[^A-Za-z0-9.+-]", "-", description).strip(".-")
    if 0 < len(compact) <= 15:
        return compact
    return f"g{revision[:14]}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--decode120", action="store_true",
                        help="offer 120 fps on a 60 Hz display too, to measure the decoder")
    parser.add_argument("--tcp-video", action="store_true",
                        help="keep video on TCP instead of UDP")
    parser.add_argument("--ui-pattern", action="store_true",
                        help="Both stick clicks step two test pages; ZL+ZR steps the scaling filter: exact, bilinear, Lanczos")
    parser.add_argument("--ui-uncached", action="store_true",
                        help="the pattern build with the UI buffers in non-cached host memory")
    parser.add_argument("--diagnostic", choices=SDK_DIAGNOSTICS,
                        help="build this decoder diagnostic instead of the app")
    parser.add_argument("--trials", choices=TRIALS, default=TRIALS[0],
                        help="the sessions an sdk-modes diagnostic runs")
    args = parser.parse_args()
    if args.ui_uncached and not args.ui_pattern:
        parser.error("--ui-uncached goes with --ui-pattern")
    if args.ui_pattern and (args.decode120 or args.tcp_video or args.diagnostic):
        parser.error("--ui-pattern goes alone")
    if args.diagnostic and (args.decode120 or args.tcp_video):
        parser.error("--diagnostic goes alone")
    if args.tcp_video and args.decode120:
        parser.error("--tcp-video does not go with --decode120")
    diagnostic = args.diagnostic or "production"
    if args.decode120:
        diagnostic += "-120-decode"
    if args.tcp_video:
        diagnostic += "-tcp"
    if args.ui_pattern:
        diagnostic += "-uncached" if args.ui_uncached else "-pattern"
    name = diagnostic
    if diagnostic == "sdk-modes" and args.trials != TRIALS[0]:
        name += f"-{args.trials}"
    revision = git("rev-parse", "HEAD")
    description = git("describe", "--tags", "--always", revision)
    branch = git("branch", "--show-current") or "detached"
    version = nacp_version(description, revision)
    build_id = f"{utc_stamp()}-{revision[:7]}-{name}"
    remote_sdk = shlex.quote(str(SDK / "ounce-sdk.tar.xz"))
    remote_sdk_sha = m4(f"shasum -a 256 {remote_sdk}", capture_output=True, text=True).stdout.split()[0]
    if remote_sdk_sha != SDK_SHA256:
        raise ValueError("The pinned m4 SDK archive changed")
    local_root = BUILDS / build_id
    remote_root = f"{REMOTE_BUILDS}/{build_id}"
    local_root.mkdir(parents=True, exist_ok=False)

    archive = local_root / "source.tar"
    with archive.open("wb") as output:
        subprocess.run(["git", "-C", str(APP), "archive", "--format=tar", revision],
                       stdout=output, check=True)

    write_json(local_root / "BUILD-REQUEST.json", {
        "revision": revision,
        "git_describe": description,
        "nacp_version": version,
        "branch": branch,
        "archive_sha256": digest(archive),
        "builder": "m4",
        "diagnostic": diagnostic,
        "trials": args.trials if diagnostic == "sdk-modes" else None,
        "sdk_sha256": SDK_SHA256,
        "builder_image": BUILDER_IMAGE,
    })

    remote = shlex.quote(remote_root)
    setup = " && ".join([
        "set -eu",
        f"test ! -e {remote}",
        f"mkdir -p {remote}/source",
        f"tar -xf - -C {remote}/source",
    ])
    with archive.open("rb") as source:
        m4(setup, stdin=source)

    foundation = shlex.quote(str(FOUNDATION))
    toolchain = shlex.quote(str(FOUNDATION / "rustup/toolchains/nightly-2026-02-09-aarch64-apple-darwin/bin"))
    cargo_home = shlex.quote(str(FOUNDATION / "cargo"))
    what = (f"--revision {revision} --branch {shlex.quote(branch)} "
            f"--diagnostic {diagnostic} --trials {args.trials}")
    m4(" ".join([
        "set -eu;",
        f"export RUSTUP_HOME={foundation}/rustup CARGO_HOME={cargo_home} MOONLIGHT_BUILDER=m4 CARGO_NET_GIT_FETCH_WITH_CLI=true;",
        f"export PATH={toolchain}:$PATH;",
        f"/usr/bin/python3 -B {remote}/source/src/rust/build.py rust",
        f"--directory {remote}/rust --cargo-home {cargo_home} {what}",
        f"> {remote}/rust-orchestrator.log 2>&1",
    ]))

    container_script = "\n".join([
        "set -eu",
        "tar -xJf /sdk/ounce-sdk.tar.xz -C /opt/devkitpro",
        "export PATH=/opt/devkitpro/devkitA64/bin:/opt/devkitpro/tools/bin:$PATH",
        f"python3 -B /work/source/src/rust/build.py nro --directory /work/nro --rust-directory /work/rust {what} --nacp-version {shlex.quote(version)}",
    ])
    m4(" ".join([
        "/usr/local/bin/docker run --rm --network=none",
        "-e MOONLIGHT_BUILDER=m4",
        f"-v {remote}:/work -v {shlex.quote(str(SDK))}:/sdk:ro",
        shlex.quote(BUILDER_IMAGE),
        "sh -c", shlex.quote(container_script),
        f"> {remote}/nro-orchestrator.log 2>&1",
    ]))

    subprocess.run(["rsync", "-a", f"m4:{remote_root}/", str(local_root) + "/"], check=True)
    artifact = local_root / "nro/moonlight-nx2-rust.nro"
    if not artifact.is_file() or artifact.stat().st_size < 20:
        raise RuntimeError(f"m4 did not return the {name} NRO")
    receipt = json.loads((local_root / "nro/BUILD-INFO.json").read_text())
    if (receipt["status"] != "built" or receipt["diagnostic"] != diagnostic
            or receipt["source_revision"] != revision):
        raise RuntimeError("The NRO receipt does not match the archived HEAD")
    write_json(local_root / "BUILD-RESULT.json", {
        "revision": revision,
        "git_describe": description,
        "nacp_version": version,
        "artifact": "nro/moonlight-nx2-rust.nro",
        "bytes": artifact.stat().st_size,
        "sha256": digest(artifact),
        "build_info": "nro/BUILD-INFO.json",
    })
    print(artifact)


if __name__ == "__main__":
    main()
