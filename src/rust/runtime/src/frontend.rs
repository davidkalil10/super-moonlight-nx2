extern crate alloc;

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
    Open(Descriptor),
    Close,
}

pub struct Frontend<F, S: Socket + 'static> {
    pub client: Client<F>,
    control: Option<Control<S>>,
    peer: Option<[u8; 4]>,
    media: Vec<MediaRequest>,
    authorization: Option<Session>,
    authenticated: bool,
    access: Access,
    exit: bool,
    message: Option<&'static str>,
    stats: Stats,
    discovery: Option<Discovery>,
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
            peer: None,
            media: Vec::new(),
            authorization,
            authenticated: false,
            access,
            exit: false,
            message,
            stats: Stats::default(),
            discovery: None,
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
                self.message = Some("PC discovery is unavailable; add the PC by address")
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
        } else if found.is_empty() && discovery.asked {
            self.message = Some("No PC answered; add the PC by address");
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

    pub fn close_control(&mut self) -> bool {
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
        if self.control.is_some() {
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
        let socket = match connections.connect(authorization.address, authorization.port) {
            Ok(socket) => socket,
            Err(_) => {
                self.client.runtime(RuntimeEvent::LinkFailed);
                self.message = Some("PC connection failed; import a new connection to retry");
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
                self.message = Some("PC connection failed; import a new connection to retry");
                if error.retained {
                    self.exit = true;
                }
            }
        }
    }

    pub fn frame<C: Connections<Socket = S>>(
        &mut self,
        bytes: &mut [u8],
        connections: &mut C,
        now_ms: u64,
    ) -> Result<client::Frame, client::Error> {
        let message = self.message.take();
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
        }
        let mut effects = Vec::new();
        let frame = match self.control.as_mut() {
            Some(control) => self
                .client
                .frame(bytes, control, now_ms, &mut |effect| effects.push(effect))?,
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
                    self.media.push(MediaRequest::Open(descriptor));
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
            self.discover(connections, now_ms, false);
        }
        self.poll_discovery(now_ms);
        if disconnected {
            crate::hid::stop_rumble();
            if !self.close_control() {
                self.exit = true;
            }
            self.client.runtime(RuntimeEvent::LinkFailed);
            self.message = Some("PC disconnected; import a new connection to reconnect");
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
