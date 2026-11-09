#!/usr/bin/env python3

import argparse
import datetime
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import struct
import zipfile


ROOT = Path(__file__).resolve().parent
TESTSHIPS = {
    "a25f0a5ead90e824f468b498badb3dbda8650af85aae90e16a8276e9913e5da2": "ethernet",
    "a1e165c275bb724cbdb4b5cd9b087295b2484bdf22b0e898ff5abcdca20491a6": "experimental-wifi",
}


def sha256(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def arm64_elf(path, static=False):
    data = path.read_bytes()
    if data[:6] != b"\x7fELF\x02\x01" or len(data) < 64 or struct.unpack_from("<H", data, 18)[0] != 183:
        raise ValueError(f"Expected a Linux ARM64 ELF: {path}")
    offset = struct.unpack_from("<Q", data, 32)[0]
    size, count = struct.unpack_from("<HH", data, 54)
    if size < 4 or offset + size * count > len(data):
        raise ValueError(f"Invalid ELF program headers: {path}")
    if static and any(struct.unpack_from("<I", data, offset + i * size)[0] == 3 for i in range(count)):
        raise ValueError("The T3 controller must be statically linked")


def check_nro(path):
    with path.open("rb") as stream:
        header = stream.read(0x80)
    if len(header) != 0x80 or header[16:20] != b"NRO0":
        raise ValueError(f"Expected a homebrew NRO: {path}")


def prepare(args):
    testship_hash = sha256(args.testship)
    if testship_hash not in TESTSHIPS:
        raise ValueError("The testship ZIP differs from the 9 November input")
    check_nro(args.nro)
    for program in args.program:
        check_nro(program)
        if program.suffix != ".nro" or program.name == "moonlight-nx2-compat.nro":
            raise ValueError("Additional programs need distinct .nro filenames")
    arm64_elf(args.controller, static=True)
    arm64_elf(args.node)
    if not args.node_license.is_file():
        raise ValueError("Node's license file is required")
    provenance = json.loads(args.nro_info.read_text())
    artifact = provenance.get("artifact", {})
    if artifact.get("sha256") != sha256(args.nro) or artifact.get("bytes") != args.nro.stat().st_size:
        raise ValueError("NRO bytes do not match the native build record")
    directory = args.directory
    if not directory.is_absolute():
        raise ValueError("--directory must be an absolute, new build directory")
    directory.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(args.testship) as archive:
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            if name.is_absolute() or ".." in name.parts:
                raise ValueError("Invalid testship ZIP entry")
            if name.parts[0] != "ns2jb":
                continue
            archive.extract(entry, directory)

    programs = directory / "ns2jb/testship/programs"
    shutil.copy2(args.nro, programs / "moonlight-nx2-compat.nro")
    for program in args.program:
        target = programs / program.name
        if target.exists():
            raise ValueError(f"Program already exists in testship: {program.name}")
        shutil.copy2(program, target)
    shutil.copy2(args.nro_info, directory / "NATIVE-BUILD-INFO.json")
    control = directory / "controller"
    shutil.copytree(ROOT / "t3switch/scripts", control / "scripts")
    shutil.copy2(ROOT / "t3switch/LICENSE", control / "LICENSE")
    shutil.copy2(ROOT / "t3switch/SOURCE.json", control / "SOURCE.json")
    shutil.copy2(args.controller, control / "t3control")
    (control / "t3control").chmod(0o755)
    for name in ("t3.py", "launch.py", "dut_run.py", "bootstrap.py", "trace-hello.cjs", "README.md", "ocr.sh", "OCR.Dockerfile"):
        shutil.copy2(ROOT / name, directory / name)
    (directory / "ocr.sh").chmod(0o755)
    runtime = directory / "node/bin"
    runtime.mkdir(parents=True)
    shutil.copy2(args.node, runtime / "node")
    (runtime / "node").chmod(0o755)
    shutil.copy2(args.node_license, directory / "node/LICENSE")
    (directory / "state").mkdir(mode=0o700)
    manifest = {
        "version": 1,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "testship_sha256": testship_hash,
        "testship_variant": TESTSHIPS[testship_hash],
        "native_build": provenance,
        "node_image": args.node_image,
        "console_tested": False,
        "streaming": False,
        "extra_programs": {program.name: sha256(program) for program in args.program},
        "files": {str(path.relative_to(directory)): sha256(path)
                  for path in sorted(directory.rglob("*")) if path.is_file()},
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(directory)


def main():
    parser = argparse.ArgumentParser(description="Prepare the T3 testship and Moonlight diagnostic package")
    parser.add_argument("--testship", type=Path, required=True)
    parser.add_argument("--nro", type=Path, required=True)
    parser.add_argument("--nro-info", type=Path, required=True)
    parser.add_argument("--controller", type=Path, required=True)
    parser.add_argument("--program", type=Path, action="append", default=[], help="additional NRO to stage")
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--node-license", type=Path, required=True)
    parser.add_argument("--node-image", required=True, help="Node image digest for build provenance")
    parser.add_argument("--directory", type=Path, required=True)
    prepare(parser.parse_args())


if __name__ == "__main__":
    main()
