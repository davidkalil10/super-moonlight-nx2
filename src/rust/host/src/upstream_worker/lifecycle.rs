use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;

pub trait Engine: Send + Sync + 'static {
    /// Return failure only after the native startup cleanup has completed.
    fn start(&self) -> bool;
    fn interrupt(&self);
    fn stop(&self);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Started,
    Failed,
    Stopped,
}

pub struct Lifecycle<E: Engine> {
    engine: Arc<E>,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    commands: mpsc::Sender<()>,
    events: mpsc::Receiver<Event>,
    stop_requested: bool,
    finished: bool,
}

impl<E: Engine> Lifecycle<E> {
    pub fn new(engine: Arc<E>) -> io::Result<Self> {
        let cancel = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let (commands, receiver) = mpsc::channel();
        let (sender, events) = mpsc::channel();
        let worker_engine = Arc::clone(&engine);
        let worker_cancel = Arc::clone(&cancel);
        let worker_done = Arc::clone(&done);
        thread::Builder::new()
            .name("moonlight-start".into())
            .spawn(move || {
                let started = worker_engine.start();
                let event = if !started {
                    if worker_cancel.load(Ordering::Acquire) {
                        Event::Stopped
                    } else {
                        Event::Failed
                    }
                } else {
                    if !worker_cancel.load(Ordering::Acquire) {
                        let _ = sender.send(Event::Started);
                    }
                    let _ = receiver.recv();
                    worker_engine.stop();
                    Event::Stopped
                };
                worker_done.store(true, Ordering::Release);
                let _ = sender.send(event);
            })?;
        Ok(Self {
            engine,
            cancel,
            done,
            commands,
            events,
            stop_requested: false,
            finished: false,
        })
    }

    pub fn request_stop(&mut self) {
        if self.stop_requested || self.done.load(Ordering::Acquire) {
            return;
        }
        self.stop_requested = true;
        self.cancel.store(true, Ordering::Release);
        let _ = self.commands.send(());
        self.engine.interrupt();
    }

    pub fn poll(&mut self) -> Option<Event> {
        if self.finished {
            return None;
        }
        if self.stop_requested && !self.done.load(Ordering::Acquire) {
            self.engine.interrupt();
        }
        loop {
            match self.events.try_recv() {
                Ok(Event::Started) if self.stop_requested => continue,
                Ok(event @ (Event::Failed | Event::Stopped)) => {
                    self.finished = true;
                    return Some(event);
                }
                Ok(event) => return Some(event),
                Err(mpsc::TryRecvError::Empty) => return None,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.finished = true;
                    return Some(Event::Failed);
                }
            }
        }
    }
}

impl<E: Engine> Drop for Lifecycle<E> {
    fn drop(&mut self) {
        self.request_stop();
    }
}
