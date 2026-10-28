# src/renderer

The console side: `moonlight/` is the HB package, built by its `build.js` from the HBV codecs
(`hbv.js`, `hbv2.js`) and `glslang-shim.sh` here. The package folder must be named after its id
(hbl-platform readPackage). Test: `node --test src/renderer/test/package.test.cjs` from the repo
root; it pins the committed shader and image hashes.
