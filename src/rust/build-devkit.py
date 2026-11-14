#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

from build import APP, BUILDS, digest, git, utc_stamp, write_json


RELEASES = "https://github.com/ouncebrew/ounce-devkit/releases"
LATEST = "https://api.github.com/repos/ouncebrew/ounce-devkit/releases/latest"
DEVKIT = "20261114"
DEVKIT_SHA256 = "f24d5773b1ee1c2b19317f57e8ae54a60fcdcefe493a0e495297c241c4912f59"
TOOLCHAIN = "nightly-2026-02-09"


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "moonlight-nx2-ci"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def latest_devkit():
    tag = json.loads(fetch(LATEST))["tag_name"]
    if not tag.startswith("devkit-"):
        raise ValueError(f"Unexpected devkit release tag {tag}")
    return tag.removeprefix("devkit-")


def published_sha256(url):
    try:
        return fetch(url + ".sha256").decode().split()[0]
    except urllib.error.HTTPError as error:
        raise ValueError(f"No SHA-256 published for {url}: {error}") from error


def download_devkit(version, cache):
    name = f"ounce-devkit-{version}.tar.xz"
    url = f"{RELEASES}/download/devkit-{version}/{name}"
    expected = DEVKIT_SHA256 if version == DEVKIT else published_sha256(url)
    archive = cache / name
    if not archive.is_file() or digest(archive) != expected:
        cache.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {url}", flush=True)
        archive.write_bytes(fetch(url))
    actual = digest(archive)
    if actual != expected:
        raise ValueError(f"{name} has SHA-256 {actual}, expected {expected}")
    return archive, actual


def install_devkit(archive, devkitpro):
    if not (devkitpro / "devkitA64/bin/aarch64-none-elf-gcc").is_file():
        raise ValueError(f"{devkitpro} has no devkitA64; use the devkitpro/devkita64 image")
    shutil.rmtree(devkitpro / "libounce", ignore_errors=True)
    shutil.rmtree(devkitpro / "portlibs/switch2", ignore_errors=True)
    subprocess.run(["tar", "-xJf", archive, "-C", devkitpro], check=True)


def install_rust():
    if not shutil.which("rustup"):
        script = fetch("https://sh.rustup.rs")
        subprocess.run(["sh", "-s", "--", "-y", "--no-modify-path", "--profile", "minimal",
                        "--default-toolchain", "none"], input=script, check=True)
        cargo_home = Path(os.environ.get("CARGO_HOME", "~/.cargo")).expanduser()
        os.environ["PATH"] = str(cargo_home / "bin") + os.pathsep + os.environ["PATH"]
    subprocess.run(["rustup", "toolchain", "install", TOOLCHAIN, "--profile", "minimal",
                    "--component", "rust-src"], check=True)
    os.environ["RUSTUP_TOOLCHAIN"] = TOOLCHAIN


def main():
    parser = argparse.ArgumentParser(
        description="Build the production NRO against the public ounce-devkit")
    parser.add_argument("--devkit", default=DEVKIT,
                        help=f"the devkit version, or latest; {DEVKIT} by default")
    parser.add_argument("--newer-only", action="store_true",
                        help="build only when the devkit is not the pinned one")
    parser.add_argument("--directory", type=Path,
                        help="a new absolute output directory, by default one under MOONLIGHT_BUILDS")
    parser.add_argument("--cache", type=Path, default=Path("~/.cache/ounce-devkit").expanduser(),
                        help="where downloaded devkit archives are kept")
    parser.add_argument("--devkitpro", type=Path,
                        default=Path(os.environ.get("DEVKITPRO", "/opt/devkitpro")))
    args = parser.parse_args()

    version = latest_devkit() if args.devkit == "latest" else args.devkit
    if args.newer_only and version == DEVKIT:
        print(f"ounce-devkit {version} is the pinned version; the push builds cover it")
        return
    archive, archive_sha256 = download_devkit(version, args.cache)
    install_devkit(archive, args.devkitpro)
    install_rust()

    revision = git("rev-parse", "HEAD")
    directory = args.directory or BUILDS / f"{utc_stamp()}-{revision[:7]}-devkit-{version}"
    branch = os.environ.get("CI_COMMIT_REF_NAME") or git("branch", "--show-current") or "detached"
    what = ["--revision", revision, "--branch", branch]
    build = [sys.executable, "-B", str(APP / "src/rust/build.py")]
    rust = directory / "rust"
    nro = directory / "nro"
    directory.mkdir(parents=True, exist_ok=False)
    subprocess.run([*build, "rust", "--directory", rust, *what], check=True)
    subprocess.run([*build, "nro", "--directory", nro, "--rust-directory", rust, *what,
                    "--nacp-version", f"ci-{revision[:8]}",
                    "--devkitpro", args.devkitpro, "--devkit", version], check=True)

    artifact = nro / "moonlight-nx2.nro"
    write_json(directory / "BUILD-RESULT.json", {
        "revision": revision,
        "devkit": version,
        "devkit_sha256": archive_sha256,
        "artifact": "nro/moonlight-nx2.nro",
        "bytes": artifact.stat().st_size,
        "sha256": digest(artifact),
        "build_info": "nro/BUILD-INFO.json",
    })


if __name__ == "__main__":
    main()
