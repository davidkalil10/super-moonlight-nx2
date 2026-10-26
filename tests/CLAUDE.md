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
<dir>/hbl-platform-dev   probe-job, audio-out-mock
```

## Test

```
npm test                                     # 337 tests
npm run typecheck                            # tsc --checkJs (npm install once)
node apps/moonlight/check.cjs                # desktop Vulkan check, needs a GPU
```

`tsconfig.json` lists the hbl-moonlight modules that went through the readability rewrite; add each
component as it lands. TypeScript is a dev dependency only, hbl-moonlight itself has no build step.

`tools/moonlight/request-budget.cjs` is the offline cost model; run it before any
device run. Console probes live in sibling `hbl-dev/sdk/tools` and
`hbl-platform-dev/sdk/tools`: the user runs them, one at a time, per
DEVICE-RULES.md.

## Rules

- A test change that alters what the runtime sends needs its reason in the commit.
- Format, then rename/extract, never both in one commit.
