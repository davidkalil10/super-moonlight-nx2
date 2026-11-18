#include "tsnx_moonlight.h"

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
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <memory>
#include <mutex>
#include <string>

#include <switch.h>

#include "qrcodegen.h"
#include "runtime.hpp"
#include "vsock.hpp"

extern "C" void moonlightPlatformRandom(uint8_t *out, size_t bytes);
extern "C" void moonlightPlatformLog(const uint8_t *message, size_t bytes);

extern "C" void tsnx_platform_random(uint8_t *buf, size_t len) {
    moonlightPlatformRandom(buf, len);
}

namespace {

constexpr const char *kConfigDir = "sdmc:/switch/moonlight-nx2";
constexpr const char *kConfigPath = "sdmc:/switch/moonlight-nx2/tailscale.ini";
constexpr const char *kStatePath = "sdmc:/switch/moonlight-nx2/tailscale.state";
constexpr const char *kLegacyConfigPath = "sdmc:/config/tailscale-nx/config.ini";
constexpr const char *kLegacyStatePath = "sdmc:/config/tailscale-nx/state";

class LibcBackend final : public tsnx::Backend {
public:
    tsnx::Result Socket(int d, int t, int p) override { return R(::socket(d, t, p)); }
    tsnx::Result Close(int fd) override { return R(::close(fd)); }
    tsnx::Result Connect(int fd, const sockaddr *a, socklen_t l) override { return R(::connect(fd, a, l)); }
    tsnx::Result Bind(int fd, const sockaddr *a, socklen_t l) override { return R(::bind(fd, a, l)); }
    tsnx::Result Listen(int fd, int b) override { return R(::listen(fd, b)); }
    tsnx::Result Accept(int fd, sockaddr *a, socklen_t *l) override { return R(::accept(fd, a, l)); }
    tsnx::Result Send(int fd, const void *b, size_t n, int f) override { return R(::send(fd, b, n, f)); }
    tsnx::Result SendTo(int fd, const void *b, size_t n, int f, const sockaddr *a, socklen_t l) override {
        return R(::sendto(fd, b, n, f, a, l));
    }
    tsnx::Result Recv(int fd, void *b, size_t n, int f) override { return R(::recv(fd, b, n, f)); }
    tsnx::Result RecvFrom(int fd, void *b, size_t n, int f, sockaddr *a, socklen_t *l) override {
        return R(::recvfrom(fd, b, n, f, a, l));
    }
    tsnx::Result Poll(pollfd *fds, nfds_t n, int t) override { return R(::poll(fds, n, t)); }
    tsnx::Result Shutdown(int fd, int h) override { return R(::shutdown(fd, h)); }
    tsnx::Result GetSockName(int fd, sockaddr *a, socklen_t *l) override { return R(::getsockname(fd, a, l)); }
    tsnx::Result GetPeerName(int fd, sockaddr *a, socklen_t *l) override { return R(::getpeername(fd, a, l)); }
    tsnx::Result GetSockOpt(int fd, int lv, int n, void *v, socklen_t *l) override {
        return R(::getsockopt(fd, lv, n, v, l));
    }
    tsnx::Result SetSockOpt(int fd, int lv, int n, const void *v, socklen_t l) override {
        return R(::setsockopt(fd, lv, n, v, l));
    }
    tsnx::Result Fcntl(int fd, int cmd, int arg) override { return R(::fcntl(fd, cmd, arg)); }
    int Errno(tsnx::Err e) override {
        switch (e) {
            case tsnx::Err::Again: return EAGAIN;
            case tsnx::Err::InProgress: return EINPROGRESS;
            case tsnx::Err::ConnRefused: return ECONNREFUSED;
            case tsnx::Err::ConnReset: return ECONNRESET;
            case tsnx::Err::NotConn: return ENOTCONN;
            case tsnx::Err::BadF: return EBADF;
            case tsnx::Err::Inval: return EINVAL;
            case tsnx::Err::AddrInUse: return EADDRINUSE;
            case tsnx::Err::IsConn: return EISCONN;
            case tsnx::Err::TimedOut: return ETIMEDOUT;
            case tsnx::Err::Pipe: return EPIPE;
            case tsnx::Err::AfNoSupport: return EAFNOSUPPORT;
            case tsnx::Err::NoBufs: return ENOBUFS;
        }
        return EINVAL;
    }
    int DontWaitFlag() override { return MSG_DONTWAIT; }
    int NonBlockFlag() override { return O_NONBLOCK; }

private:
    static tsnx::Result R(int64_t r) { return {r, r < 0 ? errno : 0}; }
};

struct ConfigData {
    bool enabled = false;
    std::string control_url = "https://controlplane.tailscale.com";
    std::string auth_key;
    std::string hostname = "switch2";
    bool accept_routes = true;
};

std::mutex g_mu;
ConfigData g_cfg;
MoonlightTailscaleSnapshot g_snap{};
LibcBackend g_backend;
std::unique_ptr<tsnx::Runtime> g_runtime;
std::unique_ptr<tsnx::VSock> g_vsock;
std::atomic<tsnx::VSock *> g_active_vsock{nullptr};
bool g_initialized = false;

void LogMsg(const char *fmt, ...) {
    char buf[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n > 0) {
        size_t len = static_cast<size_t>(n) < sizeof(buf) ? static_cast<size_t>(n) : sizeof(buf) - 1;
        moonlightPlatformLog(reinterpret_cast<const uint8_t *>(buf), len);
    }
}

void Trim(std::string &s) {
    while (!s.empty() && (s.back() == '\r' || s.back() == '\n' || s.back() == ' ' || s.back() == '\t'))
        s.pop_back();
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t'))
        i++;
    if (i > 0)
        s.erase(0, i);
}

bool FileExists(const char *path) {
    struct stat st{};
    return stat(path, &st) == 0;
}

void CopyFileIfMissing(const char *src, const char *dst) {
    if (FileExists(dst) || !FileExists(src))
        return;
    FILE *in = fopen(src, "rb");
    if (!in)
        return;
    FILE *out = fopen(dst, "wb");
    if (out) {
        char buf[1024];
        size_t n;
        while ((n = fread(buf, 1, sizeof(buf), in)) > 0)
            fwrite(buf, 1, n, out);
        fclose(out);
    }
    fclose(in);
}

void LoadConfigLocked() {
    mkdir("sdmc:/switch", 0777);
    mkdir(kConfigDir, 0777);
    CopyFileIfMissing(kLegacyStatePath, kStatePath);

    const char *path = FileExists(kConfigPath) ? kConfigPath : (FileExists(kLegacyConfigPath) ? kLegacyConfigPath : nullptr);
    if (!path)
        return;

    FILE *f = fopen(path, "r");
    if (!f)
        return;

    if (path == kLegacyConfigPath)
        g_cfg.enabled = true;

    char line[384];
    while (fgets(line, sizeof(line), f)) {
        std::string s(line);
        auto hash = s.find('#');
        if (hash != std::string::npos)
            s.erase(hash);
        Trim(s);
        auto eq = s.find('=');
        if (eq == std::string::npos)
            continue;
        std::string k = s.substr(0, eq);
        std::string v = s.substr(eq + 1);
        Trim(k);
        Trim(v);
        if (k == "enabled")
            g_cfg.enabled = (v == "1" || v == "true" || v == "yes" || v == "on");
        else if (k == "control_url" && !v.empty())
            g_cfg.control_url = v;
        else if (k == "auth_key")
            g_cfg.auth_key = v;
        else if (k == "hostname" && !v.empty())
            g_cfg.hostname = v;
        else if (k == "accept_routes")
            g_cfg.accept_routes = (v == "1" || v == "true" || v == "yes" || v == "on");
    }
    fclose(f);
}

void SaveConfigLocked() {
    mkdir("sdmc:/switch", 0777);
    mkdir(kConfigDir, 0777);
    FILE *f = fopen(kConfigPath, "w");
    if (!f)
        return;
    fprintf(f, "enabled=%d\n", g_cfg.enabled ? 1 : 0);
    fprintf(f, "control_url=%s\n", g_cfg.control_url.c_str());
    fprintf(f, "auth_key=%s\n", g_cfg.auth_key.c_str());
    fprintf(f, "hostname=%s\n", g_cfg.hostname.c_str());
    fprintf(f, "accept_routes=%d\n", g_cfg.accept_routes ? 1 : 0);
    fclose(f);
}

void UpdateQrLocked(const char *url) {
    g_snap.qr_size = 0;
    memset(g_snap.qr_modules, 0, sizeof(g_snap.qr_modules));
    if (!url || !url[0])
        return;

    uint8_t qrcode[qrcodegen_BUFFER_LEN_MAX];
    uint8_t temp[qrcodegen_BUFFER_LEN_MAX];
    if (!qrcodegen_encodeText(url, temp, qrcode, qrcodegen_Ecc_LOW, qrcodegen_VERSION_MIN, 11, qrcodegen_Mask_AUTO, true))
        return;

    int size = qrcodegen_getSize(qrcode);
    if (size <= 0 || size > 64)
        return;

    g_snap.qr_size = static_cast<uint8_t>(size);
    for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
            g_snap.qr_modules[y * size + x] = qrcodegen_getModule(qrcode, x, y) ? 1 : 0;
        }
    }
}

