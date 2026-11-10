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
RUST_COMMIT = "6efa357bff60d192688e02de0c78cae24a7f3a55"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources():
    result = {str(path.relative_to(ROOT)): digest(path)
              for path in sorted(ROOT.rglob("*")) if path.is_file()
              and not {"target", "__pycache__", ".git"}.intersection(path.relative_to(ROOT).parts)}
    assets = APP / "src/renderer/civ7/prebuilt"
    manifest = json.loads((assets / "renderer.json").read_text())
    blob = assets / "shaders.bin"
    if (manifest["format"] != "moonlight.civ7.renderer" or manifest["version"] != 2
            or manifest["blob"]["path"] != blob.name
            or manifest["blob"]["bytes"] != blob.stat().st_size
            or manifest["blob"]["sha256"] != digest(blob)):
        raise ValueError("Civ7 shader bundle differs from its manifest")
    for name in ("renderer.json", "shaders.bin"):
        result[f"../renderer/civ7/prebuilt/{name}"] = digest(assets / name)
    result["../streamer/ui/fonts/glyphs.bin"] = digest(APP / "src/streamer/ui/fonts/glyphs.bin")
    probe = ROOT / "runtime/prebuilt"
    for name in ("ui-alpha", "ui-text"):
        record = json.loads((probe / (name + ".json")).read_text())
        shader = probe / (name + ".spv")
        if (record["format"] != "moonlight.rust." + name or record["version"] != 1
                or record["shader"]["path"] != shader.name
                or record["shader"]["bytes"] != shader.stat().st_size
                or record["shader"]["sha256"] != digest(shader)):
            raise ValueError("Rust UI shader differs from its manifest")
    interop = APP / "tools/testship/sdk-interop"
    for path in sorted(interop.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            result[str(Path("../../tools/testship/sdk-interop") / path.relative_to(interop))] = digest(path)
    return result


def nacp_title(diagnostic):
    if diagnostic in ("production", "production-sdk"):
        return "Moonlight NX2"
    if diagnostic == "frontend":
        return "Moonlight NX2 Rust"
    return f"Moonlight NX2 Rust {diagnostic}"


def helpers():
    spec = importlib.util.spec_from_file_location("native_builder", APP / "build-native.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
    native = helpers()
    env = dict(os.environ)
    info = {"created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_revision": native.source_revision(args.revision),
            "sources": sources(), "native_builder_sha256": digest(APP / "build-native.py"),
            "builder": os.environ.get("MOONLIGHT_BUILDER", platform.node()),
            "builder_architecture": platform.machine(), "stage": args.stage,
            "status": "building", "streaming": False, "commands": []}
    info["diagnostic"] = args.diagnostic
    info["source_branch"] = args.branch
    if info["source_branch"] is None:
        try:
            info["source_branch"] = subprocess.check_output(
                ["git", "-C", str(APP), "branch", "--show-current"], text=True,
                stderr=subprocess.DEVNULL).strip() or "detached"
        except subprocess.CalledProcessError:
            info["source_branch"] = "unknown"
    commands = []
    artifact = None
    if args.stage in ("host", "rust"):
        rustc = subprocess.check_output(["rustc", "--version", "--verbose"], text=True).strip()
        info["rustc"] = rustc
        info["cargo"] = subprocess.check_output(["cargo", "--version"], text=True).strip()
        env["CARGO_TARGET_DIR"] = str(directory / "cargo")
        if args.cargo_home:
            if not args.cargo_home.is_absolute():
                raise ValueError("--cargo-home must be absolute")
            env["CARGO_HOME"] = str(args.cargo_home)
        if args.stage == "rust":
            if f"commit-hash: {RUST_COMMIT}" not in rustc:
                raise ValueError("Device builds require nightly-2026-02-09 and rust-src")
            env["RUSTFLAGS"] = "-C relocation-model=pic -D warnings"
            info["rustflags"] = env["RUSTFLAGS"]
            info["target"] = TARGET
            sysroot = Path(subprocess.check_output(["rustc", "--print", "sysroot"], text=True).strip())
            manifest = sysroot / "lib/rustlib/multirust-channel-manifest.toml"
            info["rust_distribution_sha256"] = digest(manifest)
            commands = [["cargo", "build", "--manifest-path", str(ROOT / "Cargo.toml"),
                         "--package", "moonlight-nx2-runtime", "--target", TARGET, "--release", "--locked",
                         "-Zbuild-std=core,alloc", "-Zbuild-std-features="]]
            if args.diagnostic == "production":
                commands[0].extend(["--features", "frontend,native-video"])
            elif args.diagnostic == "production-sdk":
                commands[0].extend(["--features", "frontend,sdk-video"])
            elif args.diagnostic == "production-sdk-modes":
                commands[0].extend(["--features", "frontend,sdk-video-docked-modes"])
            elif args.diagnostic == "production-sdk-120":
                commands[0].extend(["--features", "frontend,sdk-video-120hz"])
            elif args.diagnostic == "production-sdk-modes-120":
                commands[0].extend(["--features", "frontend,sdk-video-docked-modes,sdk-video-120hz"])
            elif args.diagnostic != "core":
                commands[0].extend(["--features", f"diagnostic-{args.diagnostic}"])
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
            reference_files = [APP / f"src/native/{name}" for name in
                               ("input.c", "native.h", "control/wire.c", "control/wire.h", "media/parser.c", "media.h", "audio/queue.c", "audio/queue.h", "codec/untile.c", "codec/untile.h", "codec/wire.c", "codec/wire.h", "renderer/frame.c", "renderer/frame.h", "renderer/layout.h", "renderer/cache.h", "renderer.h")]
            reference_files.append(APP / "src/streamer/input/controller.js")
            reference_files.append(APP / "package.json")
            info["node"] = subprocess.check_output(["node", "--version"], text=True).strip()
            info["cc"] = subprocess.check_output(["cc", "--version"], text=True).splitlines()[0]
            test_files = [path for path in tests.parent.rglob("*") if path.is_file()]
            info["reference_sources"] = {str(path.relative_to(APP)): digest(path) for path in reference_files}
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
        if rust["diagnostic"] != args.diagnostic:
            raise ValueError("The Rust archive uses a different diagnostic mode")
        library = args.rust_directory / rust["artifact"]["name"]
        if digest(library) != rust["artifact"]["sha256"]:
            raise ValueError("Rust archive checksum mismatch")
        info["rust_build"] = rust
        info["sdk"] = native.installed_sdk(args.devkitpro)
        compiler = args.devkitpro / "devkitA64/bin/aarch64-none-elf-gcc"
        info["compiler"] = subprocess.check_output([str(compiler), "--version"], text=True).splitlines()[0]
        info["target"] = "aarch64-none-elf"
        env["DEVKITPRO"] = str(args.devkitpro)
        env["PATH"] = str(args.devkitpro / "tools/bin") + os.pathsep + env.get("PATH", "")
        commands = [["make", "--no-print-directory", "-f", str(ROOT / "nro/Makefile"),
                     f"BUILD_DIR={directory}", f"RUST_LIBRARY={library}",
                     "NACP_TITLE=" + nacp_title(args.diagnostic),
                     "NACP_VERSION=" + args.nacp_version]]
        if args.diagnostic in ("sdk-backing", "native-decode", "production"):
            alias_directory = args.sdk_backing_library_dir or directory / "sdk-interop/alias"
            if not alias_directory.is_absolute():
                raise ValueError("SDK backing alias library directory must be absolute")
            backing_inputs = {
                args.devkitpro / "portlibs/switch2/lib/libouncevk.a": "9b8d1de4d5d6c64de7ab737e940a05650544823ea46cd04f60c76d7a2d93621f",
                args.devkitpro / "libounce/lib/libounce.a": "1a914c2d1e3c7bb12878ace59d77d570017beee8a1bd366fa596b194bc41efd9",
                ROOT / "nro/sdk_backing.c": "a97422200d45b8e4973f4b19ce0b618b4c0cfe1020add2e5153dba849f5df63c",
                ROOT / "nro/sdk_backing.h": "982992ee26ed8ed01f3e8ae0979626d1a712622cbf2f9540faa89125df9cb5b1",
            }
            for path, expected in backing_inputs.items():
                if digest(path) != expected:
                    raise ValueError(f"SDK backing input differs: {path.name}")
            info["sdk_backing_inputs"] = {str(path): digest(path) for path in backing_inputs}
            info["sdk_backing_library_dir"] = str(alias_directory)
            commands[0].extend(["SDK_BACKING=1", f"SDK_BACKING_LIBRARY_DIR={alias_directory}"])
            if args.diagnostic in ("native-decode", "production"):
                commands[0].append("NATIVE_DECODE=1")
            if args.diagnostic == "native-decode":
                commands[0].append("BREADCRUMBS=1")
        if args.diagnostic in ("sdk-decode", "sdk-modes") or args.diagnostic.startswith("production-sdk"):
            if info["sdk"]["version"] != native.SDK_VIDDEC:
                raise ValueError("The SDK video decoder needs the 2026-11-10 SDK")
            commands[0].append("SDK_VIDDEC=1")
            if args.diagnostic in ("sdk-decode", "sdk-modes"):
                commands[0].append("BREADCRUMBS=1")
        artifact = directory / "moonlight-nx2-rust.nro"

    directory.mkdir(parents=True, exist_ok=False)
    try:
        with (directory / "build.log").open("w") as log:
            for command in commands:
                run(command, env, log, info["commands"])
        if args.stage == "nro" and args.diagnostic in ("sdk-backing", "native-decode", "production"):
            alias = Path(info["sdk_backing_library_dir"]) / "libouncevk.a"
            if digest(alias) != "b33546d8f616e135257a27b5606992a2b8a9708dc8d11e8343b55faa34176531":
                raise ValueError("Unexpected SDK backing alias archive")
            info["sdk_backing_alias_sha256"] = digest(alias)
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
        (directory / "BUILD-INFO.json").write_text(json.dumps(info, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description="Build and verify the Rust Moonlight application")
    parser.add_argument("stage", choices=("host", "rust", "nro"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--revision")
    parser.add_argument("--branch")
    parser.add_argument("--nacp-version", default="0.1.0")
    parser.add_argument("--diagnostic", choices=("core", "renderer", "display", "display120", "coexist", "io", "audio-cue", "udp", "nvdec", "sdk-backing", "native-decode", "sdk-decode", "sdk-modes", "ui", "ui-order", "ui-data", "ui-alpha", "ui-text", "ui-text-apps", "ui-text-overlay", "ui-text-interactive", "control", "control-default", "frontend", "frontend-check", "ref-replay", "production", "production-sdk", "production-sdk-modes", "production-sdk-120", "production-sdk-modes-120"), default="core")
    parser.add_argument("--sdk-backing-library-dir", type=Path)
    parser.add_argument("--rust-directory", type=Path)
    parser.add_argument("--cargo-home", type=Path)
    parser.add_argument("--dev", type=Path)
    parser.add_argument("--devkitpro", type=Path, default=Path(os.environ.get("DEVKITPRO", "/opt/devkitpro")))
    build(parser.parse_args())


if __name__ == "__main__":
    main()
