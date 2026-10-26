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

- The frozen reference is the 1080p60 worker at HBLauncher 4bdeb1a and its records
  (`native-h264/2026-10-25T17-20-16-026Z-4bdeb1a4`): they stay untouched and every change is
  measured against them. Main may change exchange count and pacing for 120 fps. Prove each
  change with the `moonlight-dev` tests, then a live pair before it lands: the 60 fps control
  in the reference shape (fps=59, dropped=0, idr=0), then the 120 run.
- Format, then rename/extract, never both in one commit.
- No live console runs unless the user is at the console (DEVICE-RULES.md).
