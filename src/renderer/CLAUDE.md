# src/renderer

The console side: `civ7/` is the only renderer (shaders, `build.js`, `bundle.js`, `layout.js`
and the committed `prebuilt/` the bundle ships). Its README.md has the build, layout, command
buffers and pipeline cache. Tests: `src/renderer/civ7/test/` in moonlight-nx2-dev; the pixel tests render the shaders on the desktop and the renderer test fails when
`prebuilt/` is older than the sources.
