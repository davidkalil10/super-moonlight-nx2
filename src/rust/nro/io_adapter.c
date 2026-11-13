// ABI translation for runtime/src/{net,audio_device}.rs: BSD sockets and audout. No state
// beyond the audout buffer descriptors.
#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <switch.h>

#define AUDIO_SLOTS 16u

enum {
    IO_OK = 0,
    IO_WOULD_BLOCK,
    IO_INTERRUPTED,
    IO_REFUSED,
    IO_DISCONNECTED,
    IO_FAILED,
    IO_IN_PROGRESS,
    IO_CLOSE_FAILED,
};

enum {
    AUDIO_OK = 0,
    AUDIO_REFUSED,
    AUDIO_UNCERTAIN,
};

typedef struct {
    int64_t value;
    int32_t error;
    uint32_t kind;
} MoonlightIoStatus;

typedef struct {
    uint32_t sample_rate;
    uint32_t channels;
    uint32_t sample_bits;
    bool sample_signed;
} MoonlightIoAudioFormat;

_Static_assert(sizeof(MoonlightIoStatus) == 16, "MoonlightIoStatus ABI");
_Static_assert(sizeof(MoonlightIoAudioFormat) == 16, "MoonlightIoAudioFormat ABI");
_Static_assert(sizeof(AudioOutBuffer) == 40, "AudioOutBuffer ABI");
_Static_assert(MSG_DONTWAIT == 0x80, "MSG_DONTWAIT ABI");
_Static_assert(SOCK_DGRAM == 2 && IPPROTO_UDP == 17, "UDP socket ABI");

static AudioOutBuffer audio_buffers[AUDIO_SLOTS];
static bool audio_open;

static void set(MoonlightIoStatus *status, int64_t value, uint32_t kind, int error)
{
    status->value = value;
    status->kind = kind;
    status->error = error;
}

static uint32_t classify(int error)
{
    if (error == EAGAIN || error == EWOULDBLOCK)
        return IO_WOULD_BLOCK;
    if (error == EINTR)
        return IO_INTERRUPTED;
    if (error == ECONNREFUSED)
        return IO_REFUSED;
    return IO_DISCONNECTED;
}

static void open_socket(const uint8_t address[4], uint16_t port, int type, int protocol, MoonlightIoStatus *status)
{
    int fd = socket(AF_INET, type, protocol);
    if (fd < 0) {
        set(status, -1, IO_FAILED, errno);
        return;
    }

    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        int error = errno;
        set(status, -1, close(fd) == 0 ? IO_FAILED : IO_CLOSE_FAILED, error);
        return;
    }

    /* Best effort: acknowledgements and input must not wait for Nagle. A refused option
     * leaves the socket usable. */
    if (type == SOCK_STREAM) {
        int value = 1;
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &value, sizeof(value));
    }

    struct sockaddr_in endpoint;
    memset(&endpoint, 0, sizeof(endpoint));
    if (type == SOCK_DGRAM)
        endpoint.sin_len = sizeof(endpoint);
    endpoint.sin_family = AF_INET;
    endpoint.sin_port = htons(port);
    memcpy(&endpoint.sin_addr, address, 4);

    if (connect(fd, (const struct sockaddr *)&endpoint, sizeof(endpoint)) == 0) {
        set(status, fd, IO_OK, 0);
        return;
    }
    if (errno == EINPROGRESS || errno == EINTR) {
        set(status, fd, IO_IN_PROGRESS, errno);
        return;
    }
    set(status, fd, classify(errno), errno);
}

void moonlightIoSocketOpen(const uint8_t address[4], uint16_t port, MoonlightIoStatus *status)
{
    open_socket(address, port, SOCK_STREAM, IPPROTO_TCP, status);
}

void moonlightIoDatagramOpen(const uint8_t address[4], uint16_t port, MoonlightIoStatus *status)
{
    open_socket(address, port, SOCK_DGRAM, IPPROTO_UDP, status);
}

