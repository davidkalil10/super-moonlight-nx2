// SPDX-License-Identifier: ISC
#include "runtime/trampoline.h"
#include <string.h>

static Result bad_input(void) {
    return MAKERESULT(Module_Libnx, LibnxError_BadInput);
}

static u64 read_u64(const u8* data) {
    u64 value = 0;
    for (size_t i = 0; i < 8; i++)
        value |= (u64)data[i] << (i * 8);
    return value;
}

static bool contains(const TrampolineTable* table, size_t offset, size_t size) {
    return offset <= table->image_size && size <= table->image_size - offset;
}

static bool read_header(const TrampolineTable* table, size_t offset,
                        const char marker[32], size_t* out_count) {
    if (!contains(table, offset, 0x28))
        return false;
    const u8* bytes = (const u8*)table->image + offset;
    if (memcmp(bytes, marker, 32) != 0)
        return false;
    u64 count = read_u64(bytes + 0x20);
    if (count > (table->image_size - offset - 0x28) / 8)
        return false;
    *out_count = (size_t)count;
    return true;
}

static bool valid_headers(const TrampolineTable* table, size_t* out_count) {
    static const char name_marker[32] = "TrampolineNameTableMarker";
    static const char offset_marker[32] = "TrampolineOffsetTableMarker";
    if (!table || !table->image || table->image_size > UINTPTR_MAX - (uintptr_t)table->image ||
        table->image_size > UINT64_MAX - table->image_address)
        return false;
    size_t name_count, offset_count;
    if (!read_header(table, table->name_table_offset, name_marker, &name_count) ||
        !read_header(table, table->offset_table_offset, offset_marker, &offset_count) ||
        name_count != offset_count)
        return false;
    *out_count = name_count;
    return true;
}

static Result read_entry(const TrampolineTable* table, size_t index, TrampolineEntry* out) {
    const u8* bytes = table->image;
    size_t relative_entry = 0x28 + index * 8;
    u64 name_offset = read_u64(bytes + table->name_table_offset + relative_entry);
    size_t extent = 0x28 + table->count * 8;
    if (name_offset < extent || name_offset >= table->image_size - table->name_table_offset)
        return bad_input();
    size_t name_start = table->name_table_offset + (size_t)name_offset;
    const char* name = (const char*)bytes + name_start;
    const char* terminator = memchr(name, 0, table->image_size - name_start);
    if (!terminator)
        return bad_input();

    size_t record_offset = table->offset_table_offset + relative_entry;
    u64 instruction = read_u64(bytes + record_offset);
    if ((instruction & ~UINT64_C(0x03ffffff)) != UINT64_C(0x94000000))
        return bad_input();
    u64 record_address = table->image_address + record_offset;
    if (record_address & 3)
        return bad_input();
    s64 displacement = (s64)(instruction & UINT64_C(0x03ffffff));
    if (displacement & INT64_C(0x02000000))
        displacement -= INT64_C(0x04000000);
    displacement *= 4;
    u64 target;
    if (displacement < 0) {
        if ((u64)-displacement > record_address)
            return bad_input();
        target = record_address - (u64)-displacement;
    } else {
        if ((u64)displacement > UINT64_MAX - record_address)
            return bad_input();
        target = record_address + (u64)displacement;
    }
    if (target < table->image_address || target - table->image_address > SIZE_MAX)
        return bad_input();
    size_t target_offset = (size_t)(target - table->image_address);
    if (!contains(table, target_offset, 4))
        return bad_input();
    *out = (TrampolineEntry){
        .name = name,
        .name_length = (size_t)(terminator - name),
        .target_address = target,
        .target_offset = target_offset,
    };
    return 0;
}

Result trampolineTableOpen(TrampolineTable* out, const void* image, size_t image_size,
                           u64 image_address, size_t name_table_offset,
                           size_t offset_table_offset) {
    if (!out)
        return bad_input();
    TrampolineTable table = {
        .image = image,
        .image_size = image_size,
        .image_address = image_address,
        .name_table_offset = name_table_offset,
        .offset_table_offset = offset_table_offset,
    };
    if (!valid_headers(&table, &table.count))
        return bad_input();
    for (size_t i = 0; i < table.count; i++) {
        TrampolineEntry entry;
        Result rc = read_entry(&table, i, &entry);
        if (R_FAILED(rc))
            return rc;
    }
    *out = table;
    return 0;
}

Result trampolineTableGetEntry(const TrampolineTable* table, size_t index,
                               TrampolineEntry* out) {
    size_t count;
    if (!out || !valid_headers(table, &count) || count != table->count || index >= count)
        return bad_input();
    return read_entry(table, index, out);
}
