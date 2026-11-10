#!/usr/bin/env python3

import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parent
SDK = {
    "ounce-sdk": "20261109",
    "libounce": "e9d87b77",
    "ouncevk": "fd483fb",
    "ouncehen": "3094c24",
}
SDK_VIDDEC = {
    "ounce-sdk": "20261110",
    "libounce": "cc442785",
    "ouncevk": "99b78bc",
    "ouncehen": "ed1c5f0",
}
SDK_ARCHIVE_SHA256 = "0dd4be44ad73471969aac593ca1b03179f90e2014e1583c6c6249da4eeeeead7"
SDK_FILES = (
    "ounce-sdk-version.txt",
    "libounce/switch2_rules",
    "libounce/switch.specs",
    "libounce/include/switch2/services/gsv.h",
    "libounce/lib/libnx.a",
    "portlibs/switch2/include/ouncehen.h",
    "portlibs/switch2/include/vulkan/vulkan.h",
    "portlibs/switch2/lib/libvulkan.a",
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sdk_version(text):
    rows = [line.split() for line in text.splitlines() if line.strip()]
    if any(len(row) != 2 for row in rows):
        raise ValueError("Malformed ounce-sdk-version.txt")
    version = dict(rows)
    if len(version) != len(rows) or version not in (SDK, SDK_VIDDEC):
        raise ValueError(f"Expected a pinned testship SDK ({SDK} or {SDK_VIDDEC}); found {version}")
    return version


def inspect_testship(path):
    with zipfile.ZipFile(path) as bundle:
        data = bundle.read("sdk/ounce-sdk.tar.xz")
    checksum = digest(data)
    if checksum != SDK_ARCHIVE_SHA256:
        raise ValueError("The SDK archive differs from ns2jb-testship-2026-11-09.zip")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:xz") as archive:
        files = {}
        for name in SDK_FILES:
            stream = archive.extractfile(name)
            if stream is None:
                raise ValueError(f"SDK file is missing: {name}")
            files[name] = stream.read()
    return {
        "version": sdk_version(files["ounce-sdk-version.txt"].decode()),
        "sdk_archive_sha256": checksum,
        "files": {name: digest(data) for name, data in files.items()},
        "target": "aarch64-none-elf",
        "artifact": "moonlight-nx2-compat.nro",
        "streaming": False,
    }


def installed_sdk(path):
    files = {name: (path / name).read_bytes() for name in SDK_FILES}
    return {
        "version": sdk_version(files["ounce-sdk-version.txt"].decode()),
        "files": {name: digest(data) for name, data in files.items()},
    }


def source_revision(override):
    if override:
        if len(override) != 40 or any(char not in "0123456789abcdef" for char in override):
            raise ValueError("--revision must be a full Git commit hash")
        return override
    return subprocess.check_output(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True
    ).strip()


def build(directory, devkitpro, revision, jobs, renderer_pattern=False):
    if not directory.is_absolute() or not devkitpro.is_absolute():
        raise ValueError("--directory and --devkitpro must be absolute paths")
    paths = (directory, devkitpro, ROOT)
    if any(any(char.isspace() for char in str(path)) for path in paths):
        raise ValueError("The devkitPro Makefile requires paths without whitespace")
    if directory == ROOT or ROOT in directory.parents:
        raise ValueError("Keep native build outputs outside the source checkout")
    if jobs < 1 or jobs > 256:
        raise ValueError("--jobs must be between 1 and 256")

    sdk = installed_sdk(devkitpro)
    compiler = devkitpro / "devkitA64/bin/aarch64-none-elf-gcc"
    compiler_version = subprocess.check_output([str(compiler), "--version"], text=True).splitlines()[0]
    makefile = ROOT / "src/native/Makefile"
    artifact_name = "moonlight-nx2-compat.nro"
    if renderer_pattern:
        makefile = ROOT / "src/native/renderer/pattern/Makefile"
        artifact_name = "moonlight-nx2-renderer-diagnostic.nro"
    command = [
        "make", "--no-print-directory", f"-j{jobs}", "-f", str(makefile),
        f"BUILD_DIR={directory}",
    ]
    sources = sorted((ROOT / "src/native").rglob("*")) + [ROOT / "build-native.py"]
    metadata = {
        "source_revision": source_revision(revision),
        "sources": {str(path.relative_to(ROOT)): digest(path.read_bytes()) for path in sources if path.is_file()},
        "sdk": sdk,
        "target": "aarch64-none-elf",
        "builder": os.environ.get("MOONLIGHT_BUILDER", platform.node()),
        "builder_architecture": platform.machine(),
        "compiler": compiler_version,
        "command": command,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "status": "building",
        "streaming": False,
        "mode": "renderer-pattern" if renderer_pattern else "compatibility",
    }
    directory.mkdir(parents=True, exist_ok=False)
    info = directory / "BUILD-INFO.json"
    info.write_text(json.dumps(metadata, indent=2) + "\n")
    header = directory / "build-info.h"
    header.write_text(
        f'#define MOONLIGHT_SOURCE_REVISION "{metadata["source_revision"]}"\n'
        f'#define MOONLIGHT_SDK_VERSION "ounce-sdk {SDK["ounce-sdk"]}"\n'
    )
    env = dict(os.environ, DEVKITPRO=str(devkitpro))
    env["PATH"] = str(devkitpro / "tools/bin") + os.pathsep + env.get("PATH", "")

    try:
        with (directory / "build.log").open("w") as log:
            result = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=False)
        if result.returncode:
            print((directory / "build.log").read_text())
            raise RuntimeError(f"Native build failed with exit status {result.returncode}")
        artifact = directory / artifact_name
        data = artifact.read_bytes()
        if data[16:20] != b"NRO0":
            raise RuntimeError("elf2nro did not produce an NRO executable")
        metadata["status"] = "built"
        metadata["artifact"] = {"name": artifact.name, "bytes": len(data), "sha256": digest(data)}
        print(artifact)
    except BaseException:
        metadata["status"] = "failed"
        raise
    finally:
        info.write_text(json.dumps(metadata, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Build the native Moonlight compatibility NRO")
    parser.add_argument("--inspect-testship", type=Path, metavar="ZIP", help="inspect the SDK without building")
    parser.add_argument("--directory", type=Path, help="new absolute build directory")
    parser.add_argument("--devkitpro", type=Path, default=Path(os.environ.get("DEVKITPRO", "/opt/devkitpro")))
    parser.add_argument("--revision", help="source commit when building an exported source tree")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 1, 8))
    parser.add_argument("--renderer-pattern", action="store_true", help="build the bounded renderer diagnostic")
    args = parser.parse_args()
    if args.inspect_testship:
        print(json.dumps(inspect_testship(args.inspect_testship), indent=2))
        return
    if args.directory is None:
        parser.error("--directory is required for a build")
    build(args.directory, args.devkitpro, args.revision, args.jobs, args.renderer_pattern)


if __name__ == "__main__":
    main()
