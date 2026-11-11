//! Decodes platform controller and touch samples for the UI and stream.

extern crate alloc;

use crate::render::Error;
use moonlight_nx2_app::input::{EXTRA_PADS, Extra, Motion, PadState, Touches};
use moonlight_nx2_app::pads::{PLAYERS, Routing, SOURCES, Slots, Source};

pub const TOUCH_OFFSET: usize = 128;
pub const TOUCH_BYTES: usize = 656;
pub const REQUIRED_BYTES: usize = TOUCH_OFFSET + TOUCH_BYTES;
/// Players 2 to 8, 32 bytes each: u64 buttons, i32 sticks[4], u32 attributes (bit 0 connected).
/// Above the words the publish shader reads (it ends at byte 800).
pub const EXTRA_OFFSET: usize = 1024;
const SLOT_BYTES: usize = 32;
/// Motion for players 1 to 8, 32 bytes each: i32 accel[3] (1/1000 m/s^2), i32 gyro[3]
/// (1/1000 deg/s), u32 valid.
pub const MOTION_OFFSET: usize = EXTRA_OFFSET + EXTRA_PADS * SLOT_BYTES;
pub const EXTENDED_BYTES: usize = MOTION_OFFSET + (EXTRA_PADS + 1) * SLOT_BYTES;
/// What the platform reads per controller source: a pad slot, then a motion slot.
const SOURCE_BYTES: usize = 2 * SLOT_BYTES;
pub const SOURCES_BYTES: usize = SOURCES * SOURCE_BYTES;
/// The primary block holds a pad slot's buttons, sticks and attributes after its sample number.
const PRIMARY_OFFSET: usize = 8;
const PRIMARY_BYTES: usize = 28;
const BUTTON_A: u8 = 1;

#[derive(Default)]
pub struct InputGate {
    armed: bool,
    #[cfg(feature = "ui-pattern")]
    pattern_held: bool,
    #[cfg(feature = "ui-pattern")]
    pattern_edge: bool,
    #[cfg(feature = "ui-pattern")]
    filter_held: bool,
    #[cfg(feature = "ui-pattern")]
    filter_edge: bool,
    #[cfg(feature = "perf-chord")]
    perf_held: [bool; PERF_CHORDS.len()],
    #[cfg(feature = "perf-chord")]
    perf_edges: [bool; PERF_CHORDS.len()],
}

/// L3+ZL steps the decode path, L3+ZR the latency mode.
#[cfg(feature = "perf-chord")]
pub const PERF_CHORDS: [u64; 2] = [(1 << 4) | (1 << 8), (1 << 4) | (1 << 9)];

#[cfg(feature = "ui-pattern")]
const PATTERN_CHORD: u64 = (1 << 4) | (1 << 5);
#[cfg(feature = "ui-pattern")]
const FILTER_CHORD: u64 = (1 << 8) | (1 << 9);

impl InputGate {
    pub fn filter(&mut self, bytes: &mut [u8]) -> Result<FrameInput, Error> {
        let input = FrameInput::decode(bytes)?;
        if !self.armed {
            self.armed = input.raw_buttons == 0
                && input.touches.points().is_empty()
                && input
                    .pad
                    .sticks
                    .iter()
                    .all(|value| value.unsigned_abs() < 5_000);
            if !self.armed {
                bytes[8..32].fill(0);
                bytes[TOUCH_OFFSET..REQUIRED_BYTES].fill(0);
                return FrameInput::decode(bytes);
            }
        }
        #[cfg(feature = "ui-pattern")]
        {
            let held = input.held_anywhere(PATTERN_CHORD);
            self.pattern_edge |= held && !self.pattern_held;
            self.pattern_held = held;
            let filter = input.held_anywhere(FILTER_CHORD);
            self.filter_edge |= filter && !self.filter_held;
            self.filter_held = filter;
        }
        #[cfg(feature = "perf-chord")]
        for (index, chord) in PERF_CHORDS.iter().enumerate() {
            let held = input.held_anywhere(*chord);
            self.perf_edges[index] |= held && !self.perf_held[index];
            self.perf_held[index] = held;
        }
        Ok(input)
    }

