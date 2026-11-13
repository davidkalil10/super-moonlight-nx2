# Moonlight for Switch 2: PC bundle

The app no longer uses this helper; it pairs and streams with Sunshine directly. The bundle
stays for the interop tests in `moonlight-nx2-dev`.

The PC side of moonlight-nx2: `moonlight-nx2-host` talks to the console,
`moonlight-nx2-upstream-worker` talks to Sunshine, and `moonlight-nx2-pc` sets both up and
runs them. x86_64 Linux. `manifest.json` lists every file with its SHA-256, the source
revision and the pinned inputs; `THIRD-PARTY.md` and `licenses/` cover what is linked in.

## Install

Unpack the bundle anywhere and keep it there; nothing is copied elsewhere. It needs
Python 3.9 or newer and Sunshine on the same PC.

The worker loads libcurl, OpenSSL 3, expat, libuuid and Opus:

- Fedora: `sudo dnf install libcurl openssl-libs expat libuuid opus`
- Debian, Ubuntu: `sudo apt install libcurl4 libssl3 libexpat1 libuuid1 libopus0`

Where those are missing or too old, the worker runs inside the image it was built in
instead: build that image once with
`podman build -t IMAGE -f Containerfile .` from `src/rust/host/bundle/` of the source in
`source/`, using the image name in `manifest.json`. `setup` picks whichever works.

Then:

    ./moonlight-nx2-pc setup

It checks every file against the manifest, finds this PC's address, decides how the
worker runs, looks at the display and writes `~/.config/moonlight-nx2/pc.json`. Run it
again with other options at any time; earlier choices are kept.

| option | meaning |
|---|---|
| `--address IP` | this PC's LAN address, when the detected one is wrong |
| `--sunshine IP` | the PC Sunshine runs on, when it is not this one |
| `--match-display`, `--no-match-display` | let **Optimise game settings** switch this PC's display (see `DISPLAY.md`); on by default where the display can be driven |
| `--worker native`, `--worker container` | force how the worker runs |
| `--console IP`, `--console-port N` | the console's address and FTP port (5000), only for `start` below |
| `--import-civ7` | take over a Civ7 install's PCs, settings and display options (below) |
| `--install-service` | write the systemd user unit (below) |

## Run

    ./moonlight-nx2-pc serve

keeps running and serves the consoles paired with this PC on TCP port 39381 (open it in
the firewall for the LAN). Start Moonlight on the console and choose this PC.

The first time, the console shows an eight-digit pairing code. Type it here, in another
terminal, within two minutes:

    ./moonlight-nx2-pc pair 12345678

From then on the console connects by itself, also after it slept, lost Wi-Fi or this
service was restarted, and starts the app it was playing again. The code never crosses
the network; the console and this PC each keep a key (`rust-client/pairings` on the SD
card, `~/.config/moonlight-nx2/helper/` here, readable only by you).

    ./moonlight-nx2-pc consoles          # id, last address, when it was paired
    ./moonlight-nx2-pc unpair ID         # forget one console (the start of its id), or `all`

`unpair` also ends that console's open connection. On the console, **Remove PC** forgets
this PC's key. Three wrong codes turn pairing off for ten minutes. One console is served
at a time; a second paired console is refused until the first disconnects.

Video, audio and controller input are not encrypted on the LAN; the control connection
(pairing with Sunshine, the app list, starting and stopping) is.

### One launch at a time, without pairing

    ./moonlight-nx2-pc setup --console CONSOLE_IP
    ./moonlight-nx2-pc start

`start` runs a host for one launch and puts a one-time session file on the console over
hbmenu's FTP server, as earlier versions did. `--replace` overwrites a session the console
never used. A console that already holds this PC's key ignores the session file.
`./moonlight-nx2-pc serve --staged` repeats this launch after launch.

    ./moonlight-nx2-pc status    # last one-launch run, its log, the display
    ./moonlight-nx2-pc stop

Logs of these runs are under `~/.local/state/moonlight-nx2/pc-runs/`.

## Pair with Sunshine

Separate from the pairing above: add the PC in Moonlight, and enter the PIN it shows in
Sunshine's web UI (`https://PC_IP:47990`, PIN page). The keys are kept in
`~/.config/moonlight-nx2/` on this PC, shared with a Civ7 install of moonlight-nx2, so a
PC paired there stays paired. To check from the PC: `./worker list SUNSHINE_IP`.

## Autostart as a user service

    ./moonlight-nx2-pc setup --install-service
    systemctl --user daemon-reload && systemctl --user enable --now moonlight-nx2-pc

The service runs `serve`: it is there after every login and serves the paired consoles.
When it stops, the display is put back if a stream had changed it.
`journalctl --user -u moonlight-nx2-pc` shows what it does.

## Coming from the Civ7 version

    ./moonlight-nx2-pc setup --import-civ7

- `hosts.json` and `settings.json` from `~/.config/moonlight-nx2/` are checked and, at the
  next `start`, copied to `rust-client/` on the console, each only when the console has no
  such file of its own (for settings: none of `settings.json`, `settings-0.json`,
  `settings-1.json`). A file that fails the check is left out and named.
- The `kscreen.py` options in `host-display.json` (output, Wayland socket, custom modes)
  become `display.json`, unless that exists. Other display hooks are not taken over.

Nothing on the PC or the console is overwritten, and the Civ7 files stay as they are.

## Rebuild

From a moonlight-nx2 checkout, with git, podman and network access:

    python3 src/rust/build-pc-bundle.py

builds the committed HEAD into `$MOONLIGHT_BUILDS/<UTC>-<revision>-pc-bundle/`, by default under
`~/moonlight-builds` (`--directory` for another place). The build directory keeps `build.log`,
`BUILD-INFO.json` and `SHA256SUMS` beside `bundle/` and its `.tar.gz`.
