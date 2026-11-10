//! Coordinates UI, control connections, host discovery and media requests.

extern crate alloc;

#[path = "cover_fetch.rs"]
mod cover_fetch;
#[path = "idr_request.rs"]
mod idr_request;

use crate::{
    client::{self, Client},
    client_session::Session,
    control_link::{Access, Control},
    render::Renderer,
};
use alloc::{boxed::Box, vec::Vec};
use moonlight_nx2_app::{
    driver::Effect,
    link::{Link, LinkError},
    link_probe::Prober,
    netprobe,
    pairings::{Loaded, Pairing, Pairings},
    policy::{Context, DisplayCapabilities},
    presence_watch::{Seen, Watch},
    reply::Descriptor,
    service::{Action, RuntimeEvent},
    wake,
    wake_connect::{Network, Progress, WakeConnect},
};
use moonlight_nx2_core::control::Frame as ControlFrame;
use moonlight_nx2_io::{
    control,
    secure::SecureSocket,
    socket::{IoError, Socket},
    udp::Datagram,
};
use moonlight_nx2_secure::{self as secure, Mode, Random, Status};
use moonlight_nx2_ui::{
    discover::{self, Answers},
    json::{Json, Kind},
    link_choice::LinkChoice,
    model::{Address, Message, Screen},
    presence::Presence,
    store::{Files, Store},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AuthError {
    Missing,
    Invalid,
    Uncertain,
}

pub trait Connections {
    type Socket: Socket + 'static;
    fn authorization(&mut self) -> Result<Session, AuthError>;
    fn connect(&mut self, address: [u8; 4], port: u16) -> Result<Self::Socket, IoError>;
    /// Fills `bytes` from the system's random source; false where there is none, and then
    /// no PC can be paired or opened with a stored key.
    fn random(&mut self, _bytes: &mut [u8]) -> bool {
        false
    }
    /// Sends Wake-on-LAN towards `address` and the broadcast addresses, and logs the outcome.
    fn wake(&mut self, _mac: [u8; 6], _address: Option<[u8; 4]>) {}
    /// A microsecond clock for the link measurement; 0 where there is none.
    fn now_us(&mut self) -> u64 {
        0
    }
    /// An unconnected UDP socket for one mDNS query; none where the platform has no network.
    fn discovery(&mut self) -> Result<Box<dyn Datagram>, IoError> {
        Err(IoError::Failed)
    }
}

/// One mDNS window: the query is sent once, answers are read each frame until the deadline.
struct Discovery {
    socket: Box<dyn Datagram>,
    deadline_ms: u64,
    answers: Answers,
    /// Started by the user (Find hosts / Y), not at start-up: an empty result is reported.
    asked: bool,
}

struct Net<'a, C>(&'a mut C);

impl<C: Connections> Network for Net<'_, C> {
    type Socket = C::Socket;
    fn connect(&mut self, address: [u8; 4], port: u16) -> Result<Self::Socket, IoError> {
        self.0.connect(address, port)
    }
    fn wake(&mut self, mac: [u8; 6], address: Option<[u8; 4]>) {
        self.0.wake(mac, address);
    }
}

/// The link measurement of the open PC connection and what Auto made of it.
#[derive(Default)]
struct LinkTest {
    prober: Prober,
    wanted: bool,
    measured: Option<netprobe::LinkQuality>,
    chosen_for: Option<netprobe::Wanted>,
}

/// Part of each frame the link measurement may use.
const PROBE_SLICE_US: u64 = 8_000;
const PROBE_NEEDS_PC: &str = "Open a PC to test the network";
const PROBE_RUNNING: &str = "Testing the network\u{2026}";
const PROBE_UNSUPPORTED: &str = "This PC helper cannot test the network; Auto uses its defaults";
const PROBE_FAILED: &str = "The network test did not finish; Auto uses its defaults";

/// Datagrams read per frame, so a flood cannot stall the UI.
const DISCOVERY_READS: usize = 16;

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub frames: u64,
    pub opened: u64,
    pub authenticated: u64,
    pub requests: u64,
    pub closed: u64,
    pub rejected: bool,
    pub media_opened: u64,
}

/// How the helper connection being opened proves this console.
enum Auth {
    /// The staged one-shot session and its token.
    Token(Session),
    /// The key stored for a paired PC.
    Key,
    /// The same, after the helper refused it once.
    KeyAgain,
    /// No key yet: pair first, with a code the user types on the PC.
    Setup,
}

struct Target {
    address: [u8; 4],
    port: u16,
    pc: Address,
    auth: Auth,
}

/// An MNS1 handshake in progress; `code` is set while pairing.
struct Handshake<S: Socket> {
    socket: SecureSocket<S>,
    address: [u8; 4],
    pc: Address,
    code: Option<[u8; secure::CODE_DIGITS]>,
    /// This key session already follows a refusal; the next one pairs again.
    second: bool,
    deadline_ms: u64,
}

