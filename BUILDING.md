# Build a bundle

These instructions build a Linux host bundle. You need Node.js 22.12+, npm, Git and
rootless Podman. The image supplies the C toolchain. GitLab and GitHub SSH access must work.
The committed shaders are included; you do not need shader tools for a normal build.

You also need the `nx2-modules` inspector. Reuse `bin/nx2-modules` from a working bundle.
Building it from source requires a libnx2 development checkout with the `nx2-modules`
CMake target; the current public libnx2 release does not include that tool.

## Get the source

```sh
git clone git@gitlab.com:Azkali/moonlight-nx2.git
cd moonlight-nx2
npm ci
```

Create a fresh output directory. Keep using this shell for the following commands:

```sh
build="/media/storage2/builds/moonlight/$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)-bundle"
mkdir -p "$build"
```

## Build the helper

The helper is compiled in the same container image that will run it:

```sh
src/streamer/protocol/fetch.sh "$build/upstream"

podman build -t localhost/hbmoonlight-build:latest \
  -f src/streamer/protocol/Containerfile src/streamer/protocol

podman run --rm --userns=keep-id --security-opt label=disable \
  -v "$PWD:/src:ro" -v "$build:/work" \
  localhost/hbmoonlight-build:latest bash -e -c '
    cmake -S /src/src/streamer/protocol -B /work/helper \
      -DUPSTREAM_DIR=/work/upstream -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
    cmake --build /work/helper --parallel
  '

```

## Create the bundle

Replace `HOST_IP` with the LAN IP of the computer that will run the bundle. The Switch
must be able to reach it. Sunshine can run on that computer or another PC.
Replace `/path/to/nx2-modules` with the inspector from your working bundle.

```sh
node src/streamer/payload/build.js \
  --directory "$build/bundle" \
  --host HOST_IP \
  --helper "$build/helper/hbmoonlight" \
  --inspector /path/to/nx2-modules \
  --image localhost/hbmoonlight-build:latest
```

The result is `$build/bundle`. Its manifest records the source revision, builder, command
and file hashes. Run it with:

```sh
node "$build/bundle/launch.mjs" SWITCH_IP
```

Replace `SWITCH_IP` with the Switch's IP address. The runtime needs Node.js and the Podman
image above. If you move the bundle to another computer, build the same image there.
The helper binary must match that computer's architecture.

If you already have a compatible `hbmoonlight` and `nx2-modules`, skip compiling them and
pass their absolute paths to `--helper` and `--inspector`. Omit `--image` only when the
helper's shared libraries are installed on the runtime computer. Always pass `--helper`;
the current default points to a development-machine build.

## Host resolution matching

Enable **Optimise game settings** in Moonlight and configure display automation in Sunshine.
The requested resolution and frame rate are sent on every launch and reconnect.

Custom setups can use `$XDG_CONFIG_HOME/moonlight-nx2/host-display.json`
(`~/.config/moonlight-nx2/host-display.json` when unset):

```json
{
  "version": 1,
  "hosts": {
    "192.0.2.1": {
      "command": ["/absolute/path/to/display-adapter"],
      "options": {}
    }
  }
}
```

Use your Sunshine host's address as the key. The adapter receives JSON on stdin:
`{"action":"apply","session":"UUID","host":"...","width":1920,"height":1080,"fps":120,"options":{}}`.
It must apply and verify the mode, and save the original once per session. A final `restore`
request carries the same session, host and options. Commands run without a shell and time
out after five seconds. Host configuration and pairing keys are not included in bundles.

The optional KDE Wayland adapter is at
`bundle/runtime/src/streamer/payload/host-display/kscreen.py`. Configure its command as
`["python3", "/absolute/path/to/kscreen.py"]` and options as
`{"output":"YOUR_OUTPUT","waylandDisplay":"YOUR_SOCKET","allowCustomModes":true}`.
It needs Python 3 and `kscreen-doctor`. Other hosts use their own automation or adapter.

## Development

Tests and component docs live in the separate `moonlight-nx2-dev` checkout. They are not
required to build or run a bundle. With that checkout beside this one:

```sh
npm --prefix ../moonlight-nx2-dev ci
npm test
npm run typecheck
npm run typecheck:strict
```

[Implementation notes](docs/INTERNALS.md) describe the helper protocol and renderer memory.
