#!/usr/bin/env python3

import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess


APP = Path(__file__).resolve().parents[2]
BUILDS = Path("/media/storage2/builds/moonlight")
FOUNDATION = Path("/Users/azkali/claude-builds/moonlight/20261109T060400Z-ae67243-rust-foundation")
SDK = Path("/Users/azkali/claude-builds/moonlight/20261109T020739Z-ae67243-testship-native/sdk")
SDK_SHA256 = "0dd4be44ad73471969aac593ca1b03179f90e2014e1583c6c6249da4eeeeead7"
SDK_VIDDEC = Path("/Users/azkali/claude-builds/moonlight/20261110-sdk-viddec/sdk")
SDK_VIDDEC_SHA256 = "7437e4f4b88f77e80ba0732b3f7bab3dcb05ef81c6b837129381fb4c1af024fb"
BUILDER_IMAGE = "sha256:1fc388c3a0d34bd2045a6dadcb1020e069d5f876a187fd705de14b4440c00282"


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


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
    parser.add_argument("--sdk-video", action="store_true",
                        help="decode through the 2026-11-10 SDK's video decoder")
    parser.add_argument("--docked-modes", action="store_true",
                        help="with --sdk-video, offer 1440p and 4K when docked (unmeasured)")
    parser.add_argument("--hz120", action="store_true",
                        help="with --sdk-video, present at 120 Hz and offer 120 fps up to 1440p (unmeasured)")
    args = parser.parse_args()
    if (args.docked_modes or args.hz120) and not args.sdk_video:
        parser.error("--docked-modes and --hz120 need --sdk-video")
    diagnostic = "production-sdk" if args.sdk_video else "production"
    if args.docked_modes:
        diagnostic += "-modes"
    if args.hz120:
        diagnostic += "-120"
    sdk_directory = SDK_VIDDEC if args.sdk_video else SDK
    sdk_sha256 = SDK_VIDDEC_SHA256 if args.sdk_video else SDK_SHA256
    revision = subprocess.check_output(
        ["git", "-C", str(APP), "rev-parse", "HEAD"], text=True).strip()
    description = subprocess.check_output(
        ["git", "-C", str(APP), "describe", "--tags", "--always", revision],
        text=True).strip()
    branch = subprocess.check_output(
        ["git", "-C", str(APP), "branch", "--show-current"], text=True).strip()
    version = nacp_version(description, revision)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    build_id = f"{stamp}-{revision[:7]}-{diagnostic}"
    remote_sdk = shlex.quote(str(sdk_directory / "ounce-sdk.tar.xz"))
    remote_sdk_sha = subprocess.check_output(
        ["ssh", "m4", f"shasum -a 256 {remote_sdk}"], text=True).split()[0]
    if remote_sdk_sha != sdk_sha256:
        raise ValueError("The pinned m4 SDK archive changed")
    local_root = BUILDS / build_id
    remote_root = f"/Users/azkali/claude-builds/moonlight/{build_id}"
    local_root.mkdir(parents=True, exist_ok=False)

    archive = local_root / "source.tar"
    with archive.open("wb") as output:
        run(["git", "-C", str(APP), "archive", "--format=tar", revision], stdout=output)

    (local_root / "BUILD-REQUEST.json").write_text(json.dumps({
        "revision": revision,
        "git_describe": description,
        "nacp_version": version,
        "branch": branch or "detached",
        "archive_sha256": digest(archive),
        "builder": "m4",
        "diagnostic": diagnostic,
        "sdk_sha256": sdk_sha256,
        "builder_image": BUILDER_IMAGE,
    }, indent=2) + "\n")

    remote = shlex.quote(remote_root)
    setup = " && ".join([
        "set -eu",
        f"test ! -e {remote}",
        f"mkdir -p {remote}/source",
        f"tar -xf - -C {remote}/source",
    ])
    with archive.open("rb") as source:
        run(["ssh", "m4", setup], stdin=source)

    foundation = shlex.quote(str(FOUNDATION))
    remote_source = shlex.quote(remote_root + "/source")
    remote_rust = shlex.quote(remote_root + "/rust")
    rust_log = shlex.quote(remote_root + "/rust-orchestrator.log")
    toolchain = shlex.quote(str(FOUNDATION / "rustup/toolchains/nightly-2026-02-09-aarch64-apple-darwin/bin"))
    cargo_home = shlex.quote(str(FOUNDATION / "cargo"))
    rust_command = " ".join([
        "set -eu;",
        f"export RUSTUP_HOME={foundation}/rustup CARGO_HOME={cargo_home} MOONLIGHT_BUILDER=m4 CARGO_NET_GIT_FETCH_WITH_CLI=true;",
        f"export PATH={toolchain}:$PATH;",
        f"/usr/bin/python3 -B {remote_source}/src/rust/build.py rust",
        f"--directory {remote_rust} --cargo-home {cargo_home}",
        f"--revision {shlex.quote(revision)} --branch {shlex.quote(branch or 'detached')}",
        f"--diagnostic {diagnostic}",
        f"> {rust_log} 2>&1",
    ])
    run(["ssh", "m4", rust_command])

    sdk = shlex.quote(str(sdk_directory))
    docker_root = shlex.quote(remote_root)
    revision_arg = shlex.quote(revision)
    branch_arg = shlex.quote(branch or "detached")
    nro_log = shlex.quote(remote_root + "/nro-orchestrator.log")
    container_script = "\n".join([
        "set -eu",
        "tar -xJf /sdk/ounce-sdk.tar.xz -C /opt/devkitpro",
        "export PATH=/opt/devkitpro/devkitA64/bin:/opt/devkitpro/tools/bin:$PATH",
        f"python3 -B /work/source/src/rust/build.py nro --directory /work/nro --rust-directory /work/rust --revision {revision_arg} --branch {branch_arg} --diagnostic {diagnostic} --nacp-version {shlex.quote(version)}",
    ])
    docker_command = " ".join([
        "/usr/local/bin/docker run --rm --network=none",
        "-e MOONLIGHT_BUILDER=m4",
        f"-v {docker_root}:/work -v {sdk}:/sdk:ro",
        shlex.quote(BUILDER_IMAGE),
        "sh -c", shlex.quote(container_script),
        f"> {nro_log} 2>&1",
    ])
    run(["ssh", "m4", docker_command])

    run(["rsync", "-a", f"m4:{remote_root}/", str(local_root) + "/"])
    artifact = local_root / "nro/moonlight-nx2-rust.nro"
    if not artifact.is_file() or artifact.stat().st_size < 20:
        raise RuntimeError(f"m4 did not return the {diagnostic} NRO")
    receipt = json.loads((local_root / "nro/BUILD-INFO.json").read_text())
    if (receipt["status"] != "built" or receipt["diagnostic"] != diagnostic
            or receipt["source_revision"] != revision):
        raise RuntimeError("The NRO receipt does not match the archived HEAD")
    (local_root / "BUILD-RESULT.json").write_text(json.dumps({
        "revision": revision,
        "git_describe": description,
        "nacp_version": version,
        "artifact": "nro/moonlight-nx2-rust.nro",
        "bytes": artifact.stat().st_size,
        "sha256": digest(artifact),
        "build_info": "nro/BUILD-INFO.json",
    }, indent=2) + "\n")
    print(artifact)


if __name__ == "__main__":
    main()
