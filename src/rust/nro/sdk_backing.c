/* Locked OunceVK backing metadata (ouncevk fd483fb, libouncevk.a 9b8d1de4, alias copy b33546d8).
 * Offsets and lock ABI: the getter v2, SDK prerequisite and alias reviews in the Moonlight builds root. */
#include "sdk_backing.h"

#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#define SDK_PRIVATE __attribute__((visibility("hidden")))

extern const unsigned char moonlight_ouncevk_mem_ops[0x50] SDK_PRIVATE;
extern unsigned char moonlight_ouncevk_device[0x66590] SDK_PRIVATE;
bool moonlight_ouncevk_owner_lock(void *owner) SDK_PRIVATE;
void moonlight_ouncevk_owner_unlock(void *owner) SDK_PRIVATE;

enum {
    VK_MEMORY_REQUESTED_SIZE = 0x48,
    VK_MEMORY_NATIVE = 0x78,

    MEM_OPS = 0x00,
    MEM_SIZE = 0x30,
    MEM_ARENA = 0x90,
    MEM_SLICE = 0x98,

    SLICE_ARENA_ID = 0x00,
    SLICE_CPU = 0x08,
    SLICE_GPU = 0x10,
    SLICE_OFFSET = 0x18,
    SLICE_SIZE = 0x20,
    SLICE_COOKIE = 0x28,

    ARENA_SELF = 0x00,
    ARENA_OWNER = 0x08,
    ARENA_ID = 0x10,
    ARENA_CPU = 0x18,
    ARENA_GPU = 0x20,
    ARENA_SIZE = 0x28,
    ARENA_USED = 0x30,

    BACKING_SELF = 0x00,
    BACKING_ID = 0x08,
    BACKING_CPU = 0x10,
    BACKING_SIZE = 0x18,
    BACKING_HANDLE = 0x20,
    BACKING_READY = 0x2d,

    OWNER_SELF = 0x00,
    OWNER_PRIMARY_BACKING = 0x10,
    OWNER_PRIMARY_ARENA = 0x70,
    OWNER_SEGMENTS = 0x100,
    OWNER_SEGMENT_COUNT = 0x60100,
    OWNER_LOCK_BLOCK = 0x663b8,
    OWNER_LOCK_FLAGS = 0x663c0,
    SEGMENT_STRIDE = 0x180,
    SEGMENT_LIVE = 0x04,
    SEGMENT_BACKING = 0x30,
    SEGMENT_ARENA = 0x120,
    SEGMENT_LIMIT = (OWNER_SEGMENT_COUNT - OWNER_SEGMENTS) / SEGMENT_STRIDE,

    LOCK_HOLDER = 0x20,
};

#define PAGE_MASK UINT64_C(0xfff)
#define BACKING_CPU_END UINT64_C(0x8000000000)

#if defined(__aarch64__) && !defined(MOONLIGHT_SDK_BACKING_HOST_TEST)
static uintptr_t currentThreadToken(void)
{
    uintptr_t token;
    __asm__ volatile("mrs %0, tpidrro_el0" : "=r"(token));
    return token;
}
#else
uintptr_t moonlightSdkBackingTestThreadToken(void);
static uintptr_t currentThreadToken(void) { return moonlightSdkBackingTestThreadToken(); }
#endif

static uint64_t load64(uintptr_t base, size_t offset)
{
    uint64_t value;
    __builtin_memcpy(&value, (const void *)(base + offset), sizeof(value));
    return value;
}

static uint32_t load32(uintptr_t base, size_t offset)
{
    uint32_t value;
    __builtin_memcpy(&value, (const void *)(base + offset), sizeof(value));
    return value;
}

static uint8_t load8(uintptr_t base, size_t offset)
{
    return *(const volatile uint8_t *)(base + offset);
}

static bool addOverflows(uint64_t a, uint64_t b, uint64_t *sum)
{
    return __builtin_add_overflow(a, b, sum);
}

static uintptr_t ownerAddress(void)
{
    return (uintptr_t)moonlight_ouncevk_device;
}

static bool retired(const MoonlightSdkBackingRequest *request)
{
    if (request->retired == NULL)
        return false;
    return __atomic_load_n(request->retired, __ATOMIC_ACQUIRE) != 0;
}

