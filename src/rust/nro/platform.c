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
#include <dirent.h>
#include <time.h>
#include <unistd.h>

#include <switch.h>

#define LOG_DIRECTORY "sdmc:/switch/moonlight-nx2/rust"
#define PATH_BYTES 320
#define EXPORT_DIRECTORY "sdmc:/switch/moonlight-nx2/logs"

/* Controller sources: handheld, then No1 to No8. Rust decides which one plays which player. */
#define SOURCES 9
#define PLAYERS 8
#define SLOT_BYTES 32
#define SOURCE_BYTES (2 * SLOT_BYTES)

static FILE *report;
static PadState pads[SOURCES];

/* Six-axis handles per source, made for the style the controller had when first read. */
typedef struct {
    uint32_t style;
    HidSixAxisSensorHandle handles[2];
    int count;
} Motion;
static Motion motion[SOURCES];

/* Vibration handles per source, remade when the controller style changes. */
typedef struct {
    uint32_t style;
    HidVibrationDeviceHandle handles[2];
    int count;
    bool moving;
} Vibration;
static Vibration vibration[SOURCES];

_Static_assert(sizeof(GsvSync) == 12, "GsvSync ABI");
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

/* Key material: the kernel-seeded generator, mixed with the csrng service where it opens. */
void moonlightPlatformRandom(uint8_t *out, size_t bytes)
{
    randomGet(out, bytes);
    uint8_t extra[64];
    if (R_FAILED(csrngInitialize()))
        return;
    for (size_t done = 0; done < bytes;) {
        size_t count = bytes - done < sizeof(extra) ? bytes - done : sizeof(extra);
        if (R_FAILED(csrngGetRandomBytes(extra, count)))
            break;
        for (size_t i = 0; i < count; i++)
            out[done + i] ^= extra[i];
        done += count;
    }
    memset(extra, 0, sizeof(extra));
    csrngExit();
}
void moonlightPlatformNetStop(void) { socketExit(); }

static HidNpadIdType source_id(int source)
{
    return source == 0 ? HidNpadIdType_Handheld : (HidNpadIdType)(HidNpadIdType_No1 + source - 1);
}

void moonlightPlatformInputStart(void)
{
    padConfigureInput(PLAYERS, HidNpadStyleSet_NpadStandard);
    for (int source = 0; source < SOURCES; source++)
        padInitialize(&pads[source], source_id(source));
    hidInitializeTouchScreen();
}

static void stop_motion(Motion *entry)
{
    for (int i = 0; i < entry->count; i++)
        hidStopSixAxisSensor(entry->handles[i]);
    entry->count = 0;
    entry->style = 0;
}

/* One motion sample in 1/1000 m/s^2 and 1/1000 deg/s; false when the source has no sensor. */
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

/* Every source's pad slot and motion slot. */
static void read_sources(uint8_t *sources)
{
    for (int source = 0; source < SOURCES; source++) {
        uint8_t *slot = sources + source * SOURCE_BYTES;
        padUpdate(&pads[source]);
        write_pad(slot, &pads[source]);
        write_motion(slot + SLOT_BYTES, source, source_id(source), padIsConnected(&pads[source]));
    }
}

static uint32_t vibration_style(HidNpadIdType id)
{
    uint32_t styles = hidGetNpadStyleSet(id);
    return styles & HidNpadStyleTag_NpadFullKey     ? HidNpadStyleTag_NpadFullKey
           : styles & HidNpadStyleTag_NpadHandheld  ? HidNpadStyleTag_NpadHandheld
           : styles & HidNpadStyleTag_NpadJoyDual   ? HidNpadStyleTag_NpadJoyDual
           : styles & HidNpadStyleTag_NpadJoyRight  ? HidNpadStyleTag_NpadJoyRight
           : styles & HidNpadStyleTag_NpadJoyLeft   ? HidNpadStyleTag_NpadJoyLeft
                                                    : 0;
}

