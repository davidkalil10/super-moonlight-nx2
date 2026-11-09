# Existing helper telemetry inventory

This inventories existing local helper stderr status, not a native control protocol.
The selected legacy helper and optional Rust direct worker both produce newline-delimited
JSON on stderr. The host status parser recognizes JSON values, but the relay currently
acts on video/connected/terminated and does not forward RTT or quality over control or
media feedback. `input-drop-v1` has no timing or loop telemetry blocks.

| Status | Exact JSON shape | Source and meaning |
| --- | --- | --- |
| RTT | `{"event":"rtt","ms":24,"varianceMs":7}` | The two values are unsigned 32-bit integer milliseconds, obtained from `LiGetEstimatedRttInfo`. They are the ENet control connection's smoothed RTT and smoothed absolute-deviation estimate. Despite its name, `varianceMs` is not a variance in squared milliseconds. |
| Quality | `{"event":"connection-status","status":"poor"}` or `{"event":"connection-status","status":"okay"}` | `connectionStatusUpdate`: upstream `CONN_STATUS_POOR` (1) maps to `poor`; all other callback values currently map to `okay` in both helpers. These are status transitions, not periodic samples, numeric loss measurements or explicit recovery acknowledgements. |

These measure or describe the PC helper's upstream connection to the streaming PC,
not the console-to-helper UDP/TCP connection or receive-to-present time. An absent RTT
is unknown, not zero. Upstream documents the RTT API as unavailable without a connected
ENet peer (including old hosts with non-ENet control); it must only be called between
`LiStartConnection` and `LiStopConnection`. The pinned upstream reads ENet counters
without a lock and notes that occasional torn observations are possible. It does not
promise an exact end-to-end measurement or delivery for every polling interval.

Legacy C starts its reporting clock when the active stream loop begins, checks it after
an input poll of up to 100 ms and advances the deadline by one second per report. Reports
can be delayed or catch up after a stall. RTT is omitted unless the connection-started
callback has fired and upstream returns true. The loop ends on interrupt, termination or
input closure before calling `LiStopConnection`; asynchronous quality callbacks are not
individually gated by the loop's stopping flag.

The direct Rust worker initializes its RTT deadline to one second after entering the
stream loop, then advances it to one second after each eligible attempt. It emits RTT
only after connection announcement and while no stop is requested and native stop has
not completed; a connection that takes more than a second may yield its first sample
immediately after announcement. It emits no RTT on a failed capability query. Quality
callbacks are queued in a bounded 32-event listener channel; overflow fails the stream.
The worker currently processes status callbacks even while stopping, so late quality
lines are possible and cannot prove current stream ownership. Legacy quality callback
lines can likewise race teardown. Any future negotiated forwarding must bind statuses to
the owned start/session and suppress or discard stale/late events according to the agreed
lifecycle; an event does not confirm cleanup or authorize replay.

Pinned moonlight-common-c initially assumes okay and suppresses warnings for the first
3 seconds after first frame. It evaluates frame-loss windows of 3 seconds when frames
arrive: poor at >=30% for one interval or >=15% for two consecutive intervals; okay
when <=5% after poor. It emits callbacks only on transitions. Lack of a callback is not
proof of good quality. Unknown callback integers are currently collapsed to `okay` by
the helpers, so a future strict wire contract must specify handling deliberately.

Sources: `src/streamer/protocol/src/{main,session}.c`, host
`src/upstream_worker/{stream_worker,listener_callbacks}.rs`, `src/{status,relay}.rs`,
pinned moonlight-common-c `b126e481a195fdc7152d211def17190e3434bcce`
`src/{Limelight.h,ControlStream.c}` and enet `dea6fb5414b180908b58c0293c831105b5d124dd`
`include/enet/enet.h` and `protocol.c`. Direct worker streaming/status evidence is fake
upstream only; the only real paired-host direct-worker baseline is read-only app listing.
No new native control fields, ACK blocks or device qualification are implied.