    #[cfg(feature = "ui-pattern")]
    pub fn take_pattern_edge(&mut self) -> bool {
        core::mem::take(&mut self.pattern_edge)
    }

    #[cfg(feature = "ui-pattern")]
    pub fn take_filter_edge(&mut self) -> bool {
        core::mem::take(&mut self.filter_edge)
    }

    /// The perf chord pressed since the last call, as its index in `PERF_CHORDS`.
    #[cfg(feature = "perf-chord")]
    pub fn take_perf_edge(&mut self) -> Option<usize> {
        let index = self.perf_edges.iter().position(|edge| *edge)?;
        self.perf_edges[index] = false;
        Some(index)
    }
}

/// Plus and Minus held together open the stream menu. Civ7 used L+R, which games hold too.
const MENU_CHORD: u64 = 3 << 10;
/// With L and R as well it is the stop chord, which must never open the menu.
const STOP_CHORD: u64 = MENU_CHORD | (3 << 6);

fn menu_held(buttons: u64) -> bool {
    buttons & MENU_CHORD == MENU_CHORD && buttons & STOP_CHORD != STOP_CHORD
}

/// Each player's hold is timed on its own, so any controller can open the menu.
#[derive(Default)]
pub struct MenuChord {
    since: [Option<u64>; PLAYERS],
    fired: [bool; PLAYERS],
}

impl MenuChord {
    pub fn update(&mut self, input: &FrameInput, active: bool, now_ms: u64) -> bool {
        let mut fire = false;
        for (player, buttons) in input.held_buttons().enumerate() {
            fire |= self.update_player(player, active && menu_held(buttons), now_ms);
        }
        fire
    }

    fn update_player(&mut self, player: usize, held: bool, now_ms: u64) -> bool {
        if !held {
            self.since[player] = None;
            self.fired[player] = false;
            return false;
        }
        let since = self.since[player].get_or_insert(now_ms);
        if now_ms < *since {
            *since = now_ms;
        }
        if !self.fired[player] && now_ms - *since >= 1_000 {
            self.fired[player] = true;
            return true;
        }
        false
    }
}

#[derive(Default)]
pub struct UiSchedule {
    chord_active: bool,
}

impl UiSchedule {
    pub fn needs_compute(
        &mut self,
        input: &FrameInput,
        page_interactive: bool,
        menu_enabled: bool,
    ) -> bool {
        let active = menu_enabled && input.held_buttons().any(menu_held);
        let needed = page_interactive || active || self.chord_active;
        self.chord_active = active;
        needed
    }
}

impl FrameInput {
    /// Every player's raw buttons, primary first; a disconnected player holds nothing.
    pub fn held_buttons(&self) -> impl Iterator<Item = u64> + '_ {
        let primary = if self.pad.connected {
            self.raw_buttons
        } else {
            0
        };
        let extra = self.extra.pads.iter().map(|pad| {
            if pad.connected {
                u64::from(pad.buttons)
            } else {
                0
            }
        });
        core::iter::once(primary).chain(extra)
    }

    #[cfg(feature = "ui-pattern")]
    fn held_anywhere(&self, chord: u64) -> bool {
        self.held_buttons().any(|buttons| buttons & chord == chord)
    }
}

pub struct FrameInput {
    pub sampling_number: u64,
    pub raw_buttons: u64,
    pub pad: PadState,
    pub extra: Extra,
    pub touches: Touches,
}

impl FrameInput {
    pub fn decode(input: &[u8]) -> Result<Self, Error> {
        if input.len() < REQUIRED_BYTES {
            return Err(Error::Invalid);
        }
        let word = |offset| u32::from_le_bytes(input[offset..offset + 4].try_into().unwrap());
        let raw_buttons = u64::from_le_bytes(input[8..16].try_into().unwrap());
        Ok(Self {
            sampling_number: u64::from_le_bytes(input[..8].try_into().unwrap()),
            raw_buttons,
            pad: PadState {
                connected: word(32) & 1 != 0,
                buttons: raw_buttons as u32,
                sticks: [
                    word(16) as i32,
                    word(20) as i32,
                    word(24) as i32,
                    word(28) as i32,
                ],
            },
            extra: decode_extra(input),
            touches: Touches::parse(&input[TOUCH_OFFSET..REQUIRED_BYTES]),
        })
    }
}

