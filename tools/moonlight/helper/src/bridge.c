/* Client for the launcher's local bridge (smilebasic/engine/lib/bridge.cjs):
 * one JSON command per HTTP POST on a kept-alive connection, the protocol of
 * shared/rpc.cjs. A handle belongs to one thread. Bodies and replies live in
 * buffers sized at open, so the per-frame write path does not allocate.
 *
 * Addresses and arguments go out as JSON numbers: the bridge does arithmetic on
 * them, and every value the host sends is below 2^53. */
#include "host.h"

#include <curl/curl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct bridge {
  CURL *curl;
  struct curl_slist *headers;
  char *body;
  size_t body_capacity;
  size_t body_length;
  char *reply;
  size_t reply_capacity;
  size_t reply_length;
  bool reply_overflow;
  char error[256];
};

static const char BASE64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64_size(size_t bytes) {
  return (bytes + 2) / 3 * 4;
}

static size_t base64_encode(char *out, const uint8_t *in, size_t size) {
  char *at = out;
  size_t i = 0;
  for (; i + 2 < size; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16 | (uint32_t)in[i + 1] << 8 | in[i + 2];
    *at++ = BASE64[v >> 18];
    *at++ = BASE64[v >> 12 & 63];
    *at++ = BASE64[v >> 6 & 63];
    *at++ = BASE64[v & 63];
  }
  if (i < size) {
    uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < size ? (uint32_t)in[i + 1] << 8 : 0);
    *at++ = BASE64[v >> 18];
    *at++ = BASE64[v >> 12 & 63];
    *at++ = i + 1 < size ? BASE64[v >> 6 & 63] : '=';
    *at++ = '=';
  }
  return (size_t)(at - out);
}

static int base64_value(char c) {
  const char *at = c ? strchr(BASE64, c) : NULL;
  return at ? (int)(at - BASE64) : -1;
}

static size_t base64_decode(uint8_t *out, size_t capacity, const char *in) {
  size_t used = 0;
  uint32_t bits = 0;
  int count = 0;
  for (; *in && *in != '"'; in++) {
    int value = base64_value(*in);
    if (value < 0)
      continue;
    bits = bits << 6 | (uint32_t)value;
    if (++count == 4) {
      for (int shift = 16; shift >= 0; shift -= 8)
        if (used < capacity)
          out[used++] = (uint8_t)(bits >> shift);
      bits = 0;
      count = 0;
    }
  }
  if (count >= 2 && used < capacity)
    out[used++] = (uint8_t)(bits >> (count * 6 - 8));
  if (count == 3 && used < capacity)
    out[used++] = (uint8_t)(bits >> 2);
  return used;
}

static size_t receive(char *data, size_t size, size_t count, void *context) {
  struct bridge *bridge = context;
  size_t bytes = size * count;
  if (bridge->reply_length + bytes >= bridge->reply_capacity) {
    bridge->reply_overflow = true;
    return bytes;
  }
  memcpy(bridge->reply + bridge->reply_length, data, bytes);
  bridge->reply_length += bytes;
  bridge->reply[bridge->reply_length] = 0;
  return bytes;
}

static bool failed(struct bridge *bridge, const char *format, ...) {
  va_list args;
  va_start(args, format);
  vsnprintf(bridge->error, sizeof(bridge->error), format, args);
  va_end(args);
  return false;
}

bool bridge_load(struct bridge_info *info, const char *directory) {
  char path[1024];
  snprintf(path, sizeof(path), "%s/connection.json", directory);
  char *connection = read_file(path, NULL);
  if (!connection)
    return false;
  uint64_t port = 0;
  const char *addresses = json_find(connection, "addresses");
  bool ok = json_u64(connection, "port", &port) &&
            json_text(connection, "token", info->token, sizeof(info->token)) && addresses &&
            json_u64(addresses, "scratch", &info->scratch) && json_u64(addresses, "sdk", &info->sdk);
  if (addresses && !json_text(addresses, "session", info->session, sizeof(info->session)))
    info->session[0] = 0;
  info->port = (int)port;
  free(connection);
  return ok;
}

