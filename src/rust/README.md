# Rust NRO build

From the repository root, build a production NRO from the current committed `HEAD` on m4:

```sh
python3 src/rust/build-production.py
```

The command archives `HEAD`, builds the Rust runtime with `--diagnostic production`, packages it
with the pinned Switch 2 SDK and `tools/testship/sdk-interop`, and stores the NRO and receipts in
`/media/storage2/builds/moonlight/<build-id>/`. The NACP version is derived from `git describe`
and compacted to fit its version field. `src/rust/nro/icon.png` is embedded in the NRO.

`--sdk-video` builds `--diagnostic production-sdk` instead, against the 2026-11-10 SDK pinned on m4:
video is decoded through the SDK's video decoder. It asks for a 4K layer when docked and offers
H.264 and AV1 up to 1440p there.
Adding `--docked-modes` builds `production-sdk-modes`, which also offers 4K when docked. The
decoder service refuses that size so far.
Adding `--hz120` builds `production-sdk-120`, which presents every refresh, asks the display for
120 Hz and a 1440p layer when docked, and offers 120 fps up to 1440p where the display showed it.
With both flags (`production-sdk-modes-120`) the docked layer stays 4K. Not measured on the console yet.
