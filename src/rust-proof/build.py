#!/usr/bin/env python3

import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess


ROOT = Path(__file__).resolve().parent
APP = ROOT.parents[1]
TARGET = "aarch64-unknown-none"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources():
    return {str(path.relative_to(ROOT)): digest(path)
            for path in sorted(ROOT.rglob("*")) if path.is_file()}


def sdk_helpers():
    spec = importlib.util.spec_from_file_location("native_builder", APP / "build-native.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(args):
    directory = args.directory
    if not directory.is_absolute() or any(char.isspace() for char in str(directory)):
        raise ValueError("Use an absolute build directory without whitespace")
    if directory == APP or APP in directory.parents:
        raise ValueError("Keep build outputs outside the source checkout")

    helpers = sdk_helpers()
    info = {
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source_revision": helpers.source_revision(args.revision),
        "native_builder_sha256": digest(APP / "build-native.py"),
        "sources": sources(),
        "builder": os.environ.get("MOONLIGHT_BUILDER", platform.node()),
        "builder_architecture": platform.machine(),
        "stage": args.stage,
        "target": TARGET if args.stage == "rust" else "aarch64-none-elf",
        "status": "building",
        "streaming": False,
    }
    env = dict(os.environ)
    if args.stage == "rust":
        info["rustc"] = subprocess.check_output(["rustc", "--version", "--verbose"], text=True).strip()
        command = ["cargo", "build", "--manifest-path", str(ROOT / "Cargo.toml"),
                   "--target", TARGET, "--release", "--frozen", "--offline"]
        info["features"] = ["allocator-proof"] if args.allocator_proof else []
        if info["features"]:
            command += ["--features", "allocator-proof"]
        env["CARGO_TARGET_DIR"] = str(directory / "cargo")
        env["CARGO_HOME"] = str(directory / "cargo-home")
        env["RUSTFLAGS"] = "-C relocation-model=pic"
        if args.sysroot:
            if not args.sysroot.is_absolute() or any(char.isspace() for char in str(args.sysroot)):
                raise ValueError("Use an absolute Rust sysroot without whitespace")
            env["RUSTFLAGS"] += f" --sysroot {args.sysroot}"
        info["rustflags"] = env["RUSTFLAGS"]
        artifact = directory / "cargo" / TARGET / "release/libmoonlight_rust_proof.a"
    else:
        if args.rust_directory is None or not args.rust_directory.is_absolute():
            raise ValueError("NRO builds need an absolute --rust-directory")
        rust_info = json.loads((args.rust_directory / "BUILD-INFO.json").read_text())
        if rust_info.get("status") != "built" or rust_info.get("target") != TARGET:
            raise ValueError("The Rust stage did not finish for the expected target")
        if rust_info["sources"] != info["sources"] or rust_info["source_revision"] != info["source_revision"]:
            raise ValueError("The Rust archive was built from different sources")
        library = args.rust_directory / rust_info["artifact"]["name"]
        if digest(library) != rust_info["artifact"]["sha256"]:
            raise ValueError("The Rust archive hash differs from its build record")
        info["rust_build"] = rust_info
        info["sdk"] = helpers.installed_sdk(args.devkitpro)
        compiler = args.devkitpro / "devkitA64/bin/aarch64-none-elf-gcc"
        info["compiler"] = subprocess.check_output([str(compiler), "--version"], text=True).splitlines()[0]
        command = ["make", "--no-print-directory", "-f", str(ROOT / "probe/Makefile"),
                   f"BUILD_DIR={directory}", f"RUST_LIBRARY={library}"]
        info["features"] = rust_info["features"]
        if info["features"]:
            command += ["RUST_FEATURES=allocator-proof"]
        env["DEVKITPRO"] = str(args.devkitpro)
        env["PATH"] = str(args.devkitpro / "tools/bin") + os.pathsep + env.get("PATH", "")
        artifact = directory / "moonlight-nx2-rust-proof.nro"

    info["command"] = command
    directory.mkdir(parents=True, exist_ok=False)
    try:
        with (directory / "build.log").open("w") as log:
            subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        if args.stage == "nro" and artifact.read_bytes()[16:20] != b"NRO0":
            raise ValueError("elf2nro did not produce an NRO executable")
        info["artifact"] = {"name": str(artifact.relative_to(directory)),
                            "bytes": artifact.stat().st_size, "sha256": digest(artifact)}
        info["status"] = "built"
        print(artifact)
    except BaseException:
        info["status"] = "failed"
        print((directory / "build.log").read_text())
        raise
    finally:
        (directory / "BUILD-INFO.json").write_text(json.dumps(info, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Build the isolated Rust static library and diagnostic NRO")
    parser.add_argument("stage", choices=("rust", "nro"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--revision", help="full commit hash for an exported source tree")
    parser.add_argument("--sysroot", type=Path, help="optional task-local Rust target libraries")
    parser.add_argument("--allocator-proof", action="store_true", help="experimental Rust alloc bridge")
    parser.add_argument("--rust-directory", type=Path, help="completed Rust-stage output")
    parser.add_argument("--devkitpro", type=Path, default=Path(os.environ.get("DEVKITPRO", "/opt/devkitpro")))
    build(parser.parse_args())


if __name__ == "__main__":
    main()