struct bridge *bridge_open(const struct bridge_info *info, size_t write_capacity,
                           size_t read_capacity) {
  struct bridge *bridge = calloc(1, sizeof(*bridge));
  if (!bridge)
    return NULL;
  bridge->body_capacity = base64_size(write_capacity) + 512;
  bridge->reply_capacity = base64_size(read_capacity) + 512;
  bridge->body = malloc(bridge->body_capacity);
  bridge->reply = malloc(bridge->reply_capacity);
  bridge->curl = curl_easy_init();
  if (!bridge->body || !bridge->reply || !bridge->curl) {
    bridge_close(bridge);
    return NULL;
  }
  char url[64], authorization[192];
  snprintf(url, sizeof(url), "http://127.0.0.1:%d/", info->port);
  snprintf(authorization, sizeof(authorization), "Authorization: Bearer %s", info->token);
  bridge->headers = curl_slist_append(bridge->headers, authorization);
  bridge->headers = curl_slist_append(bridge->headers, "Content-Type: application/json");
  bridge->headers = curl_slist_append(bridge->headers, "Expect:");
  curl_easy_setopt(bridge->curl, CURLOPT_URL, url);
  curl_easy_setopt(bridge->curl, CURLOPT_HTTPHEADER, bridge->headers);
  curl_easy_setopt(bridge->curl, CURLOPT_POST, 1L);
  curl_easy_setopt(bridge->curl, CURLOPT_TCP_NODELAY, 1L);
  curl_easy_setopt(bridge->curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(bridge->curl, CURLOPT_TIMEOUT, 60L);
  curl_easy_setopt(bridge->curl, CURLOPT_WRITEFUNCTION, receive);
  curl_easy_setopt(bridge->curl, CURLOPT_WRITEDATA, bridge);
  return bridge;
}

void bridge_close(struct bridge *bridge) {
  if (!bridge)
    return;
  if (bridge->curl)
    curl_easy_cleanup(bridge->curl);
  curl_slist_free_all(bridge->headers);
  free(bridge->body);
  free(bridge->reply);
  free(bridge);
}

const char *bridge_error(const struct bridge *bridge) {
  return bridge->error;
}

static bool send_body(struct bridge *bridge) {
  bridge->reply_length = 0;
  bridge->reply_overflow = false;
  bridge->reply[0] = 0;
  curl_easy_setopt(bridge->curl, CURLOPT_POSTFIELDS, bridge->body);
  curl_easy_setopt(bridge->curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)bridge->body_length);
  CURLcode code = curl_easy_perform(bridge->curl);
  if (code != CURLE_OK)
    return failed(bridge, "bridge request failed: %s", curl_easy_strerror(code));
  if (bridge->reply_overflow)
    return failed(bridge, "bridge reply is larger than expected");
  long status = 0;
  curl_easy_getinfo(bridge->curl, CURLINFO_RESPONSE_CODE, &status);
  if (status != 200) {
    char message[200] = "";
    json_text(bridge->reply, "error", message, sizeof(message));
    return failed(bridge, "bridge returned %ld: %s", status, message);
  }
  return true;
}

static bool command(struct bridge *bridge, const char *format, ...) {
  va_list args;
  va_start(args, format);
  int length = vsnprintf(bridge->body, bridge->body_capacity, format, args);
  va_end(args);
  if (length < 0 || (size_t)length >= bridge->body_capacity)
    return failed(bridge, "bridge request does not fit");
  bridge->body_length = (size_t)length;
  return send_body(bridge);
}

bool bridge_prepare_write(struct bridge *bridge, uint64_t address, const void *data,
                          size_t size) {
  int prefix = snprintf(bridge->body, bridge->body_capacity,
                        "{\"command\":\"write\",\"address\":%llu,\"data\":\"",
                        (unsigned long long)address);
  if ((size_t)prefix + base64_size(size) + 3 > bridge->body_capacity)
    return failed(bridge, "write of %zu bytes does not fit", size);
  size_t length = (size_t)prefix + base64_encode(bridge->body + prefix, data, size);
  memcpy(bridge->body + length, "\"}", 3);
  bridge->body_length = length + 2;
  return true;
}

bool bridge_send_write(struct bridge *bridge) {
  if (!send_body(bridge))
    return false;
  if (!strstr(bridge->reply, "\"written\":true"))
    return failed(bridge, "bridge write was not confirmed");
  return true;
}

bool bridge_write(struct bridge *bridge, uint64_t address, const void *data, size_t size) {
  return bridge_prepare_write(bridge, address, data, size) && bridge_send_write(bridge);
}

bool bridge_read(struct bridge *bridge, uint64_t address, void *out, size_t size) {
  if (!command(bridge, "{\"command\":\"read\",\"address\":%llu,\"length\":%zu}",
               (unsigned long long)address, size))
    return false;
  const char *data = json_find(bridge->reply, "data");
  if (!data || *data != '"')
    return failed(bridge, "bridge read returned no data");
  if (base64_decode(out, size, data + 1) != size)
    return failed(bridge, "memory read was truncated");
  return true;
}

static int format_args(char *out, size_t size, const uint64_t *args, int count) {
  int used = 0;
  for (int i = 0; i < count && (size_t)used < size; i++)
    used += snprintf(out + used, size - (size_t)used, "%s%llu", i ? "," : "",
                     (unsigned long long)args[i]);
  return used;
}

static bool call_result(struct bridge *bridge, uint64_t *result) {
  uint64_t value;
  if (!json_u64(bridge->reply, "result", &value))
    return failed(bridge, "bridge call returned no result");
  if (result)
    *result = value;
  return true;
}

bool bridge_call(struct bridge *bridge, unsigned offset, const uint64_t *args, int count,
                 uint64_t *result) {
  char list[160];
  format_args(list, sizeof(list), args, count);
  return command(bridge, "{\"command\":\"call\",\"offset\":%u,\"args\":[%s]}", offset, list) &&
         call_result(bridge, result);
}

bool bridge_call_address(struct bridge *bridge, uint64_t address, const uint64_t *args,
                         int count, uint64_t *result) {
  char list[160];
  format_args(list, sizeof(list), args, count);
  return command(bridge, "{\"command\":\"call-address\",\"address\":%llu,\"args\":[%s]}",
                 (unsigned long long)address, list) &&
         call_result(bridge, result);
}

bool bridge_verify(struct bridge *bridge, uint64_t address, const char *hex) {
  if (!command(bridge, "{\"command\":\"verify-function\",\"address\":%llu,\"hex\":\"%s\"}",
               (unsigned long long)address, hex))
    return false;
  if (!strstr(bridge->reply, "\"verified\":true"))
    return failed(bridge, "function at 0x%llx was not verified", (unsigned long long)address);
  return true;
}
