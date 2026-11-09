// SPDX-License-Identifier: ISC
/**
 * @file module.h
 * @brief Bounded MOD0 metadata and an explicitly managed module registry.
 * @note Switch 2: automatic MOD0 offsets and lookup behavior from
 *       spec/rtld.md, spec/rtld-elf.md and spec/compat.md. These are libnx2
 *       objects, not overlays of the proprietary loader's module objects.
 * @copyright libnx2 Authors
 */
#pragma once
#include "../result.h"

/// Lookup failure returned by the compatibility loader, including a missing caller.
#define MODULE_RESULT_NOT_FOUND ((Result)0xa16)

/**
 * @brief Immutable metadata produced by \ref moduleReadImage.
 * @note Keep the source bytes alive while using this view. Only
 *       the relocation and lazy-binding APIs may modify them. Do not modify the fields.
 *       Addresses refer to load_address, which may differ
 *       from the address of data when inspecting a copied image.
 */
typedef struct ModuleImage {
    const u8* data;          ///< Caller-owned image bytes.
    size_t size;             ///< Complete readable span, including BSS.
    uintptr_t load_address;  ///< Address at which the image is loaded.
    size_t mod0_offset;      ///< MOD0 offset from the image start.
    size_t dynamic_offset;   ///< Dynamic table offset from the image start.
    size_t dynamic_size;     ///< Dynamic table bytes through DT_NULL.
    size_t bss_offset;       ///< BSS offset from the image start.
    size_t bss_size;         ///< BSS extent; parsing never clears it.
    size_t module_offset;    ///< Opaque module object offset; never dereferenced.
    uintptr_t init_address;  ///< Resolved DT_INIT address, or zero when absent.
    uintptr_t fini_address;  ///< Resolved DT_FINI address, or zero when absent.
    size_t hash_offset;      ///< SysV hash table offset, zero when unavailable.
    size_t symbol_offset;    ///< ELF64 symbol table offset.
    size_t string_offset;    ///< Symbol string table offset.
    size_t string_size;      ///< Symbol string table byte size.
    u32 bucket_count;        ///< SysV hash bucket count, zero without symbols.
    u32 symbol_count;        ///< SysV chain count and symbol count.
} ModuleImage;

/// Forward declaration for caller-owned registry links.
typedef struct Module Module;

/**
 * @brief A caller-owned registry, initially zero-initialized.
 * @note Keep its address stable and serialize all access externally. Fields
 *       are maintained by the module functions. Registration is frozen while
 *       initializers or finalizers run and between those two calls.
 */
typedef struct ModuleRegistry {
    Module* first;     ///< First registered module.
    Module* last;      ///< Last registered module.
    bool initialized; ///< Initializers have completed for this cycle.
    bool dispatching; ///< A lifecycle callback is running.
} ModuleRegistry;

/**
 * @brief A caller-owned module record, initially zero-initialized.
 * @note Keep its address stable while registered; do not modify the fields.
 *       Callback pointers are supplied explicitly, never inferred or executed
 *       by parsing image bytes.
 */
struct Module {
    ModuleImage image;         ///< Validated image view.
    VoidFn init;               ///< Optional initialization callback.
    VoidFn fini;               ///< Optional finalization callback.
    ModuleRegistry* registry; ///< Owning registry, or NULL when unregistered.
    Module* previous;          ///< Previous registered module.
    Module* next;              ///< Next registered module.
};

/// One staged eight-byte relocation write; storage is supplied by the caller.
typedef struct ModuleRelocationWrite {
    size_t offset; ///< Destination offset in the importing image.
    u64 value;     ///< Value to store in little-endian order after validation.
} ModuleRelocationWrite;

/**
 * @brief Optional manual lookup after automatic relocation lookup misses.
 * @param[in] user Caller-supplied context.
 * @param[in] image Importing image, valid only for the duration of the call.
 * @param[in] name Borrowed NUL-terminated symbol name.
 * @param[out] out_address Receives the resolved address on success.
 * @return Zero for a match, MODULE_RESULT_NOT_FOUND for no match, or another
 *         failure propagated by \ref moduleRelocateImage. Zero addresses miss.
 * @note Do not modify any image, registry, module record or relocation workspace
 *       during this callback, or invoke relocation or lifecycle operations.
 */
typedef Result (*ModuleSymbolResolver)(void* user, const ModuleImage* image,
                                       const char* name, uintptr_t* out_address);

