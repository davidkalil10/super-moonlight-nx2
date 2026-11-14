//! Reaches a PC that may be asleep: ask Sunshine's port, send Wake-on-LAN when it does not
//! answer, wait for it as the r5-wol service did, then connect to `service`.

use crate::wake::{self, Wait};
use moonlight_nx2_io::socket::{IoError, Socket};
use moonlight_nx2_ui::{
    model::{Host, Message},
    presence::{self, ANSWER_TIMEOUT_MS, SUNSHINE_PORT},
};

const SERVICE_LIMIT_MS: u64 = 20_000;
const SERVICE_ATTEMPT_MS: u64 = 2_000;
const SERVICE_RETRY_MS: u64 = 500;
const SERVICE_TIMEOUT: &str = "Sunshine did not answer; check that it is running";

/// The sockets and the Wake-on-LAN send the runtime provides.
pub trait Network {
    type Socket: Socket;
    fn connect(&mut self, address: [u8; 4], port: u16) -> Result<Self::Socket, IoError>;
    /// Sends the packet towards `address` and the broadcast addresses; the runtime logs it.
    fn wake(&mut self, mac: [u8; 6], address: Option<[u8; 4]>);
}

// Boxing Failed would allocate, and this module allocates nothing (see lib.rs).
#[allow(clippy::large_enum_variant)]
pub enum Progress<S> {
    Pending,
    /// Seconds since the packet went out.
    Waking(u64),
    /// The PC answered after being woken.
    Awake,
    Ready(S),
    Failed(Message),
    Retired,
}

struct Question<S> {
    socket: S,
    deadline_ms: u64,
}

enum Answer {
    Pending,
    Awake,
    Silent,
    Retired,
}

enum Phase<S> {
    Asking(Option<Question<S>>),
    Waiting {
        wait: Wait,
        question: Option<Question<S>>,
    },
    Connecting {
        socket: Option<S>,
        deadline_ms: u64,
        attempt_deadline_ms: u64,
        next_attempt_ms: u64,
    },
}

pub struct WakeConnect<S> {
    service: ([u8; 4], u16),
    host: Host,
    mac: [u8; 6],
    target: Option<[u8; 4]>,
    phase: Phase<S>,
}

fn ask<S: Socket, C: Network<Socket = S>>(
    connections: &mut C,
    target: [u8; 4],
    now_ms: u64,
) -> Option<Question<S>> {
    let socket = connections.connect(target, SUNSHINE_PORT).ok()?;
    Some(Question {
        socket,
        deadline_ms: now_ms.saturating_add(ANSWER_TIMEOUT_MS),
    })
}

/// A refused connect is an answer too: the PC is awake and only Sunshine is closed.
fn answer<S: Socket>(question: &mut Option<Question<S>>, now_ms: u64) -> Answer {
    let Some(asked) = question.as_mut() else {
        return Answer::Silent;
    };
    let result = match asked.socket.poll_connect() {
        Ok(true) | Err(IoError::Refused(_)) => Answer::Awake,
        Ok(false) | Err(IoError::WouldBlock | IoError::Interrupted)
            if now_ms < asked.deadline_ms =>
        {
            return Answer::Pending;
        }
        _ => Answer::Silent,
    };
    match question.take().map(|mut asked| asked.socket.close()) {
        Some(Err(_)) => Answer::Retired,
        _ => result,
    }
}

impl<S: Socket> WakeConnect<S> {
    /// `service` is where the connection goes once the PC is up; `force` sends the packet at
    /// once, for the user's Wake PC.
    pub fn start<C: Network<Socket = S>>(
        connections: &mut C,
        service: ([u8; 4], u16),
        host: Host,
        mac: [u8; 6],
        force: bool,
        now_ms: u64,
    ) -> Self {
        let target = presence::ipv4(host.address.as_str());
        let mut pending = Self {
            service,
            host,
            mac,
            target,
            phase: Phase::Asking(None),
        };
        match target {
            Some(target) if !force => {
                pending.phase = Phase::Asking(ask(connections, target, now_ms));
            }
            Some(_) => pending.wake(connections, now_ms),
            None => {
                connections.wake(mac, None);
                pending.connect(now_ms);
            }
        }
        pending
    }

