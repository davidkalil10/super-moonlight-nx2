use crate::socket::{IoError, Socket, wipe};
use crate::work::{Limits, Work};

/// Bounded send queue over caller storage. Sent bytes are wiped, so a token queued first
/// does not stay in memory after it has gone out.
pub struct Outbound<'a> {
    memory: &'a mut [u8],
    start: usize,
    end: usize,
    max_queued: usize,
}

impl<'a> Outbound<'a> {
    pub fn new(memory: &'a mut [u8]) -> Self {
        wipe(memory);
        Self {
            memory,
            start: 0,
            end: 0,
            max_queued: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.memory.len()
    }

    pub fn queued(&self) -> usize {
        self.end - self.start
    }

    pub fn max_queued(&self) -> usize {
        self.max_queued
    }

    /// Queues every part or nothing. `false` means not enough room right now.
    pub fn push(&mut self, parts: &[&[u8]]) -> bool {
        let bytes: usize = parts.iter().map(|part| part.len()).sum();
        if bytes > self.memory.len() - self.queued() {
            return false;
        }
        if self.end + bytes > self.memory.len() {
            self.memory.copy_within(self.start..self.end, 0);
            self.end -= self.start;
            self.start = 0;
            wipe(&mut self.memory[self.end..]);
        }
        for part in parts {
            self.memory[self.end..self.end + part.len()].copy_from_slice(part);
            self.end += part.len();
        }
        self.max_queued = self.max_queued.max(self.queued());
        true
    }

    /// Sends until the socket would block. Returns the bytes sent.
    pub fn flush(&mut self, socket: &mut impl Socket) -> Result<usize, IoError> {
        self.flush_bounded(socket, Limits::UNLIMITED, &mut Work::default())
    }

    pub(crate) fn flush_bounded(
        &mut self,
        socket: &mut impl Socket,
        limits: Limits,
        work: &mut Work,
    ) -> Result<usize, IoError> {
        let mut total = 0;
        while self.start < self.end {
            let pending = self.end - self.start;
            let sent = match work.send(socket, &self.memory[self.start..self.end], limits) {
                Err(error) if error.is_retry() => break,
                other => other?,
            };
            if sent == 0 || sent > pending {
                return Err(IoError::Failed);
            }
            wipe(&mut self.memory[self.start..self.start + sent]);
            self.start += sent;
            total += sent;
        }
        if self.start == self.end {
            self.start = 0;
            self.end = 0;
        }
        Ok(total)
    }
}

impl Drop for Outbound<'_> {
    fn drop(&mut self) {
        wipe(self.memory);
    }
}
