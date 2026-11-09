use crate::{ack::MAX_INPUT_BYTES, udp_video::DROP_MAGIC};
use moonlight_nx2_core::media::{HEADER_BYTES, Header, MAX_PENDING_ACKS};
use std::collections::VecDeque;

const DROP_BYTES: usize = 16;
const ACK_PREFIX: usize = HEADER_BYTES + 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Full,
    DuplicateFrame,
    UnknownFrame,
    UnexpectedAck,
    InvalidDrop,
    TooLarge,
    InvalidInput,
    Truncated,
    Ended,
    NoEvent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DropReason {
    Late,
    Skipped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Event {
    Ack {
        frame: u32,
        header: Header,
        input: Vec<u8>,
    },
    Dropped {
        frame: u32,
        header: Header,
        reason: DropReason,
    },
}

struct Pending {
    frame: u32,
    header: Header,
}

#[derive(Default)]
pub struct Parser {
    pending: VecDeque<Pending>,
    bytes: Vec<u8>,
    ready: Option<(Event, usize)>,
    ended: bool,
    failure: Option<Error>,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    fn fail<T>(&mut self, error: Error) -> Result<T, Error> {
        self.failure = Some(error);
        Err(error)
    }

    pub fn expect(&mut self, frame: u32, header: Header) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.ended {
            return self.fail(Error::Ended);
        }
        if self.pending.len() == MAX_PENDING_ACKS {
            return Err(Error::Full);
        }
        if self.pending.iter().any(|item| item.frame == frame) {
            return Err(Error::DuplicateFrame);
        }
        self.pending.push_back(Pending { frame, header });
        Ok(())
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Result<usize, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.ended {
            return self.fail(Error::Ended);
        }
        if self.ready.is_some() || bytes.is_empty() {
            return Ok(0);
        }
        let mut used = 0;
        loop {
            let target = if self.bytes.len() < 4 {
                4
            } else if u32::from_le_bytes(self.bytes[..4].try_into().expect("prefix")) == DROP_MAGIC
            {
                DROP_BYTES
            } else if self.bytes.len() < ACK_PREFIX {
                ACK_PREFIX
            } else {
                let length = u32::from_le_bytes(
                    self.bytes[HEADER_BYTES..ACK_PREFIX]
                        .try_into()
                        .expect("prefix"),
                ) as usize;
                if length > MAX_INPUT_BYTES {
                    return self.fail(Error::TooLarge);
                }
                ACK_PREFIX + length
            };
            let count = (target - self.bytes.len()).min(bytes.len() - used);
            self.bytes.extend_from_slice(&bytes[used..used + count]);
            used += count;
            if self.bytes.len() < target {
                return Ok(used);
            }
            if target == 4 {
                continue;
            }
            let drop =
                u32::from_le_bytes(self.bytes[..4].try_into().expect("prefix")) == DROP_MAGIC;
            if !drop && target == ACK_PREFIX {
                let length = u32::from_le_bytes(
                    self.bytes[HEADER_BYTES..ACK_PREFIX]
                        .try_into()
                        .expect("prefix"),
                ) as usize;
                if length > MAX_INPUT_BYTES {
                    return self.fail(Error::TooLarge);
                }
                if length != 0 {
                    continue;
                }
            }
            if drop {
                let frame = u32::from_le_bytes(self.bytes[4..8].try_into().expect("drop"));
                let reason = u32::from_le_bytes(self.bytes[8..12].try_into().expect("drop"));
                if self.bytes[12..16] != [0; 4] || !(1..=2).contains(&reason) {
                    return self.fail(Error::InvalidDrop);
                }
                let Some(index) = self.pending.iter().position(|item| item.frame == frame) else {
                    return self.fail(Error::UnknownFrame);
                };
                let header = self.pending[index].header;
                self.ready = Some((
                    Event::Dropped {
                        frame,
                        header,
                        reason: if reason == 1 {
                            DropReason::Late
                        } else {
                            DropReason::Skipped
                        },
                    },
                    index,
                ));
            } else {
                let Some(pending) = self.pending.front() else {
                    return self.fail(Error::UnexpectedAck);
                };
                if self.bytes[..HEADER_BYTES] != pending.header.encode() {
                    return self.fail(Error::UnexpectedAck);
                }
                let input = &self.bytes[ACK_PREFIX..];
                if std::str::from_utf8(input).is_err() {
                    return self.fail(Error::InvalidInput);
                }
                self.ready = Some((
                    Event::Ack {
                        frame: pending.frame,
                        header: pending.header,
                        input: input.to_vec(),
                    },
                    0,
                ));
            }
            return Ok(used);
        }
    }

    pub fn peek(&self) -> Result<Option<&Event>, Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        Ok(self.ready.as_ref().map(|(event, _)| event))
    }

    pub fn consume(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        let Some((_, index)) = self.ready.take() else {
            return Err(Error::NoEvent);
        };
        self.pending.remove(index).expect("pending record");
        self.bytes.clear();
        Ok(())
    }

    pub fn end(&mut self) -> Result<(), Error> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.ready.is_none() && !self.bytes.is_empty() {
            return self.fail(Error::Truncated);
        }
        self.ended = true;
        Ok(())
    }
}
