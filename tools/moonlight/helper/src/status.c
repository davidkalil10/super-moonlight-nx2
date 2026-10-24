/* JSON status lines on stderr, serialized because callbacks run on several
 * moonlight-common-c threads. */
#include "helper.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

void status(const char *format, ...) {
  va_list args;
  va_start(args, format);
  pthread_mutex_lock(&lock);
  vfprintf(stderr, format, args);
  fputc('\n', stderr);
  fflush(stderr);
  pthread_mutex_unlock(&lock);
  va_end(args);
}

void json_string(char *out, size_t size, const char *text) {
  size_t used = 0;
  for (; *text && used + 7 < size; text++) {
    unsigned char c = (unsigned char)*text;
    if (c == '"' || c == '\\')
      used += snprintf(out + used, size - used, "\\%c", c);
    else if (c < 0x20)
      used += snprintf(out + used, size - used, "\\u%04x", c);
    else
      out[used++] = c;
  }
  out[used] = 0;
}
