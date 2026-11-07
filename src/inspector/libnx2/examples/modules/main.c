// SPDX-License-Identifier: ISC
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libnx2/runtime/module.h>
#include <libnx2/runtime/trampoline.h>

#define MAX_IMAGE_SIZE (UINT64_C(512) * 1024 * 1024)

typedef struct Options {
    const char* filename;
    uintptr_t load_address;
    const char* symbol;
    bool inspect_trampolines;
    size_t name_table_offset;
    size_t offset_table_offset;
} Options;

static void usage(FILE* stream, const char* program) {
    fprintf(stream, "Usage: %s <image> <load-address> [--symbol <name>]\n"
                    "       [--trampolines <name-table-offset> <offset-table-offset>]\n"
                    "\n"
                    "Reads a contiguous mapped image including BSS, up to 512 MiB.\n"
                    "Addresses and offsets accept decimal or 0x hexadecimal.\n",
            program);
}

static bool parse_number(const char* text, uintmax_t limit, uintmax_t* out) {
    if (!text || text[0] < '0' || text[0] > '9')
        return false;
    int base = text[0] == '0' && (text[1] == 'x' || text[1] == 'X') ? 16 : 10;
    char* end;
    errno = 0;
    uintmax_t value = strtoumax(text, &end, base);
    if (errno == ERANGE || end == text || *end || value > limit)
        return false;
    *out = value;
    return true;
}

static bool parse_options(int argc, char** argv, Options* out) {
    if (argc < 3)
        return false;
    Options options = { .filename = argv[1] };
    uintmax_t value;
    if (!parse_number(argv[2], UINTPTR_MAX, &value)) {
        fprintf(stderr, "Invalid load address: %s\n", argv[2]);
        return false;
    }
    options.load_address = (uintptr_t)value;
    for (int i = 3; i < argc; i++) {
        if (!strcmp(argv[i], "--symbol")) {
            if (options.symbol || i + 1 >= argc || !argv[i + 1][0]) {
                fprintf(stderr, "--symbol requires one nonempty name and may appear once.\n");
                return false;
            }
            options.symbol = argv[++i];
        } else if (!strcmp(argv[i], "--trampolines")) {
            if (options.inspect_trampolines || argc - i < 3) {
                fprintf(stderr, "--trampolines requires two offsets and may appear once.\n");
                return false;
            }
            if (!parse_number(argv[++i], SIZE_MAX, &value)) {
                fprintf(stderr, "Invalid name table offset: %s\n", argv[i]);
                return false;
            }
            options.name_table_offset = (size_t)value;
            if (!parse_number(argv[++i], SIZE_MAX, &value)) {
                fprintf(stderr, "Invalid branch table offset: %s\n", argv[i]);
                return false;
            }
            options.offset_table_offset = (size_t)value;
            options.inspect_trampolines = true;
        } else {
            fprintf(stderr, "Unknown option: %s\n", argv[i]);
            return false;
        }
    }
    *out = options;
    return true;
}

static bool read_image_file(const char* filename, u8** out_data, size_t* out_size) {
    FILE* file = fopen(filename, "rb");
    if (!file) {
        fprintf(stderr, "Cannot open %s: %s\n", filename, strerror(errno));
        return false;
    }
    u8* data = NULL;
    if (fseek(file, 0, SEEK_END) != 0) {
        fprintf(stderr, "Cannot seek in %s: %s\n", filename, strerror(errno));
        goto failed;
    }
    long length = ftell(file);
    if (length < 0) {
        fprintf(stderr, "Cannot determine the size of %s: %s\n", filename, strerror(errno));
        goto failed;
    }
    if (length == 0 || (uintmax_t)length > MAX_IMAGE_SIZE || (uintmax_t)length > SIZE_MAX) {
        fprintf(stderr, "Image size must be between 1 byte and 512 MiB.\n");
        goto failed;
    }
    size_t size = (size_t)length;
    if (fseek(file, 0, SEEK_SET) != 0) {
        fprintf(stderr, "Cannot seek in %s: %s\n", filename, strerror(errno));
        goto failed;
    }
    data = malloc(size);
    if (!data) {
        fprintf(stderr, "Cannot allocate %zu bytes for the image.\n", size);
        goto failed;
    }
    if (fread(data, 1, size, file) != size) {
        if (ferror(file))
            fprintf(stderr, "Cannot read %s: %s\n", filename, strerror(errno));
        else
            fprintf(stderr, "Image became shorter while reading %s.\n", filename);
        goto failed;
    }
    int extra = fgetc(file);
    if (ferror(file)) {
        fprintf(stderr, "Cannot finish reading %s: %s\n", filename, strerror(errno));
        goto failed;
    }
    if (extra != EOF) {
        fprintf(stderr, "Image became longer while reading %s.\n", filename);
        goto failed;
    }
    if (fclose(file) != 0) {
        fprintf(stderr, "Cannot close %s: %s\n", filename, strerror(errno));
        free(data);
        return false;
    }
    *out_data = data;
    *out_size = size;
    return true;

failed:
    free(data);
    fclose(file);
    return false;
}

