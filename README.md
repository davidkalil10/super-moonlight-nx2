# moonlight-nx2

Stream PC games from Sunshine to Nintendo Switch 2, with controller, touch and stereo audio.

The console side is a homebrew NRO written in Rust (`src/rust`). It decodes AV1 or H.264
with the console's video decoder and talks to a small helper on the PC, which sits beside
Sunshine and speaks the Moonlight protocol for it.

## Build

The NRO is built on the arm64 builder `m4`, from the committed `HEAD`, against the pinned
Switch 2 SDK and Rust toolchain:

```sh
python3 src/rust/build-production.py
```

The NRO and its receipts land in `/media/storage2/builds/moonlight/<build-id>/`.
`--hz120` builds the variant that presents at 120 Hz and offers 120 fps, `--hz120 --decode120`
the one that measures the decoder at 120 fps on a 60 Hz display, and `--tcp-video` keeps video
on TCP instead of UDP. Those three are test builds.

The PC bundle is built on x86_64 Linux with Git and Podman:

```sh
python3 src/rust/build-pc-bundle.py
```

It compiles the helper and the Sunshine worker in a pinned image and packs them with the
launcher, the licences and a manifest into `moonlight-nx2-pc-<revision>-x86_64.tar.gz`.

## Run

On the PC, with Sunshine installed, unpack the bundle and run:

```sh
./moonlight-nx2-pc setup
./moonlight-nx2-pc serve
```

Copy `moonlight-nx2-rust.nro` to `switch/` on the SD card and start it from the homebrew
menu. Choose the PC. The first time the console shows an eight-digit code; type it on the PC:

```sh
./moonlight-nx2-pc pair 12345678
```

Then pair with Sunshine once, with the PIN the console shows, and pick a game. The bundle's
[README](src/rust/host/bundle/README.md) covers the service, the firewall port and display
matching.

## Stream controls

- **Hold Plus+Minus for a second**: open the stream menu, unless **Hold + and - for menu**
  is off. Plus and Minus still reach the PC while held.
- **L+R+Minus+Plus**: stop the stream at once and return to the apps. It always works.

## Options

Open **Settings** before launching a game. An app can keep its own picture options.

| Option | Choices |
| --- | --- |
| Resolution | Automatic, 720p, 1080p; 1440p and 4K when docked |
| Frame rate | 60 fps; 120 fps in the 120 Hz test build |
| Bitrate | Auto from the network test, or 5–40 Mbps |
| Codec | AV1, with H.264 as the fallback |
| Optimise game settings | The PC display follows the stream's size and rate |
| Play audio on the PC | On / Off |
| Hold + and - for menu | On / Off |
| Touch as mouse | Touches move the PC mouse instead of sending touch |
| Low latency | Applies after restarting the app |
| Quit host app on return | On / Off |
| Show stats on screen | Off, Compact (the stream mode) or Full (with frame rate and delays) |
| Theme | System, light or dark |
| Rumble | Strength of the controller vibration |

4K streams at 60 fps and needs AV1.

## Touch

Touch works in handheld mode. It needs **Native Pen/Touch Support** enabled under Input in
Sunshine ([`native_pen_touch`](https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2configuration.html#native_pen_touch)),
and on Linux Sunshine needs access to uinput. If the PC takes no touch, the stream says so
once on the badge.

## Development

The shaders are in `src/rust/runtime/shaders`, compiled into `src/rust/runtime/prebuilt`.
After changing one, with glslc and spirv-val installed:

```sh
python3 src/rust/build-shaders.py --directory /media/storage2/builds/moonlight/<build-id> --install
```

`--check` compares the prebuilt files with the sources without compiling.

The fonts and the glyph atlas made from them are in `src/rust/ui/fonts`. With Pillow
installed, `python3 src/rust/ui/fonts/glyphs.py atlas` rewrites `glyphs.bin`.

`src/rust/host/upstream` pins the Moonlight sources the Sunshine worker is built from:
`fetch.sh` checks them out and `CMakeLists.txt` builds their library.

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

## Licence

See [LICENSE](LICENSE) and the [font licence](src/rust/ui/fonts/OFL.txt).