/// Players 2 to 8 and motion; empty when the platform wrote no extended block.
fn decode_extra(input: &[u8]) -> Extra {
    let mut extra = Extra::default();
    if input.len() < EXTENDED_BYTES {
        return extra;
    }
    let word = |offset: usize| u32::from_le_bytes(input[offset..offset + 4].try_into().unwrap());
    for (slot, pad) in extra.pads.iter_mut().enumerate() {
        let base = EXTRA_OFFSET + slot * SLOT_BYTES;
        *pad = PadState {
            connected: word(base + 24) & 1 != 0,
            buttons: word(base),
            sticks: core::array::from_fn(|axis| word(base + 8 + axis * 4) as i32),
        };
    }
    for (index, motion) in extra.motion.iter_mut().enumerate() {
        let base = MOTION_OFFSET + index * SLOT_BYTES;
        if word(base + 24) & 1 != 0 {
            *motion = Some(Motion {
                accel: core::array::from_fn(|axis| word(base + axis * 4) as i32),
                gyro: core::array::from_fn(|axis| word(base + 12 + axis * 4) as i32),
            });
        }
    }
    extra
}

/// Chooses this frame's players and writes their pads and motion where `FrameInput::decode`
/// and the publish shader read them. `sources` is the platform's read of every controller.
pub fn route(
    routing: &mut Routing,
    claim: bool,
    sources: &[u8; SOURCES_BYTES],
    input: &mut [u8],
) -> Result<Slots, Error> {
    if input.len() < REQUIRED_BYTES {
        return Err(Error::Invalid);
    }
    let slots = routing.update(&source_states(sources), claim);
    let slot = |player: usize, part: usize| {
        let mut bytes = [0; SLOT_BYTES];
        if let Some(source) = slots[player] {
            let base = usize::from(source) * SOURCE_BYTES + part;
            bytes.copy_from_slice(&sources[base..base + SLOT_BYTES]);
        }
        bytes
    };

    input[PRIMARY_OFFSET..PRIMARY_OFFSET + PRIMARY_BYTES]
        .copy_from_slice(&slot(0, 0)[..PRIMARY_BYTES]);
    if input.len() < EXTENDED_BYTES {
        return Ok(slots);
    }
    for player in 1..PLAYERS {
        let base = EXTRA_OFFSET + (player - 1) * SLOT_BYTES;
        input[base..base + SLOT_BYTES].copy_from_slice(&slot(player, 0));
    }
    for player in 0..PLAYERS {
        let base = MOTION_OFFSET + player * SLOT_BYTES;
        input[base..base + SLOT_BYTES].copy_from_slice(&slot(player, SLOT_BYTES));
    }
    Ok(slots)
}

#[cfg(target_os = "none")]
fn change_line(
    change: moonlight_nx2_app::pads::Change,
    mask: u16,
    motion: bool,
) -> alloc::string::String {
    alloc::format!(
        "input: player {} {} from {} motion={motion} mask={mask:#x}",
        change.player + 1,
        if change.arrived { "arrived" } else { "removed" },
        moonlight_nx2_app::pads::source_name(change.source),
    )
}

fn source_states(sources: &[u8; SOURCES_BYTES]) -> [Source; SOURCES] {
    core::array::from_fn(|source| {
        let pad = &sources[source * SOURCE_BYTES..][..SLOT_BYTES];
        Source {
            connected: pad[24] & 1 != 0,
            a: pad[0] & BUTTON_A != 0,
        }
    })
}

#[cfg(target_os = "none")]
mod device {
    use super::{Error, FrameInput, SLOT_BYTES, SOURCE_BYTES, SOURCES_BYTES, change_line, route};
    use crate::{render::Renderer, sdk};
    use core::{
        marker::PhantomData,
        sync::atomic::{AtomicBool, AtomicU8, Ordering},
    };
    use moonlight_nx2_app::pads::{self, PLAYERS, Routing, Slots};

