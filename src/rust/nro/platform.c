#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <switch.h>

#define LOG_DIRECTORY "sdmc:/switch/moonlight-nx2/rust"

static FILE *report;
static PadState input_pad;

_Static_assert(sizeof(GsvSync) == 8, "GsvSync ABI");
_Static_assert(sizeof(GsvGpu) == 8, "GsvGpu ABI");
_Static_assert(sizeof(Event) == 12, "Event ABI");
_Static_assert(sizeof(TransferMemory) == 40, "TransferMemory ABI");
_Static_assert(sizeof(MemoryInfo) == 40, "MemoryInfo ABI");
_Static_assert(sizeof(Vi2DisplayModeCapability) == 24, "VI2 capabilities ABI");
_Static_assert(_Alignof(Vi2DisplayModeCapability) == 8, "VI2 capabilities alignment");
_Static_assert(sizeof(AppletOperationMode) == 4, "OperationMode ABI");
_Static_assert(sizeof(Mutex) == 4, "Mutex ABI");
_Static_assert(sizeof(HidNpadCommonState) == 40, "Npad shader ABI");
_Static_assert(offsetof(HidNpadCommonState, buttons) == 8, "Npad buttons ABI");
_Static_assert(offsetof(HidNpadCommonState, analog_stick_l) == 16, "Npad left stick ABI");
_Static_assert(offsetof(HidNpadCommonState, analog_stick_r) == 24, "Npad right stick ABI");
_Static_assert(offsetof(HidNpadCommonState, attributes) == 32, "Npad attributes ABI");
_Static_assert(sizeof(HidTouchState) == 40, "Touch entry ABI");
_Static_assert(sizeof(HidTouchScreenState) == 656, "Touch shader ABI");
_Static_assert(offsetof(HidTouchScreenState, count) == 8, "Touch count ABI");
_Static_assert(offsetof(HidTouchScreenState, touches) == 16, "Touch array ABI");
_Static_assert(MAKERESULT(Module_Libnx, LibnxError_BadInput) == ((11u << 9) | 345u), "BadInput ABI");

uint64_t moonlightNowNs(void) { return armTicksToNs(armGetSystemTick()); }

bool moonlightPlatformNetStart(void) { return R_SUCCEEDED(socketInitializeDefault()); }
void moonlightPlatformNetStop(void) { socketExit(); }

void moonlightPlatformInputStart(void)
{
    padConfigureInput(1, HidNpadStyleSet_NpadStandard);
    padInitializeDefault(&input_pad);
    hidInitializeTouchScreen();
}

uint64_t moonlightPlatformStackAvailable(void)
{
    uintptr_t stack;
    __asm__ volatile("mov %0, sp" : "=r"(stack));
    MemoryInfo info = {0};
    uint32_t page = 0;
    Result result = svcQueryMemory(&info, &page, stack);
    if (R_FAILED(result) || (info.perm & Perm_Rw) != Perm_Rw || stack < info.addr ||
        stack - info.addr >= info.size)
        return 0;
    return stack - info.addr;
}

uint32_t moonlightPlatformFileStatus(const char *path)
{
    struct stat info;
    if (stat(path, &info) == 0)
        return 1;
    return errno == ENOENT ? 0 : 2;
}

bool moonlightPlatformDirectoryCreate(const char *path)
{
    if (mkdir(path, 0777) == 0)
        return true;
    struct stat info;
    return errno == EEXIST && stat(path, &info) == 0 && S_ISDIR(info.st_mode);
}

bool moonlightPlatformDirectoryExclusive(const char *path)
{
    return mkdir(path, 0777) == 0;
}

bool moonlightPlatformDumpFile(const char *path, const uint8_t *bytes, size_t length)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0)
        return false;
    FILE *file = fdopen(fd, "wb");
    if (!file) {
        close(fd);
        return false;
    }
    bool written = fwrite(bytes, 1, length, file) == length;
    written = fflush(file) == 0 && written;
    return fclose(file) == 0 && written;
}

bool moonlightPlatformInputRead(uint64_t sample, uint8_t *input, size_t bytes)
{
    if (!input || bytes < 128 + sizeof(HidTouchScreenState))
        return false;
    padUpdate(&input_pad);
    HidNpadCommonState state = {0};
    state.sampling_number = sample;
    state.buttons = padGetButtons(&input_pad);
    state.analog_stick_l = padGetStickPos(&input_pad, 0);
    state.analog_stick_r = padGetStickPos(&input_pad, 1);
    state.attributes = padIsConnected(&input_pad) ? HidNpadAttribute_IsConnected : 0;
    memcpy(input, &state, sizeof(state));
    HidTouchScreenState touch = {0};
    hidGetTouchScreenStates(&touch, 1);
    memcpy(input + 128, &touch, sizeof(touch));
    return true;
}

bool moonlightPlatformStart(void)
{
    if (!moonlightPlatformDirectoryCreate("sdmc:/switch") ||
        !moonlightPlatformDirectoryCreate("sdmc:/switch/moonlight-nx2") ||
        !moonlightPlatformDirectoryCreate(LOG_DIRECTORY))
        return false;
    char path[160];
    snprintf(path, sizeof(path), "%s/runtime-%016" PRIx64 ".log", LOG_DIRECTORY, armGetSystemTick());
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
    if (fd < 0)
        return false;
    report = fdopen(fd, "w");
    if (!report)
        close(fd);
    return report != NULL;
}

void moonlightPlatformLog(const uint8_t *message, size_t bytes)
{
    if (!report)
        return;
    fwrite(message, 1, bytes, report);
    fputc('\n', report);
    fflush(report);
}

bool moonlightPlatformFinish(void)
{
    if (!report)
        return false;
    FILE *closing = report;
    report = NULL;
    return fclose(closing) == 0;
}

_Noreturn void moonlightPlatformAbort(void)
{
    static const uint8_t message[] = "runtime: Rust panic, exiting process";
    moonlightPlatformLog(message, sizeof(message) - 1);
    svcExitProcess();
}

void *moonlightAllocate(size_t bytes, size_t alignment)
{
    if (alignment < sizeof(void *))
        alignment = sizeof(void *);
    if (bytes > SIZE_MAX - (alignment - 1))
        return NULL;
    size_t padded = (bytes + alignment - 1) & ~(alignment - 1);
    return aligned_alloc(alignment, padded);
}

void moonlightFree(void *memory) { free(memory); }

extern int moonlightRustMain(void);

int main(void) { return moonlightRustMain(); }
