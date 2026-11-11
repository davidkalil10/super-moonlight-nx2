//! The helper as a service: it keeps listening, takes MNS1 handshakes from consoles, pairs a
//! new console when the PC's user types the code it shows, and hands one authenticated
//! connection at a time to the control server. Design: moonlight-nx2-dev/src/rust/secure/README.md.

use crate::{
    control_server::{Connection, Error as ControlError},
    display,
    helper::Helper,
    pairing_store::{Console, Store, hex},
    transport::SecureStream,
};
use moonlight_nx2_core::control;
use moonlight_nx2_secure::{
    ANSWER_BYTES, Error as SecureError, FINISH_BYTES, HELLO_BYTES, Hello, Id, MAX_RECORD, Mode,
    PAIRED, Pending, Random, Status, code_ok, refuse,
};
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    net::{IpAddr, SocketAddr, TcpListener, TcpStream},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const DEFAULT_PORT: u16 = moonlight_nx2_secure::PORT;
pub const ADMIN_SOCKET: &str = "admin.sock";
const HELLO_LIMIT: Duration = Duration::from_secs(10);
const PAIR_LIMIT: Duration = Duration::from_secs(120);
const FINISH_LIMIT: Duration = Duration::from_secs(10);
const ADMIN_LIMIT: Duration = Duration::from_secs(2);
const MAX_HANDSHAKES: usize = 4;
const MAX_ADMIN: usize = 4;
const PAIR_FAILURES: usize = 3;
const PAIR_WINDOW: Duration = Duration::from_secs(600);
const BACKGROUND_PERIOD: Duration = Duration::from_millis(5);
const REVOKE_FLUSH: Duration = Duration::from_millis(200);
const REVOCATION_PERIOD: Duration = Duration::from_secs(1);

pub fn os_random(bytes: &mut [u8]) {
    let mut filled = 0;
    while filled < bytes.len() {
        let count = unsafe {
            libc::getrandom(bytes[filled..].as_mut_ptr().cast(), bytes.len() - filled, 0)
        };
        if count > 0 {
            filled += count as usize;
        } else if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            panic!("the operating system has no random bytes");
        }
    }
}

/// An authenticated console and its encrypted stream.
pub struct Session {
    pub stream: SecureStream,
    pub console: Id,
}

enum Step {
    Hello {
        bytes: [u8; HELLO_BYTES],
        used: usize,
    },
    /// A pairing waits for the code the PC's user reads off the console.
    Code(Hello),
    Answer {
        bytes: [u8; ANSWER_BYTES],
        sent: usize,
        pending: Option<Pending>,
    },
    Finish {
        bytes: [u8; FINISH_BYTES],
        used: usize,
        pending: Pending,
    },
}

struct Handshake {
    socket: TcpStream,
    address: IpAddr,
    step: Step,
    deadline: Instant,
    /// The `pair` command waiting to hear how this pairing ended.
    asked_by: Option<UnixStream>,
    coded: bool,
}

enum Progress {
    Waiting,
    Dropped,
    Paired,
    Opened(Box<Session>),
}

struct Admin {
    stream: UnixStream,
    line: Vec<u8>,
    deadline: Instant,
}

pub struct Service {
    listener: TcpListener,
    admin: UnixListener,
    admin_path: PathBuf,
    store: Store,
    identity: Id,
    handshakes: Vec<Handshake>,
    admins: Vec<Admin>,
    failures: VecDeque<Instant>,
}

fn would_block(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

fn reply(stream: &mut UnixStream, text: &str) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(ADMIN_LIMIT));
    let _ = stream.write_all(text.as_bytes());
}