const SESSION_LIMIT_MS: u64 = 10_000;
/// Pause before a refused key is tried once more: the helper may still be storing it.
const KEY_RETRY_MS: u64 = 500;
const PAIRING_LIMIT_MS: u64 = 125_000;
const HELPER_SILENT: &str = "No Moonlight helper answered on this PC";
const CODE_REFUSED: &str = "The code typed on the PC did not match";
const PAIRING_OFF: &str = "The PC is not pairing consoles right now; try again in ten minutes";
const PAIRING_TIMED_OUT: &str = "No code was typed on the PC in time";
const FIRST_RUN: &str = "Start moonlight-nx2-pc serve on the PC, then choose it here to pair";
const HELPER_VERSION: &str = "The PC helper speaks another version; update both sides";
const KEY_NOT_SAVED: &str = "The PC was paired but its key could not be saved";

fn octets(address: &Address) -> Option<[u8; 4]> {
    let mut parts = address.as_str().split('.');
    let mut bytes = [0; 4];
    for byte in &mut bytes {
        *byte = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(bytes)
}

pub enum MediaRequest {
    Open(Box<Descriptor>),
    Close,
}

pub struct Frontend<F, S: Socket + 'static> {
    pub client: Client<F>,
    control: Option<Control<SecureSocket<S>>>,
    wake_connect: Option<(WakeConnect<S>, Target)>,
    handshake: Option<Handshake<S>>,
    key_retry: Option<(Target, u64)>,
    pairings: Pairings,
    files: F,
    forced_wake: Option<Address>,
    presence: Watch<S>,
    link_test: LinkTest,
    text: Option<Message>,
    peer: Option<[u8; 4]>,
    media: Vec<MediaRequest>,
    authorization: Option<Session>,
    authenticated: bool,
    access: Access,
    exit: bool,
    message: Option<&'static str>,
    stats: Stats,
    discovery: Option<Discovery>,
    covers: cover_fetch::Fetcher,
    idr: idr_request::Requester,
    cover_host: Option<moonlight_nx2_ui::model::Host>,
    cover_cache: Option<crate::files::CoverDirectory>,
    /// The first frame runs discovery once, as the Civ7 service does on attach.
    discover_at_start: bool,
}

struct Offline;
impl Link for Offline {
    fn ready(&self) -> bool {
        false
    }
    fn failed(&self) -> bool {
        false
    }
    fn request(&mut self, _: &[u8]) -> Result<u32, LinkError> {
        Err(LinkError::Again)
    }
    fn peek(&self) -> Option<ControlFrame<'_>> {
        None
    }
    fn consume(&mut self) -> Result<(), LinkError> {
        Err(LinkError::Again)
    }
}

