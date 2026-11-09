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

#define EXTRA_PADS 7
#define EXTRA_OFFSET 1024
#define SLOT_BYTES 32
#define MOTION_OFFSET (EXTRA_OFFSET + EXTRA_PADS * SLOT_BYTES)
#define EXTENDED_BYTES (MOTION_OFFSET + (EXTRA_PADS + 1) * SLOT_BYTES)

static FILE *report;
static PadState input_pad;
static PadState extra_pads[EXTRA_PADS];

/* Six-axis handles per player, made for the style the controller had when first read. */
typedef struct {
    uint32_t style;
    HidSixAxisSensorHandle handles[2];
    int count;
} Motion;
static Motion motion[EXTRA_PADS + 1];

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
    padConfigureInput(1 + EXTRA_PADS, HidNpadStyleSet_NpadStandard);
    padInitializeDefault(&input_pad);
    for (int slot = 0; slot < EXTRA_PADS; slot++)
        padInitialize(&extra_pads[slot], (HidNpadIdType)(HidNpadIdType_No2 + slot));
    hidInitializeTouchScreen();
}

static void stop_motion(Motion *entry)
{
    for (int i = 0; i < entry->count; i++)
        hidStopSixAxisSensor(entry->handles[i]);
    entry->count = 0;
    entry->style = 0;
}

/* One motion sample in 1/1000 m/s^2 and 1/1000 deg/s; false when the player has no sensor. */
static bool read_motion(int index, HidNpadIdType id, int32_t out[6])
{
    Motion *entry = &motion[index];
    uint32_t styles = hidGetNpadStyleSet(id);
    uint32_t style = styles & HidNpadStyleTag_NpadFullKey     ? HidNpadStyleTag_NpadFullKey
                     : styles & HidNpadStyleTag_NpadHandheld  ? HidNpadStyleTag_NpadHandheld
                     : styles & HidNpadStyleTag_NpadJoyDual   ? HidNpadStyleTag_NpadJoyDual
                     : styles & HidNpadStyleTag_NpadJoyRight  ? HidNpadStyleTag_NpadJoyRight
                     : styles & HidNpadStyleTag_NpadJoyLeft   ? HidNpadStyleTag_NpadJoyLeft
                                                              : 0;
    if (style != entry->style) {
        stop_motion(entry);
        if (!style)
            return false;
        int count = style == HidNpadStyleTag_NpadJoyDual ? 2 : 1;
        if (R_FAILED(hidGetSixAxisSensorHandles(entry->handles, count, id, (HidNpadStyleTag)style)))
            return false;
        for (int i = 0; i < count; i++)
            hidStartSixAxisSensor(entry->handles[i]);
        entry->count = count;
        entry->style = style;
    }
    /* A dual Joy-Con pair reports the right controller, which holds the face buttons. */
    HidSixAxisSensorState state = {0};
    if (hidGetSixAxisSensorStates(entry->handles[entry->count - 1], &state, 1) == 0)
        return false;
    const float standard_gravity = 9.80665f, degrees_per_turn = 360.0f;
    float values[6] = {
        state.acceleration.x * standard_gravity, state.acceleration.y * standard_gravity,
        state.acceleration.z * standard_gravity, state.angular_velocity.x * degrees_per_turn,
        state.angular_velocity.y * degrees_per_turn, state.angular_velocity.z * degrees_per_turn,
    };
    for (int i = 0; i < 6; i++)
        out[i] = (int32_t)(values[i] * 1000.0f);
    return true;
}

static void write_pad(uint8_t *slot, PadState *pad)
{
    uint64_t buttons = padGetButtons(pad);
    HidAnalogStickState sticks[2] = {padGetStickPos(pad, 0), padGetStickPos(pad, 1)};
    int32_t axes[4] = {sticks[0].x, sticks[0].y, sticks[1].x, sticks[1].y};
    uint32_t attributes = padIsConnected(pad) ? 1 : 0;
    memset(slot, 0, SLOT_BYTES);
    memcpy(slot, &buttons, sizeof(buttons));
    memcpy(slot + 8, axes, sizeof(axes));
    memcpy(slot + 24, &attributes, sizeof(attributes));
}

static void write_motion(uint8_t *slot, int index, HidNpadIdType id, bool connected)
{
    int32_t values[6];
    uint32_t valid = connected && read_motion(index, id, values);
    if (!connected)
        stop_motion(&motion[index]);
    memset(slot, 0, SLOT_BYTES);
    if (valid)
        memcpy(slot, values, sizeof(values));
    memcpy(slot + 24, &valid, sizeof(valid));
}

/* Players 2 to 8 and every player's motion, above the block the publish shader reads. */
static void read_extended(uint8_t *input)
{
    bool handheld = hidGetNpadStyleSet(HidNpadIdType_Handheld) & HidNpadStyleTag_NpadHandheld;
    write_motion(input + MOTION_OFFSET, 0, handheld ? HidNpadIdType_Handheld : HidNpadIdType_No1,
                 padIsConnected(&input_pad));
    for (int slot = 0; slot < EXTRA_PADS; slot++) {
        padUpdate(&extra_pads[slot]);
        write_pad(input + EXTRA_OFFSET + slot * SLOT_BYTES, &extra_pads[slot]);
        write_motion(input + MOTION_OFFSET + (slot + 1) * SLOT_BYTES, slot + 1,
                     (HidNpadIdType)(HidNpadIdType_No2 + slot), padIsConnected(&extra_pads[slot]));
    }
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
    if (bytes >= EXTENDED_BYTES)
        read_extended(input);
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
