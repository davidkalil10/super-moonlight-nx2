// SPDX-License-Identifier: ISC
#include <string.h>
#include <stdlib.h>

#include "runtime/module.h"

enum {
    ModuleDynamic_Null = 0,
    ModuleDynamic_PltSize = 2,
    ModuleDynamic_Hash = 4,
    ModuleDynamic_StringTable = 5,
    ModuleDynamic_SymbolTable = 6,
    ModuleDynamic_Rela = 7,
    ModuleDynamic_RelaSize = 8,
    ModuleDynamic_RelaEntry = 9,
    ModuleDynamic_StringSize = 10,
    ModuleDynamic_SymbolSize = 11,
    ModuleDynamic_Init = 12,
    ModuleDynamic_Fini = 13,
    ModuleDynamic_Rel = 17,
    ModuleDynamic_RelSize = 18,
    ModuleDynamic_RelEntry = 19,
    ModuleDynamic_PltRel = 20,
    ModuleDynamic_JmpRel = 23,
    ModuleDynamic_RelrSize = 35,
    ModuleDynamic_Relr = 36,
    ModuleDynamic_RelrEntry = 37,
    ModuleDynamic_RelaCount = 0x6ffffff9,
    ModuleDynamic_RelCount = 0x6ffffffa,
    ModuleSymbol_File = 4,
    ModuleSymbol_Tls = 6,
    ModuleSymbol_Ifunc = 10,
    ModuleSection_Undefined = 0,
    ModuleSection_Common = 0xfff2,
    ModuleSection_Extended = 0xffff,
    ModuleSymbolSize = 24,
    ModuleDynamicSize = 16,
    ModuleRelaSize = 24,
    ModuleRelocation_Abs64 = 0x101,
    ModuleRelocation_GlobalData = 0x401,
    ModuleRelocation_JumpSlot = 0x402,
    ModuleRelocation_Relative = 0x403,
};

static Result _moduleBadInput(void) {
    return MAKERESULT(Module_Libnx, LibnxError_BadInput);
}

static u16 _moduleRead16(const u8* data) {
    return (u16)data[0] | (u16)data[1] << 8;
}

static u32 _moduleRead32(const u8* data) {
    return (u32)data[0] | (u32)data[1] << 8 | (u32)data[2] << 16 | (u32)data[3] << 24;
}

static u64 _moduleRead64(const u8* data) {
    return (u64)_moduleRead32(data) | (u64)_moduleRead32(data + 4) << 32;
}

static bool _moduleValidSpan(const ModuleImage* image) {
    return image && image->data && image->size &&
        image->size <= UINTPTR_MAX - (uintptr_t)image->data &&
        image->size <= UINTPTR_MAX - image->load_address;
}

static bool _moduleContains(const ModuleImage* image, u64 offset, u64 size, size_t alignment) {
    return offset <= image->size && size <= image->size - offset &&
        !((image->load_address + (uintptr_t)offset) & (alignment - 1));
}

static bool _moduleEligible(const u8* symbol) {
    u16 section = _moduleRead16(symbol + 6);

    return (symbol[4] & 0xf) != ModuleSymbol_File &&
        section != ModuleSection_Undefined && section != ModuleSection_Common;
}

static bool _moduleUnsupported(const u8* symbol) {
    return (symbol[4] & 0xf) == ModuleSymbol_Tls ||
        (symbol[4] & 0xf) == ModuleSymbol_Ifunc ||
        _moduleRead16(symbol + 6) == ModuleSection_Extended;
}

static bool _moduleValidTables(const ModuleImage* image) {
    u64 hash_size = 8 + ((u64)image->bucket_count + image->symbol_count) * 4;

    return image->bucket_count && image->symbol_count && image->string_size &&
        _moduleContains(image, image->hash_offset, hash_size, 4) &&
        _moduleContains(image, image->symbol_offset,
                        (u64)image->symbol_count * ModuleSymbolSize, 8) &&
        _moduleContains(image, image->string_offset, image->string_size, 1);
}