/* Room for a 4K keyframe's fragments between two receive passes: the largest size up to the
 * socket service's limit that the stack accepts, and what it reports back. A refused size
 * leaves the default buffer, and the last refusal's errno is kept. */
void moonlightIoDatagramReceiveBuffer(int fd, int32_t limit, int32_t *requested, int32_t *granted,
                                      int32_t *error)
{
    *requested = 0;
    *error = 0;
    for (int size = limit; size >= 64 * 1024; size /= 2) {
        if (setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &size, sizeof(size)) == 0) {
            *requested = size;
            break;
        }
        *error = errno;
    }
    int value = 0;
    socklen_t length = sizeof(value);
    if (getsockopt(fd, SOL_SOCKET, SO_RCVBUF, &value, &length) == 0) {
        *granted = value;
    } else {
        *granted = -1;
        *error = errno;
    }
}

/* An unconnected, nonblocking UDP socket on an ephemeral port for one mDNS query: answers
 * come back by unicast (QU question) from any responder, so it is not connected to a peer. */
void moonlightIoDiscoveryOpen(MoonlightIoStatus *status)
{
    int fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (fd < 0) {
        set(status, -1, IO_FAILED, errno);
        return;
    }
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0) {
        int error = errno;
        set(status, -1, close(fd) == 0 ? IO_FAILED : IO_CLOSE_FAILED, error);
        return;
    }
    set(status, fd, IO_OK, 0);
}

void moonlightIoDiscoverySend(int32_t fd, const uint8_t address[4], uint16_t port, const void *data,
                              size_t bytes, MoonlightIoStatus *status)
{
    struct sockaddr_in endpoint;
    memset(&endpoint, 0, sizeof(endpoint));
    endpoint.sin_len = sizeof(endpoint);
    endpoint.sin_family = AF_INET;
    endpoint.sin_port = htons(port);
    memcpy(&endpoint.sin_addr, address, 4);
    ssize_t count = sendto(fd, data, bytes, MSG_DONTWAIT, (const struct sockaddr *)&endpoint,
                           sizeof(endpoint));
    if (count < 0)
        set(status, -1, classify(errno), errno);
    else
        set(status, count, IO_OK, 0);
}

void moonlightIoSocketPollConnect(int32_t fd, MoonlightIoStatus *status)
{
    struct pollfd entry = {.fd = fd, .events = POLLOUT};
    int ready = poll(&entry, 1, 0);
    if (ready < 0) {
        set(status, 0, classify(errno), errno);
        return;
    }
    if (ready == 0) {
        set(status, 0, IO_OK, 0);
        return;
    }

    int error = 0;
    socklen_t length = sizeof(error);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0) {
        set(status, 0, IO_FAILED, errno);
        return;
    }
    if (error) {
        set(status, 0, error == ECONNREFUSED ? IO_REFUSED : IO_DISCONNECTED, error);
        return;
    }
    set(status, 1, IO_OK, 0);
}

void moonlightIoSocketSend(int32_t fd, const void *data, size_t bytes, MoonlightIoStatus *status)
{
    ssize_t count = send(fd, data, bytes, MSG_DONTWAIT);
    if (count < 0)
        set(status, -1, classify(errno), errno);
    else
        set(status, count, IO_OK, 0);
}

void moonlightIoSocketRecv(int32_t fd, void *data, size_t bytes, MoonlightIoStatus *status)
{
    ssize_t count = recv(fd, data, bytes, MSG_DONTWAIT);
    if (count < 0)
        set(status, -1, classify(errno), errno);
    else
        set(status, count, IO_OK, 0);
}

void moonlightIoSocketClose(int32_t fd, MoonlightIoStatus *status)
{
    if (close(fd) < 0)
        set(status, -1, IO_FAILED, errno);
    else
        set(status, 0, IO_OK, 0);
}

