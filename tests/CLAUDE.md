# moonlight-dev

Tests, probes, simulators and research for `hbl-moonlight` (Phase 1 of the rewrite,
`hbl-notes/team/REWRITE.md`). Nothing here ships to users.

## Sibling checkouts

Everything runs against the runtime code by relative path:

```
<dir>/moonlight-dev
<dir>/hbl-moonlight      the code under test
<dir>/hbl-platform       bridge, sdk/host, sdk/native
<dir>/hbl-platform-dev   sdk/tests/recording-rpc.cjs
<dir>/hbl-dev            probe-job, audio-out-mock
```

## Test

```
node --test $(git ls-files '*.test.cjs')     # 314 tests, same names as HBLauncher 4bdeb1a
node apps/moonlight/check.cjs                # desktop Vulkan check, needs a GPU
```

`tools/moonlight/request-budget.cjs` is the offline cost model; run it before any
device run. Probes in `sdk/tools` touch the console: the user runs them, one at a
time, per DEVICE-RULES.md.

## Rules

- A test change that alters what the runtime sends needs its reason in the commit.
- Format, then rename/extract, never both in one commit.