    const UNROUTED: u8 = u8::MAX;

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    /// The controller source behind each player, for rumble.
    static ROUTES: [AtomicU8; PLAYERS] = [const { AtomicU8::new(UNROUTED) }; PLAYERS];
    unsafe extern "C" {
        fn moonlightPlatformInputStart();
        fn moonlightPlatformInputRead(
            sample: u64,
            input: *mut u8,
            bytes: usize,
            sources: *mut u8,
        ) -> bool;
        fn moonlightPlatformRumble(source: u32, low: u16, high: u16);
        fn moonlightPlatformRumbleStop();
    }

    /// Drives player `player` (0 = player 1) while the sampler owns input; else ignored.
    pub fn rumble(player: u8, low: u16, high: u16) {
        if !ACTIVE.load(Ordering::Acquire) {
            return;
        }
        let Some(route) = ROUTES.get(usize::from(player)) else {
            return;
        };
        let source = route.load(Ordering::Acquire);
        if source != UNROUTED {
            unsafe { moonlightPlatformRumble(u32::from(source), low, high) };
        }
    }

    fn has_motion(sources: &[u8; SOURCES_BYTES], source: u8) -> bool {
        let motion = &sources[usize::from(source) * SOURCE_BYTES + SLOT_BYTES..][..SLOT_BYTES];
        motion[24] & 1 != 0
    }

    /// Motors stop when a player changes controller, so none keeps an old player's rumble.
    fn publish_routes(slots: &Slots, sources: &[u8; SOURCES_BYTES]) {
        let old: Slots = core::array::from_fn(|player| {
            Some(ROUTES[player].swap(slots[player].unwrap_or(UNROUTED), Ordering::AcqRel))
                .filter(|&source| source != UNROUTED)
        });
        if old == *slots {
            return;
        }
        unsafe { moonlightPlatformRumbleStop() };
        let mask = pads::mask(slots);
        for change in pads::changes(&old, slots) {
            crate::render_platform::log(&change_line(
                change,
                mask,
                has_motion(sources, change.source),
            ));
        }
    }

    pub fn stop_rumble() {
        if ACTIVE.load(Ordering::Acquire) {
            unsafe { moonlightPlatformRumbleStop() };
        }
    }

    pub struct Sampler {
        sample: u64,
        routing: Routing,
        sources: [u8; SOURCES_BYTES],
        not_send: PhantomData<*mut ()>,
    }

    impl Sampler {
        pub fn open() -> Result<Self, Error> {
            if sdk::process_retired() {
                return Err(Error::Retained);
            }
            if ACTIVE
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return Err(Error::Busy);
            }
            unsafe { moonlightPlatformInputStart() };
            publish_routes(&[None; PLAYERS], &[0; SOURCES_BYTES]);
            Ok(Self {
                sample: 0,
                routing: Routing::new(),
                sources: [0; SOURCES_BYTES],
                not_send: PhantomData,
            })
        }

        /// `claim` lets a controller that presses A become the primary pad.
        pub fn read(&mut self, renderer: &mut Renderer, claim: bool) -> Result<FrameInput, Error> {
            self.sample = self.sample.checked_add(1).ok_or(Error::Invalid)?;
            let input = renderer.input_mut()?;
            let read = unsafe {
                moonlightPlatformInputRead(
                    self.sample,
                    input.as_mut_ptr(),
                    input.len(),
                    self.sources.as_mut_ptr(),
                )
            };
            if !read {
                return Err(Error::Invalid);
            }
            crate::stream_stats::input_sampled(crate::render_platform::now_ns());
            let slots = route(&mut self.routing, claim, &self.sources, input)?;
            publish_routes(&slots, &self.sources);
            FrameInput::decode(input)
        }
    }

    impl Drop for Sampler {
        fn drop(&mut self) {
            unsafe { moonlightPlatformRumbleStop() };
            ACTIVE.store(false, Ordering::Release);
        }
    }
}

#[cfg(target_os = "none")]
pub use device::{Sampler, rumble, stop_rumble};

#[cfg(not(target_os = "none"))]
pub fn rumble(_player: u8, _low: u16, _high: u16) {}

#[cfg(not(target_os = "none"))]
pub fn stop_rumble() {}

#[cfg(test)]
mod menu_tests {
    use super::*;

