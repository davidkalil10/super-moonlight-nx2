# moonlight-nx2 1.0.1

Changes since 1.0.0. Needs kaiHEN release `20261114c` or later.

## Streaming
- Fixes 4K streams stopping for a moment after a big scene change, when the PC sent a frame larger than the decoder took. Frames up to 4 MiB now decode; a larger one is skipped and the PC sends a fresh keyframe.

## Builds
- Release builds no longer contain paths from the build machine.
- Releases are built by CI against the public ounce devkit.

## Logs
- When the decoder stops on a bad call, the log says which check failed and which frame it was on.
- The stream video line counts skipped oversized frames as `decoder_oversize`.
