//! Console UI state machine of src/native/ui/model.c: events in, model and intents out.
//! Host work (list, pair, launch, quit) stays with the caller as intents.

use core::fmt::Write;

use crate::settings::{Capabilities, Setting, Settings};
use crate::text::Text;

pub const MAX_HOSTS: usize = 64;
pub const MAX_APPS: usize = 256;
pub const ENTRY_MAX: usize = 15;
pub const APPS_PER_PAGE: u32 = 10;
pub const HOSTS_PER_PAGE: u32 = 6;

pub type Name = Text<127>;
pub type Address = Text<63>;
pub type Message = Text<255>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mac(pub [u8; 6]);

impl Mac {
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        if bytes.len() != 17 {
            return None;
        }
        let hex = |c: u8| match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        };
        let mut out = [0; 6];
        for (i, item) in out.iter_mut().enumerate() {
            let at = i * 3;
            if i != 0 && bytes[at - 1] != b':' {
                return None;
            }
            *item = hex(bytes[at])? * 16 + hex(bytes[at + 1])?;
        }
        (out != [0; 6] && out[0] & 1 == 0).then_some(Self(out))
    }

    pub fn text(&self) -> Text<17> {
        let mut out = Text::new();
        let [a, b, c, d, e, f] = self.0;
        let _ = write!(out, "{a:02x}:{b:02x}:{c:02x}:{d:02x}:{e:02x}:{f:02x}");
        out
    }

    pub fn magic_packet(self) -> [u8; 102] {
        let mut packet = [0xff; 102];
        for chunk in packet[6..].chunks_exact_mut(6) {
            chunk.copy_from_slice(&self.0);
        }
        packet
    }
}

/// Item ids the composer gives to selectable things on a page.
pub mod item {
    pub const BACK: u32 = 1;
    pub const RETRY: u32 = 2;
    pub const PREVIOUS: u32 = 3;
    pub const NEXT: u32 = 4;
    pub const RETURN_TO_APPS: u32 = 5;
    pub const QUIT_HOST: u32 = 6;
    pub const CONFIRM_QUIT: u32 = 7;
    pub const CANCEL: u32 = 8;
    pub const ADD_HOST: u32 = 9;
    pub const FIND_HOSTS: u32 = 10;
    pub const UNPAIR: u32 = 11;
    pub const REMOVE_HOST: u32 = 12;
    pub const ERASE: u32 = 13;
    pub const CONNECT: u32 = 14;
    pub const HOST: u32 = 10000;
    pub const APP: u32 = 20000;
    pub const SETTING: u32 = 30000;
    pub const KEY: u32 = 40000;
}

/// Characters of the address keypad, by `item::KEY` offset.
pub const KEYS: &[u8] = b"123456789.0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Splash,
    Hosts,
    AddHost,
    HostMenu,
    Connecting,
    Pairing,
    Apps,
    QuitConfirm,
    Settings,
    Launching,
    Streaming,
    Error,
    ConnectionLost,
    Unpairing,
    Quitting,
    Stopped,
}

