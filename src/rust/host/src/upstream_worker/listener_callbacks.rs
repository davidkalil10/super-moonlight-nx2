use super::native;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};

const MAX_EVENTS: usize = 32;
static USED: AtomicBool = AtomicBool::new(false);
static ACTIVE: Mutex<Option<Arc<State>>> = Mutex::new(None);

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

fn emit(event: Event) {
    let Some(state) = ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.as_ref().cloned())
    else {
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
