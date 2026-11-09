#ifndef MOONLIGHT_SDK_BACKING_H
#define MOONLIGHT_SDK_BACKING_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MOONLIGHT_SDK_BACKING_ABI_VERSION 2u

typedef enum MoonlightSdkBackingResult {
    MOONLIGHT_SDK_BACKING_OK = 0,
    MOONLIGHT_SDK_BACKING_BAD_ARGUMENT,
    MOONLIGHT_SDK_BACKING_ABI_MISMATCH,
    MOONLIGHT_SDK_BACKING_RETIRED,
    MOONLIGHT_SDK_BACKING_LOCK,
    MOONLIGHT_SDK_BACKING_METADATA,
} MoonlightSdkBackingResult;

typedef enum MoonlightSdkBackingLockStatus {
    MOONLIGHT_SDK_BACKING_LOCK_OK = 0,
    MOONLIGHT_SDK_BACKING_LOCK_BAD_ARGUMENT,
    MOONLIGHT_SDK_BACKING_LOCK_FOREIGN_OWNER,
    MOONLIGHT_SDK_BACKING_LOCK_NOT_INITIALIZED,
    MOONLIGHT_SDK_BACKING_LOCK_NO_THREAD_TOKEN,
    MOONLIGHT_SDK_BACKING_LOCK_ALREADY_HELD,
    MOONLIGHT_SDK_BACKING_LOCK_FAILED,
} MoonlightSdkBackingLockStatus;

typedef enum MoonlightSdkBackingStatus {
    MOONLIGHT_SDK_BACKING_STATUS_OK = 0,
    MOONLIGHT_SDK_BACKING_STATUS_BAD_ARGUMENT,
    MOONLIGHT_SDK_BACKING_STATUS_NO_NATIVE_MEMORY,
    MOONLIGHT_SDK_BACKING_STATUS_FOREIGN_OPS,
    MOONLIGHT_SDK_BACKING_STATUS_BAD_ARENA,
    MOONLIGHT_SDK_BACKING_STATUS_OWNER_MISMATCH,
    MOONLIGHT_SDK_BACKING_STATUS_BAD_SLICE,
    MOONLIGHT_SDK_BACKING_STATUS_UNKNOWN_SEGMENT,
    MOONLIGHT_SDK_BACKING_STATUS_SEGMENT_NOT_LIVE,
    MOONLIGHT_SDK_BACKING_STATUS_BAD_BACKING,
    MOONLIGHT_SDK_BACKING_STATUS_NOT_REGISTERED,
    MOONLIGHT_SDK_BACKING_STATUS_OVERFLOW,
    MOONLIGHT_SDK_BACKING_STATUS_MISALIGNED,
    MOONLIGHT_SDK_BACKING_STATUS_BAD_OWNER,
    MOONLIGHT_SDK_BACKING_STATUS_ADDRESS_LIMIT,
    MOONLIGHT_SDK_BACKING_STATUS_BAD_SIZE,
    MOONLIGHT_SDK_BACKING_STATUS_ABI_MISMATCH,
} MoonlightSdkBackingStatus;

enum {
    MOONLIGHT_SDK_BACKING_PRIMARY = 1,
    MOONLIGHT_SDK_BACKING_SEGMENT = 2,
};

/* device_memory is the VkDeviceMemory handle value. retired is optional;
 * a nonzero value read before locking or after unlocking fails the query. */
typedef struct MoonlightSdkBackingRequest {
    uint32_t abi_version;
    uint32_t reserved;
    uint64_t device_memory;
    const volatile uint32_t *retired;
} MoonlightSdkBackingRequest;

/* requested_size is the only usable byte count; the other sizes are metadata. */
typedef struct MoonlightSdkBackingInfo {
    uint32_t abi_version;
    uint32_t memory_handle;
    uint64_t cpu_address;
    uint64_t gpu_address;
    uint64_t requested_size;
    uint64_t native_size;
    uint64_t slice_size;
    uint64_t relative_offset;
    uint64_t backing_cpu_base;
    uint64_t backing_size;
    uint64_t arena_used;
    uint32_t source;
    uint32_t segment_index;
    uint32_t owner_verified;
    uint32_t reserved;
} MoonlightSdkBackingInfo;

typedef struct MoonlightSdkBackingReport {
    uint32_t abi_version;
    uint32_t result;
    uint32_t lock_status;
    uint32_t metadata_status;
    MoonlightSdkBackingInfo info;
} MoonlightSdkBackingReport;

#if !defined(__LP64__) && !defined(_LP64)
#error "sdk_backing is LP64 only"
#endif

#ifdef __cplusplus
#define MOONLIGHT_SDK_BACKING_ASSERT static_assert
#else
#define MOONLIGHT_SDK_BACKING_ASSERT _Static_assert
#endif

MOONLIGHT_SDK_BACKING_ASSERT(sizeof(MoonlightSdkBackingRequest) == 0x18, "request size");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingRequest, device_memory) == 0x08, "request memory");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingRequest, retired) == 0x10, "request retired");
MOONLIGHT_SDK_BACKING_ASSERT(sizeof(MoonlightSdkBackingInfo) == 0x60, "info size");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, memory_handle) == 0x04, "info handle");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, cpu_address) == 0x08, "info cpu");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, gpu_address) == 0x10, "info gpu");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, requested_size) == 0x18, "info requested");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, native_size) == 0x20, "info native");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, slice_size) == 0x28, "info slice");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, relative_offset) == 0x30, "info offset");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, backing_cpu_base) == 0x38, "info base");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, backing_size) == 0x40, "info backing size");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, arena_used) == 0x48, "info used");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, source) == 0x50, "info source");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, segment_index) == 0x54, "info index");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, owner_verified) == 0x58, "info owner");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingInfo, reserved) == 0x5c, "info reserved");
MOONLIGHT_SDK_BACKING_ASSERT(sizeof(MoonlightSdkBackingReport) == 0x70, "report size");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingReport, lock_status) == 0x08, "report lock");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingReport, metadata_status) == 0x0c, "report metadata");
MOONLIGHT_SDK_BACKING_ASSERT(offsetof(MoonlightSdkBackingReport, info) == 0x10, "report info");

/* Locks the OunceVK native owner on the calling SDK thread, copies metadata for one
 * application-owned live VkDeviceMemory, then unlocks. The caller keeps the allocation,
 * device and renderer alive and pauses allocate/free, image teardown, swapchain
 * recreation and exit for the call. The SDK mutex may block. */
MoonlightSdkBackingResult moonlightSdkBackingQuery(const MoonlightSdkBackingRequest *request,
                                                   MoonlightSdkBackingReport *report);

const char *moonlightSdkBackingResultName(uint32_t result);
const char *moonlightSdkBackingLockStatusName(uint32_t status);
const char *moonlightSdkBackingStatusName(uint32_t status);

#ifdef __cplusplus
}
#endif

#endif
