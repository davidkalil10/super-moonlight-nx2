#!/usr/bin/env python3
"""Builds the PC bundle: host, upstream worker, launcher, licences and a manifest.

Everything is compiled from the committed HEAD inside the image from
host/bundle/Containerfile, against the upstream revisions fetch.sh pins and the crates
Cargo.lock pins. Compilation runs without network access.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

APP = Path(__file__).resolve().parents[2]
BUILDS = Path("/media/storage2/builds/moonlight")
BUNDLE_SOURCE = "src/rust/host/bundle"
SOURCE_PATHS = ["LICENSE", "src/rust", "src/streamer/protocol"]
BINARIES = ["moonlight-nx2-host", "moonlight-nx2-upstream-worker"]
LAUNCHER_FILES = ["moonlight-nx2-pc", "moonlight-nx2-pc.service", "README.md"]
# The workspace pins a public crate by its SSH URL; the image has no key to fetch it with.
PUBLIC_GIT = {
    "CARGO_NET_GIT_FETCH_WITH_CLI": "true",
    "GIT_CONFIG_COUNT": "1",
    "GIT_CONFIG_KEY_0": "url.https://github.com/.insteadOf",
    "GIT_CONFIG_VALUE_0": "ssh://git@github.com/",
}
UPSTREAMS = ["moonlight-embedded", "moonlight-common-c", "moonlight-common-c/enet"]
UPSTREAM_LICENCES = {
    "moonlight-embedded": "LICENSE",
    "moonlight-common-c": "LICENSE.txt",
    "moonlight-common-c/enet": "LICENSE",
}
UPSTREAM_TERMS = {
    "moonlight-embedded": "GPL-3.0-or-later",
    "moonlight-common-c": "GPL-3.0-or-later",
    "moonlight-common-c/enet": "MIT",
}


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def output(command, **kwargs):
    return subprocess.check_output(command, text=True, **kwargs).strip()


class Build:
    def __init__(self, directory):
        self.directory = directory
        self.log = (directory / "build.log").open("a")
        self.commands = []

    def run(self, label, command, **kwargs):
        print(label, flush=True)
        self.commands.append([str(word) for word in command])
        self.log.write(f"\n== {label}\n$ {' '.join(map(str, command))}\n")
        self.log.flush()
        result = subprocess.run(command, stdout=self.log, stderr=subprocess.STDOUT, **kwargs)
        if result.returncode != 0:
            raise SystemExit(f"{label} failed; see {self.directory / 'build.log'}")

    def container(self, label, image, source, command, network=False, environment=None):
        arguments = ["podman", "run", "--rm", "--userns=keep-id", "--security-opt", "label=disable",
                     "-v", f"{source}:/src:ro", "-v", f"{self.directory}:/work", "-w", "/src/src/rust"]
        if not network:
            arguments += ["--network", "none"]
        for name, value in (environment or {}).items():
            arguments += ["-e", f"{name}={value}"]
        self.run(label, [*arguments, image, *command])


def table(path):
    return [line.split("\t") for line in path.read_text().splitlines() if line]


def linked_crates(build, image, source, environment):
    """The crates that end up in the binaries, with their Cargo.lock checksums."""
    listing = build.directory / "crates.txt"
    build.container("Listing linked crates", image, source,
                    ["sh", "-c", "cargo tree --locked --offline -p moonlight-nx2-host --edges normal "
                     "--prefix none --format '{p}' > /work/crates.txt"], environment=environment)
    lock = (source / "src/rust/Cargo.lock").read_text()
    crates = []
    for line in sorted(set(listing.read_text().splitlines())):
        match = re.fullmatch(r"(\S+) v(\S+)( \(.*\))?", line)
        if not match or match.group(3):
            continue
        name, version = match.group(1), match.group(2)
        checksum = re.search(
            rf'name = "{re.escape(name)}"\nversion = "{re.escape(version)}"\n'
            r'source = "[^"]+"\nchecksum = "([0-9a-f]{64})"', lock)
        if not checksum:
            raise SystemExit(f"{name} {version} is not pinned in Cargo.lock")
        crates.append({"name": name, "version": version, "checksum": checksum.group(1)})
    return crates


def copy_crate_licences(build, crates, target):
    registry = build.directory / "cargo-home/registry/src"
    for crate in crates:
        found = list(registry.glob(f"*/{crate['name']}-{crate['version']}"))
        if len(found) != 1:
            raise SystemExit(f"no unpacked source for {crate['name']} {crate['version']}")
        texts = [path for path in found[0].iterdir()
                 if path.is_file() and re.match(r"(LICEN[CS]E|COPYING|NOTICE)", path.name, re.I)]
        if not texts:
            raise SystemExit(f"{crate['name']} ships no licence text")
        directory = target / f"{crate['name']}-{crate['version']}"
        directory.mkdir(parents=True)
        for text in texts:
            shutil.copy(text, directory / text.name)
        manifest = (found[0] / "Cargo.toml").read_text()
        crate["license"] = re.search(r'^license = "([^"]+)"', manifest, re.M).group(1)


def reed_solomon_notice(source):
    """rs.c carries its BSD terms in its first comment."""
    text = source.read_text(errors="replace")
    return text[:text.index("*/") + 2] + "\n"


def third_party(revision, upstreams, crates, libraries):
    lines = [
        "# Third-party software", "",
        f"moonlight-nx2 {revision[:7]} is distributed under the GNU General Public License,",
        "version 3 (`LICENSE`). Its source is in `source/`; the upstream sources below are public",
        "at the listed revisions. Licence texts are under `licenses/`.", "",
        "## Compiled into moonlight-nx2-upstream-worker", "",
        "| component | revision | licence | text |", "|---|---|---|---|"]
    for upstream in upstreams:
        name = upstream["name"]
        url = re.sub(r"^git@github\.com:(.*)\.git$", r"https://github.com/\1", upstream["url"])
        lines.append(f"| {name} ({url}) | `{upstream['commit']}` | {UPSTREAM_TERMS[name]} | "
                     f"`licenses/{name.replace('/', '-')}/` |")
    lines += ["| Reed-Solomon coder inside moonlight-common-c | same | BSD-2-Clause | "
              "`licenses/moonlight-common-c/reedsolomon-NOTICE.txt` |", "",
              "## Rust crates the programs are built from", "",
              "| crate | version | licence | text |", "|---|---|---|---|"]
    for crate in crates:
        lines.append(f"| {crate['name']} | {crate['version']} | {crate['license']} | "
                     f"`licenses/crates/{crate['name']}-{crate['version']}/` |")
    lines += ["", "## Shared libraries loaded at run time", "",
              "Not part of the bundle: they come from the system, or from the build image in",
              "container mode. Versions are the ones the bundle was built and checked against.", "",
              "| library | Fedora package | version | licence | text |", "|---|---|---|---|---|"]
    for library, package, version, terms in libraries:
        lines.append(f"| {library} | {package} | {version} | {terms} | `licenses/system/{package}/` |")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path,
                        help=f"new build directory (default {BUILDS}/<UTC>-<revision>-pc-bundle)")
    args = parser.parse_args()
    if platform.machine() != "x86_64" or sys.platform != "linux":
        raise SystemExit("The PC bundle is built on x86_64 Linux")
    for program in ("git", "podman", "tar"):
        if not shutil.which(program):
            raise SystemExit(f"Install {program} before building")

    revision = output(["git", "-C", str(APP), "rev-parse", "HEAD"])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = (args.directory or BUILDS / f"{stamp}-{revision[:7]}-pc-bundle").resolve()
    directory.mkdir(parents=True)
    build = Build(directory)

    source = directory / "source"
    source.mkdir()
    archive = directory / f"moonlight-nx2-{revision[:7]}-source.tar.gz"
    build.run("Archiving HEAD", ["git", "-C", str(APP), "archive", "--format=tar.gz",
                                 f"--prefix=moonlight-nx2-{revision[:7]}/", "-o", str(archive),
                                 revision, *SOURCE_PATHS])
    build.run("Unpacking the source", ["tar", "-xzf", str(archive), "-C", str(source),
                                       "--strip-components=1"])
    build.run("Testing the launcher", [sys.executable, "-B", "-m", "unittest", "test_launcher"],
              cwd=source / BUNDLE_SOURCE)
    build.run("Fetching the pinned upstream sources",
              ["bash", str(source / "src/streamer/protocol/fetch.sh"), str(directory / "upstream")])
    upstreams = [{"name": name,
                  "url": output(["git", "-C", str(directory / "upstream" / name), "remote", "get-url", "origin"]),
                  "commit": output(["git", "-C", str(directory / "upstream" / name), "rev-parse", "HEAD"])}
                 for name in UPSTREAMS]

    containerfile = source / BUNDLE_SOURCE / "Containerfile"
    image = f"localhost/moonlight-nx2-pc:{digest(containerfile)[:12]}"
    build.run("Building the image", ["podman", "build", "-t", image, "-f", str(containerfile),
                                     str(containerfile.parent)])
    image_id = output(["podman", "image", "inspect", "--format", "{{.Id}}", image])

    environment = {
        "CARGO_HOME": "/work/cargo-home", "CARGO_TARGET_DIR": "/work/target",
        "MOONLIGHT_UPSTREAM_DIR": "/work/upstream", "MOONLIGHT_UPSTREAM_BUILD": "/work/upstream-build",
        "MOONLIGHT_NATIVE_LIB_DIR": "/usr/lib64", "MOONLIGHT_NATIVE_INCLUDE_DIR": "/usr/include",
    }
    build.container("Fetching the pinned crates", image, source, ["cargo", "fetch", "--locked"],
                    network=True, environment={**environment, **PUBLIC_GIT})
    build.container("Configuring the upstream libraries", image, source,
                    ["cmake", "-S", "/src/src/streamer/protocol", "-B", "/work/upstream-build",
                     "-DUPSTREAM_DIR=/work/upstream", "-DCMAKE_BUILD_TYPE=Release",
                     "-DBUILD_TESTING=OFF", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON"])
    build.container("Compiling the upstream libraries", image, source,
                    ["cmake", "--build", "/work/upstream-build", "--target", "gamestream", "--parallel"])
    build.container("Compiling the host and the worker", image, source,
                    ["cargo", "build", "--release", "--locked", "--offline", "-p", "moonlight-nx2-host",
                     "--features", "upstream-worker", "--bins"], environment=environment)
    build.container("Collecting library notices", image, source,
                    ["sh", f"/src/{BUNDLE_SOURCE}/collect-notices.sh", "/work/notices",
                     *[f"/work/target/release/{name}" for name in BINARIES]])
    crates = linked_crates(build, image, source, environment)

    print("Packing the bundle", flush=True)
    bundle = directory / "bundle"
    (bundle / "bin").mkdir(parents=True)
    for name in BINARIES:
        shutil.copy(directory / "target/release" / name, bundle / "bin" / name)
        (bundle / "bin" / name).chmod(0o755)
    for name in LAUNCHER_FILES:
        shutil.copy(source / BUNDLE_SOURCE / name, bundle / name)
    shutil.copytree(source / BUNDLE_SOURCE / "launcher", bundle / "launcher")
    wrapper = (source / BUNDLE_SOURCE / "worker").read_text().replace("@IMAGE@", image)
    (bundle / "worker").write_text(wrapper)
    (bundle / "worker").chmod(0o755)
    shutil.copy(source / "src/rust/host/DISPLAY.md", bundle / "DISPLAY.md")
    shutil.copy(source / "LICENSE", bundle / "LICENSE")
    (bundle / "source").mkdir()
    shutil.copy(archive, bundle / "source" / archive.name)

    licences = bundle / "licenses"
    for name, text in UPSTREAM_LICENCES.items():
        target = licences / name.replace("/", "-")
        target.mkdir(parents=True)
        shutil.copy(directory / "upstream" / name / text, target / text)
    (licences / "moonlight-common-c/reedsolomon-NOTICE.txt").write_text(
        reed_solomon_notice(directory / "upstream/moonlight-common-c/reedsolomon/rs.c"))
    copy_crate_licences(build, crates, licences / "crates")
    shutil.copytree(directory / "notices/licenses", licences / "system")
    libraries = table(directory / "notices/libraries.tsv")
    (bundle / "THIRD-PARTY.md").write_text(third_party(revision, upstreams, crates, libraries))

    files = [{"path": str(path.relative_to(bundle)), "bytes": path.stat().st_size, "sha256": digest(path)}
             for path in sorted(bundle.rglob("*")) if path.is_file()]
    manifest = {
        "project": "moonlight-nx2 PC bundle",
        "sourceRevision": revision,
        "created": stamp,
        "builder": platform.node(),
        "targetArchitecture": "x86_64 Linux",
        "image": {"name": image, "id": image_id, "containerfile": f"{BUNDLE_SOURCE}/Containerfile",
                  "containerfileSha256": digest(containerfile)},
        "pins": {
            "upstream": upstreams,
            "crates": [{key: crate[key] for key in ("name", "version", "checksum")} for crate in crates],
            "toolchain": dict(table(directory / "notices/toolchain.tsv")),
            "libraries": [dict(zip(("library", "package", "version", "licence"), row)) for row in libraries],
        },
        "files": files,
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    build.run("Checking the packed bundle", [sys.executable, "-B", str(bundle / "moonlight-nx2-pc"), "--help"])
    package = directory / f"moonlight-nx2-pc-{revision[:7]}-x86_64.tar.gz"
    build.run("Writing the archive", ["tar", "--sort=name", "--owner=0", "--group=0", "--numeric-owner",
                                      f"--mtime=@{output(['git', '-C', str(APP), 'log', '-1', '--format=%ct', revision])}",
                                      "-czf", str(package), "-C", str(directory),
                                      "--transform", f"s,^bundle,moonlight-nx2-pc-{revision[:7]},", "bundle"])
    sums = "".join(f"{digest(path)}  {path.relative_to(directory)}\n" for path in
                   [package, bundle / "manifest.json", *[bundle / "bin" / name for name in BINARIES]])
    (directory / "SHA256SUMS").write_text(sums)
    (directory / "BUILD-INFO.json").write_text(json.dumps({
        "sourceRevision": revision, "branch": output(["git", "-C", str(APP), "branch", "--show-current"]),
        "builder": platform.node(), "targetArchitecture": "x86_64 Linux",
        "command": [sys.executable, *sys.argv], "commands": build.commands,
        "image": manifest["image"], "pins": manifest["pins"],
    }, indent=2) + "\n")
    print(sums, end="")
    print(f"Bundle: {bundle}")
    print(f"Next: {bundle / 'moonlight-nx2-pc'} setup")


if __name__ == "__main__":
    os.umask(0o022)
    main()
