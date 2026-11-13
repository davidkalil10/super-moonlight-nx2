#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess

from build import BUILDS, SDK_DIAGNOSTICS, TRIALS, digest, git, utc_stamp, write_json


APP = Path(__file__).resolve().parents[2]
BUILDER = os.environ.get("MOONLIGHT_BUILDER_HOST", "arm64-builder")
REMOTE_BUILDS = os.environ.get("MOONLIGHT_REMOTE_BUILDS", "~/moonlight-builds")
FOUNDATION = "20261109T060400Z-ae67243-rust-foundation"
SDK = "20261113-sdk/sdk"
SDK_ARCHIVE = "ounce-sdk-20261113.tar.xz"
SDK_SHA256 = "30d28d0909a0a60b4de87930d773ac9770530d70a1b9b3acd3b0491579368a9b"
BUILDER_IMAGE = "sha256:1fc388c3a0d34bd2045a6dadcb1020e069d5f876a187fd705de14b4440c00282"


def remote(command, **kwargs):
    return subprocess.run(["ssh", BUILDER, command], check=True, **kwargs)


def remote_builds():
    """MOONLIGHT_REMOTE_BUILDS, with a leading ~ taken as the builder's home."""
    if REMOTE_BUILDS != "~" and not REMOTE_BUILDS.startswith("~/"):
        return PurePosixPath(REMOTE_BUILDS)
    home = remote('printf %s "$HOME"', capture_output=True, text=True).stdout
    return PurePosixPath(home + REMOTE_BUILDS[1:])


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
    parser.add_argument("--release", metavar="VERSION",
                        help="the production build for testers, shown in hbmenu as VERSION (e.g. 0.1.0-rc6)")
    parser.add_argument("--diagnostic", choices=SDK_DIAGNOSTICS,
                        help="build this decoder diagnostic instead of the app")
    parser.add_argument("--trials", choices=TRIALS, default=TRIALS[0],
                        help="the sessions an sdk-modes diagnostic runs")
    args = parser.parse_args()
    if args.release and (args.ui_pattern or args.decode120 or args.tcp_video
                         or args.diagnostic):
        parser.error("--release goes alone")
    if args.release and not re.fullmatch(r"\d+\.\d+\.\d+(-[a-z0-9.]+)?", args.release):
        parser.error("--release takes a version like 0.1.0 or 0.1.0-rc6")
    if args.release and len(args.release) > 15:
        parser.error("--release is at most 15 characters, the NACP limit")
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
    if args.release:
        name = "release"
    if diagnostic == "sdk-modes" and args.trials != TRIALS[0]:
        name += f"-{args.trials}"
    revision = git("rev-parse", "HEAD")
    description = git("describe", "--tags", "--always", revision)
    branch = git("branch", "--show-current") or "detached"
    version = args.release or nacp_version(description, revision)
    build_id = f"{utc_stamp()}-{revision[:7]}-{name}"
    builds = remote_builds()
    sdk = builds / SDK
    foundation_root = builds / FOUNDATION
    remote_sdk = shlex.quote(str(sdk / SDK_ARCHIVE))
    remote_sdk_sha = remote(f"shasum -a 256 {remote_sdk}", capture_output=True, text=True).stdout.split()[0]
    if remote_sdk_sha != SDK_SHA256:
        raise ValueError(f"The pinned SDK archive on {BUILDER} changed")
    local_root = BUILDS / build_id
    remote_root = f"{builds}/{build_id}"
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
        "builder": BUILDER,
        "diagnostic": diagnostic,
        "trials": args.trials if diagnostic == "sdk-modes" else None,
        "sdk_sha256": SDK_SHA256,
        "builder_image": BUILDER_IMAGE,
    })

    remote_dir = shlex.quote(remote_root)
    setup = " && ".join([
        "set -eu",
        f"test ! -e {remote_dir}",
        f"mkdir -p {remote_dir}/source",
        f"tar -xf - -C {remote_dir}/source",
    ])
    with archive.open("rb") as source:
        remote(setup, stdin=source)

    foundation = shlex.quote(str(foundation_root))
    toolchain = shlex.quote(str(foundation_root / "rustup/toolchains/nightly-2026-02-09-aarch64-apple-darwin/bin"))
    cargo_home = shlex.quote(str(foundation_root / "cargo"))
    builder = shlex.quote(BUILDER)
    what = (f"--revision {revision} --branch {shlex.quote(branch)} "
            f"--diagnostic {diagnostic} --trials {args.trials}")
    remote(" ".join([
        "set -eu;",
        f"export RUSTUP_HOME={foundation}/rustup CARGO_HOME={cargo_home} MOONLIGHT_BUILDER={builder} CARGO_NET_GIT_FETCH_WITH_CLI=true;",
        f"export PATH={toolchain}:$PATH;",
        f"/usr/bin/python3 -B {remote_dir}/source/src/rust/build.py rust",
        f"--directory {remote_dir}/rust --cargo-home {cargo_home} {what}",
        f"> {remote_dir}/rust-orchestrator.log 2>&1",
    ]))

    container_script = "\n".join([
        "set -eu",
        f"tar -xJf /sdk/{SDK_ARCHIVE} -C /opt/devkitpro",
        "export PATH=/opt/devkitpro/devkitA64/bin:/opt/devkitpro/tools/bin:$PATH",
        f"python3 -B /work/source/src/rust/build.py nro --directory /work/nro --rust-directory /work/rust {what} --nacp-version {shlex.quote(version)}",
    ])
    remote(" ".join([
        "/usr/local/bin/docker run --rm --network=none",
        f"-e MOONLIGHT_BUILDER={builder}",
        f"-v {remote_dir}:/work -v {shlex.quote(str(sdk))}:/sdk:ro",
        shlex.quote(BUILDER_IMAGE),
        "sh -c", shlex.quote(container_script),
        f"> {remote_dir}/nro-orchestrator.log 2>&1",
    ]))

    subprocess.run(["rsync", "-a", f"{BUILDER}:{remote_root}/", str(local_root) + "/"], check=True)
    artifact = local_root / "nro/moonlight-nx2.nro"
    if not artifact.is_file() or artifact.stat().st_size < 20:
        raise RuntimeError(f"{BUILDER} did not return the {name} NRO")
    receipt = json.loads((local_root / "nro/BUILD-INFO.json").read_text())
    if (receipt["status"] != "built" or receipt["diagnostic"] != diagnostic
            or receipt["source_revision"] != revision):
        raise RuntimeError("The NRO receipt does not match the archived HEAD")
    write_json(local_root / "BUILD-RESULT.json", {
        "revision": revision,
        "git_describe": description,
        "nacp_version": version,
        "artifact": "nro/moonlight-nx2.nro",
        "bytes": artifact.stat().st_size,
        "sha256": digest(artifact),
        "build_info": "nro/BUILD-INFO.json",
    })
    print(artifact)


if __name__ == "__main__":
    main()
