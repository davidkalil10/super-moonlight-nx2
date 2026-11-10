# Matching the PC display to the stream

Sunshine streams what the PC display shows: with the desktop at 1080p a 4K or 120 Hz
request still gets 1080p content. Started with `--match-display`, the host switches the
display to the stream's size and rate for streams that have **Optimise game settings**
on, at scale 1, and puts the previous mode and scale back afterwards. Without the flag
the display is never touched.

    moonlight-nx2-host LISTEN WORKER --match-display

The mode in use before the first change is written to
`$XDG_STATE_HOME/moonlight-nx2/display-saved.json` (`~/.local/state` when unset) before
anything changes and removed once it is restored. It is restored five seconds after a
stream stops (a relaunch inside that time switches straight to its own mode), when the
console disconnects, on SIGINT or SIGTERM, and at the next start with `--match-display`
when the host was killed in between.

When the display cannot follow, the stream starts anyway and the console shows why:

| reason | meaning |
|---|---|
| `unsupported` | no display control the host can drive (`kscreen-doctor` missing or no desktop session) |
| `remote_pc` | the stream's PC is not the computer the host runs on |
| `config` | `display.json` cannot be read |
| `no_output` | the output is missing, or there are several and none is primary |
| `no_mode` | the output lists no mode of that size within 0.5 Hz of the rate |
| `failed` | the change was refused, timed out or did not take within two seconds |

## Backends

`display::Backend` is the seam: `current`, `plan` (read only) and `commit`. The one
backend is KDE Plasma through `kscreen-doctor` (Wayland and X11). It finds the desktop's
Wayland socket in `$XDG_RUNTIME_DIR` when the host runs outside the session, as a user
service does.

## display.json

Optional, in `$XDG_CONFIG_HOME/moonlight-nx2/`. Everything but `version` can be left out.

```json
{"version": 1, "output": "DP-2", "wayland_display": "wayland-1", "custom_modes": false, "dry_run": false}
```

- `output`: the output Sunshine captures. Default: the only enabled one, else the primary.
- `wayland_display`: the socket name, when there are several.
- `custom_modes`: add a reduced-blanking mode with `addCustomMode` when none is listed.
- `dry_run`: log every change as `display: dry run, ...` and change nothing.

The Civ7 service's `host-display.json` is a different file and is not read.

## By hand

    moonlight-nx2-host display status
    moonlight-nx2-host display plan 2560x1440@120
    moonlight-nx2-host display apply 2560x1440@120
    moonlight-nx2-host display restore

`status` and `plan` only read. `apply` leaves the mode in place and the saved one on disk
until `restore`.