static void send_vibration(Vibration *entry, uint16_t low, uint16_t high)
{
    HidVibrationValue value = {
        .amp_low = low / 65535.0f,
        .freq_low = 160.0f,
        .amp_high = high / 65535.0f,
        .freq_high = 320.0f,
    };
    HidVibrationValue values[2] = {value, value};
    if (entry->count > 0 && R_SUCCEEDED(hidSendVibrationValues(entry->handles, values, entry->count)))
        entry->moving = low || high;
}

void moonlightPlatformRumble(uint32_t source, uint16_t low, uint16_t high)
{
    if (source >= SOURCES)
        return;
    HidNpadIdType id = source_id((int)source);
    Vibration *entry = &vibration[source];
    uint32_t style = vibration_style(id);
    if (style != entry->style) {
        if (entry->moving)
            send_vibration(entry, 0, 0);
        entry->style = style;
        entry->count = 0;
        entry->moving = false;
        int count = style & (HidNpadStyleTag_NpadJoyLeft | HidNpadStyleTag_NpadJoyRight) ? 1 : 2;
        if (style && R_SUCCEEDED(hidInitializeVibrationDevices(entry->handles, count, id,
                                                               (HidNpadStyleTag)style)))
            entry->count = count;
    }
    if (entry->moving || low || high)
        send_vibration(entry, low, high);
}

void moonlightPlatformRumbleStop(void)
{
    for (int source = 0; source < SOURCES; source++)
        if (vibration[source].moving)
            send_vibration(&vibration[source], 0, 0);
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

static bool newest_log(char *path, size_t size)
{
    DIR *directory = opendir(LOG_DIRECTORY);
    if (!directory)
        return false;
    time_t newest = 0;
    bool found = false;
    for (struct dirent *entry; (entry = readdir(directory));) {
        char candidate[PATH_BYTES];
        struct stat info;
        if (strncmp(entry->d_name, "runtime-", 8) != 0)
            continue;
        snprintf(candidate, sizeof(candidate), "%s/%s", LOG_DIRECTORY, entry->d_name);
        if (stat(candidate, &info) != 0 || (found && info.st_mtime < newest))
            continue;
        newest = info.st_mtime;
        found = snprintf(path, size, "%s", candidate) < (int)size;
    }
    closedir(directory);
    return found;
}

/* Copies the newest runtime log to sdmc:/switch/moonlight-nx2/logs under a dated name. */
bool moonlightPlatformExportLog(void)
{
    char source[PATH_BYTES];
    char target[PATH_BYTES];
    if (!newest_log(source, sizeof(source)) || !moonlightPlatformDirectoryCreate(EXPORT_DIRECTORY))
        return false;
    time_t now = time(NULL);
    struct tm *local = localtime(&now);
    char stamp[32];
    if (!local || strftime(stamp, sizeof(stamp), "%Y%m%d-%H%M%S", local) == 0)
        snprintf(stamp, sizeof(stamp), "%016" PRIx64, armGetSystemTick());
    snprintf(target, sizeof(target), "%s/moonlight-%s.log", EXPORT_DIRECTORY, stamp);

    FILE *from = fopen(source, "rb");
    FILE *to = from ? fopen(target, "wb") : NULL;
    bool copied = to != NULL;
    uint8_t buffer[4096];
    for (size_t count; copied && (count = fread(buffer, 1, sizeof(buffer), from)) > 0;)
        copied = fwrite(buffer, 1, count, to) == count;
    if (from)
        fclose(from);
    return to && fclose(to) == 0 && copied;
}

/* Rust fills the pad blocks of `input` from `sources` (SOURCES * SOURCE_BYTES bytes). */
bool moonlightPlatformInputRead(uint64_t sample, uint8_t *input, size_t bytes, uint8_t *sources)
{
    if (!input || !sources || bytes < 128 + sizeof(HidTouchScreenState))
        return false;
    HidNpadCommonState state = {0};
    state.sampling_number = sample;
    memcpy(input, &state, sizeof(state));
    HidTouchScreenState touch = {0};
    hidGetTouchScreenStates(&touch, 1);
    memcpy(input + 128, &touch, sizeof(touch));
    read_sources(sources);
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
