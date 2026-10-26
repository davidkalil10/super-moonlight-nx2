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

## Pacing results (2026-10-26, session DjIU1L, 60 Hz panel, m5 quiet)

| Run | Presented fps | Requests/frame | Bridge ms/frame |
| --- | ---: | ---: | ---: |
| Control, 1080p60 | 59.4 | 2.1 | 4.2 |
| `--present-hz 120 --receive-wait` | 28.9 | 9.3 | 23.6 |
| Applied pacing: vsync rule, skip-backlog 1, decode and receive wait | 30.3 | 3.5 | 24.4 |

Requests per frame fell by about two thirds, but bridge ms/frame stayed flat; decoded units never cross the bridge.
Status and gate exchanges became 2.7x slower (2.5 to 7 ms) as they grew sparser; the flat gap probe points to contention while streaming, not idle wake-up, leaving roughly 40 fps at 120 present.
The pacer stayed at 8.33 ms and did not learn the panel's 16.67 ms apply grid in 40 s; that remains open.

## Rules

- The frozen reference is the 1080p60 worker at HBLauncher 4bdeb1a and its records
  (`native-h264/2026-10-25T17-20-16-026Z-4bdeb1a4`): they stay untouched and every change is
  measured against them. Main may change exchange count and pacing for 120 fps. Prove each
  change with the `moonlight-dev` tests, then a live pair before it lands: the 60 fps control
  in the reference shape (fps=59, dropped=0, idr=0), then the 120 run.
- Format, then rename/extract, never both in one commit.
- No live console runs unless the user is at the console (DEVICE-RULES.md).
