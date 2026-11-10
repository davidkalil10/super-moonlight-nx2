//! Waits for a PC to answer after its Wake-on-LAN packet, as the r5-wol service did: ask every
//! 2 s for up to 120 s. The packet is sent again every 10 s, since a single broadcast is easily
//! missed by an adapter that is still going to sleep.

use core::fmt::Write;

use moonlight_nx2_ui::model::Message;
use moonlight_nx2_ui::text::Text;

pub const LIMIT_MS: u64 = 120_000;
pub const POLL_MS: u64 = 2_000;
pub const RESEND_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Step {
    Idle,
    /// Ask the PC whether it answers yet.
    Ask,
    /// Send the packet again.
    Resend,
    TimedOut,
}

#[derive(Clone, Copy, Debug)]
pub struct Wait {
    started_ms: u64,
    next_ask_ms: u64,
    next_send_ms: u64,
}

impl Wait {
    /// Starts when the first packet went out.
    pub fn new(now_ms: u64) -> Self {
        Self {
            started_ms: now_ms,
            next_ask_ms: now_ms.saturating_add(POLL_MS),
            next_send_ms: now_ms.saturating_add(RESEND_MS),
        }
    }

    /// Called while no question is in flight.
    pub fn step(&mut self, now_ms: u64) -> Step {
        if now_ms.saturating_sub(self.started_ms) >= LIMIT_MS {
            return Step::TimedOut;
        }
        if now_ms >= self.next_send_ms {
            self.next_send_ms = now_ms.saturating_add(RESEND_MS);
            return Step::Resend;
        }
        if now_ms >= self.next_ask_ms {
            self.next_ask_ms = now_ms.saturating_add(POLL_MS);
            return Step::Ask;
        }
        Step::Idle
    }

    pub fn seconds(&self, now_ms: u64) -> u64 {
        now_ms.saturating_sub(self.started_ms) / 1000
    }
}

pub fn waiting_text(seconds: u64) -> Text<47> {
    let mut out = Text::new();
    let _ = write!(out, "Waking PC\u{2026} {seconds} s");
    out
}

pub fn timeout_text(name: &str) -> Message {
    let mut out = Message::new();
    let _ = write!(
        out,
        "{name} did not answer within {} s; check that Wake-on-LAN is on in its firmware and network adapter",
        LIMIT_MS / 1000
    );
    out
}
