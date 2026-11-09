use super::native;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, mpsc};

const MAX_EVENTS: usize = 32;
static USED: AtomicBool = AtomicBool::new(false);
static ACTIVE: Mutex<Option<Arc<State>>> = Mutex::new(None);
/// Players the client can rumble; higher controller numbers are dropped.
pub const RUMBLE_PLAYERS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Connected,
    StageFailed { stage: i32, code: i32 },
    Terminated(i32),
    Status(i32),
}

struct State {
    open: AtomicBool,
    overflow: AtomicBool,
    sender: mpsc::SyncSender<Event>,
    /// Latest motor values per player (low << 16 | high); `rumble_dirty` marks unread ones.
    /// Kept out of the bounded event queue: rumble bursts coalesce instead of overflowing it.
    rumble: [AtomicU32; RUMBLE_PLAYERS],
    rumble_dirty: AtomicU16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rumble {
    pub controller: u16,
    pub low: u16,
    pub high: u16,
}

pub struct ListenerOwner {
    state: Arc<State>,
}

pub struct ListenerMonitor {
    state: Arc<State>,
}

impl ListenerMonitor {
    pub fn overflowed(&self) -> bool {
        self.state.overflow.load(Ordering::Acquire)
    }

    /// The latest rumble of each player changed since the last call, in player order.
    pub fn take_rumble(&self, mut sink: impl FnMut(Rumble)) {
        let dirty = self.state.rumble_dirty.swap(0, Ordering::AcqRel);
        for (index, value) in self.state.rumble.iter().enumerate() {
            if dirty & (1 << index) != 0 {
                let value = value.load(Ordering::Acquire);
                sink(Rumble {
                    controller: index as u16,
                    low: (value >> 16) as u16,
                    high: value as u16,
                });
            }
        }
    }
}

impl ListenerOwner {
    pub fn new() -> Result<(Self, mpsc::Receiver<Event>), ()> {
        if USED.swap(true, Ordering::AcqRel) {
            return Err(());
        }
        let (sender, receiver) = mpsc::sync_channel(MAX_EVENTS);
        let state = Arc::new(State {
            open: AtomicBool::new(true),
            overflow: AtomicBool::new(false),
            sender,
            rumble: Default::default(),
            rumble_dirty: AtomicU16::new(0),
        });
        *ACTIVE.lock().map_err(|_| ())? = Some(Arc::clone(&state));
        Ok((Self { state }, receiver))
    }

    pub fn callbacks(&self) -> native::CONNECTION_LISTENER_CALLBACKS {
        let mut callbacks = unsafe { std::mem::zeroed() };
        unsafe { native::LiInitializeConnectionCallbacks(&mut callbacks) };
        callbacks.stageFailed = Some(stage_failed);
        callbacks.connectionStarted = Some(connected);
        callbacks.connectionTerminated = Some(terminated);
        callbacks.connectionStatusUpdate = Some(status);
        callbacks.rumble = Some(rumble);
        callbacks
    }

    pub fn overflowed(&self) -> bool {
        self.state.overflow.load(Ordering::Acquire)
    }

    pub fn monitor(&self) -> ListenerMonitor {
        ListenerMonitor {
            state: Arc::clone(&self.state),
        }
    }
}

impl Drop for ListenerOwner {
    fn drop(&mut self) {
        self.state.open.store(false, Ordering::Release);
        if let Ok(mut active) = ACTIVE.lock() {
            *active = None;
        }
    }
}

fn active() -> Option<Arc<State>> {
    ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.as_ref().cloned())
}

fn emit(event: Event) {
    let Some(state) = active() else {
        return;
    };
    if state.open.load(Ordering::Acquire) && state.sender.try_send(event).is_err() {
        state.overflow.store(true, Ordering::Release);
    }
}

unsafe extern "C" fn stage_failed(stage: i32, code: i32) {
    emit(Event::StageFailed { stage, code });
}

unsafe extern "C" fn connected() {
    emit(Event::Connected);
}

unsafe extern "C" fn terminated(code: i32) {
    emit(Event::Terminated(code));
}

unsafe extern "C" fn status(value: i32) {
    emit(Event::Status(value));
}

unsafe extern "C" fn rumble(controller: u16, low: u16, high: u16) {
    let Some(state) = active() else {
        return;
    };
    let index = usize::from(controller);
    if !state.open.load(Ordering::Acquire) || index >= RUMBLE_PLAYERS {
        return;
    }
    state.rumble[index].store(u32::from(low) << 16 | u32::from(high), Ordering::Release);
    state.rumble_dirty.fetch_or(1 << index, Ordering::AcqRel);
}
