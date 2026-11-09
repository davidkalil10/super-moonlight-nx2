use crate::render::Error;
use moonlight_nx2_app::input::{EXTRA_PADS, Extra, Motion, PadState, Touches};

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

#[derive(Default)]
pub struct InputGate {
    armed: bool,
}

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
        Ok(input)
    }
}

const MENU_CHORD: u64 = (3 << 6) | (3 << 10);

#[derive(Default)]
pub struct MenuChord {
    since: Option<u64>,
    fired: bool,
}

impl MenuChord {
    pub fn update(&mut self, input: &FrameInput, active: bool, now_ms: u64) -> bool {
        if !active || !input.pad.connected || input.raw_buttons & MENU_CHORD != MENU_CHORD {
            self.since = None;
            self.fired = false;
            return false;
        }
        let since = self.since.get_or_insert(now_ms);
        if now_ms < *since {
            *since = now_ms;
        }
        if !self.fired && now_ms - *since >= 1_000 {
            self.fired = true;
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
        _menu_enabled: bool,
    ) -> bool {
        let active = input.pad.connected && input.raw_buttons & MENU_CHORD == MENU_CHORD;
        let needed = page_interactive || active || self.chord_active;
        self.chord_active = active;
        needed
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

#[cfg(target_os = "none")]
mod device {
    use super::{Error, FrameInput};
    use crate::{render::Renderer, sdk};
    use core::{
        marker::PhantomData,
        sync::atomic::{AtomicBool, Ordering},
    };

    static ACTIVE: AtomicBool = AtomicBool::new(false);
    unsafe extern "C" {
        fn moonlightPlatformInputStart();
        fn moonlightPlatformInputRead(sample: u64, input: *mut u8, bytes: usize) -> bool;
        fn moonlightPlatformRumble(player: u32, low: u16, high: u16);
        fn moonlightPlatformRumbleStop();
    }

    /// Drives player `player` (0 = player 1) while the sampler owns input; else ignored.
    pub fn rumble(player: u8, low: u16, high: u16) {
        if ACTIVE.load(Ordering::Acquire) {
            unsafe { moonlightPlatformRumble(u32::from(player), low, high) };
        }
    }

    pub fn stop_rumble() {
        if ACTIVE.load(Ordering::Acquire) {
            unsafe { moonlightPlatformRumbleStop() };
        }
    }

    pub struct Sampler {
        sample: u64,
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
            Ok(Self {
                sample: 0,
                not_send: PhantomData,
            })
        }

        pub fn read(&mut self, renderer: &mut Renderer) -> Result<FrameInput, Error> {
            self.sample = self.sample.checked_add(1).ok_or(Error::Invalid)?;
            let input = renderer.input_mut()?;
            if !unsafe { moonlightPlatformInputRead(self.sample, input.as_mut_ptr(), input.len()) }
            {
                return Err(Error::Invalid);
            }
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
}
