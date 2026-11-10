# Rust NRO build

From the repository root, build a production NRO from the current committed `HEAD` on m4:

```sh
python3 src/rust/build-production.py
```

The command archives `HEAD`, builds the Rust runtime with `--diagnostic production`, packages it
with the pinned Switch 2 SDK and `tools/testship/sdk-interop`, and stores the NRO and receipts in
`/media/storage2/builds/moonlight/<build-id>/`. The NACP version is derived from `git describe`
and compacted to fit its version field. `src/rust/nro/icon.jpg` is embedded in the NRO; hbmenu
reads a 256x256 baseline JPEG there and shows its default icon for anything else.

`--sdk-video` builds `--diagnostic production-sdk` instead, against the 2026-11-10 SDK pinned on m4:
video is decoded through the SDK's video decoder. Docked, it asks for a 4K layer and offers
1440p on AV1 and H.264 and 2160p on AV1; handheld stops at 1080p. The decoder service takes a
2160p session only when it is configured at 30, so that is what it is told whatever the
stream's rate.
Adding `--hz120` builds `production-sdk-120`, which presents every refresh, asks the display for
120 Hz and a 1440p layer when docked, and offers 120 fps up to 1440p where the display showed it.
Not measured on the console yet.
Adding `--decode120` to `--hz120` builds `production-sdk-120-decode`, which offers 120 fps on a
60 Hz display too: two units a refresh, the newer frame shown. It measures the decoder at 120
units a second (`stream: video` and `stream: stages` lines) and is not for playing.
Video goes over UDP; `--sdk-video --tcp-video` builds `production-sdk-tcp`, the same app with video on TCP.

## Stream controls

- Hold Plus+Minus for a second: open the stream menu, unless **Hold + and - for menu** is off.
  Plus and Minus still reach the PC while held. The Civ7 payload uses L+R here; the NRO does
  not, because games hold L+R together (user decision, 2026-11-10).
- L+R+Minus+Plus: stop the stream at once and return to the apps. It always works and never
  opens the menu.