static Result _moduleReadTables(ModuleImage* image) {
    if (!_moduleContains(image, image->hash_offset, 8, 4))
        return _moduleBadInput();

    image->bucket_count = _moduleRead32(image->data + image->hash_offset);
    image->symbol_count = _moduleRead32(image->data + image->hash_offset + 4);
    if (!_moduleValidTables(image))
        return _moduleBadInput();

    const u8* indexes = image->data + image->hash_offset + 8;
    u64 index_count = (u64)image->bucket_count + image->symbol_count;
    for (u64 i = 0; i < index_count; i++) {
        if (_moduleRead32(indexes + i * 4) >= image->symbol_count)
            return _moduleBadInput();
    }

    for (u32 i = 0; i < image->symbol_count; i++) {
        const u8* symbol = image->data + image->symbol_offset + (size_t)i * ModuleSymbolSize;
        u32 name = _moduleRead32(symbol);

        if (name >= image->string_size ||
            !memchr(image->data + image->string_offset + name, 0, image->string_size - name))
            return _moduleBadInput();
        if (_moduleEligible(symbol) && !_moduleUnsupported(symbol) &&
            !_moduleContains(image, _moduleRead64(symbol + 8), _moduleRead64(symbol + 16), 1))
            return _moduleBadInput();
    }
    return 0;
}

static Result _moduleReadDynamic(ModuleImage* image) {
    enum {
        SeenHash = BIT(0),
        SeenStringTable = BIT(1),
        SeenSymbolTable = BIT(2),
        SeenStringSize = BIT(3),
        SeenSymbolSize = BIT(4),
        SeenInit = BIT(5),
        SeenFini = BIT(6),
        RequiredSymbols = SeenHash | SeenStringTable | SeenSymbolTable | SeenStringSize | SeenSymbolSize,
    };
    u32 seen = 0;
    size_t offset = image->dynamic_offset;

    for (;;) {
        if (!_moduleContains(image, offset, ModuleDynamicSize, 8))
            return _moduleBadInput();

        u64 tag = _moduleRead64(image->data + offset);
        u64 value = _moduleRead64(image->data + offset + 8);
        u32 flag = 0;
        offset += ModuleDynamicSize;
        if (tag == ModuleDynamic_Null)
            break;

        switch (tag) {
        case ModuleDynamic_Hash:
            flag = SeenHash;
            if (value > image->size)
                return _moduleBadInput();
            image->hash_offset = (size_t)value;
            break;
        case ModuleDynamic_StringTable:
            flag = SeenStringTable;
            if (value > image->size)
                return _moduleBadInput();
            image->string_offset = (size_t)value;
            break;
        case ModuleDynamic_SymbolTable:
            flag = SeenSymbolTable;
            if (value > image->size)
                return _moduleBadInput();
            image->symbol_offset = (size_t)value;
            break;
        case ModuleDynamic_StringSize:
            flag = SeenStringSize;
            if (value > image->size)
                return _moduleBadInput();
            image->string_size = (size_t)value;
            break;
        case ModuleDynamic_SymbolSize:
            flag = SeenSymbolSize;
            if (value != ModuleSymbolSize)
                return _moduleBadInput();
            break;
        case ModuleDynamic_Init:
        case ModuleDynamic_Fini:
            flag = tag == ModuleDynamic_Init ? SeenInit : SeenFini;
            if (!_moduleContains(image, value, 1, 4))
                return _moduleBadInput();
            if (tag == ModuleDynamic_Init)
                image->init_address = image->load_address + (uintptr_t)value;
            else
                image->fini_address = image->load_address + (uintptr_t)value;
            break;
        default:
            break;
        }
        if (seen & flag)
            return _moduleBadInput();
        seen |= flag;
    }
    image->dynamic_size = offset - image->dynamic_offset;

    if (!(seen & RequiredSymbols))
        return 0;
    if ((seen & RequiredSymbols) != RequiredSymbols)
        return _moduleBadInput();
    return _moduleReadTables(image);
}

