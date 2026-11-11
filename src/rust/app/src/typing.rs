//! Typing on the PC with the system keyboard. The keyboard runs outside the stream's loop; this
//! tracks it, holds what the user confirmed, and sends it to the PC helper as one `text`
//! control request. The applet takes the console's focus while it is up, so the runtime reads
//! `covers` to keep the suspend logic from stopping the stream for it.

extern crate alloc;

use crate::link::{Link, LinkError};
use alloc::{string::String, vec::Vec};
use moonlight_nx2_core::control::Kind;

/// After the keyboard closes, a focus or resume message it caused still counts as its own.
const SETTLE_MS: u64 = 2_000;
const REPLY_TIMEOUT_MS: u64 = 10_000;
/// The helper's limit for one text request, in bytes.
pub const MAX_TEXT_BYTES: usize = 512;

/// What the platform's keyboard is doing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Poll {
    Idle,
    Up,
    Typed(String),
    /// Closed without text; the platform's result code.
    Closed(u32),
}

pub trait Keyboard {
    /// False when a keyboard is already up or none could be opened.
    fn open(&mut self) -> bool;
    fn poll(&mut self) -> Poll;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Event {
    Opened,
    OpenFailed,
    Confirmed,
    Cancelled(u32),
}

#[derive(Default)]
pub struct Typing {
    up: bool,
    closed_ms: Option<u64>,
    pending: Option<String>,
    waiting: Option<(u32, u64)>,
}

impl Typing {
    /// The keyboard is on screen.
    pub fn up(&self) -> bool {
        self.up
    }

    /// The keyboard is up or has only just closed: the console's focus changes belong to it.
    pub fn covers(&self, now_ms: u64) -> bool {
        self.up
            || self
                .closed_ms
                .is_some_and(|closed| now_ms.saturating_sub(closed) < SETTLE_MS)
    }

    pub fn waiting_id(&self) -> Option<u32> {
        self.waiting.map(|(id, _)| id)
    }

    pub fn expired(&self, now_ms: u64) -> bool {
        self.waiting.is_some_and(|(_, deadline)| now_ms >= deadline)
    }

    /// Forgets everything for a new connection.
    pub fn reset(&mut self) {
        self.pending = None;
        self.waiting = None;
    }

    pub fn show(&mut self, keyboard: &mut impl Keyboard) -> Event {
        if self.up {
            return Event::Opened;
        }
        if keyboard.open() {
            self.up = true;
            Event::Opened
        } else {
            Event::OpenFailed
        }
    }

    /// Follows the keyboard; a confirmed text waits for `send`.
    pub fn step(&mut self, keyboard: &mut impl Keyboard, now_ms: u64) -> Option<Event> {
        if !self.up {
            return None;
        }
        match keyboard.poll() {
            Poll::Idle | Poll::Up => None,
            Poll::Typed(text) => {
                self.up = false;
                self.closed_ms = Some(now_ms);
                self.pending = Some(text);
                Some(Event::Confirmed)
            }
            Poll::Closed(result) => {
                self.up = false;
                self.closed_ms = Some(now_ms);
                Some(Event::Cancelled(result))
            }
        }
    }

    /// Text confirmed and not yet sent.
    pub fn take_pending(&mut self) -> Option<String> {
        self.pending.take()
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Sends the confirmed text as a `text` request; true once the request is queued.
    pub fn send<L: Link>(&mut self, link: &mut L, now_ms: u64) -> bool {
        if self.waiting.is_some() || !link.ready() {
            return false;
        }
        let Some(text) = self.pending.as_deref() else {
            return false;
        };
        match link.request(&request(text)) {
            Ok(id) => {
                self.pending = None;
                self.waiting = Some((id, now_ms.saturating_add(REPLY_TIMEOUT_MS)));
                true
            }
            Err(_) => false,
        }
    }

    /// Takes the reply to the sent text; `Some(true)` when the helper queued it.
    pub fn poll<L: Link>(&mut self, link: &mut L) -> Option<Result<bool, LinkError>> {
        let id = self.waiting_id()?;
        let frame = link.peek()?;
        if frame.header.request_id != id {
            return None;
        }
        let queued = frame.header.kind == Kind::Event
            && frame
                .payload
                .windows(13)
                .any(|window| window == br#""queued":true"#);
        self.waiting = None;
        Some(link.consume().map(|()| queued))
    }
}

/// `{"op":"text","text":...}` with the text as a JSON string.
pub fn request(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 24);
    out.extend_from_slice(br#"{"op":"text","text":""#);
    for character in text.chars() {
        match character {
            '"' => out.extend_from_slice(br#"\""#),
            '\\' => out.extend_from_slice(br"\\"),
            '\n' => out.extend_from_slice(br"\n"),
            '\r' => out.extend_from_slice(br"\r"),
            '\t' => out.extend_from_slice(br"\t"),
            control if (control as u32) < 0x20 => {
                let code = control as u32;
                out.extend_from_slice(br"\u00");
                for nibble in [code >> 4, code & 0xf] {
                    out.push(b"0123456789abcdef"[nibble as usize]);
                }
            }
            other => {
                let mut bytes = [0u8; 4];
                out.extend_from_slice(other.encode_utf8(&mut bytes).as_bytes());
            }
        }
    }
    out.extend_from_slice(br#""}"#);
    out
}

/// What the keyboard may send: not empty, not too long, no NUL.
pub fn sendable(text: &str) -> bool {
    !text.is_empty() && text.len() <= MAX_TEXT_BYTES && !text.contains('\0')
}
