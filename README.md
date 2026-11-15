# moonlight-nx2

Stream PC games from Sunshine to Nintendo Switch 2, with controller, touch and stereo audio.

The app is a homebrew NRO written in Rust (`src/rust`). It talks to Sunshine itself over
the Moonlight protocol and decodes AV1 or H.264 with the console's video decoder. Nothing
else runs on the PC.

## Build

The NRO is built on an arm64 builder reachable over ssh, from the committed `HEAD`, against
the pinned Switch 2 SDK and Rust toolchain:

```sh
MOONLIGHT_BUILDER_HOST=my-arm64-box python3 src/rust/build-production.py
```

- `MOONLIGHT_BUILDER_HOST`: the builder's ssh host, `arm64-builder` by default.
- `MOONLIGHT_REMOTE_BUILDS`: the build root on the builder, `~/moonlight-builds` by default.
  It holds the Rust foundation and the SDK the script expects.
- `MOONLIGHT_BUILDS`: the local build root, `~/moonlight-builds` by default.

The NRO and its receipts land in `$MOONLIGHT_BUILDS/<build-id>/`.
`--release 1.0.0` names a release build with that version, which hbmenu shows; a suffix
such as `1.0.0-test1` marks a test build.
`--decode120` and `--tcp-video` are test builds.

### Public devkit