impl Service {
    pub fn bind(listen: SocketAddr, state: &Path) -> io::Result<Self> {
        let store = Store::open(state)?;
        let identity = store.identity(os_random)?;
        store.consoles()?;
        let listener = TcpListener::bind(listen)?;
        listener.set_nonblocking(true)?;
        let admin_path = state.join(ADMIN_SOCKET);
        let _ = std::fs::remove_file(&admin_path);
        let admin = UnixListener::bind(&admin_path)?;
        std::fs::set_permissions(&admin_path, std::fs::Permissions::from_mode(0o600))?;
        admin.set_nonblocking(true)?;
        Ok(Self {
            listener,
            admin,
            admin_path,
            store,
            identity,
            handshakes: Vec::new(),
            admins: Vec::new(),
            failures: VecDeque::new(),
        })
    }

    pub fn port(&self) -> io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }

    pub fn paired(&self, console: &Id) -> bool {
        matches!(self.store.find(console), Ok(Some(_)))
    }

    fn locked(&mut self, now: Instant) -> bool {
        while self
            .failures
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= PAIR_WINDOW)
        {
            self.failures.pop_front();
        }
        self.failures.len() >= PAIR_FAILURES
    }

    fn accept(&mut self, now: Instant) {
        loop {
            match self.listener.accept() {
                Ok((socket, address)) => {
                    if self.handshakes.len() == MAX_HANDSHAKES
                        || socket.set_nonblocking(true).is_err()
                        || socket.set_nodelay(true).is_err()
                    {
                        continue;
                    }
                    self.handshakes.push(Handshake {
                        socket,
                        address: address.ip(),
                        step: Step::Hello {
                            bytes: [0; HELLO_BYTES],
                            used: 0,
                        },
                        deadline: now + HELLO_LIMIT,
                        asked_by: None,
                        coded: false,
                    });
                }
                Err(_) => return,
            }
        }
    }

    fn greet(&mut self, hello: &Hello, now: Instant) -> Result<Step, SecureError> {
        let identity = self.identity;
        let refusal = |status| Step::Answer {
            bytes: refuse(status, identity),
            sent: 0,
            pending: None,
        };
        match hello.mode {
            Mode::Session => {
                let Ok(Some(console)) = self.store.find(&hello.console) else {
                    return Ok(refusal(Status::UnknownConsole));
                };
                let (pending, bytes) =
                    hello.answer(self.identity, &console.key, Random(os_random))?;
                Ok(Step::Answer {
                    bytes,
                    sent: 0,
                    pending: Some(pending),
                })
            }
            Mode::Pair if self.locked(now) => Ok(refusal(Status::PairingUnavailable)),
            Mode::Pair => Ok(Step::Code(*hello)),
        }
    }

    /// One handshake's next nonblocking step.
    fn advance(&mut self, handshake: &mut Handshake, now: Instant) -> Progress {
        loop {
            match &mut handshake.step {
                Step::Hello { bytes, used } => {
                    match handshake.socket.read(&mut bytes[*used..]) {
                        Ok(0) => return Progress::Dropped,
                        Ok(count) => *used += count,
                        Err(error) if would_block(&error) => return Progress::Waiting,
                        Err(_) => return Progress::Dropped,
                    }
                    if *used < HELLO_BYTES {
                        continue;
                    }
                    let next = match Hello::parse(bytes) {
                        Ok(hello) => self.greet(&hello, now),
                        Err(SecureError::Version) => Ok(Step::Answer {
                            bytes: refuse(Status::Version, self.identity),
                            sent: 0,
                            pending: None,
                        }),
                        Err(error) => Err(error),
                    };
                    let Ok(next) = next else {
                        return Progress::Dropped;
                    };
                    handshake.deadline = now
                        + if matches!(next, Step::Code(_)) {
                            PAIR_LIMIT
                        } else {
                            FINISH_LIMIT
                        };
                    handshake.step = next;
                }
                Step::Code(_) => {
                    let mut probe = [0; 1];
                    return match handshake.socket.peek(&mut probe) {
                        Err(error) if would_block(&error) => Progress::Waiting,
                        _ => Progress::Dropped,
                    };
                }
                Step::Answer {
                    bytes,
                    sent,
                    pending,
                } => {
                    match handshake.socket.write(&bytes[*sent..]) {
                        Ok(0) => return Progress::Dropped,
                        Ok(count) => *sent += count,
                        Err(error) if would_block(&error) => return Progress::Waiting,
                        Err(_) => return Progress::Dropped,
                    }
                    if *sent < ANSWER_BYTES {
                        continue;
                    }
                    let Some(pending) = pending.take() else {
                        return Progress::Dropped;
                    };
                    handshake.step = Step::Finish {
                        bytes: [0; FINISH_BYTES],
                        used: 0,
                        pending,
                    };
                }
                Step::Finish { bytes, used, .. } => {
                    match handshake.socket.read(&mut bytes[*used..]) {
                        Ok(0) => return Progress::Dropped,
                        Ok(count) => *used += count,
                        Err(error) if would_block(&error) => return Progress::Waiting,
                        Err(_) => return Progress::Dropped,
                    }
                    if *used == FINISH_BYTES {
                        return self.conclude(handshake);
                    }
                }
            }
        }
    }

    fn conclude(&mut self, handshake: &mut Handshake) -> Progress {
        let placeholder = Step::Hello {
            bytes: [0; HELLO_BYTES],
            used: 0,
        };
        let Step::Finish { bytes, pending, .. } =
            std::mem::replace(&mut handshake.step, placeholder)
        else {
            return Progress::Dropped;
        };
        let Ok(mut established) = pending.finish(&bytes) else {
            return Progress::Dropped;
        };
        let console = established.peer;
        let Some(key) = established.pairing_key.take() else {
            let Ok(socket) = handshake.socket.try_clone() else {
                return Progress::Dropped;
            };
            return Progress::Opened(Box::new(Session {
                stream: SecureStream::new(socket, established),
                console,
            }));
        };
        let paired_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        let saved = self.store.add(Console {
            id: console,
            key,
            paired_at,
            address: handshake.address.to_string(),
        });
        let mut stored = [0; MAX_RECORD];
        let told = established
            .sealer
            .seal(PAIRED, &mut stored)
            .is_ok_and(|size| handshake.socket.write_all(&stored[..size]).is_ok());
        if saved.is_err() || !told {
            return Progress::Dropped;
        }
        eprintln!(
            "service: paired console {} at {}",
            hex(&console[..4]),
            handshake.address
        );
        Progress::Paired
    }

    fn end(&mut self, mut handshake: Handshake, paired: bool, now: Instant) {
        if handshake.coded && !paired {
            self.failures.push_back(now);
            eprintln!(
                "service: pairing with {} failed: the code did not match",
                handshake.address
            );
        }
        if let Some(asker) = &mut handshake.asked_by {
            let text = if paired {
                "ok paired\n"
            } else {
                "error the code did not match the console's, or the console gave up\n"
            };
            reply(asker, text);
        }
    }

    fn handshakes(&mut self, now: Instant, active: Option<&Id>) -> Option<Session> {
        let mut opened = None;
        let mut index = 0;
        while index < self.handshakes.len() {
            let mut handshake = self.handshakes.swap_remove(index);
            let progress = if now >= handshake.deadline {
                Progress::Dropped
            } else {
                self.advance(&mut handshake, now)
            };
            match progress {
                Progress::Waiting => {
                    self.handshakes.push(handshake);
                    let last = self.handshakes.len() - 1;
                    self.handshakes.swap(index, last);
                    index += 1;
                }
                Progress::Dropped => self.end(handshake, false, now),
                Progress::Paired => self.end(handshake, true, now),
                Progress::Opened(session) => {
                    if active.is_some_and(|console| *console != session.console) {
                        eprintln!(
                            "service: console {} refused: another console is connected",
                            hex(&session.console[..4])
                        );
                    } else if opened.is_none() {
                        opened = Some(*session);
                    }
                }
            }
        }
        self.keep_newest_pairing();
        opened
    }

    /// One console at a time may wait for its code; a newer request replaces the older.
    fn keep_newest_pairing(&mut self) {
        let newest = self
            .handshakes
            .iter()
            .filter(|handshake| matches!(handshake.step, Step::Code(_)))
            .map(|handshake| handshake.deadline)
            .max();
        self.handshakes.retain(|handshake| {
            !matches!(handshake.step, Step::Code(_)) || Some(handshake.deadline) == newest
        });
    }

    fn pair(&mut self, code: &str, mut asker: UnixStream, now: Instant) {
        if !code_ok(code.as_bytes()) {
            return reply(&mut asker, "error the code is eight digits\n");
        }
        if self.locked(now) {
            return reply(
                &mut asker,
                "error too many wrong codes; pairing is off for ten minutes\n",
            );
        }
        let waiting = self
            .handshakes
            .iter_mut()
            .rev()
            .find(|handshake| matches!(handshake.step, Step::Code(_)));
        let Some(handshake) = waiting else {
            return reply(
                &mut asker,
                "error no console is waiting; start pairing on the console first\n",
            );
        };
        let Step::Code(hello) = &handshake.step else {
            return;
        };
        match hello.answer(self.identity, code.as_bytes(), Random(os_random)) {
            Ok((pending, bytes)) => {
                handshake.step = Step::Answer {
                    bytes,
                    sent: 0,
                    pending: Some(pending),
                };
                handshake.deadline = now + FINISH_LIMIT;
                handshake.coded = true;
                handshake.asked_by = Some(asker);
            }
            Err(_) => reply(&mut asker, "error the console's request was not usable\n"),
        }
    }

    fn command(&mut self, line: &str, mut asker: UnixStream, now: Instant) {
        let mut words = line.split_whitespace();
        match (words.next(), words.next(), words.next()) {
            (Some("pair"), Some(code), None) => self.pair(code, asker, now),
            (Some("consoles"), None, None) => {
                let text = match self.store.consoles() {
                    Ok(consoles) => consoles
                        .iter()
                        .map(|console| {
                            format!(
                                "{} {} {}\n",
                                hex(&console.id),
                                console.address,
                                console.paired_at
                            )
                        })
                        .chain(["ok\n".to_string()])
                        .collect(),
                    Err(_) => "error the console list could not be read\n".to_string(),
                };
                reply(&mut asker, &text);
            }
            (Some("unpair"), Some(prefix), None) => {
                let text = match self.store.remove(prefix) {
                    Ok(count) => format!("ok {count}\n"),
                    Err(_) => "error the console list could not be changed\n".to_string(),
                };
                reply(&mut asker, &text);
            }
            _ => reply(&mut asker, "error unknown command\n"),
        }
    }

    fn admin(&mut self, now: Instant) {
        while let Ok((stream, _)) = self.admin.accept() {
            if self.admins.len() < MAX_ADMIN && stream.set_nonblocking(true).is_ok() {
                self.admins.push(Admin {
                    stream,
                    line: Vec::new(),
                    deadline: now + ADMIN_LIMIT,
                });
            }
        }
        let mut index = 0;
        while index < self.admins.len() {
            let admin = &mut self.admins[index];
            let mut chunk = [0; 64];
            let ended = match admin.stream.read(&mut chunk) {
                Ok(0) => true,
                Ok(count) => {
                    admin.line.extend_from_slice(&chunk[..count]);
                    admin.line.len() > 128
                }
                Err(error) if would_block(&error) => now >= admin.deadline,
                Err(_) => true,
            };
            let complete = admin.line.iter().position(|byte| *byte == b'\n');
            if complete.is_none() && !ended {
                index += 1;
                continue;
            }
            let admin = self.admins.swap_remove(index);
            if let Some(end) = complete
                && let Ok(line) = std::str::from_utf8(&admin.line[..end])
            {
                self.command(line, admin.stream, now);
            }
        }
    }

    /// Accepts and advances everything that is not the active connection. Returns a console
    /// that finished a session handshake: the first one, or the active console again.
    pub fn poll(&mut self, now: Instant, active: Option<&Id>) -> Option<Session> {
        self.accept(now);
        self.admin(now);
        self.handshakes(now, active)
    }

    /// Serves one console until it leaves, is revoked, or connects again.
    fn run(
        &mut self,
        session: Session,
        helper: &Helper,
        match_display: bool,
        stop: &AtomicBool,
    ) -> Result<Option<Session>, ControlError> {
        let console = session.console;
        let name = hex(&console[..4]);
        eprintln!("service: console {name} connected");
        let mut storage = vec![0; control::MAX_PAYLOAD];
        let mut connection = match Connection::secure(session.stream, helper.clone(), &mut storage)
        {
            Ok(connection) => connection,
            Err(error) => {
                eprintln!("service: console {name} could not be served: {error:?}");
                return Ok(None);
            }
        };
        if match_display {
            connection.match_display(display::Session::from_environment());
        }
        let mut polled = Instant::now();
        let mut checked = polled;
        let mut immediate_turns = 0;
        loop {
            if stop.load(Ordering::Relaxed) {
                connection.close()?;
                return Ok(None);
            }
            let now = Instant::now();
            match connection.pump_with_video_readiness(now) {
                Ok(true) => {
                    immediate_turns += 1;
                    if immediate_turns == 4 {
                        immediate_turns = 0;
                        thread::sleep(Duration::from_micros(250));
                    }
                }
                Ok(false) => {
                    immediate_turns = 0;
                    thread::sleep(Duration::from_millis(2));
                }
                Err(ControlError::Closed) => {
                    eprintln!("service: console {name} disconnected");
                    return Ok(None);
                }
                Err(error) => {
                    eprintln!("service: console {name} connection failed: {error:?}");
                    return Ok(None);
                }
            }
            if connection.revoked() {
                let removed = self.store.remove(&hex(&console));
                eprintln!("service: console {name} asked to be forgotten; removed={removed:?}");
                let flush_until = Instant::now() + REVOKE_FLUSH;
                while connection.flushing() && Instant::now() < flush_until {
                    if connection.pump_with_video_readiness(Instant::now()).is_err() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(2));
                }
                connection.close()?;
                return Ok(None);
            }
            if now.saturating_duration_since(polled) >= BACKGROUND_PERIOD {
                polled = now;
                if let Some(next) = self.poll(now, Some(&console)) {
                    eprintln!(
                        "service: console {name} connected again; closing its old connection"
                    );
                    connection.close()?;
                    return Ok(Some(next));
                }
            }
            if now.saturating_duration_since(checked) >= REVOCATION_PERIOD {
                checked = now;
                if !self.paired(&console) {
                    eprintln!("service: console {name} was unpaired; closing its connection");
                    connection.close()?;
                    return Ok(None);
                }
            }
        }
    }

    /// Runs until `stop` is set.
    pub fn serve(
        &mut self,
        helper: &Helper,
        match_display: bool,
        stop: &AtomicBool,
    ) -> Result<(), ControlError> {
        let mut next = None;
        while !stop.load(Ordering::Relaxed) {
            let Some(session) = next.take().or_else(|| self.poll(Instant::now(), None)) else {
                thread::sleep(BACKGROUND_PERIOD);
                continue;
            };
            next = self.run(session, helper, match_display, stop)?;
        }
        Ok(())
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.admin_path);
    }
}

/// Sends one command to a running service and returns its reply.
pub fn ask(state: &Path, command: &str, wait: Duration) -> io::Result<String> {
    let mut stream = UnixStream::connect(state.join(ADMIN_SOCKET))?;
    stream.set_read_timeout(Some(wait))?;
    stream.write_all(format!("{command}\n").as_bytes())?;
    let mut text = String::new();
    stream.read_to_string(&mut text)?;
    Ok(text)
}