void SyncSnapshotConfigLocked() {
    g_snap.enabled = g_cfg.enabled ? 1 : 0;
    g_snap.has_auth_key = g_cfg.auth_key.empty() ? 0 : 1;
    snprintf(g_snap.hostname, sizeof(g_snap.hostname), "%s", g_cfg.hostname.c_str());
    snprintf(g_snap.control_url, sizeof(g_snap.control_url), "%s", g_cfg.control_url.c_str());
}

void StopEngineLocked() {
    g_active_vsock.store(nullptr, std::memory_order_release);
    if (g_vsock) {
        g_vsock->CloseAll();
        g_vsock.reset();
    }
    if (g_runtime) {
        g_runtime->Stop();
        g_runtime.reset();
    }
    g_snap.state = ML_TS_STATE_OFF;
    g_snap.qr_size = 0;
    g_snap.login_url[0] = 0;
    g_snap.self_ip[0] = 0;
    g_snap.peer_path[0] = 0;
}

void StartEngineLocked() {
    StopEngineLocked();
    SyncSnapshotConfigLocked();
    if (!g_cfg.enabled)
        return;

    g_snap.state = ML_TS_STATE_STARTING;
    g_snap.last_error[0] = 0;

    tsnx::RuntimeConfig rcfg;
    rcfg.control_url = g_cfg.control_url;
    rcfg.auth_key = g_cfg.auth_key;
    rcfg.hostname = g_cfg.hostname;
    rcfg.state_path = kStatePath;
    rcfg.accept_routes = g_cfg.accept_routes;
    rcfg.on_event = [](const TsnxEvent &ev) {
        std::lock_guard<std::mutex> lock(g_mu);
        switch (ev.kind) {
            case TSNX_EVENT_LOGIN_URL:
                if (ev.text && ev.text[0]) {
                    snprintf(g_snap.login_url, sizeof(g_snap.login_url), "%s", ev.text);
                    g_snap.state = ML_TS_STATE_NEEDS_LOGIN;
                    UpdateQrLocked(ev.text);
                    LogMsg("tailscale: login URL ready: %s", ev.text);
                }
                break;
            case TSNX_EVENT_AUTHORIZED:
                g_snap.login_url[0] = 0;
                g_snap.qr_size = 0;
                if (g_snap.state == ML_TS_STATE_NEEDS_LOGIN || g_snap.state == ML_TS_STATE_STARTING)
                    g_snap.state = ML_TS_STATE_CONNECTED;
                LogMsg("tailscale: node authorized");
                break;
            case TSNX_EVENT_ADDRESSES:
                if (ev.text && ev.text[0]) {
                    snprintf(g_snap.self_ip, sizeof(g_snap.self_ip), "%s", ev.text);
                    char *comma = strchr(g_snap.self_ip, ',');
                    if (comma) *comma = 0;
                    g_snap.state = ML_TS_STATE_CONNECTED;
                    g_snap.login_url[0] = 0;
                    g_snap.qr_size = 0;
                    LogMsg("tailscale: connected ip=%s", g_snap.self_ip);
                }
                break;
            case TSNX_EVENT_PEERS:
                g_snap.peer_count = ev.value;
                break;
            case TSNX_EVENT_PEER_PATH:
                if (ev.text && ev.text[0]) {
                    snprintf(g_snap.peer_path, sizeof(g_snap.peer_path), "%s (%s)",
                             ev.value ? "Direct UDP" : "DERP relay", ev.text);
                }
                break;
            case TSNX_EVENT_ERROR:
                if (ev.text && ev.text[0]) {
                    snprintf(g_snap.last_error, sizeof(g_snap.last_error), "%s", ev.text);
                    if (g_snap.state != ML_TS_STATE_CONNECTED)
                        g_snap.state = ML_TS_STATE_ERROR;
                    LogMsg("tailscale: error: %s", ev.text);
                }
                break;
            default:
                break;
        }
    };

    std::string err;
    g_runtime = tsnx::Runtime::Start(rcfg, &err);
    if (!g_runtime) {
        g_snap.state = ML_TS_STATE_ERROR;
        snprintf(g_snap.last_error, sizeof(g_snap.last_error), "%s", err.c_str());
        LogMsg("tailscale: failed to start runtime: %s", err.c_str());
        return;
    }
    g_vsock = std::make_unique<tsnx::VSock>(g_backend, *g_runtime);
    g_vsock->SetEagerDualUdp(false);
    g_active_vsock.store(g_vsock.get(), std::memory_order_release);
    LogMsg("tailscale: runtime started (control=%s hostname=%s)", g_cfg.control_url.c_str(), g_cfg.hostname.c_str());
}

