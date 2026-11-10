use super::native;
use std::collections::VecDeque;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const MAX_FRAME_SAMPLES: usize = 5760;
const MAX_PACKET_BYTES: i32 = 65_536;
const QUEUED_BLOCKS: usize = 10;
const PCM_BLOCK_BYTES: usize = 1920;
static USED: AtomicBool = AtomicBool::new(false);
static ACTIVE: Mutex<Option<Arc<State>>> = Mutex::new(None);

struct Decoder {
    native: NonNull<native::OpusMSDecoder>,
    frame_samples: usize,
    pcm: Vec<i16>,
}

// Access to each Opus decoder is serialized by State::decoder.
unsafe impl Send for Decoder {}

impl Drop for Decoder {
    fn drop(&mut self) {
        unsafe { native::opus_multistream_decoder_destroy(self.native.as_ptr()) };
    }
}

struct State {
    open: AtomicBool,
    decoder: Mutex<Option<Decoder>>,
    blocks: Mutex<PcmQueue>,
}

struct PcmQueue {
    complete: VecDeque<Vec<u8>>,
    partial: Vec<u8>,
}

impl PcmQueue {
    fn push(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            if self.partial.capacity() < PCM_BLOCK_BYTES
                && self.partial.try_reserve_exact(PCM_BLOCK_BYTES).is_err()
            {
                return;
            }
            let count = (PCM_BLOCK_BYTES - self.partial.len()).min(bytes.len());
            self.partial.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.partial.len() == PCM_BLOCK_BYTES {
                if self.complete.len() == QUEUED_BLOCKS {
                    self.complete.pop_front();
                }
                self.complete.push_back(std::mem::take(&mut self.partial));
            }
        }
    }
}

pub struct AudioOwner {
    state: Arc<State>,
}

pub struct AudioReader {
    state: Arc<State>,
}

impl AudioReader {
    pub fn take(&self) -> Option<Vec<u8>> {
        self.state.blocks.lock().ok()?.complete.pop_front()
    }
}

impl AudioOwner {
    pub fn new() -> Result<Self, ()> {
        if USED.swap(true, Ordering::AcqRel) {
            return Err(());
        }
        let state = Arc::new(State {
            open: AtomicBool::new(true),
            decoder: Mutex::new(None),
            blocks: Mutex::new(PcmQueue {
                complete: VecDeque::with_capacity(QUEUED_BLOCKS),
                partial: Vec::new(),
            }),
        });
        let mut active = ACTIVE.lock().map_err(|_| ())?;
        *active = Some(Arc::clone(&state));
        Ok(Self { state })
    }

    pub fn callbacks(&self) -> native::AUDIO_RENDERER_CALLBACKS {
        let mut callbacks = unsafe { std::mem::zeroed() };
        unsafe { native::LiInitializeAudioCallbacks(&mut callbacks) };
        callbacks.init = Some(init);
        callbacks.stop = Some(stop);
        callbacks.cleanup = Some(cleanup);
        callbacks.decodeAndPlaySample = Some(decode);
        callbacks.capabilities = native::CAPABILITY_DIRECT_SUBMIT as i32;
        callbacks
    }

    pub fn take(&self) -> Option<Vec<u8>> {
        self.state.blocks.lock().ok()?.complete.pop_front()
    }

    pub fn reader(&self) -> AudioReader {
        AudioReader {
            state: Arc::clone(&self.state),
        }
    }

    pub fn close(&self) {
        self.state.open.store(false, Ordering::Release);
    }
}

impl Drop for AudioOwner {
    fn drop(&mut self) {
        self.close();
        if let Ok(mut active) = ACTIVE.lock() {
            *active = None;
        }
    }
}

fn state() -> Option<Arc<State>> {
    ACTIVE.lock().ok()?.as_ref().cloned()
}

unsafe extern "C" fn init(
    _configuration: i32,
    config: native::POPUS_MULTISTREAM_CONFIGURATION,
    _context: *mut libc::c_void,
    _flags: i32,
) -> i32 {
    match std::panic::catch_unwind(|| unsafe { initialize(config) }) {
        Ok(true) => 0,
        _ => -1,
    }
}

unsafe fn initialize(config: native::POPUS_MULTISTREAM_CONFIGURATION) -> bool {
    let Some(state) = state() else { return false };
    if !state.open.load(Ordering::Acquire) || config.is_null() {
        return false;
    }
    let config = unsafe { &*config };
    let Ok(samples) = usize::try_from(config.samplesPerFrame) else {
        return false;
    };
    if config.sampleRate != 48_000
        || config.channelCount != 2
        || samples == 0
        || samples > MAX_FRAME_SAMPLES
        || config.streams <= 0
        || config.coupledStreams < 0
        || config.coupledStreams > config.streams
    {
        return false;
    }
    let Ok(mut decoder) = state.decoder.try_lock() else {
        return false;
    };
    if decoder.is_some() {
        return false;
    }
    let mut pcm = Vec::new();
    if pcm.try_reserve_exact(samples * 2).is_err() {
        return false;
    }
    pcm.resize(samples * 2, 0);
    let mut error = 0;
    let ptr = unsafe {
        native::opus_multistream_decoder_create(
            config.sampleRate,
            config.channelCount,
            config.streams,
            config.coupledStreams,
            config.mapping.as_ptr(),
            &mut error,
        )
    };
    let Some(ptr) = NonNull::new(ptr) else {
        return false;
    };
    if error != 0 {
        unsafe { native::opus_multistream_decoder_destroy(ptr.as_ptr()) };
        return false;
    }
    *decoder = Some(Decoder {
        native: ptr,
        frame_samples: samples,
        pcm,
    });
    true
}

unsafe extern "C" fn decode(data: *mut libc::c_char, length: i32) {
    let _ = std::panic::catch_unwind(|| unsafe { decode_packet(data, length) });
}

unsafe fn decode_packet(data: *mut libc::c_char, length: i32) {
    let Some(state) = state() else { return };
    let packet = !data.is_null() && (1..=MAX_PACKET_BYTES).contains(&length);
    let packet_loss = data.is_null() && length == 0;
    if !state.open.load(Ordering::Acquire) || !(packet || packet_loss) {
        return;
    }
    let Ok(mut guard) = state.decoder.try_lock() else {
        return;
    };
    let Some(decoder) = guard.as_mut() else {
        return;
    };
    let count = unsafe {
        native::opus_multistream_decode(
            decoder.native.as_ptr(),
            data.cast(),
            length,
            decoder.pcm.as_mut_ptr(),
            decoder.frame_samples as i32,
            0,
        )
    };
    let Ok(count) = usize::try_from(count) else {
        return;
    };
    if count == 0 || count > decoder.frame_samples {
        return;
    }
    let mut bytes = Vec::new();
    if bytes.try_reserve_exact(count * 4).is_err() {
        return;
    }
    for sample in &decoder.pcm[..count * 2] {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    if !state.open.load(Ordering::Acquire) {
        return;
    }
    if let Ok(mut blocks) = state.blocks.lock() {
        blocks.push(&bytes);
    }
}

unsafe extern "C" fn stop() {
    if let Some(state) = state() {
        state.open.store(false, Ordering::Release);
    }
}

unsafe extern "C" fn cleanup() {
    if let Some(state) = state() {
        state.open.store(false, Ordering::Release);
        if let Ok(mut decoder) = state.decoder.lock() {
            *decoder = None;
        }
    }
}
