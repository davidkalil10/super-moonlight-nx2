# moonlight-nx2 1.1.0-test3

Test build for 1.1.0. Changes since 1.0.1. Needs kaiHEN release `20261114c` or later.

## Streaming
- Cuts about 33 ms of latency docked at 60 Hz and about 17 ms handheld at 120 Hz when the decoder got stuck three frames behind after a burst. The queue now drains back to one frame in flight, skipping at most one frame at a time and at most once every 30 frames, so a long backlog no longer stutters.
- 120 fps is offered docked again on TVs that do 1440p120 or 1080p120, even when the console's output is 4K60. On a 4K60 output Auto stays at 2160p60 and the Frame rate row reads "120 below 4K"; picking 120 streams 1440p120 and switches the TV to 120 Hz.
- The decoder is first opened at 120 fps (60 at 4K) and falls back to the stream's rate if the console refuses.
- Keyframes up to 4 MiB now decode above 1080p, not only at 4K. 1440p H.264 is decoded in the same tier as 4K, and big scene cuts there were dropped.
- When the PC keeps sending keyframes too big for the console, the app asks for new ones less often and shows a note to lower the bitrate, instead of asking every half second.
- 1440p120 H.264 stays offered; with the queue drained it should keep up better. If the frame counter stays well under 120, use 60.
- A stream whose PC sent no video now says so and points at the PC's firewall, instead of saying the console could not play it.

## Touch
- Touches now carry pressure, contact size and rotation, so two-finger scrolling and pinching work on hosts that read them, such as Sunshine on Linux.
- Opening the stream menu or leaving the app cancels the fingers on the PC, so no touch stays stuck down.
- Virtual gamepad: on-screen controls in handheld mode, sent as an extra Xbox controller. Turn it on in Settings > Controls or the stream menu.

## Settings
- Power: Auto, Battery saver or Performance, in Settings > Picture and the stream menu. Performance keeps the console's full clocks while streaming; Auto uses it docked and Battery saver handheld.
- The stream menu's rows are full size again and the list scrolls, with Disconnect and Quit at the bottom. Drag to scroll, tap to pick.
- Manual bitrate goes past 40 Mbps: 50, 60, 80, 100, 120 and 150 Mbps. The Bitrate row notes when the network test measured less than the chosen rate.

## Docs
- NETWORK.md: the VA-API `vaapi_strict_rc_buffer` setting for AMD on Linux, and what 4K and 120 fps cost in latency.

## Logs
- `video: drained queue frames=N wait_ms=…` when the decode queue drains.
- `sdk-decoder: fps hint requested=N accepted=M` when the decoder opens.
- `clocks: profile=performance|saver` when a stream starts or the profile changes.
- `display: modes supported=[…]` with each display context.
- `input: virtual pad on|off player=N`, and `virtual_pad=` on the input line.

# moonlight-nx2 1.0.1

Changes since 1.0.0. Needs kaiHEN release `20261114c` or later.

## Streaming
- Fixes 4K streams stopping for a moment after a big scene change, when the PC sent a frame larger than the decoder took. At 4K, frames up to 4 MiB now decode; a larger one is skipped and the PC sends a fresh keyframe.

## Builds
- Release builds no longer contain paths from the build machine.
- Releases are built by CI against the public ounce devkit.

## Logs
- When the decoder stops on a bad call, the log says which check failed and which frame it was on.
- The stream video line counts skipped oversized frames as `decoder_oversize`.