static MoonlightSdkBackingLockStatus checkLockable(uintptr_t owner)
{
    bool tagged = load64(owner, OWNER_SELF) == owner;
    bool initialized = (load8(owner, OWNER_LOCK_FLAGS) & 1) != 0;
    uintptr_t block = (uintptr_t)load64(owner, OWNER_LOCK_BLOCK);
    if (!tagged || !initialized || block == 0)
        return MOONLIGHT_SDK_BACKING_LOCK_NOT_INITIALIZED;

    uintptr_t token = currentThreadToken();
    if (token == 0)
        return MOONLIGHT_SDK_BACKING_LOCK_NO_THREAD_TOKEN;

    uintptr_t holder = *(const volatile uintptr_t *)(block + LOCK_HOLDER);
    if (holder == token)
        return MOONLIGHT_SDK_BACKING_LOCK_ALREADY_HELD;

    return MOONLIGHT_SDK_BACKING_LOCK_OK;
}

typedef struct Located {
    uintptr_t backing;
    uint32_t source;
    uint32_t index;
} Located;

static MoonlightSdkBackingStatus checkOwner(uintptr_t owner)
{
    if (owner != ownerAddress())
        return MOONLIGHT_SDK_BACKING_STATUS_OWNER_MISMATCH;
    if (load64(owner, OWNER_SELF) != owner)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_OWNER;
    if (load32(owner, OWNER_SEGMENT_COUNT) > SEGMENT_LIMIT)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_OWNER;
    return MOONLIGHT_SDK_BACKING_STATUS_OK;
}

static MoonlightSdkBackingStatus locateBacking(uintptr_t owner, uintptr_t arena, Located *found)
{
    if (arena == owner + OWNER_PRIMARY_ARENA) {
        found->backing = owner + OWNER_PRIMARY_BACKING;
        found->source = MOONLIGHT_SDK_BACKING_PRIMARY;
        found->index = 0;
        return MOONLIGHT_SDK_BACKING_STATUS_OK;
    }

    uintptr_t first = owner + OWNER_SEGMENTS + SEGMENT_ARENA;
    if (arena < first || (arena - first) % SEGMENT_STRIDE != 0)
        return MOONLIGHT_SDK_BACKING_STATUS_UNKNOWN_SEGMENT;

    uint64_t index = (arena - first) / SEGMENT_STRIDE;
    if (index >= load32(owner, OWNER_SEGMENT_COUNT))
        return MOONLIGHT_SDK_BACKING_STATUS_UNKNOWN_SEGMENT;

    uintptr_t record = owner + OWNER_SEGMENTS + (uintptr_t)index * SEGMENT_STRIDE;
    if ((load8(record, SEGMENT_LIVE) & 1) == 0)
        return MOONLIGHT_SDK_BACKING_STATUS_SEGMENT_NOT_LIVE;

    found->backing = record + SEGMENT_BACKING;
    found->source = MOONLIGHT_SDK_BACKING_SEGMENT;
    found->index = (uint32_t)index;
    return MOONLIGHT_SDK_BACKING_STATUS_OK;
}

static MoonlightSdkBackingStatus checkArena(uintptr_t arena)
{
    uint64_t cpu = load64(arena, ARENA_CPU);
    uint64_t gpu = load64(arena, ARENA_GPU);
    uint64_t size = load64(arena, ARENA_SIZE);
    uint64_t used = load64(arena, ARENA_USED);
    uint64_t end;

    bool present = cpu != 0 && gpu != 0 && size != 0 && load64(arena, ARENA_ID) != 0;
    if (!present)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_ARENA;

    if (((cpu | gpu | size) & PAGE_MASK) != 0)
        return MOONLIGHT_SDK_BACKING_STATUS_MISALIGNED;

    if (addOverflows(cpu, size, &end) || addOverflows(gpu, size, &end))
        return MOONLIGHT_SDK_BACKING_STATUS_OVERFLOW;

    if (used > size)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_ARENA;

    return MOONLIGHT_SDK_BACKING_STATUS_OK;
}

static MoonlightSdkBackingStatus checkSlice(uintptr_t mem, uintptr_t arena)
{
    uintptr_t slice = mem + MEM_SLICE;
    uint64_t offset = load64(slice, SLICE_OFFSET);
    uint64_t size = load64(slice, SLICE_SIZE);
    uint64_t end;

    bool ownedHere = load64(slice, SLICE_ARENA_ID) == load64(arena, ARENA_ID);
    bool live = load64(slice, SLICE_COOKIE) != 0;
    if (!ownedHere || !live || size == 0)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_SLICE;

    if (((offset | size) & PAGE_MASK) != 0)
        return MOONLIGHT_SDK_BACKING_STATUS_MISALIGNED;

    if (addOverflows(offset, size, &end))
        return MOONLIGHT_SDK_BACKING_STATUS_OVERFLOW;
    if (end > load64(arena, ARENA_USED))
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_SLICE;

    bool cpuMatches = load64(slice, SLICE_CPU) == load64(arena, ARENA_CPU) + offset;
    bool gpuMatches = load64(slice, SLICE_GPU) == load64(arena, ARENA_GPU) + offset;
    if (!cpuMatches || !gpuMatches)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_SLICE;

    if (load64(mem, MEM_SIZE) != size)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_SLICE;

    return MOONLIGHT_SDK_BACKING_STATUS_OK;
}

