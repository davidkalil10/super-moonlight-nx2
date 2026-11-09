# Native image backing prototype

An isolated B1 NRO links `native_image_probe.c` with
`--wrap=moonlightSdkBackingQuery`. It reuses the exact Rust archive and source
from the passing SDK backing diagnostic141228; no production mode is enabled.

Inside the retained64KiB Vulkan-allocation callback it queries the existing
backing, locks its owner, reserves one type3 image-memory ID, registers the
original range/CPU/size/relative offset, releases the ID and unlocks. Successful
release must precede returning to the renderer, which unmaps/frees the allocation
and draws the reversed bars. The wrapper runs once per process.

The SDK archive and aliases stay unchanged. There is no second GPU/VM/client,
native image, decoder, submission or fence. Type3 is from the pinned native
scanout caller; decoder acceptance and pixels remain unproven. A failed native
call or malformed zero ID retains the allocation through the existing retired
report path, without cleanup retry. The lock is released after returned calls;
it is never held while rendering. The application must prevent concurrent
allocation/free/teardown for this callback and use its initialized SDK thread.

The inherited diagnostic's initial metadata-only line describes the baseline.
The subsequent `b1: native-image extension active` line identifies this added
consumer transaction. A valid result requires `b1: PASS`, all three native
results0, baseline metadata comparison,240frames and confirmed renderer close.
Neither a compile nor this backing transaction is a native decode result.

Host regression source lives in the dev repo at
`src/rust/io/tests/native_image_probe_test.c`; compile it with this directory and
`src/rust/nro` on the include path. Scenarios0–6 cover success, query refusal,
lock failure, reserve failure/zero ID, attach failure, release failure and
once-only behavior. Synthetic service codes are fault injections.

The B1 proposal and the built NRO/run instructions are published under
`/media/storage2/builds/moonlight/lead/B1-PROPOSAL.md` and its artifact directory.
Only the designated tester may launch the candidate, once, after lead scheduling.

`check_link.py` adapts the existing metadata-only verifier: it requires its sole
failure to be the exact two owner-lock callers (the original query and this
wrapper). Every other identity, instruction, relocation and lock-path check must
pass. It preserves the original nonzero result and log; it does not describe
that verifier as an unchanged PASS. The new wrapper is checked byte-for-byte
against its object and its seven alias relocations resolve to the pinned locals.
