#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parent
APP = ROOT.parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Build a diagnostic fragment shader without changing Civ7 assets")
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--variant", choices=("alpha", "text"), default="alpha")
    args = parser.parse_args()
    directory = args.directory
    builds = Path("/media/storage2/builds/moonlight")
    if not directory.is_absolute() or builds not in directory.parents or directory.exists():
        raise ValueError("Use a new Moonlight build directory")
    directory.mkdir()
    shaders = APP / "src/renderer/civ7/shaders"
    base = shaders / "ui.frag"
    manifest = json.loads((APP / "src/renderer/civ7/prebuilt/renderer.json").read_text())
    for name in ["ui.frag", "storage.glsl"]:
        if digest(shaders/name) != manifest["sources"][name]:
            raise ValueError("Civ7 shader source differs from frozen reference")
    source = base.read_text()
    if not source.startswith("#version 450\n"):
        raise ValueError("Unexpected fragment shader version")
    (directory/"ui-base.frag").write_text(source.removeprefix("#version 450\n"))
    name = "ui-" + args.variant
    wrapper = ROOT / f"shaders/{name}.frag"
    shutil.copy2(wrapper, directory/(name+".frag"))
    layout = subprocess.check_output(["node", "--input-type=module", "-e",
        "const {glslLayout}=await import(process.argv[1]);process.stdout.write(glslLayout());",
        str(APP/"src/renderer/civ7/layout.js")])
    (directory/"layout.glsl").write_bytes(layout)
    if digest(directory/"layout.glsl") != manifest["sources"]["layout.glsl"]:
        raise ValueError("Generated layout differs from Civ7 reference")
    target = directory / (name+".spv")
    commands = [["glslc", "-O", "--target-env=vulkan1.0", "-I", str(directory),
                 "-I", str(shaders), str(directory/(name+".frag")), "-o", str(target)],
                ["spirv-val", "--target-env", "vulkan1.0", str(target)]]
    with (directory/"build.log").open("w") as log:
        for command in commands:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    info = {"format":"moonlight.rust."+name, "version":1, "builder":os.uname().nodename,
            "source_branch":subprocess.check_output(["git","-C",str(APP),"branch","--show-current"],text=True).strip(),
            "commands":commands, "compiler":subprocess.check_output(["glslc","--version"],text=True),
            "sources":{str(path):digest(path) for path in [wrapper, base, shaders/"storage.glsl", directory/"layout.glsl"]},
            "shader":{"path":target.name,"bytes":target.stat().st_size,"sha256":digest(target)},
            "scope":("Text strips output bitmapSample alpha as grayscale with forced alpha1; other draws unchanged"
                if args.variant=="alpha" else "Text branch separated; original colors, sampled alpha and blending retained")}
    (directory/(name+".json")).write_text(json.dumps(info,indent=2)+"\n")
    if args.install:
        install = ROOT/"prebuilt"
        install.mkdir(exist_ok=True)
        for suffix in [".spv", ".json"]:
            shutil.copy2(directory/(name+suffix), install/(name+suffix))
    print(json.dumps(info["shader"]))


if __name__ == "__main__":
    main()
