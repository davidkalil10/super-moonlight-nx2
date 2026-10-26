# hbl-moonlight

The Moonlight streaming app and its host side, split out of HBLauncher (Phase 1 of
the rewrite, `hbl-notes/team/REWRITE.md`). Runtime code only: tests, probes and
research live in `moonlight-dev`.

## Layout

Phase 1 keeps the original HBLauncher paths, so history and file names line up:

- `apps/moonlight/`: the console app (shaders, assets, `build.js`).
- `tools/moonlight/`: the PC host (`live.js`, `native-h264.js`, staggered workers,
  ring/HBV formats) and `helper/` (`hbmoonlight`, C, GPLv3 upstreams).
- `sdk/native/*-functions.json`: the native symbols only Moonlight uses.

## Sibling checkouts

Code outside this repo is required by relative path from sibling checkouts:

```
<dir>/hbl-moonlight
<dir>/hbl-platform     bridge, sdk/host, sdk/native, sdk/build.js
```

The paths become package imports with the ESM switch in Phase 2.

## Rules

- Behaviour is frozen: the bridge traffic must stay byte-identical. Prove it with the
  `moonlight-dev` tests and request-sequence recordings before every change.
- Format, then rename/extract, never both in one commit.
- No live console runs unless the user is at the console (DEVICE-RULES.md).