    fn wake<C: Network<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        connections.wake(self.mac, self.target);
        self.phase = Phase::Waiting {
            wait: Wait::new(now_ms),
            question: None,
        };
    }

    fn connect(&mut self, now_ms: u64) {
        self.phase = Phase::Connecting {
            socket: None,
            deadline_ms: now_ms.saturating_add(SERVICE_LIMIT_MS),
            attempt_deadline_ms: now_ms,
            next_attempt_ms: now_ms,
        };
    }

    pub fn poll<C: Network<Socket = S>>(
        &mut self,
        connections: &mut C,
        now_ms: u64,
    ) -> Progress<S> {
        match &mut self.phase {
            Phase::Asking(question) => match answer(question, now_ms) {
                Answer::Pending => Progress::Pending,
                Answer::Retired => Progress::Retired,
                Answer::Awake => {
                    self.connect(now_ms);
                    Progress::Pending
                }
                Answer::Silent => {
                    self.wake(connections, now_ms);
                    Progress::Waking(0)
                }
            },
            Phase::Waiting { wait, question } => {
                let seconds = wait.seconds(now_ms);
                if question.is_some() {
                    return match answer(question, now_ms) {
                        Answer::Retired => Progress::Retired,
                        Answer::Awake => {
                            self.connect(now_ms);
                            Progress::Awake
                        }
                        _ => Progress::Waking(seconds),
                    };
                }
                match wait.step(now_ms) {
                    wake::Step::TimedOut => {
                        return Progress::Failed(wake::timeout_text(self.host.name.as_str()));
                    }
                    wake::Step::Resend => connections.wake(self.mac, self.target),
                    wake::Step::Ask => {
                        *question = self
                            .target
                            .and_then(|target| ask(connections, target, now_ms));
                    }
                    wake::Step::Idle => {}
                }
                Progress::Waking(seconds)
            }
            Phase::Connecting {
                socket,
                deadline_ms,
                attempt_deadline_ms,
                next_attempt_ms,
            } => {
                if now_ms >= *deadline_ms {
                    return match socket.take().map(|mut socket| socket.close()) {
                        Some(Err(_)) => Progress::Retired,
                        _ => Progress::Failed(Message::of(SERVICE_TIMEOUT)),
                    };
                }
                if socket.is_none() && now_ms >= *next_attempt_ms {
                    *socket = connections.connect(self.service.0, self.service.1).ok();
                    *attempt_deadline_ms = now_ms.saturating_add(SERVICE_ATTEMPT_MS);
                    *next_attempt_ms = now_ms.saturating_add(SERVICE_RETRY_MS);
                }
                let Some(open) = socket.as_mut() else {
                    return Progress::Pending;
                };
                match open.poll_connect() {
                    Ok(true) => Progress::Ready(socket.take().expect("connected socket")),
                    Ok(false) | Err(IoError::WouldBlock | IoError::Interrupted)
                        if now_ms < *attempt_deadline_ms =>
                    {
                        Progress::Pending
                    }
                    _ => match socket.take().map(|mut socket| socket.close()) {
                        Some(Err(_)) => Progress::Retired,
                        _ => Progress::Pending,
                    },
                }
            }
        }
    }

    pub fn host(&self) -> &Host {
        &self.host
    }

    /// Closes whatever is open; false when a close failed and the process must retire.
    pub fn close(&mut self) -> bool {
        let closed = match &mut self.phase {
            Phase::Asking(question) | Phase::Waiting { question, .. } => {
                question.take().map(|mut asked| asked.socket.close())
            }
            Phase::Connecting { socket, .. } => socket.take().map(|mut socket| socket.close()),
        };
        !matches!(closed, Some(Err(_)))
    }
}
