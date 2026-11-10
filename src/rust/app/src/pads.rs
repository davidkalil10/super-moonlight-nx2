//! Which controller plays which player. The primary floats as Civ7's pad did: the first one
//! connected in its scan order, kept until it disconnects, or the one that pressed A in the UI.

use crate::input::EXTRA_PADS;

/// Controller sources in Civ7's scan order: handheld, then No1 to No8.
pub const SOURCES: usize = 9;
pub const PLAYERS: usize = EXTRA_PADS + 1;

/// The source behind each player; index 0 is the primary pad.
pub type Slots = [Option<u8>; PLAYERS];

/// What routing reads from one source in a frame.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Source {
    pub connected: bool,
    pub a: bool,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Routing {
    primary: Option<u8>,
    held: [bool; SOURCES],
}

impl Routing {
    pub const fn new() -> Self {
        Self {
            primary: None,
            held: [false; SOURCES],
        }
    }

    /// Routes one frame. `claim` lets another pad's fresh A press take the primary; keep it
    /// off while a stream is shown so players never swap under a game.
    pub fn update(&mut self, sources: &[Source; SOURCES], claim: bool) -> Slots {
        let held = sources.map(|source| source.connected && source.a);
        let pressed = |index: &u8| held[usize::from(*index)] && !self.held[usize::from(*index)];
        let connected = |index: &u8| sources[usize::from(*index)].connected;
        let order = 0..SOURCES as u8;

        let claimed = order
            .clone()
            .filter(|index| claim && Some(*index) != self.primary)
            .find(pressed);
        let kept = self.primary.filter(connected);
        self.primary = claimed.or(kept).or_else(|| order.clone().find(connected));
        self.held = held;

        let mut slots = [None; PLAYERS];
        slots[0] = self.primary;
        let others = order.filter(|index| Some(*index) != self.primary && connected(index));
        for (slot, index) in slots[1..].iter_mut().zip(others) {
            *slot = Some(index);
        }
        slots
    }
}
