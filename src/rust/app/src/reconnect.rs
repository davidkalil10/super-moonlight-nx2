//! Brings back the connection to a paired PC after it was cut off: reopen the PC with growing
//! pauses and, when a stream was playing, let the model resume the app the PC still runs.
//! Only a PC this console holds a key for can be reopened without the user.

use moonlight_nx2_ui::model::Screen;

/// Pauses before each attempt; the last one repeats.
pub const DELAYS_MS: [u64; 5] = [1_000, 2_000, 4_000, 8_000, 15_000];
/// How long after the cut the attempts go on.
pub const LIMIT_MS: u64 = 180_000;
pub const RECONNECTING: &str = "The connection to the PC was lost. Reconnecting\u{2026}";
pub const GAVE_UP: &str = "The PC did not come back. Press A to try again.";

#[derive(Clone, Copy, Debug)]
pub struct Snapshot {
    pub screen: Screen,
    pub link_up: bool,
    /// The selected PC has a stored key.
    pub paired: bool,
    pub in_focus: bool,
    pub now_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Command {
    None,
    /// Open the selected PC again; `resume` asks for the app it still runs to be launched.
    Reopen {
        resume: bool,
    },
    GaveUp,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum State {
    #[default]
    Idle,
    Waiting {
        resume: bool,
        attempt: usize,
        at_ms: u64,
        since_ms: u64,
    },
    Trying {
        resume: bool,
        attempt: usize,
        since_ms: u64,
    },
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Reconnect {
    state: State,
}

/// Screens from which the selected PC can be opened again.
fn reopenable(screen: Screen) -> bool {
    matches!(
        screen,
        Screen::ConnectionLost | Screen::Error | Screen::Apps
    )
}

impl Reconnect {
    pub fn active(&self) -> bool {
        self.state != State::Idle
    }

    /// Starts at once, for a caller that already knows the link is gone and what to resume.
    pub fn start(&mut self, now_ms: u64, resume: bool) {
        self.state = State::Waiting {
            resume,
            attempt: 0,
            at_ms: now_ms,
            since_ms: now_ms,
        };
    }

    pub fn tick(&mut self, now: Snapshot) -> Command {
        match self.state {
            State::Idle => {
                if now.screen == Screen::ConnectionLost && now.paired && !now.link_up {
                    self.state = State::Waiting {
                        resume: true,
                        attempt: 0,
                        at_ms: now.now_ms.saturating_add(DELAYS_MS[0]),
                        since_ms: now.now_ms,
                    };
                }
                Command::None
            }
            State::Waiting {
                resume,
                attempt,
                at_ms,
                since_ms,
            } => {
                if !now.paired || !reopenable(now.screen) {
                    self.state = State::Idle;
                    return Command::None;
                }
                if !now.in_focus || now.now_ms < at_ms {
                    return Command::None;
                }
                self.state = State::Trying {
                    resume,
                    attempt,
                    since_ms,
                };
                Command::Reopen { resume }
            }
            State::Trying {
                resume,
                attempt,
                since_ms,
            } => {
                if matches!(now.screen, Screen::Connecting | Screen::Pairing) {
                    return Command::None;
                }
                let failed = matches!(now.screen, Screen::ConnectionLost | Screen::Error)
                    || (now.screen == Screen::Apps && !now.link_up);
                if !failed {
                    self.state = State::Idle;
                    return Command::None;
                }
                if now.now_ms.saturating_sub(since_ms) >= LIMIT_MS {
                    self.state = State::Idle;
                    return Command::GaveUp;
                }
                let attempt = attempt + 1;
                let delay = DELAYS_MS[attempt.min(DELAYS_MS.len() - 1)];
                self.state = State::Waiting {
                    resume,
                    attempt,
                    at_ms: now.now_ms.saturating_add(delay),
                    since_ms,
                };
                Command::None
            }
        }
    }
}
