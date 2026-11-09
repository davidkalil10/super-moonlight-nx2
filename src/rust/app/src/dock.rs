//! Docking policy: a debounced dock monitor (civ7/dock-switch.js `createDockMonitor`) and the
//! per-session shape rules (civ7/stream-fallback.js `sessionSize`, `launchRate`). The restart on
//! a confirmed change lives in the service; saved settings are never touched here.

use crate::request::{Codec, Options};

/// A changed reading switches only when a second read this long after the first agrees.
pub const CONFIRM_MS: u64 = 100;
pub const BASE_WIDTH: u32 = 1920;
pub const BASE_HEIGHT: u32 = 1080;
/// Above this height a session runs at 60 fps at most.
pub const FAST_HEIGHT: u32 = 1440;

/// One operation-mode read; a failed or unknown read keeps the last known mode.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reading {
    Handheld,
    Docked,
    Unknown,
}

impl Reading {
    fn docked(self) -> Option<bool> {
        match self {
            Reading::Handheld => Some(false),
            Reading::Docked => Some(true),
            Reading::Unknown => None,
        }
    }
}

/// The debounced dock state. The runtime samples it each poll; a change is reported once.
#[derive(Clone, Copy, Debug)]
pub struct Monitor {
    docked: bool,
    candidate: Option<(bool, u64)>,
}

impl Monitor {
    pub const fn new(initial: bool) -> Self {
        Self {
            docked: initial,
            candidate: None,
        }
    }

    pub fn current(&self) -> bool {
        self.docked
    }

    /// Feeds one read. Returns the new mode when this read confirms a change seen at least
    /// `CONFIRM_MS` earlier. A disagreeing, unknown or backwards-clock confirmation drops the
    /// candidate, as the JS check returns without switching.
    pub fn sample(&mut self, reading: Reading, now_ms: u64) -> Option<bool> {
        let seen = reading.docked();

        let Some((candidate, since)) = self.candidate else {
            if let Some(seen) = seen
                && seen != self.docked
            {
                self.candidate = Some((seen, now_ms));
            }
            return None;
        };

        if now_ms < since {
            self.candidate = None;
            return None;
        }
        if now_ms - since < CONFIRM_MS {
            return None;
        }

        self.candidate = None;
        if seen != Some(candidate) {
            return None;
        }
        self.docked = candidate;
        Some(candidate)
    }
}

/// The size and rate one session asks for: above 1080p only docked on AV1, and at most 60 fps
/// above 1440p. Applied after the UI's `in_use`, which keeps the saved preference.
pub fn session_options(options: Options, docked: bool) -> Options {
    let mut session = options;

    let fits = options.height <= BASE_HEIGHT || (docked && options.codec == Codec::Av1);
    if !fits {
        session.width = BASE_WIDTH;
        session.height = BASE_HEIGHT;
    }

    if session.height > FAST_HEIGHT {
        session.fps = session.fps.min(60);
    }
    session
}

/// Active area inside a retained display layer, as render-mode.js `apply` requests it.
/// The runtime still owns the actual layer, refresh negotiation and evidence.
pub fn render_size(width: u32, height: u32, docked: bool) -> (u32, u32) {
    if docked {
        (width, height)
    } else {
        (width.min(BASE_WIDTH), height.min(BASE_HEIGHT))
    }
}
