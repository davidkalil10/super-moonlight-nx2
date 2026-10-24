# Console protocol 3: large request data

Protocol 2 made the RPC *response* length variable (request byte 80, u16).
Protocol 3 makes the request *data* length variable too, so one exchange can
carry up to 0x3f000 (252 KiB) instead of 0x8000 (32 KiB). The goal is the
forthcoming on-device hardware video decoder: it will write large decoded frames
into the app ring, and fewer exchanges per frame means fewer console-loop round
trips, the known throughput ceiling.

## Wire format

The first 0x80 bytes stay the request header: two 40-byte call records at 0 and
40, the u16 response length at byte 80. Protocol 3 adds a **u32 request data
length at byte 88** (the next free, 8-aligned slot after the response length;
records end at 80, data starts at 0x80). The bootstrap reads it with the
existing `U#`, which consumes 4 chars = bytes 88..95, so the host must leave
92..95 zero — `Buffer.alloc` does.

A protocol-3 request is `header(0x80) + data(D)`, D from byte 88. The console
recvs the header first (learning D and the response length N), then D data bytes
into the request data region, then runs the two calls and sends N+16 bytes,
exactly as before. The response path is unchanged (`connection.cjs` already
reads variable responses).

The protocol is negotiated in the hello: the bootstrap now announces `3`,
`connection.cjs` accepts {1,2,3} and exposes `addresses.protocol`. The console
loop is protocol-3 only once re-typed; the **host** keeps one code path and
degrades to the fixed 0x8080 request (data ≤ 0x8000, no data-length field) for
protocol 1/2 consoles, byte-for-byte as before.

### The cap

The recv lands the header at `scratch+0x40000` and data at `scratch+0x40080`;
scratch is 0x80000, so the request region is the 0x40000 bytes from 0x40000
upward. Minus the 0x80 header the hard ceiling is **0x3ff80**. We cap at
**0x3f000** (252 KiB): a 4 KiB multiple (page-aligned chunk destinations stay
page-aligned) that leaves 0xf80 of slack below the end of scratch
(`0x40080 + 0x3f000 = 0x7f080`, 0x80 into the last page). The bootstrap rejects
`D > 0x3f000` the same defensive way it clamps N, which is the only thing
stopping a bad host from writing past scratch.

## Throughput math — and the honest caveat

The console loop, not the link, is the ceiling: ~412 exchanges/s on the wired
link that gave the best DESIGN.md §1 session.

| Per-exchange write | If the loop is per-exchange-overhead-bound | If it is byte-copy-bound |
| ------------------ | ------------------------------------------ | ------------------------ |
| 32 KiB (proto 2)   | 412 × 32 KiB ≈ **13.5 MB/s**               | baseline                 |
| 252 KiB (proto 3)  | 412 × 252 KiB ≈ **106 MB/s** (~8×)         | ≈ same as 32 KiB         |

**We do not yet know which regime the console is in.** If each exchange pays a
fixed per-round-trip cost (recv + two SVCs + send, dominated by the SmileBASIC
interpreter and scheduling), fewer-but-larger exchanges is a large win. If the
loop is bound by the `memmove` byte copy inside the console, a 252 KiB request
copies 8× the bytes and the net gain is small. Protocol 3 is cheap and correct
either way; the first on-device step is to **measure write MB/s at 32 KiB vs
252 KiB and decide** before building the decoder around it.

Two honest asterisks on the table:

- The 106 MB/s row assumes the link sustains it. The measured wired session ran
  at ~2.52 MB/s at 32 KiB, so 8× is ~20 MB/s there; if a given link is faster
  the ceiling may move from the loop back to the wire before 106 MB/s, and the
  decode output rate is what actually matters, not the peak.
- Protocol 3 adds one recv + a `U#` + a compare to *every* exchange, even small
  ones (reads, input, audio appends). If small exchanges dominate a given
  workload, also capture a protocol-2 baseline so the per-exchange overhead is
  not mistaken for a win or a loss.

## Re-type package (apply on-device via the Flipper)

`bootstrap.bas` is re-typed on the console, so the diff is deliberately tiny.