bool SwkbdPrompt(const char *header, const char *guide, const char *initial, std::string *out_text) {
    SwkbdConfig kbd;
    Result rc = swkbdCreate(&kbd, 0);
    if (R_FAILED(rc))
        return false;
    swkbdConfigMakePresetDefault(&kbd);
    swkbdConfigSetHeaderText(&kbd, header);
    swkbdConfigSetGuideText(&kbd, guide);
    if (initial && initial[0])
        swkbdConfigSetInitialText(&kbd, initial);
    char buf[256] = {};
    swkbdConfigSetStringLenMax(&kbd, sizeof(buf) - 1);
    rc = swkbdShow(&kbd, buf, sizeof(buf));
    swkbdClose(&kbd);
    if (R_FAILED(rc))
        return false;
    std::string s(buf);
    Trim(s);
    *out_text = s;
    return true;
}

tsnx::VSock *ActiveLayer() {
    tsnx::VSock *v = g_active_vsock.load(std::memory_order_acquire);
    if (!v || tsnx::Runtime::InInternal())
        return nullptr;
    return v;
}

template <class T>
T ToRet(const tsnx::Result &r) {
    if (r.ret < 0)
        errno = r.err;
    return static_cast<T>(r.ret);
}

} // namespace

extern "C" void moonlightTailscaleInit(void) {
    std::lock_guard<std::mutex> lock(g_mu);
    if (g_initialized)
        return;
    g_initialized = true;
    LoadConfigLocked();
    SyncSnapshotConfigLocked();
    if (g_cfg.enabled)
        StartEngineLocked();
}