The same NRO also builds on x86_64 against the public
[ounce-devkit](https://github.com/ouncebrew/ounce-devkit), in devkitPro's image:

```sh
mkdir -p ~/moonlight-builds
docker run --rm -v "$PWD:/src" -v ~/moonlight-builds:/builds -e MOONLIGHT_BUILDS=/builds \
  -w /src docker.io/devkitpro/devkita64:20260219 sh -c '
    git config --global --add safe.directory /src
    git config --global url."https://github.com/".insteadOf ssh://git@github.com/
    python3 -B src/rust/build-devkit.py'
```

The script installs the pinned devkit, checked against its SHA-256, and the pinned Rust
nightly, then builds the Rust archive and the NRO into a new directory under
`MOONLIGHT_BUILDS`. `--devkit 20261114` picks a version and `--devkit latest` the newest
release. The `url` line lets Cargo fetch its git dependencies without a GitHub ssh key.

## CI

`.gitlab-ci.yml` builds the NRO against the pinned devkit, checks `cargo fmt` and
`cargo clippy` (host and device) and runs the workspace tests on every push to `main` and
every merge request. Scheduled pipelines build against the latest devkit release, so a
release that breaks the app fails a pipeline. With `DEVKIT_NEWER_ONLY=1` a schedule builds
only when that release is not the pinned one. The NRO, its map and the build logs are kept
as job artifacts.

A `v1.2.3` tag builds the release against the pinned devkit with
`build-devkit.py --release 1.2.3`, which packs `moonlight-nx2-1.2.3.zip` with the NRO,
`CHANGELOG.md` and `FEATURES.md` and writes its `.sha256`. Once the checks pass, the release
job creates the GitLab release with `CHANGELOG.md` as its notes and the zip in the package
registry. Before tagging, `CHANGELOG.md` must start with `# moonlight-nx2 1.2.3`.

The same source and devkit give the same NRO and zip wherever they are built, so a tag build
can be checked locally with the `docker run` above and `--release`.
`build-production.py --release` against the pinned SDK stays the fallback.

## Run

The app needs [kaiHEN](https://github.com/ouncebrew/kaihen), release `20261114c` or later.

Copy `moonlight-nx2.nro` to `switch/` on the SD card and start it from the homebrew
menu. **Find PCs** looks for Sunshine on the local network, and **Add a PC** takes an
address.

Pick the PC. The console shows a 4-digit PIN: open Sunshine's web UI on the PC, go to its
PIN page and enter it. The apps appear once Sunshine accepts it.

Each PC gets its own console identity, so several PCs pair side by side. **Forget this PC**
drops that PC's key and covers on the console. Its old entry stays in Sunshine's Clients list
and can be removed there. Pairing again needs a new PIN and makes a fresh identity, so it
never collides with the old entry.

## Sunshine

For router, PC and Sunshine settings that keep the stream smooth, see [NETWORK.md](NETWORK.md).

- **Codec**: AV1 needs a GPU that encodes it. If Sunshine cannot, pick H.264 in Settings.
- **Touch**: enable **Native Pen/Touch Support** under Input
  ([`native_pen_touch`](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html#native_pen_touch)).
  On Linux Sunshine also needs access to uinput, for touch and for the controllers.
- **Controllers**: leave the gamepad type on automatic to get motion (see below).

## Stream controls

- **Hold Plus+Minus for a second**: open the stream menu, unless **Hold + and - for menu**
  is off. Plus and Minus still reach the PC while held. Any player can open it.
- **L+R+Minus+Plus**: stop the stream at once and return to the apps. It always works.

The stream menu has **Disconnect**, which leaves the game running on the PC, **Quit app on
PC**, and **Show keyboard**, which types on the PC.

## Controllers

Up to four controllers play, in the Switch's player order with handheld as player 1, and
each keeps its player until it disconnects. Pads reach Sunshine with their motion sensors,
so by default it emulates a DualShock 4 (Windows) or DualSense (Linux) and games get gyro;
setting a gamepad type in Sunshine overrides that. PC rumble drives the pad's motors.

## Options

Open **Settings** before launching a game. An app can keep its own picture options.

| Option | Choices |
| --- | --- |
| Resolution | Automatic, 720p, 1080p; 1440p and 4K when docked |
| Frame rate | 120 fps (default) while the display runs at 120 Hz, as the handheld screen does, or 60 fps |
| Bitrate | Auto from the network test, or 5–40 Mbps in 2.5 Mbps steps, then 50, 60, 80, 100, 120 and 150 Mbps |
| Codec | AV1, with H.264 as the fallback |
| Play audio on the PC | On / Off |
| Optimise game settings | The PC display follows the stream's size and rate |
| Quit host app on return | Disconnect also quits the app on the PC |
| Hold + and - for menu | On / Off |
| Stream info badge | A small badge with the stream mode over the video |
| Frame counter | Adds the frame rate and delays to the badge |
| Touch as mouse | Touches move the PC mouse instead of sending touch |
| Theme | System, light or dark |
| Rumble | On / Off |
| Rumble strength | Strength of the controller vibration |
| Button layout | Xbox (by position) or Nintendo (by label) |

4K streams at 60 fps and needs AV1.

## Touch

Touch works in handheld mode, with the Sunshine settings above. If the PC takes no touch,
the stream says so once on the badge.

## Logs

Each launch writes `switch/moonlight-nx2/rust/runtime-<tick>.log` on the SD card. The third
line names the commit it was built from. Send the whole file with a bug report.

## Development

The shaders are in `src/rust/runtime/shaders`, compiled into `src/rust/runtime/prebuilt`.
After changing one, with glslc and spirv-val installed:

```sh
python3 src/rust/build-shaders.py --directory ~/moonlight-builds/<build-id> --install
```

The directory is a new one under `MOONLIGHT_BUILDS`.

`--check` compares the prebuilt files with the sources without compiling.

The fonts and the glyph atlas made from them are in `src/rust/ui/fonts`. With Pillow
installed, `python3 src/rust/ui/fonts/glyphs.py atlas` rewrites `glyphs.bin`.

`src/rust/host` and `build-pc-bundle.py` are the former PC helper. The app no longer uses
them; they stay only for the interop tests in `moonlight-nx2-dev`.

Tests, lab tools and design notes live in the separate `moonlight-nx2-dev` repository. It
also keeps the C sources its parity tests compare the Rust UI and wire code with, and the
Civilization VII payload, Node service and C helper this app replaced.

## Credits

- [Moonlight](https://moonlight-stream.org/) — [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) and [moonlight-embedded](https://github.com/moonlight-stream/moonlight-embedded).
- [Sunshine](https://github.com/LizardByte/Sunshine) — game streaming host.
- [ENet](https://github.com/cgutman/enet) — networking.
- [M PLUS Rounded 1c](https://github.com/coz-m/MPLUS_FONTS) — font.

## Special thanks

To [ave](https://gitlab.com/a), who made this possible.

Thanks to kurumuz for [kaiHEN](https://github.com/ouncebrew/kaihen) and the
[ounce SDK](https://github.com/ouncebrew/ounce-devkit), which make this app possible.

## Licence

See [LICENSE](LICENSE) and the [font licence](src/rust/ui/fonts/OFL.txt).

## Support

If you enjoy moonlight-nx2, you can support my work on [Ko-fi](https://ko-fi.com/azkali).
