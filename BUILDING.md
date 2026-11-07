# Build options

The copy-paste build steps are in the [README](README.md#build).
`npm run bundle` builds the helper and inspector, then packages the payload and shaders.
No previous bundle or separate libnx2 checkout is required.

| Option | Default | Purpose |
| --- | --- | --- |
| `--host HOST_IP` | Required | LAN address of the computer running the bundle |
| `--directory PATH` | `dist/<timestamp>-<revision>` | New build directory; contains the finished `bundle/` |
| `--port NUMBER` | `39380` | Payload connection port on that computer |
| `--transport udp` or `tcp` | `udp` | Initial video transport; the console setting can override it |

```sh
npm run bundle -- --host HOST_IP --directory /path/to/new-build
```

The build directory keeps `build.log`, `BUILD-INFO.json`, intermediate builds and the final
bundle. The bundle manifest records source revision and file hashes. Keep the Podman image
`localhost/hbmoonlight-build:latest` available when running it. Moving the bundle to another
computer requires that image and a matching CPU architecture.

The inspector is built from the ISC-licensed libnx2 module-inspection subset under
`src/inspector/libnx2/`; `SOURCE.json` records the source file hashes. Shaders are already
compiled in the repository. If changing them, install `glslc` and `spirv-val`, then run
`node src/renderer/civ7/build.js --directory NEW_BUILD_DIR --install` before building a bundle.

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