Result moduleReadImage(ModuleImage* out, const void* image, size_t size, uintptr_t load_address) {
    ModuleImage view = { .data = image, .size = size, .load_address = load_address };

    if (!out || !_moduleValidSpan(&view) || !_moduleContains(&view, 4, 4, 4))
        return _moduleBadInput();
    view.mod0_offset = _moduleRead32(view.data + 4);
    if (!_moduleContains(&view, view.mod0_offset, 0x1c, 4))
        return _moduleBadInput();

    const u8* mod0 = view.data + view.mod0_offset;
    if (memcmp(mod0, "MOD0", 4))
        return _moduleBadInput();

    u64 dynamic = (u64)view.mod0_offset + _moduleRead32(mod0 + 4);
    u64 bss_start = (u64)view.mod0_offset + _moduleRead32(mod0 + 8);
    u64 bss_end = (u64)view.mod0_offset + _moduleRead32(mod0 + 12);
    u64 module = (u64)view.mod0_offset + _moduleRead32(mod0 + 24);
    if (!_moduleContains(&view, dynamic, ModuleDynamicSize, 8) ||
        bss_end < bss_start || !_moduleContains(&view, bss_start, bss_end - bss_start, 1) ||
        !_moduleContains(&view, module, 1, 1))
        return _moduleBadInput();

    view.dynamic_offset = (size_t)dynamic;
    view.bss_offset = (size_t)bss_start;
    view.bss_size = (size_t)(bss_end - bss_start);
    view.module_offset = (size_t)module;

    Result rc = _moduleReadDynamic(&view);
    if (R_SUCCEEDED(rc))
        *out = view;
    return rc;
}

static u32 _moduleHashName(const char* name) {
    u32 hash = 0;

    for (const unsigned char* byte = (const unsigned char*)name; *byte; byte++) {
        hash = (hash << 4) + *byte;
        u32 high = hash & 0xf0000000;
        hash ^= high >> 24;
        hash &= ~high;
    }
    return hash;
}

static Result _moduleFindSymbol(const ModuleImage* image, const char* name,
                                bool nonlocal, uintptr_t* out_address) {
    if (!_moduleValidSpan(image) || !name || !out_address)
        return _moduleBadInput();
    if (!image->bucket_count && !image->symbol_count)
        return MODULE_RESULT_NOT_FOUND;
    if (!_moduleValidTables(image))
        return _moduleBadInput();

    const u8* buckets = image->data + image->hash_offset + 8;
    const u8* chains = buckets + (size_t)image->bucket_count * 4;
    u32 index = _moduleRead32(buckets + (size_t)(_moduleHashName(name) % image->bucket_count) * 4);
    size_t name_size = strlen(name);

    for (u32 visited = 0; index; visited++) {
        if (index >= image->symbol_count || visited >= image->symbol_count)
            return _moduleBadInput();

        const u8* symbol = image->data + image->symbol_offset + (size_t)index * ModuleSymbolSize;
        u32 string_offset = _moduleRead32(symbol);
        if (string_offset >= image->string_size)
            return _moduleBadInput();

        size_t available = image->string_size - string_offset;
        const char* candidate = (const char*)image->data + image->string_offset + string_offset;
        if (!memchr(candidate, 0, available))
            return _moduleBadInput();
        if (_moduleEligible(symbol) && name_size < available && !memcmp(candidate, name, name_size + 1)) {
            if (nonlocal && symbol[4] < 0x10)
                return MODULE_RESULT_NOT_FOUND;
            u64 value = _moduleRead64(symbol + 8);
            if (_moduleUnsupported(symbol) ||
                !_moduleContains(image, value, _moduleRead64(symbol + 16), 1))
                return _moduleBadInput();
            *out_address = image->load_address + (uintptr_t)value;
            return 0;
        }
        index = _moduleRead32(chains + (size_t)index * 4);
    }
    return MODULE_RESULT_NOT_FOUND;
}

Result moduleLookupSymbol(const ModuleImage* image, const char* name, uintptr_t* out_address) {
    return _moduleFindSymbol(image, name, false, out_address);
}

Result moduleRegister(ModuleRegistry* registry, Module* module, const ModuleImage* image,
                      VoidFn init, VoidFn fini) {
    if (!registry || !module || !image)
        return _moduleBadInput();
    if (registry->initialized || registry->dispatching || module->registry)
        return MAKERESULT(Module_Libnx, LibnxError_AlreadyInitialized);

    ModuleImage view;
    Result rc = moduleReadImage(&view, image->data, image->size, image->load_address);
    if (R_FAILED(rc))
        return rc;

    for (const Module* item = registry->first; item; item = item->next) {
        if (view.load_address < item->image.load_address + item->image.size &&
            item->image.load_address < view.load_address + view.size)
            return _moduleBadInput();
    }

    *module = (Module){
        .image = view, .init = init, .fini = fini,
        .registry = registry, .previous = registry->last,
    };
    if (registry->last)
        registry->last->next = module;
    else
        registry->first = module;
    registry->last = module;
    return 0;
}

