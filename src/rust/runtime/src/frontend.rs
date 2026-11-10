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
    policy::{Context, DisplayCapabilities},
    reply::Descriptor,
    service::{Action, RuntimeEvent},
};
use moonlight_nx2_core::control::Frame as ControlFrame;
use moonlight_nx2_io::{
    control,
    socket::{IoError, Socket},
    udp::Datagram,
};
use moonlight_nx2_ui::{
    discover::{self, Answers},
    json::{Json, Kind},
    model::Screen,
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
    fn wake(&mut self, _mac: [u8; 6]) -> Result<(), IoError> {
        Err(IoError::Failed)
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

struct WakeConnect<S> {
    authorization: Session,
    socket: Option<S>,
    deadline_ms: u64,
    attempt_deadline_ms: u64,
    next_attempt_ms: u64,
}

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

pub enum MediaRequest {
    Open(Box<Descriptor>),
    Close,
}

pub struct Frontend<F, S: Socket + 'static> {
    pub client: Client<F>,
    control: Option<Control<S>>,
    wake_connect: Option<WakeConnect<S>>,
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
        let mut client = Client::new(bytes, atlas, files, 1)?;
        client.context_changed(Context {
            docked,
            decoder: Default::default(),
            display: DisplayCapabilities::default(),
        });
        let message = import_error.or_else(|| {
            (authorization.is_none() && client.bridge.model().message().is_none())
                .then_some("Import a PC connection before connecting")
        });
        Ok(Self {
            client,
            control: None,
            wake_connect: None,
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
        if let Some(mut pending) = self.wake_connect.take()
            && let Some(mut socket) = pending.socket.take()
            && socket.close().is_err()
        {
            crate::render_platform::retire_process();
            return false;
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

    fn open<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        if self.control.is_some() || self.wake_connect.is_some() {
            self.client.runtime(RuntimeEvent::LinkFailed);
            return;
        }
        let authorization = self
            .authorization
            .take()
            .map_or_else(|| connections.authorization(), Ok);
        let Ok(mut authorization) = authorization else {
            self.client.runtime(RuntimeEvent::LinkFailed);
            self.message = Some(match authorization.err().unwrap() {
                AuthError::Missing => "Import a new PC connection before connecting",
                AuthError::Invalid => "The PC connection file is invalid",
                AuthError::Uncertain => {
                    "The PC connection file could not be consumed; restart before trying again"
                }
            });
            return;
        };
        if let Some(mac) = self.client.bridge.model().host().and_then(|host| host.mac) {
            let _ = connections.wake(mac.0);
            if crate::render_platform::process_retired() {
                self.exit = true;
                self.client.runtime(RuntimeEvent::LinkFailed);
                return;
            }
            self.client
                .driver
                .service_mut()
                .set_link_timeout(now_ms, 25_000);
            self.wake_connect = Some(WakeConnect {
                authorization,
                socket: None,
                deadline_ms: now_ms.saturating_add(20_000),
                attempt_deadline_ms: now_ms,
                next_attempt_ms: now_ms,
            });
            return;
        }
        let socket = match connections.connect(authorization.address, authorization.port) {
            Ok(socket) => socket,
            Err(_) => {
                self.client.runtime(RuntimeEvent::LinkFailed);
                self.message =
                    Some("Check Wi-Fi and Sunshine; import a new PC connection to retry");
                return;
            }
        };
        let token = core::mem::replace(&mut authorization.token, [0; 64]);
        match Control::open(socket, token, self.access, now_ms) {
            Ok(control) => {
                self.control = Some(control);
                self.peer = Some(authorization.address);
                self.stats.opened += 1;
            }
            Err(error) => {
                self.client.runtime(RuntimeEvent::LinkFailed);
                self.message =
                    Some("Check Wi-Fi and Sunshine; import a new PC connection to retry");
                if error.retained {
                    self.exit = true;
                }
            }
        }
    }

    fn poll_wake_connect<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        let Some(mut pending) = self.wake_connect.take() else {
            return;
        };
        if now_ms >= pending.deadline_ms {
            if let Some(mut socket) = pending.socket.take()
                && socket.close().is_err()
            {
                crate::render_platform::retire_process();
                self.exit = true;
            }
            self.client.runtime(RuntimeEvent::LinkFailed);
            self.message = Some("PC connection timed out after wake");
            return;
        }
        if pending.socket.is_none() && now_ms >= pending.next_attempt_ms {
            pending.socket = connections
                .connect(pending.authorization.address, pending.authorization.port)
                .ok();
            if crate::render_platform::process_retired() {
                self.exit = true;
                self.client.runtime(RuntimeEvent::LinkFailed);
                return;
            }
            pending.attempt_deadline_ms = now_ms.saturating_add(2_000);
            pending.next_attempt_ms = now_ms.saturating_add(500);
        }
        if let Some(socket) = pending.socket.as_mut() {
            match socket.poll_connect() {
                Ok(true) => {
                    let socket = pending.socket.take().unwrap();
                    let token = core::mem::replace(&mut pending.authorization.token, [0; 64]);
                    match Control::open(socket, token, self.access, now_ms) {
                        Ok(control) => {
                            self.control = Some(control);
                            self.peer = Some(pending.authorization.address);
                            self.stats.opened += 1;
                        }
                        Err(error) => {
                            self.client.runtime(RuntimeEvent::LinkFailed);
                            self.message = Some(
                                "Check Wi-Fi and Sunshine; import a new PC connection to retry",
                            );
                            if error.retained {
                                self.exit = true;
                            }
                        }
                    }
                    return;
                }
                Ok(false) | Err(IoError::WouldBlock | IoError::Interrupted)
                    if now_ms < pending.attempt_deadline_ms => {}
                _ => {
                    let mut socket = pending.socket.take().unwrap();
                    if socket.close().is_err() {
                        crate::render_platform::retire_process();
                        self.exit = true;
                        self.client.runtime(RuntimeEvent::LinkFailed);
                        return;
                    }
                }
            }
        }
        self.wake_connect = Some(pending);
    }

    pub fn frame<C: Connections<Socket = S>>(
        &mut self,
        bytes: &mut [u8],
        connections: &mut C,
        now_ms: u64,
    ) -> Result<client::Frame, client::Error> {
        let message = self.message.take();
        self.poll_wake_connect(connections, now_ms);
        let mut disconnected = false;
        if let Some(control) = self.control.as_mut() {
            match control.pump(now_ms) {
                Ok(()) | Err(control::Error::Again) => {}
                Err(_) => disconnected = true,
            }
            if control.ready() && !self.authenticated {
                self.authenticated = true;
                self.stats.authenticated += 1;
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
                    waiting: self.covers.waiting_id().or(self.idr.waiting_id()),
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
                    crate::hid::rumble(rumble.player, rumble.low, rumble.high)
                }
                Effect::Action(Action::Exit) => self.exit = true,
                Effect::Action(Action::RetireProcess) => {
                    crate::render_platform::retire_process();
                    self.exit = true;
                }
                Effect::Action(Action::RefreshHosts) => self.discover(connections, now_ms, true),
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
            self.message =
                Some("Check Wi-Fi and Sunshine; import a new PC connection to reconnect");
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
                {
                    self.covers.request(control, host.address.as_str(), now_ms);
                }
            }
        }
        if let Some(message) = message {
            self.client.set_status(Some(message));
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
