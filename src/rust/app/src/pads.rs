//! Which controller plays which player. A player keeps its controller until it disconnects, so
//! no game sees its pads swap. New controllers take the lowest free player in the Switch's
//! player order, handheld first. In the UI the controller that presses A becomes the primary.

use crate::input::EXTRA_PADS;

/// Controller sources in the Switch's player order: handheld, then No1 to No8.
pub const SOURCES: usize = 9;
/// Player slots the frame block carries.
pub const PLAYERS: usize = EXTRA_PADS + 1;
/// Players that are routed, sent as Moonlight controllers 0 to 3.
pub const MAX_PLAYERS: usize = 4;

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
    slots: Slots,
    held: [bool; SOURCES],
}

impl Routing {
    pub const fn new() -> Self {
        Self {
            slots: [None; PLAYERS],
            held: [false; SOURCES],
        }
    }

    /// Routes one frame. `claim` lets another pad's fresh A press take the primary and puts the
    /// rest back in player order; keep it off while a stream is shown.
    pub fn update(&mut self, sources: &[Source; SOURCES], claim: bool) -> Slots {
        let connected = |index: u8| sources[usize::from(index)].connected;
        let held = sources.map(|source| source.connected && source.a);
        let claimed = (0..SOURCES as u8).find(|&index| {
            claim
                && self.slots[0] != Some(index)
                && held[usize::from(index)]
                && !self.held[usize::from(index)]
        });
        self.held = held;

        for slot in &mut self.slots {
            *slot = slot.filter(|&index| connected(index));
        }
        if let Some(index) = claimed {
            self.slots = [None; PLAYERS];
            self.slots[0] = Some(index);
        }
        if self.slots[0].is_none() {
            let next = self.slots[1..MAX_PLAYERS].iter_mut().find(|slot| slot.is_some());
            self.slots[0] = next.and_then(Option::take);
        }
        for index in (0..SOURCES as u8).filter(|&index| connected(index)) {
            if self.slots.contains(&Some(index)) {
                continue;
            }
            match self.slots[..MAX_PLAYERS].iter_mut().find(|slot| slot.is_none()) {
                Some(slot) => *slot = Some(index),
                None => break,
            }
        }
        self.slots
    }
}
