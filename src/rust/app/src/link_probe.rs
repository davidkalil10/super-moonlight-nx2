//! Runs the pre-launch link measurement as `probe` control requests, one at a time.

use crate::{
    link::{Link, LinkError},
    netprobe::{self, Outcome, Session, Step},
};
use moonlight_nx2_core::control::Kind;

/// A reply still owed after the measurement ended is dropped when it arrives, or after this.
const DRAIN_US: u64 = 10_000_000;

#[derive(Default)]
pub struct Prober {
    session: Option<Session>,
    waiting: Option<u32>,
    drain_until_us: u64,
    rates: [u32; netprobe::MAX_CHUNKS],
    rate_count: usize,
}

impl Prober {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn busy(&self) -> bool {
        self.session.is_some() || self.waiting.is_some()
    }

    pub fn waiting_id(&self) -> Option<u32> {
        self.waiting
    }

    /// The rate of each throughput reply of the last finished measurement, slowest first.
    pub fn rates(&self) -> &[u32] {
        &self.rates[..self.rate_count]
    }

    pub fn start(&mut self, now_us: u64) {
        if !self.busy() {
            self.session = Some(Session::new(now_us));
        }
    }

    /// Stops asking; a reply still owed is dropped when it arrives.
    pub fn cancel(&mut self, now_us: u64) {
        if self.session.take().is_some() {
            self.drain_until_us = now_us.saturating_add(DRAIN_US);
        }
    }

    /// Exchanges requests for up to `slice_us`; `pump` moves the link's bytes and returns
    /// false once the link has failed.
    pub fn run<L: Link>(
        &mut self,
        link: &mut L,
        mut pump: impl FnMut(&mut L) -> bool,
        mut clock: impl FnMut() -> u64,
        slice_us: u64,
    ) -> Option<Outcome> {
        let begin_us = clock();
        loop {
            let now_us = clock();
            let Some(session) = self.session.as_mut() else {
                self.drain(link, now_us);
                return None;
            };
            match session.step(now_us) {
                Step::Done(outcome) => {
                    let rates = session.rates();
                    self.rate_count = rates.len();
                    self.rates[..rates.len()].copy_from_slice(rates);
                    self.session = None;
                    self.drain_until_us = now_us.saturating_add(DRAIN_US);
                    return Some(outcome);
                }
                Step::Send { sequence, bytes } => {
                    match link.request(netprobe::request(sequence, bytes).as_str().as_bytes()) {
                        Ok(id) => {
                            session.sent(bytes, clock());
                            self.waiting = Some(id);
                        }
                        Err(LinkError::Again) => return None,
                        Err(LinkError::Closed) => session.failed(),
                    }
                }
                Step::Wait => {
                    let reply = link.peek().map(|frame| {
                        let ours = Some(frame.header.request_id) == self.waiting;
                        (ours, frame.header.kind, frame.payload.len())
                    });
                    match reply {
                        Some((true, kind, bytes)) => {
                            match kind {
                                Kind::Event => session.reply(bytes, now_us),
                                _ => session.refused(),
                            }
                            self.waiting = None;
                            if link.consume().is_err() {
                                session.failed();
                            }
                        }
                        Some(_) => return None,
                        None if pump(link) => {}
                        None => {
                            self.waiting = None;
                            session.failed();
                        }
                    }
                }
            }
            if clock().saturating_sub(begin_us) >= slice_us {
                return None;
            }
        }
    }

    fn drain<L: Link>(&mut self, link: &mut L, now_us: u64) {
        let Some(id) = self.waiting else {
            return;
        };
        let arrived = link
            .peek()
            .is_some_and(|frame| frame.header.request_id == id);
        if (arrived && link.consume().is_ok()) || now_us >= self.drain_until_us {
            self.waiting = None;
        }
    }
}