    #[test]
    fn chord_fires_once_after_one_second_and_rearms() {
        let mut sample = [0u8; REQUIRED_BYTES];
        sample[8..16].copy_from_slice(&MENU_CHORD.to_le_bytes());
        sample[32..36].copy_from_slice(&1u32.to_le_bytes());
        let mut input = FrameInput::decode(&sample).unwrap();
        let mut chord = MenuChord::default();
        assert!(!chord.update(&input, true, 10));
        assert!(!chord.update(&input, true, 1009));
        assert!(chord.update(&input, true, 1010));
        assert!(!chord.update(&input, true, 2500));
        input.pad.connected = false;
        assert!(!chord.update(&input, true, 2600));
        input.pad.connected = true;
        assert!(!chord.update(&input, true, 3000));
        assert!(!chord.update(&input, true, 2000));
        assert!(chord.update(&input, true, 3000));
        assert!(!chord.update(&input, false, 4000));
    }

    fn held(buttons: u64) -> FrameInput {
        let mut sample = [0u8; REQUIRED_BYTES];
        sample[8..16].copy_from_slice(&buttons.to_le_bytes());
        sample[32..36].copy_from_slice(&1u32.to_le_bytes());
        FrameInput::decode(&sample).unwrap()
    }

    #[test]
    fn stop_chord_and_l_r_alone_never_open_the_menu() {
        let mut chord = MenuChord::default();
        for buttons in [STOP_CHORD, 3 << 6, 1 << 10, 1 << 11] {
            assert!(!chord.update(&held(buttons), true, 0));
            assert!(!chord.update(&held(buttons), true, 5_000));
        }
    }

    fn held_by(player: usize, buttons: u32) -> FrameInput {
        let mut sample = [0u8; EXTENDED_BYTES];
        let base = EXTRA_OFFSET + (player - 1) * SLOT_BYTES;
        sample[base..base + 4].copy_from_slice(&buttons.to_le_bytes());
        sample[base + 24] = 1;
        sample[32] = 1;
        FrameInput::decode(&sample).unwrap()
    }

    #[test]
    fn a_second_player_opens_the_menu_with_its_own_hold() {
        let mut chord = MenuChord::default();
        let second = held_by(1, MENU_CHORD as u32);
        assert!(!chord.update(&second, true, 0));
        assert!(chord.update(&second, true, 1_000));
        assert!(!chord.update(&second, true, 2_000));
        assert!(!chord.update(&held_by(1, STOP_CHORD as u32), true, 3_000));
        assert!(!chord.update(&held_by(3, MENU_CHORD as u32), false, 4_000));
    }

    #[test]
    fn players_holding_one_button_each_never_make_the_chord() {
        let mut chord = MenuChord::default();
        let mut split = held_by(1, 1 << 10);
        split.raw_buttons = 1 << 11;
        assert!(!chord.update(&split, true, 0));
        assert!(!chord.update(&split, true, 5_000));
    }

    #[test]
    fn a_player_letting_go_does_not_restart_another_players_hold() {
        let mut chord = MenuChord::default();
        let mut both = held_by(2, MENU_CHORD as u32);
        both.raw_buttons = MENU_CHORD;
        assert!(!chord.update(&both, true, 0));
        assert!(!chord.update(&held_by(2, MENU_CHORD as u32), true, 500));
        assert!(chord.update(&held_by(2, MENU_CHORD as u32), true, 1_000));
    }

    #[test]
    fn the_ui_wakes_for_any_player_holding_the_chord() {
        let mut schedule = UiSchedule::default();
        assert!(schedule.needs_compute(&held_by(2, MENU_CHORD as u32), false, true));
        assert!(schedule.needs_compute(&held_by(2, 0), false, true));
        assert!(!schedule.needs_compute(&held_by(2, 0), false, true));
    }

    #[test]
    fn adding_l_and_r_before_the_second_is_up_cancels_the_menu() {
        let mut chord = MenuChord::default();
        assert!(!chord.update(&held(MENU_CHORD), true, 0));
        assert!(!chord.update(&held(STOP_CHORD), true, 900));
        assert!(!chord.update(&held(STOP_CHORD), true, 2_000));
        assert!(!chord.update(&held(MENU_CHORD | 1 << 6), true, 2_100));
        assert!(chord.update(&held(MENU_CHORD | 1 << 6), true, 3_100));
    }
}
