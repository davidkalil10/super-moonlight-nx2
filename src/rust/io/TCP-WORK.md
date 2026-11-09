# TCP operation budgets

Control and media channels add:

```rust
pub fn pump_bounded(&mut self, now_ms: u64, limits: work::Limits)
    -> work::Report<Error>;
```

Each channel keeps its existing error type. `work::Report<E>` contains `result: Result<(), E>`
and `work: Work`; work remains available on fatal and early returns. The existing
`pump(now_ms) -> Result<(), Error>` uses unlimited operation permits and preserves its
configured byte caps, errors and protocol behavior. No caller is assigned production
quotas or a cadence by this change.

`Limits { reads: usize, writes: usize }` caps actual TCP socket calls within one pump.
Default limits are zero; `Limits::UNLIMITED` uses `usize::MAX` for both classes. Permits
reset only when the caller starts another pump. Zero permits dispatch no operation of
that class. Existing byte caps can stop work earlier than the operation limits.

`Work` contains:

| Field | Meaning |
|---|---|
| `connect_polls` | Actual connect polls, separate from read/write limits. |
| `reads`, `writes` | Actual socket attempts, including retries, EOF and fatal errors. |
| `read_bytes`, `written_bytes` | Successful reported bytes within the supplied slice bounds. Invalid adapter counts are not credited. |
| `read_quota_stops`, `write_quota_stops` | Local requests denied before dispatch because permits were exhausted. |
| `read_would_block`, `write_would_block` | Actual socket `WouldBlock` results. |
| `read_interrupted`, `write_interrupted` | Actual socket `Interrupted` results. |

A retry consumes one permit and stops that phase without spinning. Local denial yields
through the existing retry path but is counted separately from physical socket results.
Reaching a numeric limit is not itself denial: a final write that empties the queue or
a read that completes a record does not falsely report quota exhaustion. Buffered parsing
may make progress with zero new read calls.

Auth/token positions, partial headers/input ACKs, request IDs, clean receive EOF and the
live feedback half, existing deadline checks and sticky fatal behavior remain unchanged.
Explicit close remains outside pump quotas. Connect polls can occur with zero read/write
permits; this is not a zero-total-work claim. Counts bound dispatched calls, not the
duration of one socket call or full app/runtime work. No clock precision or wall-time
guarantee is provided, and no UDP datagram budget or app/Session API is added.

The sibling dev IO suite's `tests/tcp_work.rs` exercises the actual production channels
and outbound queue, comparing reports with independent fake-socket counters and bytes.
It covers zero/exact limits, partial auth/ACKs, buffered replies, byte caps, true retries,
fatal partial work, malformed adapter counts, truncated EOF, deadlines, legacy equivalence
and once-only explicit close. The tests use synthetic time and do not qualify a native
scheduling policy or device throughput.
