#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <switch.h>

void __real_moonlightPlatformLog(const uint8_t *message, size_t bytes);

void __wrap_moonlightPlatformLog(const uint8_t *message, size_t bytes)
{
    static char path[160];
    static bool initialized;
    int flags = O_WRONLY | O_APPEND;
    if (!initialized) {
        snprintf(path, sizeof(path), "sdmc:/switch/moonlight-nx2/rust/b2ar-%016" PRIx64 ".log", armGetSystemTick());
        flags |= O_CREAT | O_EXCL;
        initialized = true;
    }
    int fd = open(path, flags, 0666);
    bool ok = false;
    if (fd >= 0) {
        FILE *file = fdopen(fd, "a");
        if (file != NULL) {
            ok = fwrite(message, 1, bytes, file) == bytes && fputc('\n', file) != EOF;
            ok = fflush(file) == 0 && ok;
            ok = fclose(file) == 0 && ok;
        } else {
            close(fd);
        }
    }
    if (!ok) {
        static const uint8_t failure[] = "b2ar: breadcrumb write failed";
        __real_moonlightPlatformLog(failure, sizeof(failure) - 1);
    }
    __real_moonlightPlatformLog(message, bytes);
}