static uint32_t audio_class(Result rc, uint32_t *raw)
{
    *raw = rc;
    if (R_SUCCEEDED(rc))
        return AUDIO_OK;
    return R_MODULE(rc) == Module_Kernel ? AUDIO_UNCERTAIN : AUDIO_REFUSED;
}

uint32_t moonlightIoAudioOpen(uint8_t *memory, uint32_t slot_bytes, MoonlightIoAudioFormat *format, uint32_t *raw)
{
    *raw = 0;
    if (audio_open || !memory || slot_bytes % 0x1000 || (uintptr_t)memory % 0x1000)
        return AUDIO_REFUSED;

    uint32_t status = audio_class(audoutInitialize(), raw);
    if (status != AUDIO_OK)
        return status;

    audio_open = true;
    for (unsigned i = 0; i < AUDIO_SLOTS; i++) {
        audio_buffers[i] = (AudioOutBuffer){
            .buffer = memory + (size_t)i * slot_bytes,
            .buffer_size = slot_bytes,
        };
    }
    PcmFormat pcm = audoutGetPcmFormat();
    *format = (MoonlightIoAudioFormat){
        .sample_rate = audoutGetSampleRate(),
        .channels = audoutGetChannelCount(),
        .sample_bits = pcm == PcmFormat_Int16 ? 16 : 0,
        .sample_signed = pcm == PcmFormat_Int16,
    };
    return AUDIO_OK;
}

uint32_t moonlightIoAudioAppend(uint32_t slot, uint32_t bytes, uint32_t *raw)
{
    *raw = 0;
    if (slot >= AUDIO_SLOTS || bytes > audio_buffers[slot].buffer_size)
        return AUDIO_REFUSED;
    AudioOutBuffer *buffer = &audio_buffers[slot];
    buffer->data_size = bytes;
    buffer->data_offset = 0;
    armDCacheFlush(buffer->buffer, bytes);
    return audio_class(audoutAppendAudioOutBuffer(buffer), raw);
}

uint32_t moonlightIoAudioReleased(int32_t *slot, uint32_t *raw)
{
    AudioOutBuffer *released = NULL;
    u32 count = 0;
    uint32_t status = audio_class(audoutGetReleasedAudioOutBuffer(&released, &count), raw);
    *slot = -1;
    if (status != AUDIO_OK || count == 0)
        return status;

    *slot = -2;
    for (unsigned i = 0; i < AUDIO_SLOTS; i++) {
        if (released == &audio_buffers[i])
            *slot = (int32_t)i;
    }
    return AUDIO_OK;
}

uint32_t moonlightIoAudioQueued(uint32_t *count, uint32_t *raw)
{
    u32 value = 0;
    uint32_t status = audio_class(audoutGetAudioOutBufferCount(&value), raw);
    *count = value;
    return status;
}

uint32_t moonlightIoAudioContains(uint32_t slot, bool *contains, uint32_t *raw)
{
    *raw = 0;
    *contains = true;
    if (slot >= AUDIO_SLOTS)
        return AUDIO_REFUSED;
    return audio_class(audoutContainsAudioOutBuffer(&audio_buffers[slot], contains), raw);
}

uint32_t moonlightIoAudioStart(uint32_t *raw) { return audio_class(audoutStartAudioOut(), raw); }

uint32_t moonlightIoAudioStop(uint32_t *raw) { return audio_class(audoutStopAudioOut(), raw); }

uint32_t moonlightIoAudioFlush(uint32_t *raw)
{
    bool flushed = false;
    return audio_class(audoutFlushAudioOutBuffers(&flushed), raw);
}

uint32_t moonlightIoAudioClose(uint32_t *raw)
{
    *raw = 0;
    if (audio_open)
        audoutExit();
    audio_open = false;
    memset(audio_buffers, 0, sizeof(audio_buffers));
    return AUDIO_OK;
}