/**
 * @brief Reads an automatic module's unsigned MOD0 offsets and ELF64 metadata.
 * @param[out] out Receives the validated view only on success.
 * @param[in] image Contiguous readable image bytes, including the BSS extent.
 * @param[in] size Number of readable bytes.
 * @param[in] load_address Image address used to resolve relative addresses.
 * @return Zero on success; LibnxError_BadInput for invalid arguments or metadata.
 * @note Requires little-endian MOD0 and a terminated dynamic table. A symbol
 *       table requires DT_HASH, DT_STRTAB, DT_SYMTAB, DT_STRSZ and DT_SYMENT.
 *       Duplicate supported tags, misaligned tables and out-of-span metadata
 *       or defined symbols are rejected as libnx2 validation policy. BSS and
 *       the opaque module-object offset must also lie in the supplied span.
 * @note No relocation, BSS clearing, discovery, permission changes or callbacks
 *       occur. GNU hash, TLS/IFUNC resolution and extended symbol indices are not
 *       supported. Unknown dynamic tags are ignored. Chain cycles are detected
 *       during lookup, with at most symbol_count chain entries visited.
 */
Result moduleReadImage(ModuleImage* out, const void* image, size_t size, uintptr_t load_address);

/**
 * @brief Finds the first eligible definition in one image's SysV hash chain.
 * @param[in] image An unmodified view from \ref moduleReadImage.
 * @param[in] name NUL-terminated symbol name.
 * @param[out] out_address Receives load_address plus symbol value on success.
 * @return Zero, MODULE_RESULT_NOT_FOUND, or LibnxError_BadInput for malformed
 *         metadata or a matching unsupported TLS, IFUNC or extended-index symbol.
 * @note Undefined, common and file symbols are skipped. Local definitions are
 *       eligible here. SHN_ABS also uses base plus value, matching the captured
 *       loader rather than general ELF absolute-symbol semantics.
 */
Result moduleLookupSymbol(const ModuleImage* image, const char* name, uintptr_t* out_address);

/**
 * @brief Appends a module to the registration order without invoking callbacks.
 * @param[in,out] registry Zero-initialized or existing registry.
 * @param[in,out] module Zero-initialized, unregistered record.
 * @param[in] image Image view; its bytes are validated again and remain borrowed.
 * @param[in] init Optional callback for \ref moduleRunInitializers.
 * @param[in] fini Optional callback for \ref moduleRunFinalizers.
 * @return Zero, LibnxError_BadInput for invalid or overlapping images, or
 *         LibnxError_AlreadyInitialized for a registered record or frozen registry.
 */
Result moduleRegister(ModuleRegistry* registry, Module* module, const ModuleImage* image,
                      VoidFn init, VoidFn fini);

/**
 * @brief Removes and clears a record without invoking callbacks.
 * @return Zero, LibnxError_BadInput for NULL, LibnxError_NotInitialized for an
 *         unregistered record, or LibnxError_AlreadyInitialized for a frozen registry.
 */
Result moduleUnregister(Module* module);

/**
 * @brief Finds the first non-local definition in registration order.
 * @note The first eligible matching symbol in each module decides its result.
 *       A local match skips that module, even if its chain has another match.
 *       Results and output preservation match \ref moduleLookupSymbol.
 */
Result moduleLookupGlobalSymbol(const ModuleRegistry* registry, const char* name,
                                uintptr_t* out_address);

/**
 * @brief Finds a non-local definition strictly after the caller's module.
 * @param[in] registry Registry to search in registration order, without wrapping.
 * @param[in] caller_address Address inside the caller's registered image.
 * @param[in] name NUL-terminated symbol name.
 * @param[out] out_address Receives the symbol address only on success.
 * @return As \ref moduleLookupSymbol; an unknown caller returns MODULE_RESULT_NOT_FOUND.
 * @note The caller supplies an address with pointer-authentication bits already
 *       removed. Identification uses image containment; there are no kernel queries.
 */
Result moduleLookupNextSymbol(const ModuleRegistry* registry, uintptr_t caller_address,
                              const char* name, uintptr_t* out_address);

/**
 * @brief Returns the workspace entry count for an explicit relocation pass.
 * @param[in] image Image view whose bytes are validated again.
 * @param[out] out_count Receives regular plus PLT RELA record count on success.
 *             Must not overlap the image bytes or descriptor.
 * @return Zero, LibnxError_BadInput for malformed metadata, or
 *         LibnxError_BadReloc for unsupported REL/RELR metadata or PLT format.
 * @note This validates table extents and tags, without resolving symbols or
 *       validating individual relocation records. No image bytes are changed.
 *       The result is also a safe workspace upper bound for
 *       \ref moduleRelocateRegularImage.
 */
