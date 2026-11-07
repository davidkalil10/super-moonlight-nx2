// SPDX-License-Identifier: ISC
/**
 * @file trampoline.h
 * @brief Bounded, read-only compatibility trampoline table inspection.
 * @note Switch 2: table and branch encoding from spec/compat.md. Parsing
 *       neither installs nor executes hooks and does not infer signatures.
 * @copyright libnx2 Authors
 */
#pragma once
#include "../types.h"
#include "../result.h"

/**
 * @brief Paired trampoline tables in a caller-owned mapped image.
 * @note Initialize with trampolineTableOpen. Keep the image alive and
 *       immutable while using the table; treat these members as read-only.
 */
typedef struct TrampolineTable {
    const void* image; ///< Local bytes, independent of the target address.
    size_t image_size; ///< Number of readable local bytes.
    u64 image_address; ///< Virtual address corresponding to image[0].
    size_t name_table_offset; ///< Offset of the name-table marker within image.
    size_t offset_table_offset; ///< Offset of the branch-table marker within image.
    size_t count; ///< Number of paired records.
} TrampolineTable;

/// A validated name and the PLT target of its branch record.
typedef struct TrampolineEntry {
    const char* name; ///< NUL-terminated name borrowing the mapped image.
    size_t name_length; ///< Name length excluding the terminator.
    u64 target_address; ///< Target virtual address, not a callable host pointer.
    size_t target_offset; ///< Offset of the target within the mapped image.
} TrampolineEntry;

/**
 * @brief Validates both table headers and every paired entry.
 * @param[out] out Receives the validated table only on success.
 * @param image Readable bytes containing tables, names and target instructions.
 * @param image_size Size of image in bytes.
 * @param image_address Virtual address corresponding to its first byte.
 * @param name_table_offset Image offset of TrampolineNameData.
 * @param offset_table_offset Image offset of TrampolineOffsetData.
 * @note Counts must match but are not restricted to the captured count of 29.
 *       As libnx2 safety policy, names must follow the name table extent,
 *       target instructions must lie wholly within image, and arithmetic
 *       overflow, misaligned branches and malformed encodings are rejected.
 * @return BadInput for any invalid argument or malformed table.
 */
Result trampolineTableOpen(TrampolineTable* out, const void* image, size_t image_size,
                           u64 image_address, size_t name_table_offset,
                           size_t offset_table_offset);

/**
 * @brief Reads a validated pair by index.
 * @param table Table returned by trampolineTableOpen.
 * @param index Zero-based record index.
 * @param[out] out Receives the entry only on success.
 * @return BadInput for invalid bounds, encoding or index; out is unchanged.
 */
Result trampolineTableGetEntry(const TrampolineTable* table, size_t index,
                               TrampolineEntry* out);
