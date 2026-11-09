# Experimental Rust upstream worker

The `upstream-worker` feature builds `moonlight-nx2-upstream-worker`. It is an
isolated child and supports `list`, `pair`, `unpair`, `quit` and an experimental
`stream` path using inherited media descriptors. The current C helper remains
the selected stream path. The parent must kill and reap the worker on cancellation
or deadline. The Rust stream path has only been exercised with fake upstream
callbacks and is not qualified for production or live streaming.
Exit code 3 indicates a timed-out operation, code 4 a response that exceeds the
control payload bound, and code 5 an explicit unpaired server response. The host
maps code 5 to `not_paired` only for list, start preflight and quit. The legacy
C helper's structured unpaired status remains supported. Other backend failures
do not become pairing errors.

The feature adds no Cargo dependencies. It requires `bindgen` 0.72.1, Clang,
Git and these absolute paths:

- `MOONLIGHT_UPSTREAM_DIR`: checkouts at moonlight-embedded
  `f32e415aea6797d261d6b470dcf8bf18727341c2`, moonlight-common-c
  `b126e481a195fdc7152d211def17190e3434bcce`, and its `enet`
  `dea6fb5414b180908b58c0293c831105b5d124dd`.
- `MOONLIGHT_UPSTREAM_BUILD`: PIC archives `libgamestream.a`,
  `common-c/libmoonlight-common-c.a` and `common-c/enet/libenet.a` built from
  those checkouts for the target architecture.
- `MOONLIGHT_NATIVE_LIB_DIR`: target linker names for libcurl, expat, uuid,
  OpenSSL ssl and crypto, and Opus. Their runtime dependencies must also be
  available.
- `MOONLIGHT_NATIVE_INCLUDE_DIR`: a target Opus development include directory
  containing `opus/opus_multistream.h` and its dependencies. The initial build
  used Opus 1.6 from the existing Fedora helper image.

Generate upstream archives using the existing `src/streamer/protocol`
CMake project and `-DCMAKE_POSITION_INDEPENDENT_CODE=ON`. Build with
`cargo build -p moonlight-nx2-host --bin moonlight-nx2-upstream-worker --features upstream-worker`.
`build.rs` generates bindings from the pinned `client.h`, `http.h`, `xml.h`
and `Limelight.h`; do not use headers or archives from different revisions or
architectures. Default builds do not need these native inputs.

One process runs one operation. Its upstream C state is process-global; the
separate process preserves cancellation even when HTTP blocks. The isolated
video callback owner copies up to 1 MiB per frame into a two-frame queue and
allows at most one submission to copy at a time. The audio owner decodes Opus
into 48 kHz stereo signed little-endian PCM and retains at most ten complete
10 ms records, dropping the oldest under backlog. The experimental stream path
registers these callbacks; no real upstream stream has been tested. Each keeps
state alive for callbacks in progress and refuses a second registration within
the process. Closing an owner does not prove callbacks have finished: callback
tables and state remain owned until startup returns and stop completes.

Upstream can signal a missing audio packet with a null pointer and zero length;
the worker passes that signal to Opus for packet-loss concealment. The worker
combines decoded audio into 1,920-byte records. An incomplete final record is
discarded on shutdown; complete records and their release acknowledgements are
drained within the existing deadlines. This is not a real-audio quality or
device-playback qualification.

Video setup accepts only the requested 8-bit format, width, height and frame
rate. Submissions before successful setup are refused. The callback joins
each complete access unit only when its positive declared length, every
fragment and the aggregate length agree within the 1 MiB limit. Malformed or
oversized units return the upstream `DR_NEED_IDR` signal; queue pressure does
the same. A setup failure stops the worker through the existing owned-stream
failure and cleanup path. Fake callback tests do not establish decoder support.

The selected formats match the legacy helper: H.264 High `0x0001`, HEVC Main
`0x0100`, or AV1 Main 8-bit `0x1000`. Only the selected format is offered to
upstream. Both helpers advertise four video slices without direct submission.
The native control contract and Rust worker require even dimensions at most
3840x2160 and 1..120 fps; the legacy helper CLI permits a wider range. Pinned
upstream rounds odd heights down, but the native contract rejects them before
launch. Upstream may choose H.264 if an offered HEVC or AV1 stream is unavailable;
both helpers reject a selected-format mismatch at setup. Unlike the legacy
helper, Rust also refuses a setup dimension or frame-rate mismatch. The worker
passes the server's codec capability mask to upstream; a nonzero mask alone does
not prove the selected stream is available. App launch can precede negotiation,
so a later setup failure does not prove that no upstream launch occurred.

The direct-input adapter accepts the controller, touch and IDR lines produced
by the host relay and calls the pinned upstream input API. Its integration has
only been tested against a fake upstream. Once stop is requested, queued input
and controller arrival are not sent while native connection teardown runs.

The experimental connection engine retains owned server strings, callback
tables and callback owners while the lifecycle coordinator starts and stops the
upstream connection. Its listener queue reports overflow so callers can fail
closed. The CLI and media relay integration has only been tested with a fake
upstream connection; no real host stream has been launched. While connected,
the worker emits the legacy helper's periodic `rtt` status when upstream reports
an estimate. Native control-v1 does not currently forward this status.
