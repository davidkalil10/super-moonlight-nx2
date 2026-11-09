#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "../media.h"

#if defined(MSG_NOSIGNAL) && !defined(__SWITCH2__)
#define SEND_FLAGS (MSG_DONTWAIT | MSG_NOSIGNAL)
#else
#define SEND_FLAGS MSG_DONTWAIT
#endif

#define DEFAULT_READ_BUDGET (256u * 1024u)

struct MoonlightMedia {
    int fd;
    MoonlightMediaLog log;
    MoonlightMediaState state;
    MoonlightMediaResult result;
    uint64_t deadline_ms;
    uint64_t last_ms;
    size_t read_budget;
    MoonlightMediaParser parser;
    char token[MOONLIGHT_MEDIA_TOKEN_BYTES];
    size_t token_sent;
    uint8_t pending[MOONLIGHT_MEDIA_PENDING_ACKS][MOONLIGHT_MEDIA_HEADER_BYTES];
    uint32_t pending_head;
    uint32_t pending_count;
    uint8_t outbound[MOONLIGHT_MEDIA_OUTBOUND_BYTES];
    size_t out_start;
    size_t out_end;
    MoonlightMediaStats stats;
};

static void report(const MoonlightMedia *media, const char *format, ...)
{
    if (!media->log)
        return;

    char line[160];
    va_list args;
    va_start(args, format);
    vsnprintf(line, sizeof(line), format, args);
    va_end(args);
    media->log(line);
}

static void wipe(void *memory, size_t bytes)
{
    volatile uint8_t *cursor = memory;
    while (bytes--)
        *cursor++ = 0;
}

static bool retry_errno(int error)
{
    return error == EAGAIN || error == EWOULDBLOCK || error == EINTR;
}

static MoonlightMediaResult fail(MoonlightMedia *media, MoonlightMediaResult result, int error, const char *what)
{
    media->result = result;
    media->state = MOONLIGHT_MEDIA_CLOSED;
    media->stats.last_errno = error;
    if (error)
        report(media, "media: %s: %s (errno %d)", what, moonlightMediaResultName(result), error);
    else
        report(media, "media: %s: %s", what, moonlightMediaResultName(result));
    return result;
}

static MoonlightMediaResult connect_error(MoonlightMedia *media, int error)
{
    if (error == ECONNREFUSED)
        return fail(media, MOONLIGHT_MEDIA_REFUSED, error, "connect");
    return fail(media, MOONLIGHT_MEDIA_DISCONNECTED, error, "connect");
}

static bool valid_token(const char *token)
{
    for (size_t i = 0; i < MOONLIGHT_MEDIA_TOKEN_BYTES; i++) {
        bool digit = token[i] >= '0' && token[i] <= '9';
        bool letter = token[i] >= 'a' && token[i] <= 'f';
        if (!digit && !letter)
            return false;
    }
    return true;
}

static bool valid_config(const MoonlightMediaConfig *config)
{
    static const uint8_t any[4];

    if (!config->port || !config->connect_timeout_ms)
        return false;
    if (!memcmp(config->address, any, sizeof(any)))
        return false;
    return valid_token(config->token);
}

static MoonlightMediaResult start_connect(MoonlightMedia *media, const MoonlightMediaConfig *config)
{
    media->fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (media->fd < 0)
        return fail(media, MOONLIGHT_MEDIA_FAILED, errno, "socket");

    int flags = fcntl(media->fd, F_GETFL, 0);
    if (flags < 0 || fcntl(media->fd, F_SETFL, flags | O_NONBLOCK) < 0)
        return fail(media, MOONLIGHT_MEDIA_FAILED, errno, "nonblocking");

    struct sockaddr_in endpoint;
    memset(&endpoint, 0, sizeof(endpoint));
    endpoint.sin_family = AF_INET;
    endpoint.sin_port = htons(config->port);
    memcpy(&endpoint.sin_addr, config->address, sizeof(config->address));
    report(media, "media: connecting to %u.%u.%u.%u:%u", config->address[0], config->address[1],
           config->address[2], config->address[3], config->port);

    if (connect(media->fd, (const struct sockaddr *)&endpoint, sizeof(endpoint)) == 0) {
        media->state = MOONLIGHT_MEDIA_STREAMING;
        return MOONLIGHT_MEDIA_OK;
    }
    if (errno == EINPROGRESS || errno == EINTR)
        return MOONLIGHT_MEDIA_OK;
    return connect_error(media, errno);
}

