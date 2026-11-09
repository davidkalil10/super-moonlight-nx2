use crate::render::Error;
use moonlight_nx2_app::input::{PadState, Touches};

pub const TOUCH_OFFSET: usize = 128;
pub const TOUCH_BYTES: usize = 656;
pub const REQUIRED_BYTES: usize = TOUCH_OFFSET + TOUCH_BYTES;

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
        const CHORD: u64 = (1 << 6) | (1 << 7);
        let active = menu_enabled && input.pad.connected && input.raw_buttons & CHORD == CHORD;
        let needed = page_interactive || active || self.chord_active;
        self.chord_active = active;
        needed
    }
}

pub struct FrameInput {
    pub sampling_number: u64,
    pub raw_buttons: u64,
    pub pad: PadState,
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
            touches: Touches::parse(&input[TOUCH_OFFSET..REQUIRED_BYTES]),
        })
    }
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
            ACTIVE.store(false, Ordering::Release);
        }
    }
}

#[cfg(target_os = "none")]
pub use device::Sampler;