Result moduleGetRelocationCount(const ModuleImage* image, size_t* out_count);

/**
 * @brief Applies a bounded, eager AArch64 RELA pass after staging every write.
 * @param[in] image Image view whose bytes are validated again.
 * @param[in,out] writable_image Must equal image->data and permit writes across
 *                image->size bytes. load_address may describe a separate mapping.
 * @param[in] registry Optional registry searched in registration order. Register
 *            all automatic providers, including the importer for self lookup.
 * @param[in] resolver Optional manual fallback for default-visibility references.
 * @param[in] user Context passed to resolver.
 * @param[out] workspace Caller-owned scratch entries; contents unspecified on
 *             failure. Required entries must not overlap image bytes, image
 *             descriptors, registry/module objects, registered images or
 *             resolver-owned state. Entry order is unspecified. May be NULL
 *             when the required count is zero.
 * @param[in] workspace_count Capacity from \ref moduleGetRelocationCount or larger.
 * @return Zero; MODULE_RESULT_NOT_FOUND for an unresolved strong symbol;
 *         LibnxError_BadInput for invalid spans, tables, aliases, capacity or
 *         unsupported provider symbols;
 *         LibnxError_BadReloc for unsupported forms or arithmetic overflow;
 *         LibnxError_AlreadyInitialized for an initialized/busy registry; or a
 *         resolver error. Failures leave image bytes unchanged.
 * @note Supports eight-byte RELATIVE in the DT_RELACOUNT prefix, ABS64 and
 *       GLOB_DAT after that prefix, and JUMP_SLOT in the RELA PLT table. Every
 *       other kind, including ABS32, COPY, REL, RELR, TLS and IFUNC, is refused.
 *       Tables require DT_RELAENT=24; RELATIVE requires symbol index zero.
 *       Targets must be aligned, nonoverlapping
 *       eight-byte spans outside the image's MOD0, dynamic, symbol, hash,
 *       string and relocation metadata. Signed addends must not wrap.
 *       Image bytes must not overlap the caller's image descriptor, registry or
 *       module records. Registered image byte spans must either match the
 *       importing byte span exactly or be disjoint from it.
 * @note Visibility selects importer-only lookup; otherwise automatic lookup
 *       precedes the resolver. An unresolved weak symbol uses address zero.
 *       No lazy slots, GOT hooks, code execution or permission changes occur.
 *       Serialize all access externally, including resolver callbacks. Resolver
 *       side effects outside image bytes are not rolled back on failure.
 */
Result moduleRelocateImage(const ModuleImage* image, void* writable_image,
                           const ModuleRegistry* registry, ModuleSymbolResolver resolver,
                           void* user, ModuleRelocationWrite* workspace, size_t workspace_count);

/**
 * @brief Applies only regular RELA relocations, preserving PLT and GOT contents.
 * @param[in] image Image view whose metadata is validated again.
 * @param[in,out] writable_image Writable bytes at exactly image->data.
 * @param[in] registry Optional automatic symbol providers.
 * @param[in] resolver Optional manual symbol fallback.
 * @param[in] user Context passed to resolver.
 * @param[out] workspace Scratch entries with the separation rules of
 *             \ref moduleRelocateImage; contents unspecified on failure.
 * @param[in] workspace_count Capacity for the regular RELA records;
 *            \ref moduleGetRelocationCount gives a safe upper bound.
 * @return Same results and image-preservation guarantees as
 *         \ref moduleRelocateImage.
 * @note Applies the DT_RELACOUNT relative prefix, then regular ABS64/GLOB_DAT
 *       records. PLT records are not resolved or written. Table metadata,
 *       including skipped PLT metadata, is validated. Use this before
 *       \ref moduleInitializeLazyBinding for a regular-plus-lazy sequence.
 *       Regular destinations overlapping PLT slots or the GOT prefix are refused.
 *       Registry state, callbacks, arithmetic and alias rules match the eager API.
 */
Result moduleRelocateRegularImage(const ModuleImage* image, void* writable_image,
                                  const ModuleRegistry* registry, ModuleSymbolResolver resolver,
                                  void* user, ModuleRelocationWrite* workspace, size_t workspace_count);