extern "C" void moonlightTailscaleStop(void) {
    std::lock_guard<std::mutex> lock(g_mu);
    StopEngineLocked();
}

extern "C" void moonlightTailscaleGetSnapshot(MoonlightTailscaleSnapshot *out) {
    if (!out)
        return;
    std::lock_guard<std::mutex> lock(g_mu);
    if (!g_initialized) {
        g_initialized = true;
        LoadConfigLocked();
        SyncSnapshotConfigLocked();
    }
    *out = g_snap;
}

extern "C" void moonlightTailscaleToggle(void) {
    std::lock_guard<std::mutex> lock(g_mu);
    g_cfg.enabled = !g_cfg.enabled;
    SaveConfigLocked();
    StartEngineLocked();
}

extern "C" void moonlightTailscaleStartQrLogin(void) {
    std::lock_guard<std::mutex> lock(g_mu);
    g_cfg.enabled = true;
    g_cfg.auth_key.clear();
    SaveConfigLocked();
    StartEngineLocked();
}

extern "C" bool moonlightTailscalePromptAuthKey(void) {
    std::string current;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        current = g_cfg.auth_key;
    }
    std::string entered;
    if (!SwkbdPrompt("Tailscale Auth Key", "tskey-auth-...", current.c_str(), &entered))
        return false;
    std::lock_guard<std::mutex> lock(g_mu);
    g_cfg.auth_key = entered;
    g_cfg.enabled = true;
    SaveConfigLocked();
    StartEngineLocked();
    return true;
}

extern "C" bool moonlightTailscalePromptControlUrl(void) {
    std::string current;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        current = g_cfg.control_url;
    }
    std::string entered;
    if (!SwkbdPrompt("Tailscale Control Server", "https://controlplane.tailscale.com", current.c_str(), &entered))
        return false;
    std::lock_guard<std::mutex> lock(g_mu);
    g_cfg.control_url = entered.empty() ? "https://controlplane.tailscale.com" : entered;
    SaveConfigLocked();
    if (g_cfg.enabled)
        StartEngineLocked();
    else
        SyncSnapshotConfigLocked();
    return true;
}

