# Host UDP video profile

The host crate supports `udp-v1` from `NATIVE-UDP-V1.md`. A Start request selects it with
`options.transport`; `tcp-v1` or an omitted field uses the original TCP profile. Other
values fail validation. UDP startup failure never falls back to TCP.

`StreamOptions::transport` uses `Transport::{TcpV1,UdpV1}`. `Relay::prepare` binds the
TCP feedback listener, optional audio listener and requested UDP endpoint before the
controller sends its descriptor. UDP requires a distinct `udp_token` in `relay::Config`;
`Relay::udp_addr` and `Relay::udp_timing` expose the bound port and negotiated timing.
The controller creates independent random tokens and includes UDP fields in the video
descriptor. Tokens must not be logged or passed in command arguments.

After a descriptor, a startup or stream failure produces the control-v1 `stream_failed`
lifecycle event with the original start ID. The stream remains owned until a subsequent
stop or disconnect confirms cleanup. A stop racing the failure is still accepted; cleanup
failure closes the control connection without reporting a successful stop.

`udp_video` implements packetization, pacing, retained repairs and tail probes;
`udp_endpoint` owns a nonblocking, peer-pinned socket; `udp_control` incrementally parses
ACK and drop records; `udp_feedback` binds that parser to the TCP feedback socket. Relay
owns all of them and applies the lost-keyframe policy to dropped units. Explicit stop drains
feedback and sends repeated end markers within the existing bounded shutdown period.

The Cargo manifest is `src/rust/host/Cargo.toml`; root workspace registration remains
Worker1's responsibility. Local tests exercise the host against the Rust IO receiver
with a fake upstream and standard sockets. Device sockets, real streams, decoder output
and display modes require separate qualification. Timing and loop telemetry are not part
of `input-drop-v1`.