static MoonlightSdkBackingStatus checkRequested(uintptr_t vk, uintptr_t mem)
{
    uint64_t requested = load64(vk, VK_MEMORY_REQUESTED_SIZE);

    if (requested == 0 || requested > load64(mem, MEM_SIZE))
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_SIZE;
    return MOONLIGHT_SDK_BACKING_STATUS_OK;
}

static MoonlightSdkBackingStatus checkBacking(uintptr_t backing, uintptr_t arena)
{
    if (load64(backing, BACKING_SELF) != backing)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_BACKING;

    bool sameIdentity = load64(backing, BACKING_ID) == load64(arena, ARENA_ID);
    bool sameCpu = load64(backing, BACKING_CPU) == load64(arena, ARENA_CPU);
    bool sameSize = load64(backing, BACKING_SIZE) == load64(arena, ARENA_SIZE);
    if (!sameIdentity || !sameCpu || !sameSize)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_BACKING;

    uint64_t cpu = load64(backing, BACKING_CPU);
    uint64_t size = load64(backing, BACKING_SIZE);
    if (cpu - 1 > BACKING_CPU_END - 2 || size == 0)
        return MOONLIGHT_SDK_BACKING_STATUS_ADDRESS_LIMIT;
    if (((cpu | size) & PAGE_MASK) != 0)
        return MOONLIGHT_SDK_BACKING_STATUS_MISALIGNED;
    if (BACKING_CPU_END - cpu < size)
        return MOONLIGHT_SDK_BACKING_STATUS_ADDRESS_LIMIT;

    bool ready = (load8(backing, BACKING_READY) & 1) != 0;
    if (!ready || load32(backing, BACKING_HANDLE) == 0)
        return MOONLIGHT_SDK_BACKING_STATUS_NOT_REGISTERED;

    return MOONLIGHT_SDK_BACKING_STATUS_OK;
}

static MoonlightSdkBackingStatus snapshot(uintptr_t vk, MoonlightSdkBackingInfo *out)
{
    uintptr_t mem = (uintptr_t)load64(vk, VK_MEMORY_NATIVE);
    if (mem == 0)
        return MOONLIGHT_SDK_BACKING_STATUS_NO_NATIVE_MEMORY;
    if (load64(mem, MEM_OPS) != (uintptr_t)moonlight_ouncevk_mem_ops)
        return MOONLIGHT_SDK_BACKING_STATUS_FOREIGN_OPS;

    uintptr_t arena = (uintptr_t)load64(mem, MEM_ARENA);
    if (arena == 0 || load64(arena, ARENA_SELF) != arena)
        return MOONLIGHT_SDK_BACKING_STATUS_BAD_ARENA;

    uintptr_t owner = (uintptr_t)load64(arena, ARENA_OWNER);
    MoonlightSdkBackingStatus status = checkOwner(owner);
    if (status != MOONLIGHT_SDK_BACKING_STATUS_OK)
        return status;

    status = checkArena(arena);
    if (status != MOONLIGHT_SDK_BACKING_STATUS_OK)
        return status;

    status = checkSlice(mem, arena);
    if (status != MOONLIGHT_SDK_BACKING_STATUS_OK)
        return status;

    status = checkRequested(vk, mem);
    if (status != MOONLIGHT_SDK_BACKING_STATUS_OK)
        return status;

    Located found;
    status = locateBacking(owner, arena, &found);
    if (status != MOONLIGHT_SDK_BACKING_STATUS_OK)
        return status;

    status = checkBacking(found.backing, arena);
    if (status != MOONLIGHT_SDK_BACKING_STATUS_OK)
        return status;

    uintptr_t slice = mem + MEM_SLICE;
    out->abi_version = MOONLIGHT_SDK_BACKING_ABI_VERSION;
    out->memory_handle = load32(found.backing, BACKING_HANDLE);
    out->cpu_address = load64(slice, SLICE_CPU);
    out->gpu_address = load64(slice, SLICE_GPU);
    out->requested_size = load64(vk, VK_MEMORY_REQUESTED_SIZE);
    out->native_size = load64(mem, MEM_SIZE);
    out->slice_size = load64(slice, SLICE_SIZE);
    out->backing_cpu_base = load64(found.backing, BACKING_CPU);
    out->backing_size = load64(found.backing, BACKING_SIZE);
    out->relative_offset = out->cpu_address - out->backing_cpu_base;
    out->arena_used = load64(arena, ARENA_USED);
    out->source = found.source;
    out->segment_index = found.index;
    out->owner_verified = 1;
    return MOONLIGHT_SDK_BACKING_STATUS_OK;
}

