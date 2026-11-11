//! Coordinates UI, control connections, host discovery and media requests.

extern crate alloc;

#[path = "cover_fetch.rs"]
mod cover_fetch;

use crate::{
    client::{self, Client},
    render::Renderer,
    upstream::{Dialer, Upstream},
};
use alloc::{boxed::Box, vec::Vec};
use moonlight_nx2_app::{
    direct::DirectLink,
    direct_keys::Keys as DirectKeys,
    driver::Effect,
    link::{Link, LinkError},
    pairings::Loaded,
    policy::{Context, DisplayCapabilities},
    presence_watch::{Seen, Watch},
    service::{Action, RuntimeEvent},
    wake,
    wake_connect::{Network, Progress, WakeConnect},
};
use moonlight_nx2_core::control::Frame as ControlFrame;
use moonlight_nx2_io::{
    socket::{IoError, Socket},
    udp::Datagram,
};
use moonlight_nx2_ui::{
    discover::{self, Answers},
    model::{Address, Message, Screen},
    presence::{Presence, SUNSHINE_PORT},
    store::Files,
};

pub trait Connections {
    type Socket: Socket + 'static;
    fn connect(&mut self, address: [u8; 4], port: u16) -> Result<Self::Socket, IoError>;
    /// Sends Wake-on-LAN towards `address` and the broadcast addresses, and logs the outcome.
    fn wake(&mut self, _mac: [u8; 6], _address: Option<[u8; 4]>) {}
    /// An unconnected UDP socket for one mDNS query; none where the platform has no network.
    fn discovery(&mut self) -> Result<Box<dyn Datagram>, IoError> {
        Err(IoError::Failed)
    }
    /// Opens connections straight to Sunshine; none where the console cannot pair with it.
    fn dialer(&mut self) -> Option<Dialer<Self::Socket>> {
        None
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

/// Datagrams read per frame, so a flood cannot stall the UI.
const DISCOVERY_READS: usize = 16;

const NO_NETWORK_TEST: &str = "Sunshine has no network test; Auto uses its defaults";
const UNREACHABLE: &str = "The console could not reach the PC; check Wi-Fi";
const LINK_LOST: &str = "Check Wi-Fi and Sunshine to reconnect";

const FORGOTTEN_DIRECT: &str =
    "Forgotten here. Remove this console under Clients in Sunshine's web UI (port 47990) too";

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub frames: u64,
    pub opened: u64,
    pub authenticated: u64,
    pub closed: u64,
    pub media_opened: u64,
}

fn octets(address: &Address) -> Option<[u8; 4]> {
    let mut parts = address.as_str().split('.');
    let mut bytes = [0; 4];
    for byte in &mut bytes {
        *byte = parts.next()?.parse().ok()?;
    }
    parts.next().is_none().then_some(bytes)
}

pub enum MediaRequest {
    Open,
    Close,
}

pub struct Frontend<F, S: Socket + 'static> {
    pub client: Client<F>,
    control: Option<Upstream<S>>,
    wake_connect: Option<WakeConnect<S>>,
    keys: DirectKeys,
    files: F,
    forced_wake: Option<Address>,
    presence: Watch<S>,
    text: Option<Message>,
    peer: Option<[u8; 4]>,
    media: Vec<MediaRequest>,
    authenticated: bool,
    exit: bool,
    message: Option<&'static str>,
    stats: Stats,
    discovery: Option<Discovery>,
    covers: cover_fetch::Fetcher,
    typing: moonlight_nx2_app::typing::Typing,
    keyboard: crate::hid::software_keyboard::Platform,
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
        docked: bool,
    ) -> Result<Self, client::Error> {
        let mut key_files = files.clone();
        let (keys, loaded) = DirectKeys::load(&mut key_files);
        if loaded == Loaded::Damaged {
            crate::render_platform::log("direct: the Sunshine key book is unreadable; ignored");
        }
        let mut client = Client::new(bytes, atlas, files, 1)?;
        client.context_changed(Context {
            docked,
            decoder: Default::default(),
            display: DisplayCapabilities::default(),
        });
        Ok(Self {
            client,
            control: None,
            wake_connect: None,
            keys,
            files: key_files,
            forced_wake: None,
            presence: Watch::default(),
            text: None,
            peer: None,
            media: Vec::new(),
            authenticated: false,
            exit: false,
            message: None,
            stats: Stats::default(),
            discovery: None,
            covers: cover_fetch::Fetcher::default(),
            typing: moonlight_nx2_app::typing::Typing::default(),
            keyboard: crate::hid::software_keyboard::Platform,
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
                Some("Select a PC to pair with it")
            };
        }
    }

    pub fn stats(&self) -> Stats {
        self.stats
    }

    pub fn exiting(&self) -> bool {
        self.exit
    }
    pub fn screen(&self) -> Screen {
        self.client.bridge.model().screen()
    }

    /// The link to Sunshine is open.
    pub fn link_up(&self) -> bool {
        self.control.is_some() && self.authenticated
    }

    /// The live Sunshine session media opens from when the link is direct.
    pub fn direct_media(
        &mut self,
    ) -> Option<(
        moonlight_nx2_app::sunshine::stream::Negotiated,
        moonlight_nx2_app::direct_stream::Outbox,
    )> {
        let live = self.control.as_mut()?.live()?;
        Some((live.negotiated.clone(), live.outbox()))
    }

    /// The direct input counters since the last call, while a stream is live.
    pub fn take_input_counters(
        &mut self,
    ) -> Option<(moonlight_nx2_app::direct_input::Counters, usize)> {
        Some(self.control.as_mut()?.live()?.take_input_counters())
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

    /// The system keyboard is up or has just closed; its focus changes are not the user leaving.
    pub fn keyboard_covers(&self, now_ms: u64) -> bool {
        self.typing.covers(now_ms)
    }

    fn step_keyboard(&mut self, now_ms: u64) {
        use moonlight_nx2_app::typing::Event;
        match self.typing.step(&mut self.keyboard, now_ms) {
            Some(Event::Confirmed) => {
                crate::render_platform::log("keyboard: text confirmed");
            }
            Some(Event::Cancelled(result)) => crate::render_platform::log(&alloc::format!(
                "keyboard: closed without text result=0x{result:x}"
            )),
            Some(Event::OpenFailed) | Some(Event::Opened) | None => {}
        }
    }

    fn send_text(&mut self) {
        if !self.typing.has_pending() {
            return;
        }
        let text = self.typing.take_pending();
        let sent = match (text, self.control.as_mut().and_then(Upstream::live)) {
            (Some(text), Some(live)) => live.text(&text),
            _ => false,
        };
        crate::render_platform::log(&alloc::format!("keyboard: direct text sent={sent}"));
    }

    pub fn close_control(&mut self) -> bool {
        self.covers.reset();
        self.typing.reset();
        self.cover_host = None;
        self.client.clear_covers();
        if let Some(mut pending) = self.wake_connect.take() {
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
        control.close();
        self.authenticated = false;
        self.stats.closed += 1;
        self.keys = DirectKeys::load(&mut self.files).0;
        true
    }

    fn open<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        if self.control.is_some() || self.wake_connect.is_some() {
            self.client.runtime(RuntimeEvent::LinkFailed);
            return;
        }
        let host = self.client.bridge.model().host().copied();
        let Some((host, address)) =
            host.and_then(|host| octets(&host.address).map(|address| (host, address)))
        else {
            return self.link_failed(UNREACHABLE);
        };
        let force = self.forced_wake.take() == Some(host.address);
        let Some(mac) = host.mac else {
            return self.open_direct(connections);
        };
        let pending = WakeConnect::start(
            &mut Net(connections),
            (address, SUNSHINE_PORT),
            host,
            mac.0,
            force,
            now_ms,
        );
        if crate::render_platform::process_retired() {
            self.exit = true;
            self.client.runtime(RuntimeEvent::LinkFailed);
            return;
        }
        self.client
            .driver
            .service_mut()
            .set_link_timeout(now_ms, wake::LIMIT_MS + 30_000);
        self.wake_connect = Some(pending);
    }

    fn link_failed(&mut self, message: &'static str) {
        self.client.runtime(RuntimeEvent::LinkFailed);
        self.message = Some(message);
    }

    /// Talks to Sunshine itself for the selected PC; pairing starts there when this console
    /// holds no certificate for it yet.
    fn open_direct<C: Connections<Socket = S>>(&mut self, connections: &mut C) {
        let pc = self.client.bridge.model().host().map(|host| host.address);
        let address = pc.as_ref().and_then(octets);
        let link = connections
            .dialer()
            .zip(pc)
            .and_then(|(dialer, pc)| DirectLink::new(dialer, &pc, &mut self.files));
        let (Some(pc), Some(address), Some(link)) = (pc, address, link) else {
            return self.link_failed(UNREACHABLE);
        };
        crate::render_platform::log(&alloc::format!(
            "direct: talking to Sunshine at {} paired={}",
            pc.as_str(),
            link.paired()
        ));
        self.message = None;
        self.control = Some(Upstream::new(link));
        self.peer = Some(address);
        self.stats.opened += 1;
    }

    /// Removes the stored keys of a PC the user removed. Sunshine keeps its side of a direct
    /// pairing until the user removes the client in its web UI, which needs that UI's password.
    fn forget(&mut self, host: &moonlight_nx2_ui::model::Host) {
        if let Some(cache) = self.cover_cache.as_ref() {
            let covers = cache.forget(host);
            crate::render_platform::log(&alloc::format!(
                "covers: dropped {covers} of {}",
                host.address.as_str()
            ));
        }
        if self
            .cover_host
            .is_some_and(|shown| shown.address == host.address)
        {
            self.cover_host = None;
        }
        let pc = &host.address;
        let open =
            self.control.is_some() && octets(pc).is_some_and(|address| self.peer == Some(address));
        let mut keys = DirectKeys::load(&mut self.files).0;
        let pinned = keys.forget(pc);
        if pinned {
            let saved = keys.save(&mut self.files);
            crate::render_platform::log(&alloc::format!(
                "direct: forgot {} saved={saved}",
                pc.as_str()
            ));
        }
        self.keys = keys;
        if pinned || open {
            self.message = Some(FORGOTTEN_DIRECT);
        }
    }

    /// Whether the selected PC can be opened again without the user.
    pub fn paired_host(&self) -> bool {
        let Some(host) = self.client.bridge.model().host() else {
            return false;
        };
        match &self.control {
            Some(control) if octets(&host.address) == self.peer => control.paired(),
            _ => self.keys.server(&host.address).is_some(),
        }
    }

    fn poll_wake_connect<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        let Some(mut pending) = self.wake_connect.take() else {
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
            Progress::Ready(mut socket) => {
                self.client.set_presence(&host.address, Presence::Online);
                if socket.close().is_err() {
                    crate::render_platform::retire_process();
                    self.exit = true;
                    self.client.runtime(RuntimeEvent::LinkFailed);
                    return;
                }
                self.open_direct(connections);
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
        self.wake_connect = Some(pending);
    }

    /// Asks the saved PCs whether they answer while the hosts page is up and nothing is open.
    fn watch_presence<C: Connections<Socket = S>>(&mut self, connections: &mut C, now_ms: u64) {
        let watching = self.control.is_none()
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

    /// A new display or decoder context, as on a dock change. The network test's choice is
    /// made again for the shape the new context asks for before the stream is, so a stream
    /// that starts again takes the new shape with a bitrate chosen for it.
    pub fn context_changed(&mut self, context: Context) -> bool {
        let before = self.client.requested_options();
        let accepted = self.client.context_changed(context);
        let after = self.client.driver.service().relaunch_options();
        if let (Some(before), Some(after)) = (before, after) {
            crate::render_platform::log(&alloc::format!(
                "stream: dock change relaunch from {}x{}@{} {} kbps to {}x{}@{} {} kbps",
                before.width,
                before.height,
                before.fps,
                before.bitrate_kbps,
                after.width,
                after.height,
                after.fps,
                after.bitrate_kbps
            ));
        }
        accepted
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
        self.watch_presence(connections, now_ms);
        self.step_keyboard(now_ms);
        self.send_text();
        let mut disconnected = false;
        if let Some(control) = self.control.as_mut() {
            control.pump(&mut self.files, now_ms);
            disconnected |= control.failed();
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
            if crate::stream_stats::take_idr_request()
                && let Some(live) = control.live()
            {
                let queued = live.request_idr(now_ms).is_ok();
                crate::render_platform::log(&alloc::format!(
                    "video-recovery: direct idr queued={queued}"
                ));
            }
        }
        let mut effects = Vec::new();
        let frame = match self.control.as_mut() {
            Some(control) => {
                let mut guard = cover_fetch::Guard {
                    link: control,
                    waiting: self.covers.waiting_id(),
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
                Effect::Action(Action::OpenMedia(mut descriptor)) => {
                    descriptor.wipe();
                    self.stats.media_opened += 1;
                    self.media.push(MediaRequest::Open);
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
                Effect::Action(Action::ForgetHost(host)) => self.forget(&host),
                Effect::Action(Action::TestNetwork) => self.client.set_link(None, NO_NETWORK_TEST),
                Effect::Action(Action::ExportLogs) => {
                    self.message = Some(if crate::files::export_log() {
                        "Log copied to switch/moonlight-nx2/logs on the SD card"
                    } else {
                        "The log could not be copied to the SD card"
                    });
                }
                Effect::Action(Action::ShowKeyboard) => {
                    use moonlight_nx2_app::typing::Event;
                    if self.typing.show(&mut self.keyboard) == Event::OpenFailed {
                        self.message = Some("The keyboard could not open");
                    }
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
                self.message = Some(LINK_LOST);
            }
        }
        if !disconnected
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
                if let Some(control) = self.control.as_mut() {
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