/**
 * @brief Returns the scratch-entry count for lazy RELA PLT initialization.
 * @param[in] image Image whose metadata is validated again.
 * @param[out] out_count Receives PLT record count plus two when DT_PLTGOT is present.
 *             Must not overlap image bytes or the descriptor.
 * @return As \ref moduleGetRelocationCount, including malformed GOT metadata.
 * @note Validates table extents, not individual records. No image bytes change.
 */
Result moduleGetLazyBindingCount(const ModuleImage* image, size_t* out_count);

/**
 * @brief Stages and applies lazy RELA JUMP_SLOT and optional GOT initialization.
 * @param[in] image Image whose metadata is validated again.
 * @param[in,out] writable_image Writable bytes at exactly image->data.
 * @param[in] module_address Opaque caller-supplied value for GOT +8.
 * @param[in] resolver_address Caller-supplied resolver entry value for GOT +16.
 * @param[out] workspace Scratch entries with the separation rules of
 *             \ref moduleRelocateImage; contents unspecified on failure.
 * @param[in] workspace_count Capacity from \ref moduleGetLazyBindingCount or larger.
 * @return Zero, LibnxError_BadInput for invalid spans, aliases, records or
 *         capacity, or LibnxError_BadReloc for unsupported forms or overflow.
 *         Failure leaves image bytes unchanged.
 * @note Each initial slot must contain the same aligned image-relative resolver
 *       offset inside the image. Initialization adds load_address, ignoring the
 *       RELA addend. Call exactly once on unbound, unrelocated PLT slots.
 *       Regular relocations are untouched. GOT +0 is preserved; a PLT slot
 *       overlapping the three-word GOT prefix is rejected. With no DT_PLTGOT,
 *       module_address and resolver_address are ignored.
 * @note Values are only stored, never called or interpreted as libnx2 objects.
 *       This does not supply a resolver's calling convention, executable code,
 *       permission changes or a complete process loader. Serialize access.
 */
Result moduleInitializeLazyBinding(const ModuleImage* image, void* writable_image,
                                   uintptr_t module_address, uintptr_t resolver_address,
                                   ModuleRelocationWrite* workspace, size_t workspace_count);

/**
 * @brief Resolves and updates one bounded RELA JUMP_SLOT by its PLT index.
 * @param[in] image Image whose metadata is validated again.
 * @param[in,out] writable_image Writable bytes at exactly image->data.
 * @param[in] index Zero-based index in DT_JMPREL, not a regular RELA index.
 * @param[in] registry Optional registry searched in registration order.
 * @param[in] resolver Optional manual fallback for default-visibility references.
 * @param[in] user Context passed to resolver; callback restrictions match
 *            \ref moduleRelocateImage.
 * @param[out] out_address Receives the value stored in the slot. Must not
 *             overlap image bytes, descriptors, registry, registered modules
 *             or resolver-owned state.
 * @return Zero, MODULE_RESULT_NOT_FOUND for an unresolved strong symbol,
 *         LibnxError_BadInput for invalid metadata, index or aliases,
 *         LibnxError_BadReloc for unsupported forms or overflow, or resolver error.
 *         Failure preserves the slot and out_address.
 * @note A nonzero resolved address stores address plus the signed RELA addend.
 *       An unresolved weak symbol stores zero and ignores the addend, as in
 *       the captured lazy resolver. Strong misses return a recoverable error
 *       instead of overwriting the slot with zero. Only the selected record is
 *       validated; unsupported REL/RELR metadata is always refused.
 *       May run after registry initialization. Serialize all access externally.
 */
Result moduleResolveLazyBinding(const ModuleImage* image, void* writable_image, u32 index,
                                const ModuleRegistry* registry, ModuleSymbolResolver resolver,
                                void* user, uintptr_t* out_address);

/**
 * @brief Invokes non-null init callbacks in reverse registration order.
 * @return Zero, LibnxError_BadInput for NULL, or LibnxError_AlreadyInitialized
 *         if already initialized or a lifecycle call is in progress.
 * @note Finalization permits a new initialization cycle. Callbacks may look up
 *       symbols but cannot register, unregister or invoke lifecycle functions.
 */
Result moduleRunInitializers(ModuleRegistry* registry);

/**
 * @brief Invokes non-null fini callbacks in registration order once per cycle.
 * @return Zero, LibnxError_BadInput for NULL, LibnxError_NotInitialized before
 *         initialization, or LibnxError_AlreadyInitialized during a lifecycle call.
 */
Result moduleRunFinalizers(ModuleRegistry* registry);
