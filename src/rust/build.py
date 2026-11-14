#!/usr/bin/env python3

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess


ROOT = Path(__file__).resolve().parent
APP = ROOT.parents[1]
BUILDS = Path(os.environ.get("MOONLIGHT_BUILDS", "~/moonlight-builds")).expanduser()
TARGET = "aarch64-unknown-none"
RUST_COMMIT = "6efa357bff60d192688e02de0c78cae24a7f3a55"
SDK = {
    "ounce-sdk": "20261113",
    "libounce": "db3f88a3",
    "ouncevk": "791c34e",
    "ouncehen": "9451c44",
}
SDK_FILES = (
    "libounce/switch2_rules",
    "libounce/switch.specs",
    "libounce/include/switch2/services/gsv.h",
    "libounce/lib/libnx.a",
    "libounce/lib/libounce.a",
    "libounce/lib/libounce_core.a",
    "libounce/lib/libounce_malloc.a",
    "portlibs/switch2/include/vulkan/vulkan.h",
    "portlibs/switch2/lib/libvulkan.a",
)
# The version file and kaiHEN header of the pinned SDK, then of the public
# devkit (github.com/ouncebrew/ounce-devkit), where OunceHEN became kaiHEN.
PINNED_SDK_FILES = ("ounce-sdk-version.txt", "portlibs/switch2/include/ouncehen.h")
DEVKIT_FILES = ("ounce-devkit-version.txt", "portlibs/switch2/include/kaihen.h")
# The builds users and testers get, and the runtime features each one turns on.
PRODUCTION = {
    "production": "frontend",
    "production-tcp": "frontend,video-tcp",
    "production-120-decode": "frontend,sdk-video-120-decode",
    "production-pattern": "frontend,ui-pattern,ui-page-check",
    "production-uncached": "frontend,ui-pattern,ui-page-check,ui-uncached",
}
# Diagnostics of the SDK video decoder: the frontend with reference clips replayed first.
SDK_DIAGNOSTICS = ("sdk-decode", "sdk-modes")
# The session sets of sdk-modes (runtime/src/ref_replay.rs).
TRIALS = ("sizes", "4k", "rate", "paced")


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def output(*command):
    return subprocess.check_output([str(word) for word in command], text=True).strip()


def git(*arguments):
    return output("git", "-C", APP, *arguments)


def utc_stamp():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def sources():
    result = {str(path.relative_to(ROOT)): digest(path)
              for path in sorted(ROOT.rglob("*")) if path.is_file()
              and not {"target", "__pycache__", ".git"}.intersection(path.relative_to(ROOT).parts)}
    manifest = json.loads((ROOT / "runtime/prebuilt/renderer.json").read_text())
    blob = ROOT / "runtime/prebuilt/shaders.bin"
    if (manifest["format"] != "moonlight.civ7.renderer" or manifest["version"] != 2
            or manifest["blob"]["path"] != blob.name
            or manifest["blob"]["bytes"] != blob.stat().st_size
            or manifest["blob"]["sha256"] != digest(blob)):
        raise ValueError("Shader bundle differs from its manifest")
    record = json.loads((ROOT / "runtime/prebuilt/ui-text.json").read_text())
    shader = ROOT / "runtime/prebuilt/ui-text.spv"
    if (record["format"] != "moonlight.rust.ui-text" or record["version"] != 1
            or record["shader"]["path"] != shader.name
            or record["shader"]["bytes"] != shader.stat().st_size
            or record["shader"]["sha256"] != digest(shader)):
        raise ValueError("Rust UI shader differs from its manifest")
    return result


def features(diagnostic):
    return PRODUCTION.get(diagnostic, f"diagnostic-{diagnostic}")


def build_name(args):
    if args.diagnostic == "sdk-modes" and args.trials != TRIALS[0]:
        return f"sdk-modes-{args.trials}"
    return args.diagnostic


def nacp_title(name):
    return "Moonlight NX2" if name == "production" else f"Moonlight NX2 Rust {name}"


def installed_sdk(path, devkit=None):
    names = (*(DEVKIT_FILES if devkit else PINNED_SDK_FILES), *SDK_FILES)
    files = {name: (path / name).read_bytes() for name in names}
    rows = [line.split() for line in files[names[0]].decode().splitlines() if line.strip()]
    if any(len(row) != 2 for row in rows):
        raise ValueError(f"Unreadable {names[0]}")
    version = dict(rows)
    if devkit and version.get("ounce-devkit") != devkit:
        raise ValueError(f"Expected ounce-devkit {devkit}, found {version.get('ounce-devkit')}")
    if not devkit and version != SDK:
        raise ValueError(f"Expected the pinned SDK {SDK}")
    return {"version": version,
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}


