//! libounce audout behind the io crate's `audio::Device`. C side: src/rust/nro/io_adapter.c.
//! Behaviour follows src/native/audio/audout.c.

use crate::sdk;
use core::ptr::NonNull;
use moonlight_nx2_io::audio::{Device, DeviceError, Format, SLOT_BYTES, SLOTS, Slots};

const AUDIO_OK: u32 = 0;
const AUDIO_REFUSED: u32 = 1;

#[repr(C)]
#[derive(Default)]
struct AudioFormat {
    sample_rate: u32,
    channels: u32,
    sample_bits: u32,
    sample_signed: bool,
}

const _: () = assert!(size_of::<AudioFormat>() == 16);

unsafe extern "C" {
    fn moonlightIoAudioOpen(
        memory: *mut u8,
        slot_bytes: u32,
        format: *mut AudioFormat,
        raw: *mut u32,
    ) -> u32;
    fn moonlightIoAudioAppend(slot: u32, bytes: u32, raw: *mut u32) -> u32;
    fn moonlightIoAudioReleased(slot: *mut i32, raw: *mut u32) -> u32;
    fn moonlightIoAudioQueued(count: *mut u32, raw: *mut u32) -> u32;
    fn moonlightIoAudioContains(slot: u32, contains: *mut bool, raw: *mut u32) -> u32;
    fn moonlightIoAudioStart(raw: *mut u32) -> u32;
    fn moonlightIoAudioStop(raw: *mut u32) -> u32;
    fn moonlightIoAudioFlush(raw: *mut u32) -> u32;
    fn moonlightIoAudioClose(raw: *mut u32) -> u32;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AudioState {
    Closed,
    Open,
    Uncertain,
}

/// audout, one instance per process. After an uncertain result no further SDK call is made
/// and the process is retired, so device-owned buffers are never reused.
pub struct Audout {
    state: AudioState,
    last_result: u32,
}

impl Audout {
    pub const fn new() -> Self {
        Self {
            state: AudioState::Closed,
            last_result: 0,
        }
    }

    /// Raw SDK Result of the last failed call, for the diagnostic log.
    pub fn last_result(&self) -> u32 {
        self.last_result
    }

    fn check(&mut self, status: u32, raw: u32) -> Result<(), DeviceError> {
        match status {
            AUDIO_OK => Ok(()),
            AUDIO_REFUSED => {
                self.last_result = raw;
                Err(DeviceError::Refused)
            }
            _ => {
                self.last_result = raw;
                self.state = AudioState::Uncertain;
                sdk::retire_process();
                Err(DeviceError::Uncertain)
            }
        }
    }

    fn ready(&self) -> Result<(), DeviceError> {
        match self.state {
            AudioState::Open => Ok(()),
            AudioState::Closed => Err(DeviceError::Refused),
            AudioState::Uncertain => Err(DeviceError::Uncertain),
        }
    }

    fn slot(slot: usize) -> Result<u32, DeviceError> {
        if slot < SLOTS {
            Ok(slot as u32)
        } else {
            Err(DeviceError::Refused)
        }
    }

    fn call(&mut self, f: unsafe extern "C" fn(*mut u32) -> u32) -> Result<(), DeviceError> {
        self.ready()?;
        let mut raw = 0;
        let status = unsafe { f(&mut raw) };
        self.check(status, raw)
    }
}

impl Default for Audout {
    fn default() -> Self {
        Self::new()
    }
}

impl Device for Audout {
    fn open(&mut self, memory: NonNull<Slots>) -> Result<Format, DeviceError> {
        match self.state {
            AudioState::Closed => {}
            AudioState::Open => return Err(DeviceError::Refused),
            AudioState::Uncertain => return Err(DeviceError::Uncertain),
        }

        let mut format = AudioFormat::default();
        let mut raw = 0;
        let memory = memory.as_ptr().cast::<u8>();
        let status =
            unsafe { moonlightIoAudioOpen(memory, SLOT_BYTES as u32, &mut format, &mut raw) };
        self.check(status, raw)?;

        self.state = AudioState::Open;
        Ok(Format {
            sample_rate: format.sample_rate,
            channels: format.channels,
            sample_bits: format.sample_bits,
            signed: format.sample_signed,
        })
    }

    fn append(&mut self, slot: usize, bytes: usize) -> Result<(), DeviceError> {
        self.ready()?;
        let slot = Self::slot(slot)?;
        if bytes == 0 || bytes > SLOT_BYTES {
            return Err(DeviceError::Refused);
        }
        let mut raw = 0;
        let status = unsafe { moonlightIoAudioAppend(slot, bytes as u32, &mut raw) };
        self.check(status, raw)
    }

    fn released(&mut self) -> Result<Option<usize>, DeviceError> {
        self.ready()?;
        let mut slot = -1;
        let mut raw = 0;
        let status = unsafe { moonlightIoAudioReleased(&mut slot, &mut raw) };
        self.check(status, raw)?;
        match slot {
            -1 => Ok(None),
            0.. => Ok(Some(slot as usize)),
            _ => Ok(Some(usize::MAX)),
        }
    }

    fn queued(&mut self) -> Result<u32, DeviceError> {
        self.ready()?;
        let mut count = 0;
        let mut raw = 0;
        let status = unsafe { moonlightIoAudioQueued(&mut count, &mut raw) };
        self.check(status, raw)?;
        Ok(count)
    }

    fn contains(&mut self, slot: usize) -> Result<bool, DeviceError> {
        self.ready()?;
        let slot = Self::slot(slot)?;
        let mut contains = true;
        let mut raw = 0;
        let status = unsafe { moonlightIoAudioContains(slot, &mut contains, &mut raw) };
        self.check(status, raw)?;
        Ok(contains)
    }

    fn start(&mut self) -> Result<(), DeviceError> {
        self.call(moonlightIoAudioStart)
    }

    fn stop(&mut self) -> Result<(), DeviceError> {
        self.call(moonlightIoAudioStop)
    }

    fn flush(&mut self) -> Result<(), DeviceError> {
        self.call(moonlightIoAudioFlush)
    }

    fn close(&mut self) -> Result<(), DeviceError> {
        self.call(moonlightIoAudioClose)?;
        self.state = AudioState::Closed;
        Ok(())
    }
}
