#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

#include <switch.h>

#include "../proof.h"

#define PROBE_DIRECTORY "sdmc:/switch/moonlight-nx2/rust-proof"

_Static_assert(sizeof(MoonlightRustControlHeader) == 12, "Unexpected header size");
_Static_assert(offsetof(MoonlightRustControlHeader, request_id) == 4, "Unexpected request ID offset");
_Static_assert(offsetof(MoonlightRustControlHeader, payload_bytes) == 8, "Unexpected payload length offset");

#ifdef MOONLIGHT_RUST_ALLOCATOR_PROOF
static uint64_t expected_checksum(uint32_t seed)
{
    uint64_t checksum = UINT64_C(0xcbf29ce484222325);
    for (unsigned block = 0; block < 8; block++) {
        uint8_t value = (uint8_t)(seed + block * 17u);
        for (unsigned byte = 0; byte < 64; byte++) {
            checksum ^= value;
            checksum *= UINT64_C(0x100000001b3);
        }
    }
    return checksum;
}
#endif

static bool run(FILE *report)
{
    const uint8_t header[] = {
        0x4d, 0x4e, 0x43, 0x31, 1, 0, 3, 0,
        0xef, 0xcd, 0xab, 0x89, 0, 0, 1, 0,
    };
    MoonlightRustControlHeader parsed = {0};
    uint32_t result = moonlightRustReadControlHeader(header, sizeof(header), &parsed);
    bool header_ok = result == MOONLIGHT_RUST_OK && parsed.kind == 3;
    header_ok = header_ok && parsed.request_id == UINT32_C(0x89abcdef) && parsed.payload_bytes == 65536;
    fprintf(report, "header: result=%u kind=%u request=%08x bytes=%u %s\n",
        result, parsed.kind, parsed.request_id, parsed.payload_bytes, header_ok ? "PASS" : "FAIL");
    fflush(report);

#ifdef MOONLIGHT_RUST_ALLOCATOR_PROOF
    bool allocations_ok = true;
    for (uint32_t seed = 0; seed < 32; seed++) {
        uint64_t checksum = 0;
        result = moonlightRustCheckAllocation(seed, &checksum);
        if (result != MOONLIGHT_RUST_OK || checksum != expected_checksum(seed)) {
            fprintf(report, "allocation: seed=%u result=%u checksum=%016" PRIx64 " FAIL\n",
                seed, result, checksum);
            allocations_ok = false;
            break;
        }
    }
    fprintf(report, "allocation: 32 aligned Rust Vec round trips %s\n", allocations_ok ? "PASS" : "FAIL");
    return header_ok && allocations_ok;
#else
    fprintf(report, "allocation: not enabled in this proof\n");
    return header_ok;
#endif
}

int main(void)
{
    if (mkdir(PROBE_DIRECTORY, 0777) < 0 && errno != EEXIST)
        return 1;

    char path[160];
    snprintf(path, sizeof(path), "%s/proof-%016" PRIx64 ".log", PROBE_DIRECTORY, armGetSystemTick());
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0)
        return 1;
    FILE *report = fdopen(fd, "w");
    if (!report) {
        close(fd);
        return 1;
    }

    fprintf(report, "Moonlight Rust proof: C entry, libounce runtime, no streaming\n");
    fflush(report);
    bool passed = run(report);
    fprintf(report, "proof: result %s\n", passed ? "PASS" : "FAIL");
    if (fclose(report) != 0)
        return 1;
    return passed ? 0 : 1;
}
