# Native host control

This additional path connects the NRO to the PC helper. Civ7 keeps its existing
launcher, RPC and media paths. Host-control operations and native main-loop
integration are still pending.

`control-wire.js` defines version 1 of the control framing. Each frame has this
16-byte little-endian header, followed by its payload:

| Offset | Type | Value |
| --- | --- | --- |
| 0 | u32 | `0x31434e4d` (`MNC1`) |
| 4 | u16 | Version 1 |
| 6 | u16 | Kind |
| 8 | u32 | Request ID |
| 12 | u32 | Payload length, 1–65,536 bytes |

Kinds: authentication 1, accepted 2, request 3, event 4, stream descriptor 5,
error 6. Authentication uses request ID 0 and exactly 64 ASCII bytes: the
session's random lowercase hexadecimal token. The PC verifies it before
accepting operations. Other payloads will be UTF-8 JSON; their operation
schemas and session state checks are not implemented yet. Tokens must not
appear in logs or saved settings.

The incremental parser retains one frame over fixed memory. `feed` returns
the consumed byte count and stops at that frame, leaving any next frame with
the caller. `peek` borrows the payload until `consume`, which wipes it.
Callers must consume or close; a ready frame cannot be overwritten. EOF
preserves a complete frame; partial EOF and invalid headers are permanent
failures. Creating a new connection, replaying a command or reconnecting
requires an explicit caller decision.

Tests are in `moonlight-nx2-dev/src/streamer/native/test/control-wire.test.cjs`.
They cover the shared byte layout, all split points, coalesced input, one-byte
fragments through the maximum payload, partial EOF, permanent failures and
exact-token authentication.
