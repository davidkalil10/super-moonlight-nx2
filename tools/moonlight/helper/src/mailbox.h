/* Newest-frame mailbox: three preallocated buffers rotate between a producer
 * (back), a one-frame slot (pending) and a consumer (front). Publishing over a
 * frame nobody took drops it (publish returns true), so a slow consumer never
 * builds a queue. */
#pragma once

#include <pthread.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct mailbox {
  uint8_t *buffers[3];
  double stamps[3];
  int back, pending, front;
  bool has_pending;
  bool stopping;
  pthread_mutex_t lock;
  pthread_cond_t ready;
};

bool mailbox_init(struct mailbox *box, size_t bytes);
void mailbox_free(struct mailbox *box);
uint8_t *mailbox_back(struct mailbox *box);
bool mailbox_publish(struct mailbox *box, double stamp);
const uint8_t *mailbox_take(struct mailbox *box, double *stamp);
void mailbox_stop(struct mailbox *box);