static MoonlightMediaResult close_socket(MoonlightMedia *media)
{
    if (media->fd < 0)
        return MOONLIGHT_MEDIA_OK;

    int fd = media->fd;
    media->fd = -1;
    if (close(fd) == 0)
        return MOONLIGHT_MEDIA_OK;

    report(media, "media: close failed (errno %d)", errno);
    return MOONLIGHT_MEDIA_FAILED;
}

MoonlightMediaResult moonlightMediaOpen(const MoonlightMediaConfig *config, MoonlightMediaLog log, uint64_t now_ms,
                                        MoonlightMedia **out)
{
    if (!out)
        return MOONLIGHT_MEDIA_INVALID;
    *out = NULL;
    if (!config || !valid_config(config))
        return MOONLIGHT_MEDIA_INVALID;

    MoonlightMedia *media = calloc(1, sizeof(*media));
    if (!media)
        return MOONLIGHT_MEDIA_NO_MEMORY;
    media->fd = -1;
    media->log = log;

    MoonlightMediaResult result = moonlightMediaParserInit(&media->parser, config->memory, config->capacity,
                                                           config->exact_bytes);
    if (result != MOONLIGHT_MEDIA_OK) {
        free(media);
        return result;
    }

    memcpy(media->token, config->token, sizeof(media->token));
    media->read_budget = config->read_budget ? config->read_budget : DEFAULT_READ_BUDGET;
    media->deadline_ms = now_ms + config->connect_timeout_ms;
    media->last_ms = now_ms;

    result = start_connect(media, config);
    if (result != MOONLIGHT_MEDIA_OK) {
        MoonlightMediaResult closed = moonlightMediaClose(media);
        return closed == MOONLIGHT_MEDIA_OK ? result : closed;
    }

    *out = media;
    return MOONLIGHT_MEDIA_OK;
}

