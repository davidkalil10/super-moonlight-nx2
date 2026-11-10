//! Pauses a stream when the console leaves the app (HOME, another applet, sleep) and resumes it
//! on return. Pausing is the user's Disconnect: the same stop, so the decoder and audio close
//! the proven way and the app keeps running on the PC. Resuming launches that app again.

use moonlight_nx2_ui::model::Screen;

/// Time after the return for the stop and the app list to finish before giving up.
pub const RESUME_LIMIT_MS: u64 = 15_000;
/// A stream still on screen this long after it was paused is asked to stop once more. A stop
/// asked for in a stream's first second has been seen to end the PC's side only.
pub const STOP_AGAIN_MS: u64 = 3_000;

pub const ENDED_LINK: &str =
    "The PC connection ended while the console was away; import a new PC connection to continue";
pub const ENDED_APP: &str =
    "The app closed on the PC while the console was away; choose it to start again";
pub const ENDED_TIMEOUT: &str = "The stream could not be resumed; choose the app to start again";

/// What the runtime sees this frame.
#[derive(Clone, Copy, Debug)]
pub struct Snapshot {
    pub in_focus: bool,
    /// The system reported a resume, or the main loop stood still: the console slept or the
    /// process was suspended, and a stream that was open is stale.
    pub woke: bool,
    pub screen: Screen,
    /// The app being launched or streamed.
    pub playing: Option<u32>,
    /// The apps are listed and the PC helper is idle.
    pub apps_ready: bool,
    /// The app the PC still runs, 0 for none.
    pub running: u32,
    pub link_up: bool,
    /// The PC has a stored key, so a lost connection can be opened again.
    pub paired: bool,
    pub now_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Command {
    None,
    /// Stop the stream and leave the app running on the PC.
    Pause,
    /// Launch this app again.
    Resume(u32),
    /// The connection is gone but the PC is paired: reconnect, then resume.
    Reconnect,
    /// The stream cannot come back; tell the user why.
    Ended(&'static str),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum State {
    #[default]
    Active,
    Paused {
        app: u32,
        returned_ms: Option<u64>,
        stop_asked_ms: u64,
    },
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Suspend {
    state: State,
}

impl Suspend {
    pub fn paused(&self) -> bool {
        self.state != State::Active
    }

    pub fn tick(&mut self, now: Snapshot) -> Command {
        let streaming = matches!(now.screen, Screen::Launching | Screen::Streaming);
        match self.state {
            State::Active => {
                let Some(app) = now.playing.filter(|_| streaming) else {
                    return Command::None;
                };
                if now.in_focus && !now.woke {
                    return Command::None;
                }
                self.state = State::Paused {
                    app,
                    returned_ms: now.in_focus.then_some(now.now_ms),
                    stop_asked_ms: now.now_ms,
                };
                Command::Pause
            }
            State::Paused {
                app,
                returned_ms,
                stop_asked_ms,
            } => {
                if !now.in_focus {
                    self.state = State::Paused {
                        app,
                        returned_ms: None,
                        stop_asked_ms,
                    };
                    return Command::None;
                }
                let returned_ms = returned_ms.unwrap_or(now.now_ms);
                let still_shown = streaming
                    && now.now_ms.saturating_sub(stop_asked_ms) >= STOP_AGAIN_MS
                    && now.now_ms.saturating_sub(returned_ms) < RESUME_LIMIT_MS;
                self.state = State::Paused {
                    app,
                    returned_ms: Some(returned_ms),
                    stop_asked_ms: if still_shown {
                        now.now_ms
                    } else {
                        stop_asked_ms
                    },
                };
                if still_shown {
                    return Command::Pause;
                }
                let command = self.returned(now, app, returned_ms);
                if command != Command::None || self.left(now.screen) {
                    self.state = State::Active;
                }
                command
            }
        }
    }

    /// The user or a failure moved to a screen that explains itself.
    fn left(&self, screen: Screen) -> bool {
        !matches!(
            screen,
            Screen::Launching | Screen::Streaming | Screen::Connecting | Screen::Apps
        )
    }

    fn returned(&self, now: Snapshot, app: u32, returned_ms: u64) -> Command {
        if self.left(now.screen) {
            return Command::None;
        }
        if !now.link_up {
            return if now.paired {
                Command::Reconnect
            } else {
                Command::Ended(ENDED_LINK)
            };
        }
        if now.screen == Screen::Apps && now.apps_ready {
            return if now.running == app {
                Command::Resume(app)
            } else {
                Command::Ended(ENDED_APP)
            };
        }
        if now.now_ms.saturating_sub(returned_ms) >= RESUME_LIMIT_MS {
            return Command::Ended(ENDED_TIMEOUT);
        }
        Command::None
    }
}

/// The screen must stay on and the console awake while a stream is starting or playing.
pub fn keeps_awake(screen: Screen) -> bool {
    matches!(screen, Screen::Launching | Screen::Streaming)
}