impl<F: Files + Clone, S: Socket + 'static> Frontend<F, S> {
    pub fn new(
        bytes: &mut [u8],
        atlas: &[u8],
        files: F,
        authorization: Option<Session>,
        access: Access,
        docked: bool,
    ) -> Result<Self, client::Error> {
        let mut import_error = None;
        if let Some(session) = authorization.as_ref() {
            let mut store = Store::new(files.clone());
            let mut json = Box::new(Json::new());
            if let Ok(mut hosts) = store.load_hosts(&mut json) {
                let mut read = files.clone();
                let mut text = alloc::vec![0; moonlight_nx2_ui::hosts::MAX_BYTES + 1];
                let readable = !read.exists("hosts.json")
                    || read.read("hosts.json", &mut text).is_some_and(|length| {
                        json.parse(&text[..length])
                            .is_some_and(|root| matches!(root.kind(), Kind::Array | Kind::Object))
                    });
                if !readable {
                    import_error =
                        Some("Saved hosts could not be read; the connection was not added");
                } else if !hosts
                    .hosts()
                    .iter()
                    .any(|host| host.address == session.host.address)
                    && hosts.remember(&session.host).is_ok()
                    && !store.save_hosts(&mut hosts)
                {
                    return Err(client::Error::Storage);
                }
            }
        }
        let mut pairing_files = files.clone();
        let (pairings, loaded) = Pairings::load(&mut pairing_files);
        if loaded == Loaded::Damaged {
            crate::render_platform::log("pairing: the pairings file is unreadable; ignored");
        }
        let mut client = Client::new(bytes, atlas, files, 1)?;
        client.context_changed(Context {
            docked,
            decoder: Default::default(),
            display: DisplayCapabilities::default(),
        });
        let message = import_error.or_else(|| {
            (authorization.is_none()
                && pairings.count() == 0
                && client.bridge.model().message().is_none())
            .then_some(FIRST_RUN)
        });
        Ok(Self {
            client,
            control: None,
            wake_connect: None,
            handshake: None,
            key_retry: None,
            pairings,
            files: pairing_files,
            forced_wake: None,
            presence: Watch::default(),
            link_test: LinkTest::default(),
            text: None,
            peer: None,
            media: Vec::new(),
            authorization,
            authenticated: false,
            access,
            exit: false,
            message,
            stats: Stats::default(),
            discovery: None,
            covers: cover_fetch::Fetcher::default(),
            idr: idr_request::Requester::default(),
            cover_host: None,
            cover_cache: None,
            discover_at_start: true,
        })
    }

    fn discover<C: Connections<Socket = S>>(
        &mut self,
        connections: &mut C,
        now_ms: u64,
        asked: bool,
    ) {
        if self.discovery.is_some() {
            return;
        }
        let started =
            connections
                .discovery()
                .and_then(|mut socket| match socket.send(&discover::query()) {
                    Ok(()) => Ok(socket),
                    Err(error) => {
                        let _ = socket.close();
                        Err(error)
                    }
                });
        match started {
            Ok(socket) => {
                self.discovery = Some(Discovery {
                    socket,
                    deadline_ms: now_ms.saturating_add(discover::WINDOW_MS),
                    answers: Answers::default(),
                    asked,
                })
            }
            Err(_) if asked => {
                self.message = Some("PC discovery unavailable; check Wi-Fi or add a PC by IP")
            }
            Err(_) => {}
        }
    }

    fn poll_discovery(&mut self, now_ms: u64) {
        let Some(discovery) = self.discovery.as_mut() else {
            return;
        };
        let mut packet = alloc::vec![0; discover::MAX_PACKET + 1];
        let mut failed = false;
        for _ in 0..DISCOVERY_READS {
            match discovery.socket.recv(&mut packet) {
                Ok(count) if count <= discover::MAX_PACKET => {
                    discovery.answers.add(&packet[..count])
                }
                Ok(_) | Err(IoError::Interrupted) => {}
                Err(IoError::WouldBlock) => break,
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
        if !failed && now_ms < discovery.deadline_ms {
            return;
        }
        let mut discovery = self.discovery.take().expect("discovery");
        let _ = discovery.socket.close();
        let found = discovery.answers.hosts();
        if let Some(error) = self.client.discovered(&found) {
            self.message = Some(error);
        } else if discovery.asked {
            self.message = if failed {
                Some("PC discovery failed; check Wi-Fi or add a PC by IP")
            } else if found.is_empty() {
                Some("No PCs found; check Sunshine or add a PC by IP")
            } else {
                Some("Select a PC; import a PC connection before connecting")
            };
        }
    }

    pub fn stats(&self) -> Stats {
        let mut stats = self.stats;
        if let Some(control) = &self.control {
            stats.requests += control.stats().map_or(0, |stats| stats.requests);
            stats.rejected |= control.rejected();
        }
        stats
    }

    pub fn exiting(&self) -> bool {
        self.exit
    }
    pub fn screen(&self) -> Screen {
        self.client.bridge.model().screen()
    }

    pub fn peer(&self) -> Option<[u8; 4]> {
        self.peer
    }

    /// The PC helper connection is open and authenticated.
    pub fn link_up(&self) -> bool {
        self.control.is_some() && self.authenticated
    }

    pub fn take_media(&mut self) -> Vec<MediaRequest> {
        core::mem::take(&mut self.media)
    }

    pub fn notice(&mut self, text: &'static str) {
        self.message = Some(text);
    }

    pub fn set_cover_cache(&mut self, cache: crate::files::CoverDirectory) {
        self.cover_cache = Some(cache);
    }

    pub fn close_control(&mut self) -> bool {
        self.covers.reset();
        self.idr.reset();
        self.cover_host = None;
        self.client.clear_covers();
        self.link_test = LinkTest::default();
        self.client.set_link(None, "");
        self.key_retry = None;
        if let Some(mut handshake) = self.handshake.take()
            && handshake.socket.close().is_err()
        {
            crate::render_platform::retire_process();
            return false;
        }
        if let Some((mut pending, target)) = self.wake_connect.take() {
            // The token has not left the console yet, so the connection file is still good.
            if let Auth::Token(authorization) = target.auth {
                self.authorization = Some(authorization);
            }
            let host = pending.host().address;
            self.client.set_presence(&host, Presence::Unknown);
            self.client.set_status(None);
            if !pending.close() {
                crate::render_platform::retire_process();
                return false;
            }
        }
        let Some(mut control) = self.control.take() else {
            return true;
        };
        self.stats.rejected |= control.rejected();
        self.authenticated = false;
        if let Some(closed) = control.close() {
            self.stats.requests += closed.stats.requests;
            self.stats.closed += 1;
            !closed.retained
        } else {
            false
        }
    }

    /// Chooses how to reach the helper for the selected PC: its stored key, the staged
    /// one-shot session, or a first pairing. A staged session never replaces a key.
    fn target<C: Connections<Socket = S>>(&mut self, connections: &mut C) -> Option<Target> {
        let pc = self.client.bridge.model().host().map(|host| host.address);
        let secure = pc
            .and_then(|pc| octets(&pc).map(|address| (pc, address)))
            .filter(|_| connections.random(&mut [0; 1]));
        let paired = secure.filter(|(pc, _)| self.pairings.find(pc).is_some());
        let staged = self
            .authorization
            .take()
            .map_or_else(|| connections.authorization(), Ok);
        if let Some((pc, address)) = paired {
            match staged {
                Ok(session) if session.host.address == pc => crate::render_platform::log(
                    "pairing: the staged PC connection was discarded; this PC is paired",
                ),
                Ok(session) => self.authorization = Some(session),
                Err(_) => {}
            }
            return Some(Target {
                address,
                port: secure::PORT,
                pc,
                auth: Auth::Key,
            });
        }
        match (staged, secure) {
            (Ok(session), _) => Some(Target {
                address: session.address,
                port: session.port,
                pc: session.host.address,
                auth: Auth::Token(session),
            }),
            (Err(AuthError::Missing), Some((pc, address))) => Some(Target {
                address,
                port: secure::PORT,
                pc,
                auth: Auth::Setup,
            }),
            (Err(error), _) => {
                self.message = Some(match error {
                    AuthError::Missing => "Import a new PC connection before connecting",
                    AuthError::Invalid => "The PC connection file is invalid",
                    AuthError::Uncertain => {
                        "The PC connection file could not be consumed; restart before trying again"
                    }
                });
                None
            }
        }
    }

    fn open<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        if self.control.is_some()
            || self.wake_connect.is_some()
            || self.handshake.is_some()
            || self.key_retry.is_some()
        {
            self.client.runtime(RuntimeEvent::LinkFailed);
            return;
        }
        let Some(target) = self.target(connections) else {
            self.client.runtime(RuntimeEvent::LinkFailed);
            return;
        };
        let host = self.client.bridge.model().host().copied();
        if let Some((host, mac)) = host.and_then(|host| host.mac.map(|mac| (host, mac))) {
            let force = self.forced_wake.take() == Some(host.address);
            let helper = (target.address, target.port);
            let pending =
                WakeConnect::start(&mut Net(connections), helper, host, mac.0, force, now_ms);
            if crate::render_platform::process_retired() {
                self.exit = true;
                self.client.runtime(RuntimeEvent::LinkFailed);
                return;
            }
            self.client
                .driver
                .service_mut()
                .set_link_timeout(now_ms, wake::LIMIT_MS + 30_000);
            self.wake_connect = Some((pending, target));
            return;
        }
        self.forced_wake = None;
        self.connect(connections, target, now_ms);
    }

    fn connect<C: Connections<Socket = S>>(
        &mut self,
        connections: &mut C,
        target: Target,
        now_ms: u64,
    ) {
        match connections.connect(target.address, target.port) {
            Ok(socket) => self.attach(connections, socket, target, now_ms),
            Err(_) => {
                self.client.runtime(RuntimeEvent::LinkFailed);
                self.message = Some(match target.auth {
                    Auth::Token(_) => {
                        "Check Wi-Fi and Sunshine; import a new PC connection to retry"
                    }
                    _ => HELPER_SILENT,
                });
            }
        }
    }

    /// Starts authentication on a socket whose connect is in progress.
    fn attach<C: Connections<Socket = S>>(
        &mut self,
        connections: &mut C,
        socket: S,
        target: Target,
        now_ms: u64,
    ) {
        let mut random = Random(|bytes: &mut [u8]| {
            connections.random(bytes);
        });
        let (mode, code, limit_ms) = match target.auth {
            Auth::Token(mut session) => {
                let token = core::mem::replace(&mut session.token, [0; 64]);
                return self.control_over(
                    SecureSocket::plain(socket),
                    token,
                    session.address,
                    now_ms,
                );
            }
            Auth::Key | Auth::KeyAgain => (Mode::Session, None, SESSION_LIMIT_MS),
            Auth::Setup => (
                Mode::Pair,
                Some(secure::new_code(&mut random)),
                PAIRING_LIMIT_MS,
            ),
        };
        let console = self.pairings.console(|bytes| random.0(bytes));
        let key = self.pairings.find(&target.pc).map(|pairing| pairing.key);
        let secret: &[u8] = match (&code, &key) {
            (Some(code), _) => code,
            (None, Some(key)) => key,
            (None, None) => &[],
        };
        let socket = SecureSocket::secured(socket, mode, console, secret, &mut random);
        if code.is_some() {
            self.client
                .driver
                .service_mut()
                .set_link_timeout(now_ms, PAIRING_LIMIT_MS + 5_000);
            crate::render_platform::log("pairing: showing a code and waiting for the PC");
        }
        self.handshake = Some(Handshake {
            socket,
            address: target.address,
            pc: target.pc,
            code,
            second: matches!(target.auth, Auth::KeyAgain),
            deadline_ms: now_ms.saturating_add(limit_ms),
        });
    }

    fn control_over(
        &mut self,
        socket: SecureSocket<S>,
        token: [u8; 64],
        address: [u8; 4],
        now_ms: u64,
    ) {
        match Control::open(socket, token, self.access, now_ms) {
            Ok(control) => {
                self.control = Some(control);
                self.peer = Some(address);
                self.stats.opened += 1;
            }
            Err(error) => {
                self.client.runtime(RuntimeEvent::LinkFailed);
                self.message = Some(HELPER_SILENT);
                if error.retained {
                    self.exit = true;
                }
            }
        }
    }

    fn link_failed(&mut self, message: &'static str) {
        self.client.runtime(RuntimeEvent::LinkFailed);
        self.message = Some(message);
    }

    /// Stores the key a finished pairing produced and opens a session with it.
    fn paired<C: Connections<Socket = S>>(
        &mut self,
        connections: &mut C,
        mut handshake: Handshake<S>,
        now_ms: u64,
    ) {
        let pairing = handshake.socket.take_pairing();
        if handshake.socket.close().is_err() {
            crate::render_platform::retire_process();
            self.exit = true;
        }
        let Some((helper, key)) = pairing else {
            return self.link_failed(HELPER_SILENT);
        };
        self.pairings.add(Pairing {
            address: handshake.pc,
            helper,
            key,
        });
        if !self.pairings.save(&mut self.files) {
            self.pairings.forget(&handshake.pc);
            return self.link_failed(KEY_NOT_SAVED);
        }
        crate::render_platform::log(&alloc::format!(
            "pairing: paired with the helper at {}",
            handshake.pc.as_str()
        ));
        self.text = Some(Message::of("Paired. Connecting\u{2026}"));
        let target = Target {
            address: handshake.address,
            port: secure::PORT,
            pc: handshake.pc,
            auth: Auth::Key,
        };
        self.connect(connections, target, now_ms);
    }

    fn poll_handshake<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        let cancelled = self.client.bridge.model().screen() != Screen::Connecting;
        let Some(mut handshake) = self.handshake.take() else {
            match self.key_retry.take() {
                Some((target, at_ms)) if !cancelled && now_ms >= at_ms => {
                    self.connect(connections, target, now_ms)
                }
                Some(retry) if !cancelled => self.key_retry = Some(retry),
                _ => {}
            }
            return;
        };
        let pairing = handshake.code.is_some();
        if let Some(code) = &handshake.code {
            let left_s = handshake.deadline_ms.saturating_sub(now_ms).div_ceil(1000);
            self.client
                .bridge
                .set_helper_code(core::str::from_utf8(code).ok(), Some(left_s as u32));
        }
        let progress = if cancelled {
            Err(IoError::Failed)
        } else {
            handshake.socket.poll_connect()
        };
        let waiting = progress == Ok(false) && now_ms < handshake.deadline_ms;
        if pairing && !waiting {
            self.client.bridge.set_helper_code(None, None);
        }
        match progress {
            Ok(false) if waiting => {
                self.handshake = Some(handshake);
                return;
            }
            Ok(true) if pairing => return self.paired(connections, handshake, now_ms),
            Ok(true) => {
                crate::render_platform::log("pairing: session opened with the stored key");
                return self.control_over(
                    handshake.socket,
                    secure::SESSION_TOKEN,
                    handshake.address,
                    now_ms,
                );
            }
            _ => {}
        }
        let failure = handshake.socket.failure();
        if handshake.socket.close().is_err() {
            crate::render_platform::retire_process();
            self.exit = true;
        }
        if cancelled {
            return;
        }
        crate::render_platform::log(&alloc::format!(
            "pairing: handshake ended pairing={pairing} failure={failure:?} timed_out={}",
            progress == Ok(false)
        ));
        let rejected = matches!(
            failure,
            Some(secure::Error::Confirm | secure::Error::Refused(Status::UnknownConsole))
        );
        let again = |auth| Target {
            address: handshake.address,
            port: secure::PORT,
            pc: handshake.pc,
            auth,
        };
        match failure {
            _ if rejected && !pairing && !handshake.second => {
                self.key_retry = Some((again(Auth::KeyAgain), now_ms.saturating_add(KEY_RETRY_MS)));
            }
            _ if rejected && !pairing => self.connect(connections, again(Auth::Setup), now_ms),
            Some(secure::Error::Confirm) => self.link_failed(CODE_REFUSED),
            Some(secure::Error::Refused(Status::PairingUnavailable)) => {
                self.link_failed(PAIRING_OFF)
            }
            Some(secure::Error::Version | secure::Error::Refused(Status::Version)) => {
                self.link_failed(HELPER_VERSION)
            }
            _ if pairing && progress == Ok(false) => self.link_failed(PAIRING_TIMED_OUT),
            _ => self.link_failed(HELPER_SILENT),
        }
    }

    /// Removes the stored key of a PC the user removed.
    fn forget(&mut self, pc: &Address) {
        if !self.pairings.forget(pc) {
            return;
        }
        // The second write replaces the backup the first one leaves, which still holds the key.
        let saved = self.pairings.save(&mut self.files) && self.pairings.save(&mut self.files);
        crate::render_platform::log(&alloc::format!(
            "pairing: forgot {} saved={saved}",
            pc.as_str()
        ));
    }

    /// Whether the selected PC can be opened again without the user.
    pub fn paired_host(&self) -> bool {
        self.client
            .bridge
            .model()
            .host()
            .is_some_and(|host| self.pairings.find(&host.address).is_some())
    }

    fn poll_wake_connect<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        let Some((mut pending, target)) = self.wake_connect.take() else {
            return;
        };
        let host = *pending.host();
        match pending.poll(&mut Net(connections), now_ms) {
            Progress::Pending => {}
            Progress::Waking(seconds) => {
                self.client.set_presence(&host.address, Presence::Waking);
                self.client
                    .set_status(Some(wake::waiting_text(seconds).as_str()));
            }
            Progress::Awake => {
                crate::render_platform::log(&alloc::format!(
                    "wake: {} answered",
                    host.address.as_str()
                ));
                self.client.set_presence(&host.address, Presence::Online);
                self.client.set_status(None);
            }
            Progress::Ready(socket) => {
                self.client.set_presence(&host.address, Presence::Online);
                self.attach(connections, socket, target, now_ms);
                return;
            }
            Progress::Failed(message) => {
                crate::render_platform::log(&alloc::format!(
                    "wake: {} gave up: {}",
                    host.address.as_str(),
                    message.as_str()
                ));
                self.client.set_presence(&host.address, Presence::Offline);
                self.client.runtime(RuntimeEvent::LinkFailed);
                self.text = Some(message);
                if let Auth::Token(authorization) = target.auth {
                    self.authorization = Some(authorization);
                }
                return;
            }
            Progress::Retired => {
                crate::render_platform::retire_process();
                self.exit = true;
                self.client.runtime(RuntimeEvent::LinkFailed);
                return;
            }
        }
        if crate::render_platform::process_retired() {
            self.exit = true;
            self.client.runtime(RuntimeEvent::LinkFailed);
            return;
        }
        self.wake_connect = Some((pending, target));
    }

    /// Asks the saved PCs whether they answer while the hosts page is up and nothing is open.
    fn watch_presence<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        let watching = self.access != Access::SingleList
            && self.control.is_none()
            && self.wake_connect.is_none()
            && self.client.bridge.model().screen() == Screen::Hosts;
        if !watching {
            if !self.presence.stop() {
                crate::render_platform::retire_process();
                self.exit = true;
            }
            return;
        }
        let seen = self.presence.poll(
            &mut Net(connections),
            self.client.bridge.model().hosts(),
            now_ms,
        );
        match seen {
            Seen::Nothing => {}
            Seen::Answer { address, online } => {
                let presence = if online {
                    Presence::Online
                } else {
                    Presence::Offline
                };
                if self.client.bridge.model().presence(&address) != presence {
                    crate::render_platform::log(&alloc::format!(
                        "presence: {} {}",
                        address.as_str(),
                        if online { "online" } else { "offline" }
                    ));
                }
                self.client.set_presence(&address, presence);
            }
            Seen::Retired => {
                crate::render_platform::retire_process();
                self.exit = true;
            }
        }
    }

    fn wanted_shape(&self) -> netprobe::Wanted {
        let model = self.client.bridge.model();
        let options = model
            .stream_settings()
            .stream_options(model.docked(), model.capabilities());
        netprobe::Wanted {
            width: options.width,
            height: options.height,
            fps: options.fps,
            codec: moonlight_nx2_app::service::options_of(&options).codec,
            size_auto: options.size_auto,
        }
    }

    /// Picks Auto's shape from the measured link for the settings in use.
    fn choose_link(&mut self, quality: netprobe::LinkQuality, announce: bool) {
        use moonlight_nx2_ui::settings::Size;
        let wanted = self.wanted_shape();
        let model = self.client.bridge.model();
        let capabilities = *model.capabilities();
        let codec = model
            .stream_settings()
            .in_use(model.docked(), &capabilities)
            .codec();
        let choice = netprobe::choose(quality, wanted, |_, height, fps| {
            capabilities.mode(codec, Size::from_height(height), fps)
        });
        let note = netprobe::note(&choice);
        crate::render_platform::log(&alloc::format!(
            "netprobe: {quality:?} wanted={}x{}@{} -> {}x{}@{} {} kbps {:?}",
            wanted.width,
            wanted.height,
            wanted.fps,
            choice.width,
            choice.height,
            choice.fps,
            choice.bitrate_kbps,
            choice.grade
        ));
        self.client.set_link(
            Some(LinkChoice {
                width: choice.width,
                height: choice.height,
                fps: choice.fps,
                bitrate_kbps: choice.bitrate_kbps,
                grade: match choice.grade {
                    netprobe::Grade::Good => moonlight_nx2_ui::link_choice::Grade::Good,
                    netprobe::Grade::Fair => moonlight_nx2_ui::link_choice::Grade::Fair,
                    netprobe::Grade::Weak => moonlight_nx2_ui::link_choice::Grade::Weak,
                },
                rtt_us: choice.quality.rtt_us,
                throughput_kbps: choice.quality.throughput_kbps,
            }),
            note.as_str(),
        );
        self.link_test.chosen_for = Some(wanted);
        if announce && self.client.bridge.model().screen() == Screen::Apps {
            self.text = Some(Message::of(note.as_str()));
        }
    }

    /// Measures the link once per PC connection, before the covers, and again when asked.
    fn test_link<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        let screen = self.client.bridge.model().screen();
        let quiet = self.authenticated
            && self.access != Access::SingleList
            && self.client.driver.service().idle()
            && self.covers.waiting_id().is_none()
            && self.idr.waiting_id().is_none();
        let Some(control) = self.control.as_mut() else {
            return;
        };
        if self.link_test.wanted
            && quiet
            && matches!(screen, Screen::Apps | Screen::Settings)
            && !self.link_test.prober.busy()
        {
            self.link_test.wanted = false;
            self.link_test.prober.start(connections.now_us());
        }
        if self.link_test.prober.busy() && !quiet {
            self.link_test.prober.cancel(connections.now_us());
            self.link_test.wanted = true;
        }
        if !self.link_test.prober.busy() {
            if let Some(quality) = self.link_test.measured
                && self.link_test.chosen_for != Some(self.wanted_shape())
            {
                self.choose_link(quality, true);
            }
            return;
        }
        let outcome = self.link_test.prober.run(
            control,
            |control| matches!(control.pump(now_ms), Ok(()) | Err(control::Error::Again)),
            || connections.now_us(),
            PROBE_SLICE_US,
        );
        match outcome {
            Some(netprobe::Outcome::Measured(quality)) => {
                crate::render_platform::log(&alloc::format!(
                    "netprobe: reply rates kbps {:?}",
                    self.link_test.prober.rates()
                ));
                self.link_test.measured = Some(quality);
                self.choose_link(quality, true);
            }
            Some(outcome) => {
                crate::render_platform::log(&alloc::format!("netprobe: {outcome:?}"));
                let note = if outcome == netprobe::Outcome::Unsupported {
                    PROBE_UNSUPPORTED
                } else {
                    PROBE_FAILED
                };
                self.client.set_link(None, note);
            }
            None => {}
        }
    }

    pub fn frame<C: Connections<Socket = S>>(
        &mut self,
        bytes: &mut [u8],
        connections: &mut C,
        now_ms: u64,
    ) -> Result<client::Frame, client::Error> {
        let message = self.message.take();
        let text = self.text.take();
        self.poll_wake_connect(connections, now_ms);
        self.poll_handshake(connections, now_ms);
        self.watch_presence(connections, now_ms);
        self.test_link(connections, now_ms);
        let mut disconnected = false;
        if let Some(control) = self.control.as_mut() {
            match control.pump(now_ms) {
                Ok(()) | Err(control::Error::Again) => {}
                Err(_) => disconnected = true,
            }
            if control.ready() && !self.authenticated {
                self.authenticated = true;
                self.stats.authenticated += 1;
                self.link_test.wanted = true;
                self.client.runtime(RuntimeEvent::LinkOpened);
            }
            if let Some((app, png)) = self.covers.poll(control, now_ms)
                && let Some(host) = self.cover_host
                && self
                    .client
                    .bridge
                    .model()
                    .host()
                    .is_some_and(|selected| selected.address == host.address)
            {
                let installed = self.client.install_cover(app, &png);
                crate::render_platform::log(&alloc::format!(
                    "cover: app={app} bytes={} {}",
                    png.len(),
                    if installed {
                        "installed"
                    } else {
                        "not decodable"
                    }
                ));
                if installed {
                    if let Some(cache) = self.cover_cache.as_ref() {
                        let _ = cache.write(&host, app, &png);
                    }
                } else {
                    self.covers.mark_attempted(app);
                }
            }
            if self.covers.failed() || self.covers.expired(now_ms) {
                disconnected = true;
            }
            match self.idr.poll(control) {
                Some(Ok(reply)) => crate::render_platform::log(&alloc::format!(
                    "video-recovery: host idr {reply:?}"
                )),
                Some(Err(_)) => disconnected = true,
                None => {}
            }
            let wanted = crate::stream_stats::take_idr_request();
            let idle = self.covers.waiting_id().is_none();
            if wanted && !(idle && self.idr.request(control, true, now_ms)) {
                crate::stream_stats::request_idr();
            }
            if self.idr.expired(now_ms) {
                disconnected = true;
            }
        }
        let mut effects = Vec::new();
        let frame = match self.control.as_mut() {
            Some(control) => {
                let mut guard = cover_fetch::Guard {
                    link: control,
                    waiting: self
                        .covers
                        .waiting_id()
                        .or(self.idr.waiting_id())
                        .or(self.link_test.prober.waiting_id()),
                };
                self.client
                    .frame(bytes, &mut guard, now_ms, &mut |effect| {
                        effects.push(effect)
                    })?
            }
            None => self
                .client
                .frame(bytes, &mut Offline, now_ms, &mut |effect| {
                    effects.push(effect)
                })?,
        };
        for effect in effects {
            match effect {
                Effect::Action(Action::OpenControl) => self.open(connections, now_ms),
                Effect::Action(Action::CloseControl) => {
                    crate::hid::stop_rumble();
                    if !self.close_control() {
                        self.exit = true;
                    }
                }
                Effect::Action(Action::OpenMedia(descriptor)) => {
                    self.stats.media_opened += 1;
                    self.media.push(MediaRequest::Open(Box::new(descriptor)));
                }
                Effect::Action(Action::CloseMedia) => {
                    crate::hid::stop_rumble();
                    self.media.push(MediaRequest::Close)
                }
                Effect::Action(Action::Rumble(rumble)) => {
                    let percent = self.client.bridge.model().settings().rumble_percent();
                    let scaled = |motor: u16| (u32::from(motor) * percent / 100) as u16;
                    crate::hid::rumble(rumble.player, scaled(rumble.low), scaled(rumble.high))
                }
                Effect::Action(Action::TouchNote) => self.client.touch_note(bytes, now_ms)?,
                Effect::Action(Action::DisplayNote(reason)) => {
                    self.client.stream_note(bytes, now_ms, reason.note())?
                }
                Effect::Action(Action::Exit) => self.exit = true,
                Effect::Action(Action::RetireProcess) => {
                    crate::render_platform::retire_process();
                    self.exit = true;
                }
                Effect::Action(Action::RefreshHosts) => {
                    self.presence.restart();
                    self.discover(connections, now_ms, true)
                }
                Effect::Action(Action::WakeHost(host)) => self.forced_wake = Some(host.address),
                Effect::Action(Action::ForgetHost(host)) => self.forget(&host.address),
                Effect::Action(Action::TestNetwork) => {
                    let ready = self.control.is_some() && self.authenticated;
                    self.link_test.wanted = ready;
                    let note = if ready { PROBE_RUNNING } else { PROBE_NEEDS_PC };
                    self.client.set_link(None, note);
                    self.link_test.chosen_for = None;
                    self.link_test.measured = None;
                }
                Effect::Action(Action::ExportLogs) => {
                    self.message = Some(if crate::files::export_log() {
                        "Log copied to switch/moonlight-nx2/logs on the SD card"
                    } else {
                        "The log could not be copied to the SD card"
                    });
                }
                Effect::Action(Action::PauseInput) => crate::hid::stop_rumble(),
                Effect::Action(Action::ResumeInput) => {}
                Effect::HostsError(message) => self.message = Some(message),
                Effect::Action(_) => {}
            }
        }
        if core::mem::take(&mut self.discover_at_start) {
            let first_run = self.client.bridge.model().hosts().is_empty();
            if first_run {
                self.message = Some("Searching for PCs; you can also add one by IP");
            }
            self.discover(connections, now_ms, first_run);
        }
        self.poll_discovery(now_ms);
        if disconnected {
            crate::hid::stop_rumble();
            if !self.close_control() {
                self.exit = true;
            }
            self.client.runtime(RuntimeEvent::LinkFailed);
            if !self.paired_host() {
                self.message =
                    Some("Check Wi-Fi and Sunshine; import a new PC connection to reconnect");
            }
        }
        if !disconnected
            && self.access != Access::SingleList
            && self.authenticated
            && self.client.bridge.model().screen() == Screen::Apps
            && self.client.driver.service().idle()
            && let Some(host) = self.client.bridge.model().host().copied()
        {
            if self
                .cover_host
                .is_none_or(|old| old.address != host.address || old.uniqueid != host.uniqueid)
                && self.covers.waiting_id().is_none()
            {
                self.covers.reset();
                self.client.clear_covers();
                self.cover_host = Some(host);
            }
            if self
                .cover_host
                .is_some_and(|old| old.address == host.address)
            {
                if !self.covers.busy() {
                    let model = self.client.bridge.model();
                    let start =
                        model.app_page() as usize * moonlight_nx2_ui::model::APPS_PER_PAGE as usize;
                    let next = model
                        .apps()
                        .iter()
                        .skip(start)
                        .take(moonlight_nx2_ui::model::APPS_PER_PAGE as usize)
                        .map(|app| app.id)
                        .find(|id| {
                            !self.client.has_cover(*id) && self.covers.eligible(*id, now_ms)
                        });
                    if let Some(app) = next {
                        let cached = self
                            .cover_cache
                            .as_ref()
                            .and_then(|cache| cache.read(&host, app));
                        if !cached
                            .as_ref()
                            .is_some_and(|png| self.client.install_cover(app, png))
                        {
                            self.covers.begin(app);
                        }
                    }
                }
                if let Some(control) = self.control.as_mut()
                    && self.idr.waiting_id().is_none()
                    && !self.link_test.prober.busy()
                    && !self.link_test.wanted
                {
                    self.covers.request(control, host.address.as_str(), now_ms);
                }
            }
        }
        if let Some(message) = message {
            self.client.set_status(Some(message));
        }
        if let Some(text) = text {
            self.client.set_status(Some(text.as_str()));
        }
        while let Some(feedback) = self.client.next_policy_output() {
            self.client.paint_policy(bytes, feedback)?;
        }
        self.stats.frames += 1;
        Ok(frame)
    }

    pub fn close(&mut self, renderer: &mut Renderer) -> bool {
        if !self.close_control() || crate::render_platform::process_retired() {
            return false;
        }
        renderer
            .storage_mut()
            .ok()
            .is_some_and(|bytes| self.client.close(bytes).is_ok())
    }
}