static MoonlightMediaResult check_connect(MoonlightMedia *media, uint64_t now_ms)
{
    struct pollfd watch = {.fd = media->fd, .events = POLLOUT};
    int ready = poll(&watch, 1, 0);
    if (ready < 0 && errno != EINTR)
        return fail(media, MOONLIGHT_MEDIA_DISCONNECTED, errno, "connect poll");

    if (ready > 0) {
        int error = 0;
        socklen_t length = sizeof(error);
        if (getsockopt(media->fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0)
            return fail(media, MOONLIGHT_MEDIA_DISCONNECTED, errno, "connect status");
        if (error)
            return connect_error(media, error);

        media->state = MOONLIGHT_MEDIA_STREAMING;
        report(media, "media: connected");
        return MOONLIGHT_MEDIA_OK;
    }

    if (now_ms >= media->deadline_ms)
        return fail(media, MOONLIGHT_MEDIA_TIMEOUT, 0, "connect");
    return MOONLIGHT_MEDIA_OK;
}

static MoonlightMediaResult send_some(MoonlightMedia *media, const void *data, size_t bytes, size_t *sent)
{
    *sent = 0;
    ssize_t count = send(media->fd, data, bytes, SEND_FLAGS);
    if (count < 0 && retry_errno(errno))
        return MOONLIGHT_MEDIA_AGAIN;
    if (count < 0)
        return fail(media, MOONLIGHT_MEDIA_DISCONNECTED, errno, "send");
    if ((size_t)count > bytes)
        return fail(media, MOONLIGHT_MEDIA_FAILED, 0, "send length");
    if (!count)
        return MOONLIGHT_MEDIA_AGAIN;

    *sent = (size_t)count;
    media->stats.bytes_sent += *sent;
    return MOONLIGHT_MEDIA_OK;
}

static MoonlightMediaResult flush(MoonlightMedia *media)
{
    MoonlightMediaResult result = MOONLIGHT_MEDIA_OK;
    size_t sent;

    while (media->token_sent < MOONLIGHT_MEDIA_TOKEN_BYTES && result == MOONLIGHT_MEDIA_OK) {
        result = send_some(media, media->token + media->token_sent, MOONLIGHT_MEDIA_TOKEN_BYTES - media->token_sent,
                           &sent);
        media->token_sent += sent;
        if (media->token_sent == MOONLIGHT_MEDIA_TOKEN_BYTES)
            wipe(media->token, sizeof(media->token));
    }

    while (media->out_start < media->out_end && result == MOONLIGHT_MEDIA_OK) {
        result = send_some(media, media->outbound + media->out_start, media->out_end - media->out_start, &sent);
        media->out_start += sent;
    }
    if (media->out_start == media->out_end)
        media->out_start = media->out_end = 0;

    return result == MOONLIGHT_MEDIA_AGAIN ? MOONLIGHT_MEDIA_OK : result;
}

static MoonlightMediaResult end_of_stream(MoonlightMedia *media)
{
    MoonlightMediaResult result = moonlightMediaParserEnd(&media->parser);
    return fail(media, result, 0, "peer closed");
}

static MoonlightMediaResult receive(MoonlightMedia *media)
{
    size_t budget = media->read_budget;
    if (media->parser.ready) {
        media->stats.stalled_pumps++;
        return MOONLIGHT_MEDIA_OK;
    }

    while (budget) {
        uint8_t *window;
        size_t space;
        if (moonlightMediaParserSpace(&media->parser, &window, &space) != MOONLIGHT_MEDIA_OK)
            return MOONLIGHT_MEDIA_OK;
        if (space > budget)
            space = budget;

        ssize_t count = recv(media->fd, window, space, MSG_DONTWAIT);
        if (count < 0 && retry_errno(errno))
            return MOONLIGHT_MEDIA_OK;
        if (count < 0)
            return fail(media, MOONLIGHT_MEDIA_DISCONNECTED, errno, "receive");
        if (!count)
            return end_of_stream(media);
        if ((size_t)count > space)
            return fail(media, MOONLIGHT_MEDIA_FAILED, 0, "receive length");

        budget -= (size_t)count;
        media->stats.bytes_received += (size_t)count;
        MoonlightMediaResult result = moonlightMediaParserCommit(&media->parser, (size_t)count);
        if (result != MOONLIGHT_MEDIA_OK) {
            uint32_t length;
            memcpy(&length, media->parser.header, sizeof(length));
            report(media, "media: record of %u bytes refused, capacity %zu", (unsigned)length, media->parser.capacity);
            return fail(media, result, 0, "record");
        }
        if (media->parser.ready) {
            media->stats.records++;
            return MOONLIGHT_MEDIA_OK;
        }
    }

    media->stats.budget_stops++;
    return MOONLIGHT_MEDIA_OK;
}

MoonlightMediaResult moonlightMediaPump(MoonlightMedia *media, uint64_t now_ms)
{
    if (!media)
        return MOONLIGHT_MEDIA_INVALID;
    if (media->result != MOONLIGHT_MEDIA_OK)
        return media->result;
    if (now_ms < media->last_ms)
        return MOONLIGHT_MEDIA_INVALID;
    media->last_ms = now_ms;

    MoonlightMediaResult result = MOONLIGHT_MEDIA_OK;
    if (media->state == MOONLIGHT_MEDIA_CONNECTING)
        result = check_connect(media, now_ms);
    if (result != MOONLIGHT_MEDIA_OK || media->state != MOONLIGHT_MEDIA_STREAMING)
        return result;

    result = flush(media);
    if (result != MOONLIGHT_MEDIA_OK)
        return result;
    if (media->token_sent < MOONLIGHT_MEDIA_TOKEN_BYTES)
        return MOONLIGHT_MEDIA_OK;
    return receive(media);
}

MoonlightMediaResult moonlightMediaPeek(const MoonlightMedia *media, MoonlightMediaRecord *record)
{
    if (!media)
        return MOONLIGHT_MEDIA_INVALID;
    return moonlightMediaParserPeek(&media->parser, record);
}

MoonlightMediaResult moonlightMediaConsume(MoonlightMedia *media)
{
    if (!media)
        return MOONLIGHT_MEDIA_INVALID;
    if (!media->parser.ready)
        return MOONLIGHT_MEDIA_AGAIN;
    if (media->pending_count == MOONLIGHT_MEDIA_PENDING_ACKS)
        return MOONLIGHT_MEDIA_AGAIN;

    uint32_t slot = (media->pending_head + media->pending_count) % MOONLIGHT_MEDIA_PENDING_ACKS;
    memcpy(media->pending[slot], media->parser.header, MOONLIGHT_MEDIA_HEADER_BYTES);
    media->pending_count++;
    return moonlightMediaParserConsume(&media->parser);
}

MoonlightMediaResult moonlightMediaAcknowledge(MoonlightMedia *media, const uint8_t header[MOONLIGHT_MEDIA_HEADER_BYTES],
                                               const uint8_t *extra, size_t extra_bytes)
{
    if (!media || !header || (!extra && extra_bytes))
        return MOONLIGHT_MEDIA_INVALID;
    if (media->result != MOONLIGHT_MEDIA_OK)
        return media->result;
    if (!media->pending_count)
        return MOONLIGHT_MEDIA_INVALID;
    if (memcmp(header, media->pending[media->pending_head], MOONLIGHT_MEDIA_HEADER_BYTES))
        return MOONLIGHT_MEDIA_INVALID;

    size_t bytes = MOONLIGHT_MEDIA_HEADER_BYTES + extra_bytes;
    if (extra_bytes > MOONLIGHT_MEDIA_OUTBOUND_BYTES - MOONLIGHT_MEDIA_HEADER_BYTES)
        return MOONLIGHT_MEDIA_INVALID;
    if (bytes > MOONLIGHT_MEDIA_OUTBOUND_BYTES - (media->out_end - media->out_start))
        return MOONLIGHT_MEDIA_AGAIN;

    if (media->out_end + bytes > MOONLIGHT_MEDIA_OUTBOUND_BYTES) {
        memmove(media->outbound, media->outbound + media->out_start, media->out_end - media->out_start);
        media->out_end -= media->out_start;
        media->out_start = 0;
    }
    memcpy(media->outbound + media->out_end, header, MOONLIGHT_MEDIA_HEADER_BYTES);
    if (extra_bytes)
        memcpy(media->outbound + media->out_end + MOONLIGHT_MEDIA_HEADER_BYTES, extra, extra_bytes);
    media->out_end += bytes;

    media->pending_head = (media->pending_head + 1) % MOONLIGHT_MEDIA_PENDING_ACKS;
    media->pending_count--;
    media->stats.acknowledgements++;
    size_t queued = media->out_end - media->out_start;
    if (queued > media->stats.max_outbound_bytes)
        media->stats.max_outbound_bytes = queued;
    return MOONLIGHT_MEDIA_OK;
}

void moonlightMediaGetStats(const MoonlightMedia *media, MoonlightMediaStats *stats)
{
    if (!media || !stats)
        return;

    *stats = media->stats;
    stats->state = media->state;
    stats->pending_acks = media->pending_count;
    stats->outbound_bytes = media->out_end - media->out_start;
}

MoonlightMediaResult moonlightMediaClose(MoonlightMedia *media)
{
    if (!media)
        return MOONLIGHT_MEDIA_INVALID;

    MoonlightMediaResult result = close_socket(media);
    wipe(media->token, sizeof(media->token));
    free(media);
    return result;
}
