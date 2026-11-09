# Rust NRO build

From the repository root, build a production NRO from the current committed `HEAD` on m4:

```sh
python3 src/rust/build-production.py
```

The command archives `HEAD`, builds the Rust runtime with `--diagnostic production`, packages it
with the pinned Switch 2 SDK and `tools/testship/sdk-interop`, and stores the NRO and receipts in
`/media/storage2/builds/moonlight/<build-id>/`. The NACP version is derived from `git describe`
and compacted to fit its version field. `src/rust/nro/icon.png` is embedded in the NRO.
