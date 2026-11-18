#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <poll.h>
#include <sys/socket.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    ML_TS_STATE_OFF = 0,
    ML_TS_STATE_STARTING = 1,
    ML_TS_STATE_NEEDS_LOGIN = 2,
    ML_TS_STATE_CONNECTED = 3,
    ML_TS_STATE_ERROR = 4,
};

typedef struct {
    uint8_t enabled;
    uint8_t state;
    uint8_t has_auth_key;
    uint8_t qr_size;
    uint32_t peer_count;
    char self_ip[48];
    char hostname[64];
    char control_url[128];
    char login_url[192];
    char peer_path[96];
    char last_error[128];
    uint8_t qr_modules[64 * 64]; // 1 = dark module, 0 = light module (for qr_size <= 64)
} MoonlightTailscaleSnapshot;

typedef struct {
    uint8_t ip[4];
    char address[32];
    char name[64];
} MoonlightTailscalePeer;

void moonlightTailscaleInit(void);
void moonlightTailscaleStop(void);
void moonlightTailscaleGetSnapshot(MoonlightTailscaleSnapshot *out);
void moonlightTailscaleToggle(void);
void moonlightTailscaleStartQrLogin(void);
bool moonlightTailscalePromptAuthKey(void);
bool moonlightTailscalePromptControlUrl(void);
bool moonlightTailscalePromptHostname(void);
size_t moonlightTailscaleGetPeers(MoonlightTailscalePeer *out, size_t max_peers);

// Socket wrappers for io_adapter.c that route 100.x.y.z tailnet traffic through VSock
int tsnx_ml_socket(int domain, int type, int protocol);
int tsnx_ml_close(int fd);
int tsnx_ml_connect(int fd, const struct sockaddr *addr, socklen_t len);
ssize_t tsnx_ml_send(int fd, const void *buf, size_t len, int flags);
ssize_t tsnx_ml_sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *to, socklen_t tolen);
ssize_t tsnx_ml_recv(int fd, void *buf, size_t len, int flags);
int tsnx_ml_poll(struct pollfd *fds, nfds_t n, int timeout_ms);
int tsnx_ml_getsockopt(int fd, int level, int name, void *val, socklen_t *len);
int tsnx_ml_setsockopt(int fd, int level, int name, const void *val, socklen_t len);
int tsnx_ml_fcntl(int fd, int cmd, int arg);

#ifdef __cplusplus
}
#endif