extern "C" bool moonlightTailscalePromptHostname(void) {
    std::string current;
    {
        std::lock_guard<std::mutex> lock(g_mu);
        current = g_cfg.hostname;
    }
    std::string entered;
    if (!SwkbdPrompt("Tailscale Hostname", "switch2", current.c_str(), &entered))
        return false;
    std::lock_guard<std::mutex> lock(g_mu);
    g_cfg.hostname = entered.empty() ? "switch2" : entered;
    SaveConfigLocked();
    if (g_cfg.enabled)
        StartEngineLocked();
    else
        SyncSnapshotConfigLocked();
    return true;
}

extern "C" size_t moonlightTailscaleGetPeers(MoonlightTailscalePeer *out, size_t max_peers) {
    std::unique_ptr<tsnx::Runtime> *rt_ptr = nullptr;
    char self_ip[48] = {};
    {
        std::lock_guard<std::mutex> lock(g_mu);
        if (!g_runtime)
            return 0;
        snprintf(self_ip, sizeof(self_ip), "%s", g_snap.self_ip);
        rt_ptr = &g_runtime;
    }
    char hosts_buf[4096] = {};
    (*rt_ptr)->Read([&](TsnxEngine *e) {
        if (e)
            tsnx_engine_hosts(e, hosts_buf, sizeof(hosts_buf));
    });

    size_t count = 0;
    const char *p = hosts_buf;
    while (*p && count < max_peers) {
        const char *nl = strchr(p, '\n');
        size_t len = nl ? static_cast<size_t>(nl - p) : strlen(p);
        char line[128] = {};
        if (len > 0 && len < sizeof(line)) {
            memcpy(line, p, len);
            line[len] = 0;
            char *sp = strchr(line, ' ');
            if (sp) {
                *sp = 0;
                const char *ip_str = line;
                const char *name_str = sp + 1;
                while (*name_str == ' ')
                    name_str++;
                if (strcmp(ip_str, self_ip) != 0) {
                    in_addr addr{};
                    if (inet_pton(AF_INET, ip_str, &addr) == 1) {
                        if (out) {
                            memcpy(out[count].ip, &addr.s_addr, 4);
                            snprintf(out[count].address, sizeof(out[count].address), "%s", ip_str);
                            snprintf(out[count].name, sizeof(out[count].name), "%s", name_str);
                        }
                        count++;
                    }
                }
            }
        }
        if (!nl)
            break;
        p = nl + 1;
    }
    return count;
}

extern "C" int tsnx_ml_socket(int domain, int type, int protocol) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<int>(v->Socket(domain, type, protocol));
    return ::socket(domain, type, protocol);
}

extern "C" int tsnx_ml_close(int fd) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<int>(v->Close(fd));
    return ::close(fd);
}

extern "C" int tsnx_ml_connect(int fd, const struct sockaddr *addr, socklen_t len) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<int>(v->Connect(fd, addr, len));
    return ::connect(fd, addr, len);
}

extern "C" ssize_t tsnx_ml_send(int fd, const void *buf, size_t len, int flags) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<ssize_t>(v->Send(fd, buf, len, flags));
    return ::send(fd, buf, len, flags);
}

extern "C" ssize_t tsnx_ml_sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *to, socklen_t tolen) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<ssize_t>(v->SendTo(fd, buf, len, flags, to, tolen));
    return ::sendto(fd, buf, len, flags, to, tolen);
}

extern "C" ssize_t tsnx_ml_recv(int fd, void *buf, size_t len, int flags) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<ssize_t>(v->Recv(fd, buf, len, flags));
    return ::recv(fd, buf, len, flags);
}

extern "C" int tsnx_ml_poll(struct pollfd *fds, nfds_t n, int timeout_ms) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<int>(v->Poll(fds, n, timeout_ms));
    return ::poll(fds, n, timeout_ms);
}

extern "C" int tsnx_ml_getsockopt(int fd, int level, int name, void *val, socklen_t *len) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<int>(v->GetSockOpt(fd, level, name, val, len));
    return ::getsockopt(fd, level, name, val, len);
}

extern "C" int tsnx_ml_setsockopt(int fd, int level, int name, const void *val, socklen_t len) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<int>(v->SetSockOpt(fd, level, name, val, len));
    return ::setsockopt(fd, level, name, val, len);
}

extern "C" int tsnx_ml_fcntl(int fd, int cmd, int arg) {
    if (tsnx::VSock *v = ActiveLayer())
        return ToRet<int>(v->Fcntl(fd, cmd, arg));
    return ::fcntl(fd, cmd, arg);
}