static bool lookup_symbol(const ModuleImage* image, const char* name) {
    ModuleRegistry registry = {0};
    Module module = {0};
    Result rc = moduleRegister(&registry, &module, image, NULL, NULL);
    if (R_FAILED(rc)) {
        fprintf(stderr, "Cannot register the image for symbol lookup (result 0x%08" PRIx32 ").\n", rc);
        return false;
    }
    uintptr_t address;
    rc = moduleLookupGlobalSymbol(&registry, name, &address);
    Result cleanup = moduleUnregister(&module);
    if (rc == MODULE_RESULT_NOT_FOUND) {
        fprintf(stderr, "Symbol not found: %s\n", name);
        return false;
    }
    if (R_FAILED(rc)) {
        fprintf(stderr, "Cannot look up %s (result 0x%08" PRIx32 ").\n", name, rc);
        return false;
    }
    if (R_FAILED(cleanup)) {
        fprintf(stderr, "Cannot unregister the image (result 0x%08" PRIx32 ").\n", cleanup);
        return false;
    }
    printf("Symbol %s: 0x%" PRIxPTR "\n", name, address);
    return true;
}

static bool inspect_trampolines(const u8* data, size_t size, const Options* options) {
    TrampolineTable table;
    Result rc = trampolineTableOpen(&table, data, size, options->load_address,
                                     options->name_table_offset, options->offset_table_offset);
    if (R_FAILED(rc)) {
        fprintf(stderr, "Invalid trampoline tables (result 0x%08" PRIx32 ").\n", rc);
        return false;
    }
    printf("Trampolines: %zu\n", table.count);
    for (size_t i = 0; i < table.count; i++) {
        TrampolineEntry entry;
        rc = trampolineTableGetEntry(&table, i, &entry);
        if (R_FAILED(rc)) {
            fprintf(stderr, "Cannot read trampoline %zu (result 0x%08" PRIx32 ").\n", i, rc);
            return false;
        }
        printf("  %zu: %s -> 0x%" PRIx64 " (+0x%zx)\n",
               i, entry.name, entry.target_address, entry.target_offset);
    }
    return true;
}

static bool inspect_image(const u8* data, size_t size, const Options* options) {
    if (size > UINTPTR_MAX - options->load_address) {
        fprintf(stderr, "Image range overflows the supplied load address.\n");
        return false;
    }
    ModuleImage image;
    Result rc = moduleReadImage(&image, data, size, options->load_address);
    if (R_FAILED(rc)) {
        fprintf(stderr, "Invalid mapped module image (result 0x%08" PRIx32 ").\n", rc);
        return false;
    }
    printf("Image size: %zu bytes\n", size);
    printf("Load address: 0x%" PRIxPTR "\n", image.load_address);
    printf("MOD0: +0x%zx\n", image.mod0_offset);
    printf("Dynamic table: +0x%zx (%zu bytes)\n", image.dynamic_offset, image.dynamic_size);
    printf("BSS: +0x%zx (%zu bytes)\n", image.bss_offset, image.bss_size);
    printf("Symbols: %" PRIu32 "\n", image.symbol_count);
    if (options->symbol && !lookup_symbol(&image, options->symbol))
        return false;
    return !options->inspect_trampolines || inspect_trampolines(data, size, options);
}

int main(int argc, char** argv) {
    if (argc == 2 && !strcmp(argv[1], "--help")) {
        usage(stdout, argv[0]);
        return 0;
    }
    Options options;
    if (!parse_options(argc, argv, &options)) {
        usage(stderr, argv[0]);
        return 2;
    }
    u8* data;
    size_t size;
    if (!read_image_file(options.filename, &data, &size))
        return 1;
    bool success = inspect_image(data, size, &options);
    free(data);
    if (ferror(stdout) || fflush(stdout) != 0) {
        fprintf(stderr, "Cannot write output: %s\n", strerror(errno));
        return 1;
    }
    return success ? 0 : 1;
}
