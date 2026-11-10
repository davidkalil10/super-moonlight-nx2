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
video is decoded through the SDK's video decoder. It asks for a 4K layer when docked and offers
H.264 and AV1 up to 1440p there.
Adding `--docked-modes` builds `production-sdk-modes`, which also offers 4K when docked. The
decoder service refuses that size so far.
Adding `--hz120` builds `production-sdk-120`, which presents every refresh, asks the display for
120 Hz and a 1440p layer when docked, and offers 120 fps up to 1440p where the display showed it.
With both flags (`production-sdk-modes-120`) the docked layer stays 4K. Not measured on the console yet.
Video goes over UDP; `--sdk-video --tcp-video` builds `production-sdk-tcp`, the same app with video on TCP.

## Stream controls

- Hold Plus+Minus for a second: open the stream menu, unless **Hold + and - for menu** is off.
  Plus and Minus still reach the PC while held. The Civ7 payload uses L+R here; the NRO does
  not, because games hold L+R together (user decision, 2026-11-10).
- L+R+Minus+Plus: stop the stream at once and return to the apps. It always works and never
  opens the menu.
