// libnx2 usefulness check: lists this process's MOD0 modules and reads them with libnx2's
// module parser. Reads only; calls nothing it finds. LIBNX2-ASSESSMENT.md, "DUT probe".
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include <switch.h>

#include "inspect.h"
#include "scan.h"

#define CHECK_DIRECTORY "sdmc:/switch/moonlight-nx2/libnx2-check"
#define MAX_MODULES 32u

__attribute__((used, visibility("default"))) const uint32_t libnx2CheckAnchor = 0x3258584e;

static const char *const lookups[] = {
    "libnx2CheckAnchor",
    "nnMain",
    "nninitStartup",
    "nvnBootstrapLoader",
    "vkGetInstanceProcAddr",
};
#define LOOKUPS (sizeof(lookups) / sizeof(lookups[0]))

static FILE *report;

static void note(const char *format, ...) __attribute__((format(printf, 1, 2)));

static void note(const char *format, ...)
{
    if (!report)
        return;

    va_list args;
    va_start(args, format);
    fprintf(report, "%" PRIu64 " ", armTicksToNs(armGetSystemTick()) / 1000000);
    vfprintf(report, format, args);
    fputc('\n', report);
    va_end(args);
    fflush(report);
}

static bool open_report(void)
{
    if (mkdir(CHECK_DIRECTORY, 0777) < 0 && errno != EEXIST)
        return false;

    char path[160];
    snprintf(path, sizeof(path), "%s/check-%016" PRIx64 ".log", CHECK_DIRECTORY, armGetSystemTick());
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0)
        return false;
    report = fdopen(fd, "w");
    if (!report)
        close(fd);
    return report != NULL;
}

static bool query(void *user, uint64_t address, CheckRegion *out)
{
    (void)user;
    MemoryInfo info;
    u32 page = 0;
    if (R_FAILED(svcQueryMemory(&info, &page, address)))
        return false;

    *out = (CheckRegion){
        .address = info.addr,
        .size = info.size,
        .type = info.type,
        .perm = info.perm,
    };
    if (info.type == MemType_Io || (info.attr & MemAttr_IsUncached))
        out->perm = 0;
    return true;
}

static const uint8_t *view(void *user, uint64_t address)
{
    (void)user;
    return (const uint8_t *)(uintptr_t)address;
}

static void log_map(void)
{
    uint64_t address = 0;
    for (unsigned i = 0; i < 4096; i++) {
        CheckRegion region;
        if (!query(NULL, address, &region) || region.size == 0)
            break;
        if (region.type != MemType_Unmapped)
            note("map %010" PRIx64 " %010" PRIx64 " type 0x%x perm %u", region.address, region.size,
                region.type, region.perm);

        uint64_t next = region.address + region.size;
        if (next <= address)
            break;
        address = next;
    }
}

static bool inspect_module(const CheckModule *module, bool *self)
{
    uintptr_t addresses[LOOKUPS];
    uint32_t results[LOOKUPS];
    CheckImageSummary summary;
    const void *image = (const void *)(uintptr_t)module->base;
    checkInspectImage(image, module->span, module->base, lookups, LOOKUPS, addresses, results, &summary);

    note("module %s base %010" PRIx64 " span 0x%" PRIx64 " mod0 0x%x type 0x%x read 0x%x", module->name,
        module->base, module->span, module->mod0_offset, module->text_type, summary.read_result);
    if (summary.read_result != 0)
        return false;

    note("  dynamic 0x%" PRIx64 " bss 0x%" PRIx64 "+0x%" PRIx64 " symbols %u init %010" PRIx64,
        summary.dynamic_offset, summary.bss_offset, summary.bss_size, summary.symbol_count,
        summary.init_address);
    for (size_t i = 0; i < LOOKUPS; i++) {
        if (results[i] == 0)
            note("  symbol %s %010" PRIxPTR, lookups[i], addresses[i]);
    }

    uintptr_t anchor = (uintptr_t)&libnx2CheckAnchor;
    bool contains = anchor >= module->base && anchor - module->base < module->span;
    if (contains) {
        *self = results[0] == 0 && addresses[0] == anchor;
        note("  self anchor %010" PRIxPTR " lookup %010" PRIxPTR " result 0x%x: %s", anchor, addresses[0],
            results[0], *self ? "MATCH" : "MISMATCH");
    }
    return true;
}

int main(void)
{
    if (!open_report())
        return 1;

    note("check: start, libnx2 module parser c278681+wt, anchor %010" PRIxPTR,
        (uintptr_t)&libnx2CheckAnchor);
    log_map();

    CheckMemory memory = {.query = query, .view = view};
    CheckModule modules[MAX_MODULES];
    size_t found = checkFindModules(&memory, modules, MAX_MODULES);
    note("check: %zu MOD0 modules", found);

    bool self = false;
    size_t parsed = 0;
    for (size_t i = 0; i < found; i++) {
        if (inspect_module(&modules[i], &self))
            parsed++;
    }

    note("check: parsed %zu of %zu, self %s", parsed, found, self ? "MATCH" : "MISSING");
    note("check: result %s", self && parsed == found ? "PASS" : "FAIL");
    fclose(report);
    return 0;
}