impl Screen {
    pub fn name(self) -> &'static str {
        [
            "splash",
            "hosts",
            "addHost",
            "hostMenu",
            "connecting",
            "pairing",
            "apps",
            "quitConfirm",
            "settings",
            "launching",
            "streaming",
            "error",
            "connectionLost",
            "unpairing",
            "quitting",
            "stopped",
        ][self as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    A,
    B,
    X,
    Y,
    Adjust,
    Chord,
    Edit,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Host {
    pub name: Name,
    pub address: Address,
    pub uniqueid: Address,
    pub mac: Option<Mac>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct App {
    pub id: u32,
    pub name: Name,
}

#[derive(Clone, Copy, Debug)]
pub enum Event<'a> {
    Command {
        op: Op,
        item: u32,
        value: i32,
    },
    Attached,
    NotPaired,
    Paired,
    StreamStarted,
    StreamEnded,
    QuitDone,
    AppGone,
    Unpaired,
    ConnectionLost {
        host: Option<&'a Host>,
    },
    Hosts {
        hosts: &'a [Host],
    },
    Listed {
        apps: &'a [App],
        current_game: u32,
        message: Option<&'a str>,
    },
    Pin {
        pin: Option<&'a str>,
        url: Option<&'a str>,
    },
    Stage {
        message: Option<&'a str>,
    },
    OperationMode {
        docked: bool,
    },
    /// `back_apps` set overrides whether the error returns to the host's apps.
    Failed {
        message: Option<&'a str>,
        back_apps: Option<bool>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntentKind {
    List,
    RefreshHosts,
    RemoveHost,
    UnpairHost,
    Launch,
    QuitHost,
    SaveSettings,
    PauseInput,
    ResumeInput,
    CancelList,
    CancelPair,
    StopStream,
    Covers,
    Pair,
    Exit,
}

impl IntentKind {
    pub fn name(self) -> &'static str {
        [
            "list",
            "refreshHosts",
            "removeHost",
            "unpairHost",
            "launch",
            "quitHost",
            "saveSettings",
            "pauseInput",
            "resumeInput",
            "cancelList",
            "cancelPair",
            "stopStream",
            "covers",
            "pair",
            "exit",
        ][self as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Intent {
    pub kind: IntentKind,
    pub host: Option<Host>,
    /// Set for `Launch` only.
    pub app: Option<App>,
}

/// What one event did: whether the page needs rebuilding and the host work to start.
#[derive(Clone, Copy, Debug, Default)]
pub struct Step {
    pub changed: bool,
    intents: [Option<Intent>; 2],
}

impl Step {
    pub fn intents(&self) -> impl Iterator<Item = &Intent> {
        self.intents.iter().flatten()
    }

    fn add(&mut self, kind: IntentKind, host: Option<Host>) {
        self.add_intent(Intent {
            kind,
            host,
            app: None,
        });
    }

    fn add_intent(&mut self, intent: Intent) {
        if let Some(slot) = self.intents.iter_mut().find(|slot| slot.is_none()) {
            *slot = Some(intent);
        }
    }
}

/// The UI model. About 60 KiB; the owner keeps one rather than placing it on a small stack.
#[derive(Clone)]
pub struct Model {
    screen: Screen,
    hosts: [Host; MAX_HOSTS],
    host_count: usize,
    host: Option<Host>,
    apps: [App; MAX_APPS],
    app_count: usize,
    current_game: u32,
    app: Option<App>,
    app_page: u32,
    app_index: u32,
    host_page: u32,
    host_index: u32,
    pin: Option<Message>,
    url: Option<Message>,
    entry: Text<ENTRY_MAX>,
    message: Option<Message>,
    back_apps: bool,
    from: Screen,
    overlay: bool,
    settings: Settings,
    docked: bool,
    editing: Option<Setting>,
    capabilities: Capabilities,
}

fn last_page(length: usize, size: u32) -> u32 {
    (length as u32).div_ceil(size).saturating_sub(1)
}

fn octet_ok(octet: &[u8]) -> bool {
    if octet.is_empty() || octet.len() > 3 {
        return false;
    }
    if octet[0] == b'0' && octet.len() > 1 {
        return false;
    }
    if !octet.iter().all(u8::is_ascii_digit) {
        return false;
    }

    octet
        .iter()
        .fold(0u32, |value, digit| value * 10 + (digit - b'0') as u32)
        <= 255
}

/// A dotted IPv4 unicast address, without leading zeros.
pub fn is_address(entry: &str) -> bool {
    let mut octets = 0;
    let mut first = 0;
    for octet in entry.as_bytes().split(|&c| c == b'.') {
        if !octet_ok(octet) {
            return false;
        }
        if octets == 0 {
            first = octet
                .iter()
                .fold(0u32, |value, digit| value * 10 + (digit - b'0') as u32);
        }
        octets += 1;
    }
    octets == 4 && first != 0 && first < 224
}

fn message(text: Option<&str>) -> Option<Message> {
    text.map(Message::of)
}

fn formatted(args: core::fmt::Arguments<'_>) -> Option<Message> {
    let mut out = Message::new();
    let _ = out.write_fmt(args);
    Some(out)
}

impl Model {
    /// Starts on the splash screen with the saved hosts.
    pub fn new(hosts: &[Host], settings: Settings, capabilities: Capabilities) -> Self {
        let mut model = Self {
            screen: Screen::Splash,
            hosts: [Host::default(); MAX_HOSTS],
            host_count: 0,
            host: None,
            apps: [App::default(); MAX_APPS],
            app_count: 0,
            current_game: 0,
            app: None,
            app_page: 0,
            app_index: 0,
            host_page: 0,
            host_index: 0,
            pin: None,
            url: None,
            entry: Text::new(),
            message: None,
            back_apps: false,
            from: Screen::Hosts,
            overlay: false,
            settings,
            docked: false,
            editing: None,
            capabilities,
        };
        model.set_hosts(hosts);
        model
    }

    pub fn screen(&self) -> Screen {
        self.screen
    }

    pub fn hosts(&self) -> &[Host] {
        &self.hosts[..self.host_count]
    }

    /// The host being browsed, paired or streamed from.
    pub fn host(&self) -> Option<&Host> {
        self.host.as_ref()
    }

    pub fn apps(&self) -> &[App] {
        &self.apps[..self.app_count]
    }

    /// Id of the app the host reports running, 0 for none.
    pub fn current_game(&self) -> u32 {
        self.current_game
    }

    pub fn app(&self) -> Option<&App> {
        self.app.as_ref()
    }

    pub fn app_page(&self) -> u32 {
        self.app_page
    }

    pub fn app_index(&self) -> u32 {
        self.app_index
    }

    pub fn host_page(&self) -> u32 {
        self.host_page
    }

    pub fn host_index(&self) -> u32 {
        self.host_index
    }

    pub fn pin(&self) -> Option<&str> {
        self.pin.as_ref().map(Message::as_str)
    }

    pub fn url(&self) -> Option<&str> {
        self.url.as_ref().map(Message::as_str)
    }

    /// The address typed so far on the add-host keypad.
    pub fn entry(&self) -> &str {
        self.entry.as_str()
    }

    pub fn message(&self) -> Option<&str> {
        self.message.as_ref().map(Message::as_str)
    }

    pub fn set_status(&mut self, text: Option<&str>) -> bool {
        let next = message(text);
        if self.message == next {
            return false;
        }
        self.message = next;
        true
    }

    pub fn back_apps(&self) -> bool {
        self.back_apps
    }

    /// The screen settings return to.
    pub fn from(&self) -> Screen {
        self.from
    }

    /// The in-stream menu is open.
    pub fn overlay(&self) -> bool {
        self.overlay
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn docked(&self) -> bool {
        self.docked
    }

    /// The settings row whose value left/right currently changes.
    pub fn editing(&self) -> Option<Setting> {
        self.editing
    }

    pub fn capabilities(&self) -> &Capabilities {
        &self.capabilities
    }

    pub fn set_capabilities(&mut self, capabilities: Capabilities) -> bool {
        if self.capabilities == capabilities {
            return false;
        }
        self.capabilities = capabilities;
        true
    }

    /// Controller input goes to the host only while the stream is shown bare.
    pub fn allow_input(&self) -> bool {
        self.screen == Screen::Streaming && !self.overlay
    }

    /// The page needs input handling unless a stream is shown bare with its page applied.
    pub fn interactive(&self, page_applied: bool) -> bool {
        !self.allow_input() || !page_applied
    }

    pub fn reduce(&mut self, event: &Event<'_>) -> Step {
        let mut step = Step::default();
        match *event {
            Event::Command { op, item, value } => self.on_command(op, item, value, &mut step),
            _ => self.on_service(event, &mut step),
        }
        step
    }

    fn set_hosts(&mut self, hosts: &[Host]) {
        let count = hosts.len().min(MAX_HOSTS);
        self.hosts[..count].copy_from_slice(&hosts[..count]);
        self.host_count = count;
    }

    fn set_apps(&mut self, apps: &[App]) {
        let count = apps.len().min(MAX_APPS);
        self.apps[..count].copy_from_slice(&apps[..count]);
        self.app_count = count;
    }

    fn host_item(&self, item: u32) -> Option<usize> {
        let index = item.checked_sub(item::HOST)? as usize;
        (index < self.host_count).then_some(index)
    }

    fn app_item(&self, item: u32) -> Option<usize> {
        let index = item.checked_sub(item::APP)? as usize;
        (index < self.app_count).then_some(index)
    }

    fn find_host(&self, address: &Address) -> Option<usize> {
        self.hosts()
            .iter()
            .position(|host| host.address == *address)
    }

    fn leave_host(&mut self) {
        self.screen = Screen::Hosts;
        self.host = None;
        self.app_count = 0;
        self.app = None;
        self.app_page = 0;
        self.app_index = 0;
    }

    fn back_to_hosts(&mut self, step: &mut Step) {
        self.screen = Screen::Hosts;
        self.host = None;
        step.changed = true;
    }

    fn open_host(&mut self, host: Host, index: u32, step: &mut Step) {
        self.screen = Screen::Connecting;
        self.host = Some(host);
        self.host_index = index;
        self.host_page = index / HOSTS_PER_PAGE;
        self.pin = None;
        self.url = None;
        self.message = None;
        step.changed = true;
        step.add(IntentKind::List, self.host);
    }

    fn fail(&mut self, text: Option<&str>, back_apps: bool, step: &mut Step) {
        self.screen = Screen::Error;
        self.message = message(text);
        self.back_apps = back_apps;
        self.pin = None;
        self.url = None;
        self.overlay = false;
        step.changed = true;
    }

    fn on_hosts(&mut self, op: Op, item: u32, step: &mut Step) {
        let host = self.host_item(item);
        if let (Op::A, Some(index)) = (op, host) {
            self.open_host(self.hosts[index], index as u32, step);
            return;
        }
        if let (Op::Y, Some(index)) = (op, host) {
            self.screen = Screen::HostMenu;
            self.host = Some(self.hosts[index]);
            self.host_index = index as u32;
            self.message = None;
            step.changed = true;
            return;
        }

        match (op, item) {
            (Op::A, item::PREVIOUS) => {
                self.host_page = self.host_page.saturating_sub(1);
                step.changed = true;
            }
            (Op::A, item::NEXT) => {
                self.host_page = last_page(self.host_count, HOSTS_PER_PAGE).min(self.host_page + 1);
                step.changed = true;
            }
            (Op::A, item::ADD_HOST) => {
                self.screen = Screen::AddHost;
                self.entry.clear();
                self.message = None;
                step.changed = true;
            }
            (Op::Y, _) | (Op::A, item::FIND_HOSTS) => {
                self.message = None;
                step.changed = true;
                step.add(IntentKind::RefreshHosts, None);
            }
            _ => {}
        }
    }

    fn on_add_host(&mut self, op: Op, item: u32, step: &mut Step) {
        match (op, item) {
            (Op::B, _) | (Op::A, item::CANCEL) => {
                self.screen = Screen::Hosts;
                self.entry.clear();
                step.changed = true;
            }
            (Op::Y, _) | (Op::A, item::ERASE) => {
                let kept = self.entry.len().saturating_sub(1);
                self.entry = Text::of(&self.entry.as_str()[..kept]);
                step.changed = true;
            }
            (Op::A, item::CONNECT) => self.connect_typed(step),
            (Op::A, _) => self.type_key(item, step),
            _ => {}
        }
    }

    fn type_key(&mut self, item: u32, step: &mut Step) {
        let Some(&key) = item
            .checked_sub(item::KEY)
            .and_then(|index| KEYS.get(index as usize))
        else {
            return;
        };
        if self.entry.len() >= ENTRY_MAX {
            return;
        }

        self.entry
            .push_str(core::str::from_utf8(&[key]).unwrap_or(""));
        step.changed = true;
    }

    fn connect_typed(&mut self, step: &mut Step) {
        if !is_address(self.entry.as_str()) {
            return;
        }

        let address = Address::of(self.entry.as_str());
        self.entry.clear();
        if let Some(index) = self.find_host(&address) {
            self.open_host(self.hosts[index], index as u32, step);
            return;
        }

        let typed = Host {
            name: Name::of(address.as_str()),
            address,
            uniqueid: Address::new(),
            mac: None,
        };
        self.open_host(typed, self.host_index, step);
    }

    fn on_host_menu(&mut self, op: Op, item: u32, step: &mut Step) {
        let cancelled = op == Op::B || (op == Op::A && item == item::CANCEL);
        let Some(host) = self.host.filter(|_| !cancelled) else {
            self.back_to_hosts(step);
            return;
        };
        if op != Op::A {
            return;
        }

        match item {
            item::UNPAIR => {
                self.screen = Screen::Unpairing;
                step.changed = true;
                step.add(IntentKind::UnpairHost, self.host);
            }
            item::REMOVE_HOST => self.remove_host(host, step),
            _ => {}
        }
    }

    fn remove_host(&mut self, removed: Host, step: &mut Step) {
        let mut kept = 0;
        for index in 0..self.host_count {
            if self.hosts[index].address != removed.address {
                self.hosts[kept] = self.hosts[index];
                kept += 1;
            }
        }

        self.host_count = kept;
        self.screen = Screen::Hosts;
        self.host = None;
        self.host_index = self.host_index.min((kept as u32).saturating_sub(1));
        self.host_page = self.host_index / HOSTS_PER_PAGE;
        self.message = formatted(format_args!("Removed {}", removed.name));
        step.changed = true;
        step.add(IntentKind::RemoveHost, Some(removed));
    }

    fn on_quit_asked(&mut self, item: u32, step: &mut Step) {
        let Some(index) = self.app_item(item) else {
            return;
        };
        if self.current_game == 0 || self.apps[index].id != self.current_game {
            return;
        }

        self.screen = Screen::QuitConfirm;
        step.changed = true;
    }

    fn on_apps(&mut self, op: Op, item: u32, step: &mut Step) {
        match (op, item) {
            (Op::B, _) | (Op::A, item::BACK) => {
                self.leave_host();
                step.changed = true;
            }
            (Op::Y, _) => self.on_quit_asked(item, step),
            (Op::A, item::PREVIOUS) => {
                self.app_page = self.app_page.saturating_sub(1);
                step.changed = true;
            }
            (Op::A, item::NEXT) => {
                self.app_page = last_page(self.app_count, APPS_PER_PAGE).min(self.app_page + 1);
                step.changed = true;
            }
            (Op::A, _) => {
                if let Some(index) = self.app_item(item) {
                    self.launch(index, step);
                }
            }
            _ => {}
        }
    }

    fn launch(&mut self, index: usize, step: &mut Step) {
        let app = self.apps[index];
        if self.current_game != 0 && app.id != self.current_game {
            let running = self.apps().iter().find(|app| app.id == self.current_game);
            let name = running.map_or("Another app", |app| app.name.as_str());
            self.message = formatted(format_args!(
                "{name} is still running on the PC; press Y on it to quit it first"
            ));
            step.changed = true;
            return;
        }
        if !self.capabilities.launchable() {
            self.message = Some(Message::of("This console cannot play a stream yet"));
            step.changed = true;
            return;
        }

        self.screen = Screen::Launching;
        self.app = Some(app);
        self.app_index = index as u32;
        self.message = None;
        self.overlay = false;
        step.changed = true;
        step.add_intent(Intent {
            kind: IntentKind::Launch,
            host: self.host,
            app: Some(app),
        });
    }

    fn on_quit_confirm(&mut self, op: Op, item: u32, step: &mut Step) {
        match (op, item) {
            (Op::A, item::CONFIRM_QUIT) => {
                self.screen = Screen::Quitting;
                step.changed = true;
                step.add(IntentKind::QuitHost, self.host);
            }
            (Op::B, _) | (Op::A, item::CANCEL) => {
                self.screen = Screen::Apps;
                step.changed = true;
            }
            _ => {}
        }
    }

    fn setting_item(item: u32) -> Option<Setting> {
        Setting::from_index(item.checked_sub(item::SETTING)? as usize)
    }

    fn on_edit(&mut self, item: u32, step: &mut Step) {
        let editing = Self::setting_item(item).filter(|&setting| self.settings.adjustable(setting));
        if editing == self.editing {
            return;
        }

        self.editing = editing;
        step.changed = true;
    }

    fn on_edit_command(&mut self, op: Op, item: u32, value: i32, step: &mut Step) {
        let Some(setting) = Self::setting_item(item) else {
            return;
        };
        if op != Op::Adjust || Some(setting) != self.editing {
            return;
        }
        let Some(adjusted) = self
            .settings
            .adjust(setting, value, self.docked, &self.capabilities)
        else {
            return;
        };

        self.settings = adjusted;
        step.changed = true;
        step.add(IntentKind::SaveSettings, None);
    }

    fn on_settings(&mut self, op: Op, item: u32, value: i32, step: &mut Step) {
        if op == Op::Edit {
            self.on_edit(item, step);
            return;
        }
        if self.editing.is_some() {
            self.on_edit_command(op, item, value, step);
            return;
        }

        match op {
            Op::B => {
                self.screen = self.from;
                step.changed = true;
            }
            Op::Y => {
                self.settings = Settings::default();
                step.changed = true;
                step.add(IntentKind::SaveSettings, None);
            }
            _ => {}
        }
    }

    fn on_streaming(&mut self, op: Op, item: u32, step: &mut Step) {
        if op == Op::Chord {
            if self.settings.index(Setting::MenuChord) == 0 {
                return;
            }
            self.overlay = true;
            step.changed = true;
            step.add(IntentKind::PauseInput, None);
            return;
        }
        if !self.overlay {
            return;
        }
        if op == Op::B {
            self.overlay = false;
            step.changed = true;
            step.add(IntentKind::ResumeInput, None);
            return;
        }

        let return_pressed = op == Op::A && item == item::RETURN_TO_APPS;
        let quit_on_return = return_pressed && self.settings.index(Setting::QuitOnReturn) != 0;
        if return_pressed && !quit_on_return {
            self.screen = Screen::Connecting;
            self.overlay = false;
            step.changed = true;
            step.add(IntentKind::StopStream, None);
            return;
        }
        if quit_on_return || (op == Op::A && item == item::QUIT_HOST) {
            self.screen = Screen::Quitting;
            self.overlay = false;
            step.changed = true;
            step.add(IntentKind::StopStream, None);
            step.add(IntentKind::QuitHost, self.host);
        }
    }

    fn on_error(&mut self, op: Op, step: &mut Step) {
        if op != Op::A && op != Op::B {
            return;
        }

        let lost_back = self.screen == Screen::ConnectionLost && op == Op::B;
        if let Some(host) = self.host.filter(|_| self.back_apps && !lost_back) {
            self.open_host(host, self.host_index, step);
            return;
        }
        self.message = None;
        self.back_to_hosts(step);
    }

    fn on_command(&mut self, op: Op, item: u32, value: i32, step: &mut Step) {
        let browsing = matches!(self.screen, Screen::Hosts | Screen::Apps);
        if op == Op::X && browsing {
            self.from = self.screen;
            self.screen = Screen::Settings;
            self.editing = None;
            step.changed = true;
            return;
        }

        match self.screen {
            Screen::Hosts => self.on_hosts(op, item, step),
            Screen::AddHost => self.on_add_host(op, item, step),
            Screen::HostMenu => self.on_host_menu(op, item, step),
            Screen::Connecting if op == Op::B => {
                self.back_to_hosts(step);
                step.add(IntentKind::CancelList, None);
            }
            Screen::Pairing if op == Op::B => {
                self.pin = None;
                self.url = None;
                self.back_to_hosts(step);
                step.add(IntentKind::CancelPair, None);
            }
            Screen::Apps => self.on_apps(op, item, step),
            Screen::QuitConfirm => self.on_quit_confirm(op, item, step),
            Screen::Settings => self.on_settings(op, item, value, step),
            Screen::Launching if op == Op::B => {
                self.screen = Screen::Connecting;
                self.app = None;
                step.changed = true;
                step.add(IntentKind::StopStream, None);
            }
            Screen::Streaming => self.on_streaming(op, item, step),
            Screen::Error | Screen::ConnectionLost => self.on_error(op, step),
            _ => {}
        }
    }

    fn on_listed(&mut self, apps: &[App], current_game: u32, text: Option<&str>, step: &mut Step) {
        if !matches!(
            self.screen,
            Screen::Connecting | Screen::Pairing | Screen::Quitting
        ) {
            return;
        }

        self.set_apps(apps);
        self.screen = Screen::Apps;
        self.current_game = current_game;
        self.app_page = self.app_page.min(last_page(self.app_count, APPS_PER_PAGE));
        self.pin = None;
        self.url = None;
        self.message = message(text);
        step.changed = true;
        step.add(IntentKind::Covers, self.host);
    }

    fn on_connection_lost(&mut self, lost: Option<&Host>, step: &mut Step) {
        let index = lost.and_then(|lost| self.find_host(&lost.address));
        self.screen = Screen::ConnectionLost;
        self.app = None;
        self.app_count = 0;
        self.overlay = false;
        step.changed = true;

        let Some(index) = index else {
            self.host = None;
            self.back_apps = false;
            self.message = Some(Message::of("Connection lost. Select a PC to reconnect."));
            return;
        };

        let host = self.hosts[index];
        self.host = Some(host);
        self.host_index = index as u32;
        self.host_page = index as u32 / HOSTS_PER_PAGE;
        self.back_apps = true;
        self.message = formatted(format_args!(
            "The stream from {} was cut off. Press A to reconnect.",
            host.name
        ));
    }

    fn list_again(&mut self, step: &mut Step) {
        self.screen = Screen::Connecting;
        self.app = None;
        step.changed = true;
        step.add(IntentKind::List, self.host);
    }

    fn on_service(&mut self, event: &Event<'_>, step: &mut Step) {
        let screen = self.screen;
        match *event {
            Event::Attached if screen != Screen::ConnectionLost => {
                self.screen = Screen::Hosts;
                step.changed = true;
            }
            Event::ConnectionLost { host } => self.on_connection_lost(host, step),
            Event::Hosts { hosts } => {
                self.set_hosts(hosts);
                self.host_page = self
                    .host_page
                    .min(last_page(self.host_count, HOSTS_PER_PAGE));
                step.changed = true;
            }
            Event::Listed {
                apps,
                current_game,
                message,
            } => self.on_listed(apps, current_game, message, step),
            Event::NotPaired if screen == Screen::Connecting => {
                self.screen = Screen::Pairing;
                self.pin = None;
                self.url = None;
                step.changed = true;
                step.add(IntentKind::Pair, self.host);
            }
            Event::Pin { pin, url } if screen == Screen::Pairing => {
                self.pin = message(pin);
                self.url = message(url);
                step.changed = true;
            }
            Event::Paired if screen == Screen::Pairing => {
                self.screen = Screen::Connecting;
                self.pin = None;
                self.url = None;
                step.changed = true;
                step.add(IntentKind::List, self.host);
            }
            Event::StreamStarted if screen == Screen::Launching => {
                self.screen = Screen::Streaming;
                self.overlay = false;
                step.changed = true;
            }
            Event::Stage { message: text } if screen == Screen::Launching => {
                self.message = message(text);
                step.changed = true;
            }
            Event::StreamEnded
                if matches!(
                    screen,
                    Screen::Launching | Screen::Streaming | Screen::Connecting
                ) =>
            {
                self.overlay = false;
                self.list_again(step);
            }
            Event::Unpaired if screen == Screen::Unpairing => {
                let name = self.host.map_or(Name::of("undefined"), |host| host.name);
                self.screen = Screen::Hosts;
                self.message = formatted(format_args!("Unpaired {name}"));
                self.host = None;
                step.changed = true;
            }
            Event::QuitDone if screen == Screen::Quitting => self.list_again(step),
            Event::Failed { message, back_apps } => {
                let idle = matches!(
                    screen,
                    Screen::Hosts | Screen::AddHost | Screen::HostMenu | Screen::Settings
                );
                if !idle {
                    self.fail(message, back_apps.unwrap_or(self.host.is_some()), step);
                }
            }
            Event::AppGone => {
                self.screen = Screen::Stopped;
                step.changed = true;
                step.add(IntentKind::Exit, None);
            }
            Event::OperationMode { docked } if docked != self.docked => {
                self.docked = docked;
                step.changed = true;
            }
            _ => {}
        }
    }
}