Result moduleUnregister(Module* module) {
    if (!module)
        return _moduleBadInput();
    ModuleRegistry* registry = module->registry;
    if (!registry)
        return MAKERESULT(Module_Libnx, LibnxError_NotInitialized);
    if (registry->initialized || registry->dispatching)
        return MAKERESULT(Module_Libnx, LibnxError_AlreadyInitialized);

    if (module->previous)
        module->previous->next = module->next;
    else
        registry->first = module->next;
    if (module->next)
        module->next->previous = module->previous;
    else
        registry->last = module->previous;
    *module = (Module){0};
    return 0;
}

static Result _moduleLookupList(const Module* module, const char* name, uintptr_t* out_address) {
    for (; module; module = module->next) {
        uintptr_t address;
        Result rc = _moduleFindSymbol(&module->image, name, true, &address);
        if (rc == MODULE_RESULT_NOT_FOUND)
            continue;
        if (R_FAILED(rc))
            return rc;
        *out_address = address;
        return 0;
    }
    return MODULE_RESULT_NOT_FOUND;
}

Result moduleLookupGlobalSymbol(const ModuleRegistry* registry, const char* name,
                                uintptr_t* out_address) {
    if (!registry || !name || !out_address)
        return _moduleBadInput();
    return _moduleLookupList(registry->first, name, out_address);
}

Result moduleLookupNextSymbol(const ModuleRegistry* registry, uintptr_t caller_address,
                              const char* name, uintptr_t* out_address) {
    if (!registry || !name || !out_address)
        return _moduleBadInput();
    for (const Module* module = registry->first; module; module = module->next) {
        if (caller_address >= module->image.load_address &&
            caller_address - module->image.load_address < module->image.size)
            return _moduleLookupList(module->next, name, out_address);
    }
    return MODULE_RESULT_NOT_FOUND;
}

typedef struct {
    size_t offset;
    size_t size;
} ModuleRelocationTable;

typedef struct {
    ModuleRelocationTable regular;
    ModuleRelocationTable plt;
    size_t relative_count;
    size_t count;
} ModuleRelocationTables;

static Result _moduleBadRelocation(void) {
    return MAKERESULT(Module_Libnx, LibnxError_BadReloc);
}

static bool _moduleSpansOverlap(u64 first, u64 first_size, u64 second, u64 second_size) {
    if (!first_size || !second_size)
        return false;
    return first <= second ? second - first < first_size : first - second < second_size;
}