1. HELLO protocol word (in `START`), first `P$(2)` → `P$(3)` (leave the second
   `P$(2)`, the platform, alone):

   - old: `HELLO$=P$(&H31545344)+P$(2)+P$(2)+P$(S#)+P$(&H80000)+...`
   - new: `HELLO$=P$(&H31545344)+P$(3)+P$(2)+P$(S#)+P$(&H80000)+...`

2. `RPC()` variable list, add `L` (length — kept clear of the SDK-base global
   `D#`, which is one keystroke away in a hand-typed file):

   - old: `VAR R#,V$,FIRST$,LAST$,N`
   - new: `VAR R#,V$,FIRST$,LAST$,N,L`

3. The header recv (shrink 0x8080 → 0x80):

   - old: `R#=CALL#(&H140B90,FD,S#+&H40000,&H8080,&H40)`
   - old: `IF R#!=&H8080 THEN BREAK`
   - new: `R#=CALL#(&H140B90,FD,S#+&H40000,&H80,&H40)`
   - new: `IF R#!=&H80 THEN BREAK`

4. Three new lines, right after the `N=ASC(...)` line and before
   `R#=RAW#(LEFT$(V$,20))`:

   - `L=U#(COPY(NSR[1],&H2002C,4)):IF L>&H3F000 THEN BREAK`
   - `R#=L:IF L THEN R#=CALL#(&H140B90,FD,S#+&H40080,L,&H40)`
   - `IF R#!=L THEN BREAK`

   (`&H2002C` is the char index of byte 88 in the recv buffer: `0x20000 +
   88/2`. The stop-sentinel check on the line above stays before the data recv,
   so a zero request still exits cleanly. The `stmt:IF…` form matches the
   existing loop lines; it avoids a nested single-line `IF…THEN…:IF…` whose
   parse could not be checked offline.)

Nothing else changes. The old protocol is not meant to be re-typed for the A/B
comparison — the per-exchange size is a host knob (`HB_WRITE_CHUNK`, below) on
the same protocol-3 console, so the measurement is one code path.

**On-device step 0:** before trusting the numbers, confirm Horizon's
`recv(…, 0x40 WAITALL)` returns the full count in one call for a 252 KiB data
recv. If the socket service short-counts, `IF R#!=L THEN BREAK` ends the session
on the first large write; the first measurement run reveals this immediately.

### Host constants (`smilebasic/engine/lib/native.cjs`)

- `DATA_LENGTH_OFFSET = 88` — new, u32 request data length.
- `MAX_DATA_BYTES = 0x3f000` — new cap.
- `exchange()` now allows data up to `MAX_DATA_BYTES` on protocol 3, writes the
  data length into the header, and frames the request as `header + data` (the
  fixed 0x8080 packet for protocol 1/2 is unchanged).
- The variable-response gate changed from `protocol !== 2` to `protocol < 2`, so
  protocol 3 keeps short responses.
- `write()` chunks by `chunkBytes()` — 0x8000 on protocol 1/2, `MAX_DATA_BYTES`
  on protocol 3 (or `HB_WRITE_CHUNK` when set).
- `connection.cjs` `parseHello` accepts protocol `3`.

## Measurement command (run on-device, do not run offline)

Reuse the DESIGN.md §1 method: the launcher's startup write of ~14.7 MB right
after `vkMapMemory2` is a clean throughput probe — the gap in
`runs/<session>/launcher-auto-operations.jsonl` between that `vkMapMemory2` and
the next `vkCreateBuffer` is the write time. `start.sh` and `start-launcher.cjs`
inherit the environment into `smilebasic/host.cjs` (which owns the
`NativeClient`), so `HB_WRITE_CHUNK` reaches the write path:

```sh
# Session A — 32 KiB per exchange (the protocol-2-sized chunk)
HB_WRITE_CHUNK=32768 ./start.sh

# Session B — 252 KiB per exchange (protocol-3 default; unset is the same)
HB_WRITE_CHUNK=258048 ./start.sh
```

For each session, take the `vkMapMemory2 → vkCreateBuffer` gap from its
`launcher-auto-operations.jsonl` and divide 14,681,088 bytes by it (as in
DESIGN.md §1, where the good session was 5,817 ms ≈ 2.52 MB/s at 32 KiB). If B
is markedly faster the loop is overhead-bound and the decoder should batch into
large writes; if A and B are close it is copy-bound and large requests buy
little. Capture a plain protocol-2 session too if small exchanges dominate the
real workload.