static MoonlightSdkBackingResult fail(MoonlightSdkBackingReport *report, MoonlightSdkBackingResult result)
{
    report->result = result;
    return result;
}

MoonlightSdkBackingResult moonlightSdkBackingQuery(const MoonlightSdkBackingRequest *request,
                                                   MoonlightSdkBackingReport *report)
{
    if (report == NULL)
        return MOONLIGHT_SDK_BACKING_BAD_ARGUMENT;
    memset(report, 0, sizeof(*report));
    report->abi_version = MOONLIGHT_SDK_BACKING_ABI_VERSION;

    if (request == NULL)
        return fail(report, MOONLIGHT_SDK_BACKING_BAD_ARGUMENT);
    bool versionOk = request->abi_version == MOONLIGHT_SDK_BACKING_ABI_VERSION;
    if (!versionOk || request->reserved != 0)
        return fail(report, MOONLIGHT_SDK_BACKING_ABI_MISMATCH);
    if (request->device_memory == 0)
        return fail(report, MOONLIGHT_SDK_BACKING_BAD_ARGUMENT);
    if (retired(request))
        return fail(report, MOONLIGHT_SDK_BACKING_RETIRED);

    uintptr_t owner = ownerAddress();
    MoonlightSdkBackingInfo info;
    memset(&info, 0, sizeof(info));
    MoonlightSdkBackingLockStatus lock = checkLockable(owner);
    report->lock_status = lock;
    if (lock != MOONLIGHT_SDK_BACKING_LOCK_OK)
        return fail(report, MOONLIGHT_SDK_BACKING_LOCK);

    if (!moonlight_ouncevk_owner_lock((void *)owner)) {
        report->lock_status = MOONLIGHT_SDK_BACKING_LOCK_FAILED;
        return fail(report, MOONLIGHT_SDK_BACKING_LOCK);
    }
    MoonlightSdkBackingStatus status = snapshot((uintptr_t)request->device_memory, &info);
    moonlight_ouncevk_owner_unlock((void *)owner);

    report->metadata_status = status;
    if (status != MOONLIGHT_SDK_BACKING_STATUS_OK)
        return fail(report, MOONLIGHT_SDK_BACKING_METADATA);
    if (retired(request))
        return fail(report, MOONLIGHT_SDK_BACKING_RETIRED);

    report->info = info;
    report->result = MOONLIGHT_SDK_BACKING_OK;
    return MOONLIGHT_SDK_BACKING_OK;
}

static const char *nameAt(const char *const *names, size_t count, uint32_t value)
{
    return value < count ? names[value] : "unknown";
}

const char *moonlightSdkBackingResultName(uint32_t result)
{
    static const char *const names[] = {
        "ok", "bad-argument", "abi-mismatch", "retired", "lock", "metadata",
    };
    return nameAt(names, sizeof(names) / sizeof(names[0]), result);
}

const char *moonlightSdkBackingLockStatusName(uint32_t status)
{
    static const char *const names[] = {
        "ok", "bad-argument", "foreign-owner", "not-initialized", "no-thread-token", "already-held",
        "lock-failed",
    };
    return nameAt(names, sizeof(names) / sizeof(names[0]), status);
}

const char *moonlightSdkBackingStatusName(uint32_t status)
{
    static const char *const names[] = {
        "ok", "bad-argument", "no-native-memory", "foreign-ops", "bad-arena",
        "owner-mismatch", "bad-slice", "unknown-segment", "segment-not-live",
        "bad-backing", "not-registered", "overflow", "misaligned",
        "bad-owner", "address-limit", "bad-size", "abi-mismatch",
    };
    return nameAt(names, sizeof(names) / sizeof(names[0]), status);
}
