# moonlight-nx2

Stream PC games from Sunshine to Nintendo Switch 2, with controller, touch and stereo audio.
Runs through the CivSwitch loader in Civilization VII.

## Build

On Linux, install Node.js 22.12+, Git, CMake, a C compiler, Make and Podman.
GitHub and GitLab SSH access is needed to fetch the source.

```sh
git clone git@gitlab.com:Azkali/moonlight-nx2.git
cd moonlight-nx2
npm ci
npm run bundle -- --host HOST_IP
```

Replace `HOST_IP` with this computer's LAN IP. The build creates a complete bundle under
`dist/` and prints its path and launch command. [Build options](BUILDING.md).

## Run

You need Sunshine on your gaming PC, Node.js 22.12+ on the computer running the bundle,
and the CivSwitch loader open on your Switch. Container bundles also need Podman.

From the generated bundle directory, run:

```sh
node launch.mjs SWITCH_IP
```

Replace `SWITCH_IP` with your Switch's IP address. Choose your PC in Moonlight, pair it
using the PIN in Sunshine, then select a game.

- **Hold L+R**: open the stream menu.
- **L+R+Minus+Plus**: stop streaming.

## Options

Open **Settings** in Moonlight before launching a game.

| Option | Choices |
| --- | --- |
| Resolution | 720p, 1080p; 1440p and 4K when docked with AV1 |
| Frame rate | 60 or 120 fps; 4K is limited to 60 fps |
| Bitrate | Auto, or 5–40 Mbps |
| Codec | AV1 or H.264 |
| Transport | UDP or TCP |
| Play audio on the PC | On / Off |
| Optimise game settings | Request host resolution matching; requires host display automation |
| Quit host app on return | On / Off |
| Button layout | Button positions or button labels |
| Stream info badge | On / Off |

Selecting 4K remembers your previous frame rate and restores it at smaller resolutions.
After choosing 1440p or 4K, fully close and reopen the console app once.
Undocking from 4K switches the menu and stream to 1080p120; docking restores 4K60.

## Credits

- [Moonlight](https://moonlight-stream.org/) — [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) and [moonlight-embedded](https://github.com/moonlight-stream/moonlight-embedded).
- [Sunshine](https://github.com/LizardByte/Sunshine) — game streaming host.
- [ENet](https://github.com/cgutman/enet) — networking.
- [libnx2](https://gitlab.com/Azkali/libnx2) — Switch 2 tooling.
- [Sora](https://github.com/sora-xor/sora-font) — font.

See [LICENSE](LICENSE) and the [font licence](src/streamer/ui/fonts/OFL.txt).