def release_error(version):
    """Why hbmenu cannot show VERSION as a release, or None."""
    if not re.fullmatch(r"\d+\.\d+\.\d+(-[a-z0-9.]+)?", version):
        return "--release takes a version like 1.0.0 or 1.0.0-test1"
    if len(version) > 15:
        return "--release is at most 15 characters, the NACP limit"
    return None


def remap_paths(prefixes):
    """--remap-path-prefix flags that keep the build paths out of the binary."""
    flags = []
    for path, name in prefixes.items():
        if any(char.isspace() for char in str(path)):
            raise ValueError(f"{path} has whitespace, which RUSTFLAGS cannot carry")
        flags.append(f"--remap-path-prefix={path}={name}")
    return flags


def source_revision(override):
    if override:
        if len(override) != 40 or any(char not in "0123456789abcdef" for char in override):
            raise ValueError("--revision must be a full Git commit hash")
        return override
    return git("rev-parse", "HEAD")


def run(command, env, log, commands):
    commands.append([str(value) for value in command])
    log.write(json.dumps(commands[-1]) + "\n")
    log.flush()
    subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)


def build(args):
    directory = args.directory
    if not directory.is_absolute() or any(char.isspace() for char in str(directory)):
        raise ValueError("Use an absolute output directory without whitespace")
    if directory == APP or APP in directory.parents:
        raise ValueError("Keep output outside the app checkout")
    env = dict(os.environ)
    info = {"created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_revision": source_revision(args.revision), "sources": sources(),
            "builder": os.environ.get("MOONLIGHT_BUILDER", platform.node()),
            "builder_architecture": platform.machine(), "stage": args.stage,
            "status": "building", "streaming": False, "commands": []}
    info["diagnostic"] = args.diagnostic
    if args.diagnostic == "sdk-modes":
        info["trials"] = args.trials
        env["MOONLIGHT_SDK_MODES_TRIALS"] = args.trials
    env["MOONLIGHT_REVISION"] = info["source_revision"]
    info["source_branch"] = args.branch
    if info["source_branch"] is None:
        try:
            info["source_branch"] = git("branch", "--show-current") or "detached"
        except subprocess.CalledProcessError:
            info["source_branch"] = "unknown"
    commands = []
    artifact = None
    if args.stage in ("host", "rust"):
        rustc = output("rustc", "--version", "--verbose")
        info["rustc"] = rustc
        info["cargo"] = output("cargo", "--version")
        env["CARGO_TARGET_DIR"] = str(directory / "cargo")
        if args.cargo_home:
            if not args.cargo_home.is_absolute():
                raise ValueError("--cargo-home must be absolute")
            env["CARGO_HOME"] = str(args.cargo_home)
        if args.stage == "rust":
            if f"commit-hash: {RUST_COMMIT}" not in rustc:
                raise ValueError("Device builds require nightly-2026-02-09 and rust-src")
            sysroot = Path(output("rustc", "--print", "sysroot"))
            cargo_home = Path(env.get("CARGO_HOME", "~/.cargo")).expanduser()
            env["RUSTFLAGS"] = " ".join([
                "-C relocation-model=pic -C target-feature=+aes,+sha2 -D warnings",
                *remap_paths({APP: "/moonlight-nx2", cargo_home: "/cargo", sysroot: "/rustc",
                              directory / "cargo": "/target"})])
            info["rustflags"] = env["RUSTFLAGS"]
            info["target"] = TARGET
            manifest = sysroot / "lib/rustlib/multirust-channel-manifest.toml"
            info["rust_distribution_sha256"] = digest(manifest)
            commands = [["cargo", "build", "--manifest-path", str(ROOT / "Cargo.toml"),
                         "--package", "moonlight-nx2-runtime", "--target", TARGET, "--release", "--locked",
                         "-Zbuild-std=core,alloc", "-Zbuild-std-features=",
                         "--features", features(args.diagnostic)]]
            artifact = directory / "cargo" / TARGET / "release/libmoonlight_nx2_runtime.a"
        else:
            dev = args.dev or APP.parent / "moonlight-nx2-dev"
            tests = dev / "src/rust/tests/Cargo.toml"
            packages = ["-p", "moonlight-nx2-core", "-p", "moonlight-nx2-runtime"]
            commands = [["cargo", "fmt", "--manifest-path", str(ROOT / "Cargo.toml"), *packages, "--check"],
                        ["cargo", "clippy", "--manifest-path", str(ROOT / "Cargo.toml"), *packages, "--all-targets", "--locked", "--offline", "--", "-D", "warnings"],
                        ["cargo", "fmt", "--manifest-path", str(tests), "--check"],
                        ["cargo", "clippy", "--manifest-path", str(tests), "--all-targets", "--locked", "--offline", "--", "-D", "warnings"],
                        ["cargo", "test", "--manifest-path", str(tests), "--locked", "--offline"]]
            reference_files = [dev / f"reference/native/{name}" for name in
                               ("input.c", "native.h", "control/wire.c", "control/wire.h", "media/parser.c", "media.h", "audio/queue.c", "audio/queue.h", "codec/untile.c", "codec/untile.h", "codec/wire.c", "codec/wire.h", "renderer/frame.c", "renderer/frame.h", "renderer/layout.h", "renderer/cache.h", "renderer.h")]
            reference_files.append(dev / "legacy/src/streamer/input/controller.js")
            reference_files.append(dev / "legacy/package.json")
            info["node"] = output("node", "--version")
            info["cc"] = output("cc", "--version").splitlines()[0]
            test_files = [path for path in tests.parent.rglob("*") if path.is_file()]
            info["reference_sources"] = {str(path.relative_to(dev)): digest(path) for path in reference_files}
            info["test_sources"] = {str(path.relative_to(dev)): digest(path) for path in test_files}
    else:
        if args.rust_directory is None or not args.rust_directory.is_absolute():
            raise ValueError("NRO stage needs an absolute --rust-directory")
        if not 0 < len(args.nacp_version) <= 15:
            raise ValueError("NACP version must fit its 15-byte version field")
        rust = json.loads((args.rust_directory / "BUILD-INFO.json").read_text())
        if rust["status"] != "built" or rust["stage"] != "rust" or rust["target"] != TARGET:
            raise ValueError("Expected a completed device Rust build")
        if rust["sources"] != info["sources"] or rust["source_revision"] != info["source_revision"]:
            raise ValueError("The Rust archive was built from different source")
        if rust["diagnostic"] != args.diagnostic or rust.get("trials") != info.get("trials"):
            raise ValueError("The Rust archive uses a different diagnostic mode")
        library = args.rust_directory / rust["artifact"]["name"]
        if digest(library) != rust["artifact"]["sha256"]:
            raise ValueError("Rust archive checksum mismatch")
        info["rust_build"] = rust
        info["sdk"] = installed_sdk(args.devkitpro, args.devkit)
        compiler = args.devkitpro / "devkitA64/bin/aarch64-none-elf-gcc"
        info["compiler"] = output(compiler, "--version").splitlines()[0]
        info["target"] = "aarch64-none-elf"
        env["DEVKITPRO"] = str(args.devkitpro)
        env["PATH"] = str(args.devkitpro / "tools/bin") + os.pathsep + env.get("PATH", "")
        commands = [["make", "--no-print-directory", "-C", directory, "-f", str(ROOT / "nro/Makefile"),
                     f"BUILD_DIR={directory}", f"RUST_LIBRARY={library}",
                     "NACP_TITLE=" + nacp_title(build_name(args)),
                     "NACP_VERSION=" + args.nacp_version]]
        if args.diagnostic in SDK_DIAGNOSTICS:
            commands[0].append("BREADCRUMBS=1")
        artifact = directory / "moonlight-nx2.nro"

    directory.mkdir(parents=True, exist_ok=False)
    try:
        with (directory / "build.log").open("w") as log:
            for command in commands:
                run(command, env, log, info["commands"])
        if sources() != info["sources"]:
            raise ValueError("Rust source changed during the build")
        if artifact:
            if args.stage == "nro" and artifact.read_bytes()[16:20] != b"NRO0":
                raise ValueError("Missing NRO header")
            info["artifact"] = {"name": str(artifact.relative_to(directory)),
                                "bytes": artifact.stat().st_size, "sha256": digest(artifact)}
        info["status"] = "built" if artifact else "passed"
        print(artifact or directory)
    except BaseException:
        info["status"] = "failed"
        print((directory / "build.log").read_text())
        raise
    finally:
        write_json(directory / "BUILD-INFO.json", info)


def main():
    parser = argparse.ArgumentParser(description="Build and verify the Rust Moonlight application")
    parser.add_argument("stage", choices=("host", "rust", "nro"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--revision")
    parser.add_argument("--branch")
    parser.add_argument("--nacp-version", default="0.1.0")
    parser.add_argument("--diagnostic", default="production",
                        choices=(*PRODUCTION, *SDK_DIAGNOSTICS))
    parser.add_argument("--trials", choices=TRIALS, default=TRIALS[0],
                        help="the sessions an sdk-modes build runs")
    parser.add_argument("--rust-directory", type=Path)
    parser.add_argument("--cargo-home", type=Path)
    parser.add_argument("--dev", type=Path)
    parser.add_argument("--devkitpro", type=Path, default=Path(os.environ.get("DEVKITPRO", "/opt/devkitpro")))
    parser.add_argument("--devkit", metavar="VERSION",
                        help="the public ounce-devkit version in --devkitpro, instead of the pinned SDK")
    build(parser.parse_args())


if __name__ == "__main__":
    main()
