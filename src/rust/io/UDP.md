# UDP receiver API

Implements `NATIVE-UDP-V1.md` with eight caller-owned access-unit slots and a separate
TCP feedback connection. It preserves original helper headers and Civ7 wire bytes.

`Receiver::open(config, memory, feedback, datagram, now_us)` takes both sockets.
Invalid configuration returns `(Error, feedback, datagram)` without socket operations;
the caller closes both. Successful construction requires subsequent `pump` calls.
`Config` tokens are independent 64-byte lowercase hexadecimal values. Tokens are wiped
from receiver configuration, sent feedback storage, and the retained hello after receipt.

`Memory.units` needs at least `8 * config.max_payload` bytes. `max_payload` is 1..1048576.
`Memory.feedback` needs 3860..8192 bytes. The receiver allocates no heap memory.
`deadline_us`, `spread_us`, `connect_timeout_us`, and `pump(now_us)` use microseconds;
`hello_ms` uses milliseconds and `pace_bytes_per_ms` bytes per millisecond.
The negotiated deadline is the base; keyframes double it, and the receiver adds the
larger of negotiated spread and payload pacing time. `datagram_budget` is 1..256 per pump.

`Datagram` is a connected, nonblocking message socket pinned to the configured control
peer's IPv4 endpoint. Sends accept one complete message or return an error; callers
never retry a byte tail. Receives preserve message boundaries. A zero-byte receive is
counted and ignored. The receiver supplies 1401 bytes so an oversized message is rejected.
An adapter must consume/truncate one whole message, never split it into stream reads.
Its optional `now_us()` only measures drain work; absence leaves that counter zero.

`pump(now_us)` connects both sockets, flushes the 64-byte TCP token, sends/retries UDP
hello, consumes bounded datagrams, accounts expired units, and sends repair/statistics.
Connection and TCP token transmission share `connect_timeout_us`. The hello timeout
starts when both sockets and the TCP token are ready, including any blocked hello send.
A clock rollback returns `Clock` without receiving or sending; the caller must stop or
provide a valid monotonic time. Transport failures and timeout failures are sticky.

`peek()` borrows only the complete next transport frame. Its payload and helper header
remain unchanged until `acknowledge(input)` or `drop_ready(reason)` succeeds. The decoder
must accept/copy the payload before acknowledgement. A successful acknowledgement queues
the original 16-byte header, input length and bytes before releasing its slot. `Again`
retains the slot and requires pumping feedback before retry. Input is bounded to 3840 bytes.
Explicit drops use `wire::DropReason::{Late, Skipped}`; skipped keyframes are refused.
Late incomplete units produce a late drop, followed by skipped dependencies until a keyframe.

`receive_ended()` means every transport frame through the explicit end marker has been
acknowledged or dropped. It does not mean queued TCP feedback was sent. Continue pumping
after `Error::Ended`; these pumps flush pending feedback without receiving/replaying units.
`drained()` requires receive end, empty feedback, and no fatal error. The app retains its
own decoder-pending and PCM release-ACK conditions and a bounded shutdown deadline.
A missing end marker is not clean EOF; expiry of the app deadline means Aborted.

`close(self) -> (Result<(), CloseError>, Stats)` attempts both socket closes once and
reports their independent errors. `Stats.feedback_bytes` reports discarded pending bytes.
Explicitly close before releasing receiver storage; ordinary receiver drop only wipes its
retained hello and feedback memory. The runtime socket adapters close on drop, and retire
the process if a close leaves descriptor state uncertain. No reconnect or protocol fallback.

Runtime `PeerConnector` implements `app::media::UdpConnector` with `Datagram = UdpSocket`;
`connect_datagram(port)` and the TCP connector always use the same configured IPv4 peer.
The SDK C adapter opens `AF_INET/SOCK_DGRAM/IPPROTO_UDP`, sets nonblocking mode, and uses
connected send/receive. Host FFI tests qualify Rust routing/lifetime behavior; native
compile/link and a bounded network-only DUT check are separate gates. UDP transport does
not establish decoder, display mode, real-game, latency or audio-quality support.