static Result _moduleReadRelocations(const ModuleImage* image, ModuleRelocationTables* tables) {
    enum {
        SeenRela = BIT(0),
        SeenRelaSize = BIT(1),
        SeenRelaEntry = BIT(2),
        SeenRelativeCount = BIT(3),
        SeenPlt = BIT(4),
        SeenPltSize = BIT(5),
        SeenPltType = BIT(6),
        RequiredRela = SeenRela | SeenRelaSize,
        RequiredPlt = SeenPlt | SeenPltSize | SeenPltType,
    };
    u32 seen = 0;
    *tables = (ModuleRelocationTables){0};

    for (size_t offset = 0; offset < image->dynamic_size; offset += ModuleDynamicSize) {
        const u8* record = image->data + image->dynamic_offset + offset;
        u64 tag = _moduleRead64(record);
        u64 value = _moduleRead64(record + 8);
        u32 flag = 0;
        size_t* field = NULL;

        switch (tag) {
        case ModuleDynamic_Rela:
            flag = SeenRela;
            field = &tables->regular.offset;
            break;
        case ModuleDynamic_RelaSize:
            flag = SeenRelaSize;
            field = &tables->regular.size;
            break;
        case ModuleDynamic_RelaEntry:
            flag = SeenRelaEntry;
            if (value != ModuleRelaSize)
                return _moduleBadInput();
            break;
        case ModuleDynamic_RelaCount:
            flag = SeenRelativeCount;
            field = &tables->relative_count;
            break;
        case ModuleDynamic_JmpRel:
            flag = SeenPlt;
            field = &tables->plt.offset;
            break;
        case ModuleDynamic_PltSize:
            flag = SeenPltSize;
            field = &tables->plt.size;
            break;
        case ModuleDynamic_PltRel:
            flag = SeenPltType;
            if (value != ModuleDynamic_Rela)
                return _moduleBadRelocation();
            break;
        case ModuleDynamic_Rel:
        case ModuleDynamic_RelSize:
        case ModuleDynamic_RelEntry:
        case ModuleDynamic_RelCount:
        case ModuleDynamic_Relr:
        case ModuleDynamic_RelrSize:
        case ModuleDynamic_RelrEntry:
            return _moduleBadRelocation();
        default:
            break;
        }
        if (seen & flag)
            return _moduleBadInput();
        seen |= flag;
        if (field) {
            if (value > image->size)
                return _moduleBadInput();
            *field = (size_t)value;
        }
    }

    if (((seen & (RequiredRela | SeenRelativeCount)) && (seen & RequiredRela) != RequiredRela) ||
        ((seen & RequiredPlt) && (seen & RequiredPlt) != RequiredPlt) ||
        ((seen & (RequiredRela | RequiredPlt)) && !(seen & SeenRelaEntry)))
        return _moduleBadInput();
    if (tables->regular.size % ModuleRelaSize || tables->plt.size % ModuleRelaSize ||
        ((seen & SeenRela) && !_moduleContains(image, tables->regular.offset, tables->regular.size, 8)) ||
        ((seen & SeenPlt) && !_moduleContains(image, tables->plt.offset, tables->plt.size, 8)) ||
        tables->relative_count > tables->regular.size / ModuleRelaSize ||
        _moduleSpansOverlap(tables->regular.offset, tables->regular.size,
                            tables->plt.offset, tables->plt.size))
        return _moduleBadInput();

    size_t count = tables->regular.size / ModuleRelaSize;
    size_t plt_count = tables->plt.size / ModuleRelaSize;
    if (count > SIZE_MAX - plt_count)
        return _moduleBadInput();
    tables->count = count + plt_count;
    return 0;
}

Result moduleGetRelocationCount(const ModuleImage* image, size_t* out_count) {
    if (!image || !out_count ||
        _moduleSpansOverlap((uintptr_t)out_count, sizeof(*out_count), (uintptr_t)image, sizeof(*image)) ||
        _moduleSpansOverlap((uintptr_t)out_count, sizeof(*out_count), (uintptr_t)image->data, image->size))
        return _moduleBadInput();

    ModuleImage view;
    Result rc = moduleReadImage(&view, image->data, image->size, image->load_address);
    if (R_FAILED(rc))
        return rc;
    ModuleRelocationTables tables;
    rc = _moduleReadRelocations(&view, &tables);
    if (R_SUCCEEDED(rc))
        *out_count = tables.count;
    return rc;
}

static bool _moduleRelocationObjectsSeparate(const ModuleImage* image, const ModuleRegistry* registry) {
    uintptr_t data = (uintptr_t)image->data;
    if (_moduleSpansOverlap(data, image->size, (uintptr_t)image, sizeof(*image)))
        return false;
    if (!registry)
        return true;
    if (_moduleSpansOverlap(data, image->size, (uintptr_t)registry, sizeof(*registry)))
        return false;
    for (const Module* module = registry->first; module; module = module->next) {
        if (_moduleSpansOverlap(data, image->size, (uintptr_t)module, sizeof(*module)))
            return false;
        if ((module->image.data != image->data || module->image.size != image->size) &&
            _moduleSpansOverlap(data, image->size, (uintptr_t)module->image.data, module->image.size))
            return false;
    }
    return true;
}

static bool _moduleWorkspaceOverlaps(const ModuleRelocationWrite* workspace, size_t size,
                                     const void* data, size_t data_size) {
    return _moduleSpansOverlap((uintptr_t)workspace, size, (uintptr_t)data, data_size);
}

