# moonlight-nx2 1.1.0

Changes since 1.0.1. Needs kaiHEN release `20261114c` or later.

## Streaming
- Lower latency after a burst: when the decoder fell a few frames behind, the queue stayed full and cost about 33 ms docked at 60 Hz and 17 ms handheld at 120 Hz. It now drains back to one frame in flight, skipping at most one frame at a time and at most once every 30 frames, so catching up doesn't stutter.
- 120 fps docked on TVs that do 1440p120 or 1080p120, even when the console outputs 4K60. There Auto stays at 2160p60 and the Frame rate row reads "120 below 4K"; picking 120 streams 1440p120 and switches the TV to 120 Hz.
- 1440p H.264 is offered at 120 fps. If the frame counter stays well under 120, use 60.
- Keyframes up to 4 MiB decode above 1080p, not only at 4K, so big scene cuts at 1440p no longer drop.
- When the PC keeps sending keyframes too big for the console, the app asks for new ones less often and shows a note to lower the bitrate, instead of asking every half second.
- A stream whose PC sent no video now says so and points at the PC's firewall, instead of saying the console could not play it.

## Touch
- Touches carry pressure, contact size and rotation, so two-finger scrolling and pinching work on hosts that read them, such as Sunshine on Linux.
- Opening the stream menu or leaving the app cancels the fingers on the PC, so no touch stays stuck down.
- Virtual gamepad: on-screen sticks, D-pad, face and shoulder buttons in handheld mode, sent as an extra Xbox controller. Turn it on in Settings > Controls or the stream menu, with its opacity. The face buttons wear the Xbox colours, the sticks are analog (the knob follows the finger inside its ring and springs back on lift), and a held control lights up clearly. A finger that lands on a control stays with it; every other touch still reaches the PC.

## Settings
- Power: Auto, Battery saver or Performance, in Settings > Picture and the stream menu. Performance keeps the console's full clocks while streaming; Auto uses it docked and Battery saver handheld. Battery saver keeps full clocks docked at 120 fps, and goes straight back to them if a stream falls behind.
- Manual bitrate goes past 40 Mbps: 50, 60, 80, 100, 120 and 150 Mbps. The Bitrate row notes when the network test measured less than the chosen rate.
- The stream menu's rows are full size again and the list scrolls, with Disconnect and Quit at the bottom. Drag to scroll, tap to pick.

## Docs
- NETWORK.md: the VA-API `vaapi_strict_rc_buffer` setting for AMD on Linux, and what 4K and 120 fps cost in latency.

## Logs
- `video: drained queue frames=N wait_ms=…` when the decode queue drains.
- `clocks: profile=performance|saver` when a stream starts or the profile changes, and `reason=keep-stock` or `reason=behind` when the clocks are set.
- `display: modes supported=[…]` with each display context.
- `input: virtual pad on|off player=N`, `virtual_pad=` on the input line, and `pad: redraws=N updates=N us=N` each second the gamepad changed.

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
