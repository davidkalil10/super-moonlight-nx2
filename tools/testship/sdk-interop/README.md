# SDK backing link helpers

Prepare an isolated four-alias OunceVK archive and check the linked
`moonlightSdkBackingQuery`. Run archive generation and ARM64 builds on m4,
using the pinned GNU toolchain. These tools never run the SDK or the application.

## Prepare the archive

```sh
sh tools/testship/sdk-interop/prepare-alias-archive.sh \
  --devkitpro /opt/devkitpro \
  --out /work/new-alias
```

`--archive` overrides the input archive, and `--tool-prefix` overrides the
default `/opt/devkitpro/devkitA64/bin/aarch64-none-elf`. Paths may contain spaces.
The output must be new and outside the SDK and input archive directory. The
script preserves originals, refuses an existing output and retains working
evidence on success or failure. It publishes `libouncevk.a` and `logs/` only
after every gate passes.

The pins in `lib/pins.py` require:

| Input or output | SHA-256 |
| --- | --- |
| Original SDK archive | `9b8d1de4d5d6c64de7ab737e940a05650544823ea46cd04f60c76d7a2d93621f` |
| Original `vulkan.o` | `5b3efdf1968e41230915e62cfef7a16942c993f56c9a37290bdbf49ac55f63b5` |
| Aliased `vulkan.o` | `adcb05710664bf85a66d07e6ccea4a81c5895bc52546027527c61ee84a9f2449` |
| Aliased archive | `b33546d8f616e135257a27b5606992a2b8a9708dc8d11e8343b55faa34176531` |

Identity checks cover the four true private definitions and their section
bytes. Raw comparison requires every other section and relocation to remain
unchanged, every original symbol to remain at its index with all fields
unchanged, and exactly four aliases to be appended. Member round-trip and
the final archive hash are required. LLVM objcopy is unsupported.

Exit status is 0 for a qualified archive, 1 for a failed gate and 2 for usage
or an invalid output path. Logs and staging files may remain after failure;
use a fresh output for every attempt.

## Verify the application ELF

Place `-L/work/new-alias` before SDK library paths, keep a linker map and an
unstripped ELF, then run:

```sh
python3 -B tools/testship/sdk-interop/verify-final-elf.py \
  --tool-prefix /opt/devkitpro/devkitA64/bin/aarch64-none-elf \
  --sdk-archive /opt/devkitpro/portlibs/switch2/lib/libouncevk.a \
  --alias-archive /work/new-alias/libouncevk.a \
  --map /work/final.map \
  --elf /work/final.elf \
  /work/sdk_backing.o
```

Pass every input object that references an alias. Each reference must be
undefined GLOBAL HIDDEN and use the qualified direct AArch64 relocation forms.
LTO, GOT references and linker instruction relaxation are unsupported and fail
closed. The default query is `moonlightSdkBackingQuery`, with one lock call and
ten unlock sites; `--query` and `--expect-unlock-sites` permit explicit future
qualifications. No probe-specific function, pointer table or fixed ELF address
is required.

The verifier resolves the true SDK locals and aliases from the input ELF,
checks their types, sizes, visibility and section-relative identity, checks the
SDK lock bodies against the original archive, and checks every input alias
relocation against the linked instructions. It walks the actual query's paths:
the lock result must be tested, refusal must not unlock, and every returning
path that acquired the lock must unlock exactly once, without other calls,
indirect branches or traps. The linked query must match its object except at
relocated instructions.

It also requires AArch64 ET_DYN, no NEEDED or TEXTREL, no exported aliases or
private targets, and only RELATIVE/RELR dynamic relocations into writable data.
GNU ld 2.45.1 localizes the function aliases to LOCAL DEFAULT while retaining
the object aliases as GLOBAL HIDDEN; this is the qualified final form.

Optional `--placeholder /work/placeholder.elf` compares a second link of the
same objects against the original archive, with each alias defined through
`-Wl,--defsym=ALIAS=vkCreateInstance`. It requires identical layout and non-alias
symbols, with allocated-byte differences confined to alias users and link
notes. The qualification run uses this comparison and a reproducible relink.

Exit status is 0 when every check passes, 1 for failed checks and 2 for usage,
malformed input or tool errors. Fail the owner build on any nonzero exit.

## Integration limit

These are static identity and link checks. Keep the actual C2 production source
and header pins in the owner build receipt. Passing does not establish safe
execution, decoder support or a memory lease. The caller must retain the
renderer, device and allocation, use the initialized SDK thread, and prevent
allocation/free, image teardown, swapchain recreation and exit during the
metadata query. The SDK owner mutex does not prevent device shutdown.