static bool _moduleValidWorkspace(const ModuleImage* image, const ModuleRegistry* registry,
                                  ModuleRelocationWrite* workspace, size_t count) {
    if (!count)
        return true;
    if (!workspace || (uintptr_t)workspace % _Alignof(ModuleRelocationWrite) ||
        count > SIZE_MAX / sizeof(*workspace))
        return false;
    size_t size = count * sizeof(*workspace);
    if (size > UINTPTR_MAX - (uintptr_t)workspace ||
        _moduleWorkspaceOverlaps(workspace, size, image, sizeof(*image)) ||
        _moduleWorkspaceOverlaps(workspace, size, image->data, image->size))
        return false;
    if (!registry)
        return true;
    if (_moduleWorkspaceOverlaps(workspace, size, registry, sizeof(*registry)))
        return false;
    for (const Module* module = registry->first; module; module = module->next) {
        if (_moduleWorkspaceOverlaps(workspace, size, module, sizeof(*module)) ||
            _moduleWorkspaceOverlaps(workspace, size, module->image.data, module->image.size))
            return false;
    }
    return true;
}

static bool _moduleRelocationTarget(const ModuleImage* image, const ModuleRelocationTables* tables,
                                    u64 offset) {
    if (!_moduleContains(image, offset, sizeof(u64), 8) ||
        _moduleSpansOverlap(offset, sizeof(u64), 4, 4) ||
        _moduleSpansOverlap(offset, sizeof(u64), image->mod0_offset, 0x1c) ||
        _moduleSpansOverlap(offset, sizeof(u64), image->dynamic_offset, image->dynamic_size) ||
        _moduleSpansOverlap(offset, sizeof(u64), tables->regular.offset, tables->regular.size) ||
        _moduleSpansOverlap(offset, sizeof(u64), tables->plt.offset, tables->plt.size))
        return false;
    if (!image->symbol_count)
        return true;
    u64 hash_size = 8 + ((u64)image->bucket_count + image->symbol_count) * 4;
    return !_moduleSpansOverlap(offset, sizeof(u64), image->hash_offset, hash_size) &&
        !_moduleSpansOverlap(offset, sizeof(u64), image->symbol_offset,
                             (u64)image->symbol_count * ModuleSymbolSize) &&
        !_moduleSpansOverlap(offset, sizeof(u64), image->string_offset, image->string_size);
}

static Result _moduleResolveRelocation(const ModuleImage* image, u32 index,
                                       const ModuleRegistry* registry, ModuleSymbolResolver resolver,
                                       void* user, uintptr_t* out_address) {
    if (index >= image->symbol_count)
        return _moduleBadInput();
    const u8* symbol = image->data + image->symbol_offset + (size_t)index * ModuleSymbolSize;
    if (_moduleUnsupported(symbol))
        return _moduleBadRelocation();

    const char* name = (const char*)image->data + image->string_offset + _moduleRead32(symbol);
    uintptr_t address = 0;
    Result rc = MODULE_RESULT_NOT_FOUND;
    if (symbol[5] & 3) {
        rc = moduleLookupSymbol(image, name, &address);
    } else {
        if (registry)
            rc = moduleLookupGlobalSymbol(registry, name, &address);
        if ((rc == MODULE_RESULT_NOT_FOUND || (R_SUCCEEDED(rc) && !address)) && resolver)
            rc = resolver(user, image, name, &address);
    }
    if (rc != MODULE_RESULT_NOT_FOUND && R_FAILED(rc))
        return rc;
    if (R_SUCCEEDED(rc) && address) {
        *out_address = address;
        return 0;
    }
    if ((symbol[4] & 0xf0) != 0x20)
        return MODULE_RESULT_NOT_FOUND;
    *out_address = 0;
    return 0;
}

static Result _moduleAddRelocation(uintptr_t address, u64 addend, u64* out_value) {
    if (addend & (UINT64_C(1) << 63)) {
        u64 magnitude = ~addend + 1;
        if (magnitude > address)
            return _moduleBadRelocation();
        *out_value = (u64)address - magnitude;
    } else {
        if (addend > UINTPTR_MAX - address)
            return _moduleBadRelocation();
        *out_value = (u64)address + addend;
    }
    return 0;
}

