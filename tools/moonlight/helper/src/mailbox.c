#include "mailbox.h"

#include <stdlib.h>
#include <string.h>

bool mailbox_init(struct mailbox *box, size_t bytes) {
  memset(box, 0, sizeof(*box));
  pthread_mutex_init(&box->lock, NULL);
  pthread_cond_init(&box->ready, NULL);
  box->back = 0;
  box->pending = 1;
  box->front = 2;
  for (int i = 0; i < 3; i++)
    if (!(box->buffers[i] = calloc(1, bytes)))
      return false;
  return true;
}

void mailbox_free(struct mailbox *box) {
  for (int i = 0; i < 3; i++) {
    free(box->buffers[i]);
    box->buffers[i] = NULL;
  }
  pthread_mutex_destroy(&box->lock);
  pthread_cond_destroy(&box->ready);
}

uint8_t *mailbox_back(struct mailbox *box) {
  return box->buffers[box->back];
}

bool mailbox_publish(struct mailbox *box, double stamp) {
  pthread_mutex_lock(&box->lock);
  box->stamps[box->back] = stamp;
  int swap = box->back;
  box->back = box->pending;
  box->pending = swap;
  bool dropped = box->has_pending;
  box->has_pending = true;
  pthread_cond_signal(&box->ready);
  pthread_mutex_unlock(&box->lock);
  return dropped;
}

const uint8_t *mailbox_take(struct mailbox *box, double *stamp) {
  pthread_mutex_lock(&box->lock);
  while (!box->has_pending && !box->stopping)
    pthread_cond_wait(&box->ready, &box->lock);
  if (box->stopping) {
    pthread_mutex_unlock(&box->lock);
    return NULL;
  }
  int swap = box->front;
  box->front = box->pending;
  box->pending = swap;
  box->has_pending = false;
  if (stamp)
    *stamp = box->stamps[box->front];
  pthread_mutex_unlock(&box->lock);
  return box->buffers[box->front];
}

void mailbox_stop(struct mailbox *box) {
  pthread_mutex_lock(&box->lock);
  box->stopping = true;
  pthread_cond_broadcast(&box->ready);
  pthread_mutex_unlock(&box->lock);
}

