use super::native;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const QUEUED_FRAMES: usize = 2;
static USED: AtomicBool = AtomicBool::new(false);
static ACTIVE: Mutex<Option<Arc<State>>> = Mutex::new(None);

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub number: i32,
    pub keyframe: bool,
    pub pts_us: u64,
    pub bytes: Vec<u8>,
}

struct State {
    expected_format: i32,
    expected_width: i32,
    expected_height: i32,
    expected_fps: i32,
    open: AtomicBool,
    configured: AtomicBool,
    submitting: AtomicBool,
    sender: mpsc::SyncSender<Frame>,
}

pub struct VideoOwner {
    state: Arc<State>,
}

impl VideoOwner {
    pub fn new(
        expected_format: i32,
        expected_width: i32,
        expected_height: i32,
        expected_fps: i32,
    ) -> Result<(Self, mpsc::Receiver<Frame>), ()> {
        if USED.swap(true, Ordering::AcqRel) {
            return Err(());
        }
        let (sender, receiver) = mpsc::sync_channel(QUEUED_FRAMES);
        let state = Arc::new(State {
            expected_format,
            expected_width,
            expected_height,
            expected_fps,
            open: AtomicBool::new(true),
            configured: AtomicBool::new(false),
            submitting: AtomicBool::new(false),
            sender,
        });
        let mut active = ACTIVE.lock().map_err(|_| ())?;
        *active = Some(Arc::clone(&state));
        Ok((Self { state }, receiver))
    }

    pub fn callbacks(&self) -> native::DECODER_RENDERER_CALLBACKS {
        let mut callbacks = unsafe { std::mem::zeroed() };
        unsafe { native::LiInitializeVideoCallbacks(&mut callbacks) };
        callbacks.setup = Some(setup);
        callbacks.stop = Some(stop);
        callbacks.cleanup = Some(stop);
        callbacks.submitDecodeUnit = Some(submit);
        callbacks.capabilities = 4 << 24;
        callbacks
    }

    pub fn close(&self) {
        self.state.open.store(false, Ordering::Release);
    }
}

impl Drop for VideoOwner {
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

unsafe extern "C" fn setup(
    format: i32,
    width: i32,
    height: i32,
    fps: i32,
    _context: *mut libc::c_void,
    _flags: i32,
) -> i32 {
    match state() {
        Some(state)
            if state.open.load(Ordering::Acquire)
                && state.expected_format == format
                && state.expected_width == width
                && state.expected_height == height
                && state.expected_fps == fps =>
        {
            state.configured.store(true, Ordering::Release);
            0
        }
        Some(state) => {
            state.configured.store(false, Ordering::Release);
            -1
        }
        None => -1,
    }
}

unsafe extern "C" fn stop() {
    if let Some(state) = state() {
        state.open.store(false, Ordering::Release);
    }
}

unsafe extern "C" fn submit(unit: native::PDECODE_UNIT) -> i32 {
    match std::panic::catch_unwind(|| unsafe { copy_frame(unit) }) {
        Ok(true) => native::DR_OK as i32,
        _ => native::DR_NEED_IDR,
    }
}

unsafe fn copy_frame(unit: native::PDECODE_UNIT) -> bool {
    let Some(state) = state() else { return false };
    if !state.open.load(Ordering::Acquire)
        || !state.configured.load(Ordering::Acquire)
        || unit.is_null()
    {
        return false;
    }
    if state
        .submitting
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return false;
    }
    struct Submission<'a>(&'a AtomicBool);
    impl Drop for Submission<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }
    let _submission = Submission(&state.submitting);
    let unit = unsafe { &*unit };
    let Ok(total) = usize::try_from(unit.fullLength) else {
        return false;
    };
    if total == 0 || total > MAX_FRAME_BYTES {
        return false;
    }
    let mut bytes = Vec::new();
    if bytes.try_reserve_exact(total).is_err() {
        return false;
    }
    let mut entry = unit.bufferList;
    while !entry.is_null() {
        let next = unsafe { &*entry };
        let Ok(length) = usize::try_from(next.length) else {
            return false;
        };
        if length == 0 || next.data.is_null() || length > total - bytes.len() {
            return false;
        }
        bytes.extend_from_slice(unsafe { std::slice::from_raw_parts(next.data.cast(), length) });
        entry = next.next;
    }
    if bytes.len() != total || !state.open.load(Ordering::Acquire) {
        return false;
    }
    state
        .sender
        .try_send(Frame {
            number: unit.frameNumber,
            keyframe: unit.frameType == native::FRAME_TYPE_IDR as i32,
            pts_us: unit.presentationTimeUs,
            bytes,
        })
        .is_ok()
}