static Result _moduleStageRelocation(const ModuleImage* image, const ModuleRelocationTables* tables,
                                     size_t index, const ModuleRegistry* registry,
                                     ModuleSymbolResolver resolver, void* user,
                                     ModuleRelocationWrite* workspace) {
    size_t regular_count = tables->regular.size / ModuleRelaSize;
    bool plt = index >= regular_count;
    size_t record_offset = plt ? tables->plt.offset + (index - regular_count) * ModuleRelaSize :
                                tables->regular.offset + index * ModuleRelaSize;
    const u8* record = image->data + record_offset;
    u64 offset = _moduleRead64(record);
    u64 info = _moduleRead64(record + 8);
    u32 type = (u32)info;
    u32 symbol_index = (u32)(info >> 32);
    bool relative = index < tables->relative_count;

    if ((relative && (type != ModuleRelocation_Relative || symbol_index)) ||
        (plt && type != ModuleRelocation_JumpSlot) ||
        (!relative && !plt && type != ModuleRelocation_Abs64 && type != ModuleRelocation_GlobalData))
        return _moduleBadRelocation();
    if (!_moduleRelocationTarget(image, tables, offset))
        return _moduleBadInput();
    uintptr_t address = image->load_address;
    if (!relative) {
        Result rc = _moduleResolveRelocation(image, symbol_index, registry, resolver, user, &address);
        if (R_FAILED(rc))
            return rc;
    }
    u64 value;
    Result rc = _moduleAddRelocation(address, _moduleRead64(record + 16), &value);
    if (R_SUCCEEDED(rc))
        workspace[index] = (ModuleRelocationWrite){ .offset = (size_t)offset, .value = value };
    return rc;
}

static int _moduleCompareRelocationWrites(const void* first, const void* second) {
    const ModuleRelocationWrite* left = first;
    const ModuleRelocationWrite* right = second;
    if (left->offset < right->offset)
        return -1;
    return left->offset > right->offset;
}

Result moduleRelocateImage(const ModuleImage* image, void* writable_image,
                           const ModuleRegistry* registry, ModuleSymbolResolver resolver,
                           void* user, ModuleRelocationWrite* workspace, size_t workspace_count) {
    if (!image || !writable_image || writable_image != image->data ||
        !_moduleRelocationObjectsSeparate(image, registry))
        return _moduleBadInput();
    if (registry && (registry->initialized || registry->dispatching))
        return MAKERESULT(Module_Libnx, LibnxError_AlreadyInitialized);

    ModuleImage view;
    Result rc = moduleReadImage(&view, image->data, image->size, image->load_address);
    if (R_FAILED(rc))
        return rc;
    ModuleRelocationTables tables;
    rc = _moduleReadRelocations(&view, &tables);
    if (R_FAILED(rc))
        return rc;
    if (workspace_count < tables.count || !_moduleValidWorkspace(image, registry, workspace, tables.count))
        return _moduleBadInput();

    for (size_t i = 0; i < tables.count; i++) {
        rc = _moduleStageRelocation(&view, &tables, i, registry, resolver, user, workspace);
        if (R_FAILED(rc))
            return rc;
    }
    if (tables.count > 1) {
        qsort(workspace, tables.count, sizeof(*workspace), _moduleCompareRelocationWrites);
        for (size_t i = 1; i < tables.count; i++) {
            if (_moduleSpansOverlap(workspace[i - 1].offset, sizeof(u64), workspace[i].offset, sizeof(u64)))
                return _moduleBadInput();
        }
    }
    u8* bytes = writable_image;
    for (size_t i = 0; i < tables.count; i++) {
        for (size_t byte = 0; byte < sizeof(u64); byte++)
            bytes[workspace[i].offset + byte] = (u8)(workspace[i].value >> (byte * 8));
    }
    return 0;
}

Result moduleRunInitializers(ModuleRegistry* registry) {
    if (!registry)
        return _moduleBadInput();
    if (registry->initialized || registry->dispatching)
        return MAKERESULT(Module_Libnx, LibnxError_AlreadyInitialized);

    registry->dispatching = true;
    for (const Module* module = registry->last; module; module = module->previous) {
        if (module->init)
            module->init();
    }
    registry->initialized = true;
    registry->dispatching = false;
    return 0;
}

Result moduleRunFinalizers(ModuleRegistry* registry) {
    if (!registry)
        return _moduleBadInput();
    if (registry->dispatching)
        return MAKERESULT(Module_Libnx, LibnxError_AlreadyInitialized);
    if (!registry->initialized)
        return MAKERESULT(Module_Libnx, LibnxError_NotInitialized);

    registry->dispatching = true;
    for (const Module* module = registry->first; module; module = module->next) {
        if (module->fini)
            module->fini();
    }
    registry->initialized = false;
    registry->dispatching = false;
    return 0;
}
