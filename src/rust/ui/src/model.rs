//! Console UI state machine of dev reference/native/ui/model.c: events in, model and intents out.
//! Host work (list, pair, launch, quit) stays with the caller as intents.

use alloc::vec::Vec;
use core::fmt::Write;

use crate::extras::{AppOverride, Extras, INHERIT, MAX_OVERRIDES, OVERRIDABLE};
use crate::link_choice::LinkChoice;
use crate::presence::{Presence, Table};
use crate::readout::{Readout, StreamReadout};
use crate::settings::{Capabilities, MouseSide, Setting, Settings, StreamOptions};
use crate::text::Text;
use crate::theme::Look;

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
    pub const REMOVE_HOST: u32 = 12;
    pub const ERASE: u32 = 13;
    pub const CONNECT: u32 = 14;
    pub const TOGGLE_STATS: u32 = 15;
    pub const RENAME_HOST: u32 = 16;
    pub const KEY_PAGE: u32 = 17;
    pub const SAVE_NAME: u32 = 18;
    pub const WAKE_HOST: u32 = 19;
    pub const RESUME_STREAM: u32 = 20;
    pub const RESUME_HOST: u32 = 21;
    pub const EXPORT_LOGS: u32 = 22;
    pub const CONFIRM_FORGET: u32 = 23;
    pub const SHOW_KEYBOARD: u32 = 24;
    pub const TOGGLE_JOYCON_MOUSE: u32 = 25;
    pub const CATEGORY: u32 = 50000;
    pub const HOST: u32 = 10000;
    pub const APP: u32 = 20000;
    pub const SETTING: u32 = 30000;
    pub const KEY: u32 = 40000;
    /// Footer button hints, plus the button's bit as the console reports it.
    pub const HINT: u32 = 0x0010_0000;
}

/// Characters of the address keypad, by `item::KEY` offset.
pub const KEYS: &[u8] = b"123456789.0";
pub const NAME_KEYS: [&[u8]; 5] = [
    b"ABCDEFGHIJKLM",
    b"NOPQRSTUVWXYZ",
    b"abcdefghijklm",
    b"nopqrstuvwxyz",
    b"0123456789 -_.",
];

/// What held Automatic resolution to the size it streams at. Sunshine does not report the PC's
/// display mode, so the console and the network test are all Auto can go by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SizeLimit {
    /// The console screen, handheld.
    Screen,
    /// The TV the dock outputs to and the decoder.
    Output,
    /// The network test found the link too weak for the larger size.
    Network,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Screen {
    Splash,
    Hosts,
    AddHost,
    HostMenu,
    RenameHost,
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
    AppOptions,
    ForgetConfirm,
}

impl Screen {
    pub fn name(self) -> &'static str {
        [
            "splash",
            "hosts",
            "addHost",
            "hostMenu",
            "renameHost",
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
            "appOptions",
            "forgetConfirm",
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
    Focus,
    Minus,
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
        /// What ended the stream, when the PC said; None for a closed connection.
        reason: Option<&'a str>,
    },
    /// Open the selected PC again without the user; `resume` launches the app it still runs.
    Reopen {
        resume: bool,
    },
    Hosts {
        hosts: &'a [Host],
    },
    Listed {
        apps: &'a [App],
        current_game: u32,
        message: Option<&'a str>,
    },
    /// `timeout_s`: how long the PC accepts this PIN.
    Pin {
        pin: Option<&'a str>,
        url: Option<&'a str>,
        timeout_s: u32,
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
    RememberHost,
    RemoveHost,
    RenameHost,
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
    WakeHost,
    TestNetwork,
    SaveExtras,
    ExportLogs,
    ShowKeyboard,
}

impl IntentKind {
    pub fn name(self) -> &'static str {
        [
            "list",
            "refreshHosts",
            "rememberHost",
            "removeHost",
            "renameHost",
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
            "wakeHost",
            "testNetwork",
            "saveExtras",
            "exportLogs",
            "showKeyboard",
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

/// How many PCs remember the app last started on them.
const PLAYED: usize = MAX_HOSTS;
/// Settings categories, in the order the page lists them.
pub const CATEGORIES: u8 = 4;

/// What the badge over the video shows: nothing, the stream mode, or the mode with the live
/// frame counter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stats {
    Off,
    Compact,
    Full,
}

impl Stats {
    fn next(self) -> Self {
        match self {
            Self::Off => Self::Compact,
            Self::Compact => Self::Full,
            Self::Full => Self::Off,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Off => "Off",
            Self::Compact => "Compact",
            Self::Full => "Full",
        }
    }
}

/// An app the PC reports as still running, offered on the PCs page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resume {
    pub address: Address,
    pub app: Name,
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
    pin_timeout_s: u32,
    pin_left_s: Option<u32>,
    entry: Text<ENTRY_MAX>,
    rename: Text<63>,
    name_keys: usize,
    message: Option<Message>,
    back_apps: bool,
    from: Screen,
    overlay: bool,
    /// The side the in-stream menu turns the Joy-Con mouse back on with.
    joycon_side: MouseSide,
    stream_stats: Message,
    settings: Settings,
    docked: bool,
    editing: Option<Setting>,
    capabilities: Capabilities,
    presence: Table,
    link_choice: Option<LinkChoice>,
    link_note: Message,
    network_test: bool,
    system_status: Message,
    console_dark: Option<bool>,
    readout: Readout,
    stream: StreamReadout,
    resume: Option<Resume>,
    resume_pending: bool,
    forgetting: bool,
    played: [(Address, Name); PLAYED],
    played_count: usize,
    overrides: Vec<AppOverride>,
    category: u8,
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
            pin_timeout_s: 0,
            pin_left_s: None,
            entry: Text::new(),
            rename: Text::new(),
            name_keys: 0,
            message: None,
            back_apps: false,
            from: Screen::Hosts,
            overlay: false,
            joycon_side: match settings.joycon_mouse() {
                MouseSide::Off => MouseSide::Right,
                side => side,
            },
            stream_stats: Message::of("FPS --   Bitrate --   Latency --"),
            settings,
            docked: false,
            editing: None,
            capabilities,
            presence: Table::default(),
            link_choice: None,
            link_note: Message::new(),
            network_test: false,
            system_status: Message::new(),
            console_dark: None,
            readout: Readout::default(),
            stream: StreamReadout::default(),
            resume: None,
            resume_pending: false,
            forgetting: false,
            played: [(Address::new(), Name::default()); PLAYED],
            played_count: 0,
            overrides: Vec::new(),
            category: 0,
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

    pub fn pin_timeout_s(&self) -> u32 {
        self.pin_timeout_s
    }

    /// Seconds before the PC gives up on the shown PIN, once the bridge started counting.
    pub fn pin_left_s(&self) -> Option<u32> {
        self.pin_left_s.filter(|_| self.pin.is_some())
    }

    /// True when the shown countdown changed.
    pub fn set_pin_left(&mut self, left: Option<u32>) -> bool {
        if self.pin_left_s == left {
            return false;
        }
        self.pin_left_s = left;
        self.screen == Screen::Pairing
    }

    /// Whether the unpair in progress is part of forgetting the PC.
    pub fn forgetting(&self) -> bool {
        self.forgetting
    }

    /// The address typed so far on the add-host keypad.
    pub fn rename_entry(&self) -> &str {
        self.rename.as_str()
    }

    pub fn name_keys(&self) -> &[u8] {
        NAME_KEYS[self.name_keys]
    }

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

    pub fn stream_stats(&self) -> &str {
        self.stream_stats.as_str()
    }

    pub fn look(&self) -> Look {
        self.settings.theme().resolve(self.console_dark)
    }

    pub fn console_dark(&self) -> Option<bool> {
        self.console_dark
    }

    pub fn set_console_dark(&mut self, dark: Option<bool>) -> bool {
        let changed = self.console_dark != dark;
        self.console_dark = dark;
        changed
    }

    pub fn readout(&self) -> &Readout {
        &self.readout
    }

    pub fn set_readout(&mut self, readout: Readout) -> bool {
        let changed = self.readout != readout;
        self.readout = readout;
        changed
    }

    pub fn stream(&self) -> &StreamReadout {
        &self.stream
    }

    /// True when the sheet is up and shows something different.
    pub fn set_stream(&mut self, stream: StreamReadout) -> bool {
        let changed = self.stream != stream;
        self.stream = stream;
        changed && self.overlay
    }

    /// The app a PC still runs, unless that PC has since stopped answering.
    pub fn resume(&self) -> Option<&Resume> {
        self.resume
            .as_ref()
            .filter(|resume| self.presence(&resume.address) != Presence::Offline)
    }

    pub fn last_played(&self, address: &Address) -> Option<&str> {
        self.played[..self.played_count]
            .iter()
            .find(|(known, _)| known == address)
            .map(|(_, name)| name.as_str())
    }

    pub fn category(&self) -> u8 {
        self.category
    }

    /// How much the badge over the video shows: it follows the two badge settings.
    pub fn stats(&self) -> Stats {
        if self.settings.on(Setting::FrameCounter) {
            Stats::Full
        } else if self.settings.on(Setting::StreamInfo) {
            Stats::Compact
        } else {
            Stats::Off
        }
    }

    fn set_stats(&mut self, stats: Stats) -> bool {
        let wanted = [
            (Setting::StreamInfo, stats != Stats::Off),
            (Setting::FrameCounter, stats == Stats::Full),
        ];
        let mut changed = false;
        for (setting, on) in wanted {
            if self.settings.on(setting) == on {
                continue;
            }
            let direction = if on { 1 } else { -1 };
            if let Some(adjusted) =
                self.settings
                    .adjust(setting, direction, self.docked, &self.capabilities)
            {
                self.settings = adjusted;
                changed = true;
            }
        }
        changed
    }

    /// Takes back what hosts.json remembered per PC.
    pub fn load_extras(&mut self, extras: Extras<'_>) {
        self.overrides = extras.overrides.to_vec();
        let count = extras.played.len().min(PLAYED);
        self.played[..count].copy_from_slice(&extras.played[..count]);
        self.played_count = count;
    }

    /// What is to be remembered per PC, for the caller to save.
    pub fn extras(&self) -> Extras<'_> {
        Extras {
            overrides: &self.overrides,
            played: &self.played[..self.played_count],
        }
    }

    fn overridden_app(&self) -> Option<u32> {
        match self.screen {
            Screen::Apps | Screen::AppOptions => {
                self.apps().get(self.app_index as usize).map(|app| app.id)
            }
            _ => self.app.map(|app| app.id),
        }
    }

    fn override_of(&self, app: u32) -> Option<&AppOverride> {
        let host = self.host?;
        self.overrides
            .iter()
            .find(|stored| stored.host == host.address && stored.app == app)
    }

    /// The settings a stream of the chosen or focused app uses: the saved ones with that
    /// app's own choices on top.
    pub fn stream_settings(&self) -> Settings {
        let stored = self
            .overridden_app()
            .and_then(|app| self.override_of(app));
        match stored {
            Some(stored) => self.settings.with_override(&stored.values),
            None => self.settings,
        }
    }

    /// True when the focused app has choices of its own.
    pub fn has_override(&self) -> bool {
        self.overridden_app()
            .is_some_and(|app| self.override_of(app).is_some())
    }

    fn store_override(&mut self, adjusted: &Settings) -> bool {
        let (Some(host), Some(app)) = (self.host, self.overridden_app()) else {
            return false;
        };
        let values = adjusted.override_from(&self.settings);
        let position = self
            .overrides
            .iter()
            .position(|stored| stored.host == host.address && stored.app == app);
        match (position, values.iter().all(|value| *value == INHERIT)) {
            (Some(index), true) => {
                self.overrides.remove(index);
            }
            (Some(index), false) => self.overrides[index].values = values,
            (None, true) => return false,
            (None, false) => {
                if self.overrides.len() >= MAX_OVERRIDES {
                    return false;
                }
                let mut stored = AppOverride::new(host.address, app);
                stored.values = values;
                self.overrides.push(stored);
            }
        }
        true
    }

    fn clear_override(&mut self) -> bool {
        let (Some(host), Some(app)) = (self.host, self.overridden_app()) else {
            return false;
        };
        let before = self.overrides.len();
        self.overrides
            .retain(|stored| !(stored.host == host.address && stored.app == app));
        self.overrides.len() != before
    }

    /// True when the PC's last played app changed.
    fn remember_played(&mut self, address: Address, name: Name) -> bool {
        let known = self.played[..self.played_count]
            .iter()
            .position(|(known, _)| *known == address);
        match known {
            Some(index) if self.played[index].1 == name => return false,
            Some(index) => self.played[index].1 = name,
            None if self.played_count < PLAYED => {
                self.played[self.played_count] = (address, name);
                self.played_count += 1;
            }
            None => {
                self.played.copy_within(1.., 0);
                self.played[PLAYED - 1] = (address, name);
            }
        }
        true
    }

    pub fn set_stream_stats(&mut self, text: &str) -> bool {
        let next = Message::of(text);
        if self.stream_stats.as_str() == next.as_str() {
            return false;
        }
        self.stream_stats = next;
        self.overlay
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn presence(&self, address: &Address) -> Presence {
        self.presence.get(address)
    }

    /// True when the hosts page shows the change.
    pub fn set_presence(&mut self, address: &Address, presence: Presence) -> bool {
        self.presence.set(address, presence) && self.screen == Screen::Hosts
    }

    /// A PC that did not answer but can be woken: A wakes it before connecting.
    pub fn is_asleep(&self, host: &Host) -> bool {
        host.mac.is_some() && self.presence(&host.address) == Presence::Offline
    }

    pub fn link_ms(&self, address: &Address) -> Option<u32> {
        self.presence.link_ms(address)
    }

    pub fn set_link_ms(&mut self, address: &Address, ms: u32) -> bool {
        self.presence.set_link_ms(address, ms) && self.screen == Screen::Hosts
    }

    /// What a launch would stream now: the settings, limited by the network test's choice.
    pub fn planned_stream(&self) -> StreamOptions {
        let options = self
            .stream_settings()
            .stream_options(self.docked, &self.capabilities);
        self.link_choice
            .map_or(options, |choice| choice.apply(options))
    }

    /// The height the saved Automatic resolution streams at now and what held it there; None
    /// for a size picked by name.
    pub fn automatic_size(&self) -> Option<(u32, SizeLimit)> {
        let settings = self.settings();
        if !settings.size_auto() {
            return None;
        }
        let options = settings.stream_options(self.docked, &self.capabilities);
        let tested = self
            .link_choice
            .map_or(options, |choice| choice.apply(options));
        let limit = if tested.height < options.height {
            SizeLimit::Network
        } else if self.docked {
            SizeLimit::Output
        } else {
            SizeLimit::Screen
        };
        Some((tested.height, limit))
    }

    pub fn link_choice(&self) -> Option<&LinkChoice> {
        self.link_choice.as_ref()
    }

    /// The network test's one line: what it measured and picked, or why it could not run.
    pub fn link_note(&self) -> &str {
        self.link_note.as_str()
    }

    /// True when the settings page shows the change.
    pub fn set_link(&mut self, choice: Option<LinkChoice>, note: &str) -> bool {
        let changed = self.link_choice != choice || self.link_note.as_str() != note;
        self.link_choice = choice;
        self.link_note = Message::of(note);
        changed && self.screen == Screen::Settings
    }

    /// Whether the host can measure the link; Sunshine cannot, so X stays free on Settings.
    pub fn network_test(&self) -> bool {
        self.network_test
    }

    /// True when the settings page shows the change.
    pub fn set_network_test(&mut self, supported: bool) -> bool {
        let changed = self.network_test != supported;
        self.network_test = supported;
        changed && self.screen == Screen::Settings
    }

    /// Battery, temperature and Wi-Fi, shown under the stream statistics.
    pub fn system_status(&self) -> &str {
        self.system_status.as_str()
    }

    pub fn set_system_status(&mut self, text: &str) -> bool {
        if self.system_status.as_str() == text {
            return false;
        }
        self.system_status = Message::of(text);
        self.overlay
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
        self.forgetting = false;
        self.resume_pending = false;
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
        self.resume_pending = false;
        self.screen = Screen::Error;
        self.message = message(text);
        self.back_apps = back_apps;
        self.pin = None;
        self.url = None;
        self.overlay = false;
        step.changed = true;
    }

    fn on_focus(&mut self, item: u32, step: &mut Step) {
        match self.screen {
            Screen::Apps => {
                let Some(index) = self.app_item(item).map(|index| index as u32) else {
                    return;
                };
                if index != self.app_index {
                    self.app_index = index;
                    step.changed = true;
                }
            }
            Screen::Settings if self.editing.is_none() => {
                let category = item
                    .checked_sub(item::CATEGORY)
                    .and_then(|category| u8::try_from(category).ok())
                    .filter(|category| *category < CATEGORIES);
                if let Some(category) = category.filter(|category| *category != self.category) {
                    self.category = category;
                    step.changed = true;
                }
            }
            _ => {}
        }
    }

    fn on_resume_host(&mut self, step: &mut Step) {
        let Some(resume) = self.resume().copied() else {
            return;
        };
        let Some(index) = self.find_host(&resume.address) else {
            return;
        };
        self.resume_pending = true;
        self.open_host(self.hosts[index], index as u32, step);
    }

    fn on_hosts(&mut self, op: Op, item: u32, step: &mut Step) {
        if (op, item) == (Op::A, item::RESUME_HOST) || op == Op::Minus {
            self.on_resume_host(step);
            return;
        }
        let host = self.host_item(item);
        if let (Op::A, Some(index)) = (op, host) {
            let chosen = self.hosts[index];
            if self.is_asleep(&chosen) {
                step.add(IntentKind::WakeHost, Some(chosen));
            }
            self.open_host(chosen, index as u32, step);
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
            item::WAKE_HOST if host.mac.is_some() => {
                step.add(IntentKind::WakeHost, Some(host));
                self.open_host(host, self.host_index, step);
            }
            item::REMOVE_HOST => {
                self.screen = Screen::ForgetConfirm;
                step.changed = true;
            }
            item::RENAME_HOST => {
                self.rename = Text::of(host.name.as_str());
                self.name_keys = 0;
                self.screen = Screen::RenameHost;
                step.changed = true;
            }
            _ => {}
        }
    }

    fn on_forget_confirm(&mut self, op: Op, item: u32, step: &mut Step) {
        match (op, item) {
            (Op::A, item::CONFIRM_FORGET) => {
                self.forgetting = true;
                self.screen = Screen::Unpairing;
                step.changed = true;
                step.add(IntentKind::UnpairHost, self.host);
            }
            (Op::B, _) | (Op::A, item::CANCEL) => {
                self.screen = Screen::HostMenu;
                step.changed = true;
            }
            _ => {}
        }
    }

    fn on_rename_host(&mut self, op: Op, item: u32, step: &mut Step) {
        match (op, item) {
            (Op::B, _) | (Op::A, item::CANCEL) => {
                self.screen = Screen::HostMenu;
                step.changed = true;
            }
            (Op::Y, _) | (Op::A, item::ERASE) => {
                let current = self.rename.as_str();
                let kept = current.char_indices().last().map_or(0, |(index, _)| index);
                self.rename = Text::of(&current[..kept]);
                step.changed = true;
            }
            (Op::X, _) | (Op::A, item::KEY_PAGE) => {
                self.name_keys = (self.name_keys + 1) % NAME_KEYS.len();
                step.changed = true;
            }
            (Op::A, item::SAVE_NAME) => {
                let name = self.rename.as_str().trim();
                if name.is_empty() {
                    return;
                }
                if let Some(mut host) = self.host {
                    host.name = Name::of(name);
                    self.host = None;
                    self.screen = Screen::Hosts;
                    step.changed = true;
                    step.add(IntentKind::RenameHost, Some(host));
                }
            }
            (Op::A, _) => {
                if let Some(&key) = item
                    .checked_sub(item::KEY)
                    .and_then(|i| self.name_keys().get(i as usize))
                {
                    self.rename
                        .push_str(core::str::from_utf8(&[key]).unwrap_or(""));
                    step.changed = true;
                }
            }
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

        let played = self
            .host
            .is_some_and(|host| self.remember_played(host.address, app.name));
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
        if played {
            step.add(IntentKind::SaveExtras, None);
        }
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

    fn app_option_item(&self, item: u32) -> Option<Setting> {
        Self::setting_item(item).filter(|setting| OVERRIDABLE.contains(setting))
    }

    fn on_app_options(&mut self, op: Op, item: u32, value: i32, step: &mut Step) {
        let adjusting = self.editing.is_some();
        match op {
            Op::Edit => {
                let editing = self
                    .app_option_item(item)
                    .filter(|&setting| self.stream_settings().adjustable(setting));
                if editing != self.editing {
                    self.editing = editing;
                    step.changed = true;
                }
            }
            Op::Adjust if adjusting => {
                let Some(setting) = self.app_option_item(item).filter(|s| Some(*s) == self.editing)
                else {
                    return;
                };
                let Some(adjusted) =
                    self.stream_settings()
                        .adjust(setting, value, self.docked, &self.capabilities)
                else {
                    return;
                };
                if self.store_override(&adjusted) {
                    step.changed = true;
                    step.add(IntentKind::SaveExtras, None);
                }
            }
            Op::B => {
                self.screen = Screen::Apps;
                self.editing = None;
                step.changed = true;
            }
            Op::Y if !adjusting && self.clear_override() => {
                step.changed = true;
                step.add(IntentKind::SaveExtras, None);
            }
            _ => {}
        }
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
            Op::X if self.network_test => step.add(IntentKind::TestNetwork, self.host),
            Op::A if item == item::EXPORT_LOGS => step.add(IntentKind::ExportLogs, None),
            _ => {}
        }
    }

    fn on_streaming(&mut self, op: Op, item: u32, step: &mut Step) {
        if op == Op::Chord {
            if self.overlay || !self.settings.on(Setting::MenuChord) {
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
        if op == Op::B || (op == Op::A && item == item::RESUME_STREAM) {
            self.overlay = false;
            step.changed = true;
            step.add(IntentKind::ResumeInput, None);
            return;
        }

        if op == Op::A && item == item::SHOW_KEYBOARD {
            step.add(IntentKind::ShowKeyboard, None);
            return;
        }
        if op == Op::A && item == item::TOGGLE_JOYCON_MOUSE {
            let side = match self.settings.joycon_mouse() {
                MouseSide::Off => self.joycon_side,
                side => {
                    self.joycon_side = side;
                    MouseSide::Off
                }
            };
            self.settings = self.settings.with_joycon_mouse(side);
            step.changed = true;
            step.add(IntentKind::SaveSettings, None);
            return;
        }
        if op == Op::A && item == item::TOGGLE_STATS {
            if self.set_stats(self.stats().next()) {
                step.changed = true;
                step.add(IntentKind::SaveSettings, None);
            }
            return;
        }
        let quit_on_return =
            item == item::RETURN_TO_APPS && self.settings.on(Setting::QuitOnReturn);
        if op == Op::A && item == item::RETURN_TO_APPS && !quit_on_return {
            self.screen = Screen::Connecting;
            self.overlay = false;
            step.changed = true;
            step.add(IntentKind::StopStream, None);
            return;
        }
        if op == Op::A && (quit_on_return || item == item::QUIT_HOST) {
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
        if op == Op::Focus {
            self.on_focus(item, step);
            return;
        }
        let menu = matches!(self.screen, Screen::Hosts | Screen::Apps | Screen::AppOptions);
        let editing_option = self.screen == Screen::AppOptions && self.editing.is_some();
        if op == Op::X && menu && !editing_option {
            self.from = self.screen;
            self.screen = Screen::Settings;
            self.editing = None;
            step.changed = true;
            return;
        }
        if op == Op::Minus && self.screen == Screen::Apps && self.app_count > 0 {
            self.screen = Screen::AppOptions;
            self.editing = None;
            step.changed = true;
            return;
        }

        let cancelled = op == Op::B || (op == Op::A && item == item::CANCEL);
        match self.screen {
            Screen::Hosts => self.on_hosts(op, item, step),
            Screen::AddHost => self.on_add_host(op, item, step),
            Screen::HostMenu => self.on_host_menu(op, item, step),
            Screen::RenameHost => self.on_rename_host(op, item, step),
            Screen::ForgetConfirm => self.on_forget_confirm(op, item, step),
            Screen::Connecting if cancelled => {
                self.back_to_hosts(step);
                step.add(IntentKind::CancelList, None);
            }
            Screen::Pairing if cancelled => {
                self.pin = None;
                self.url = None;
                self.back_to_hosts(step);
                step.add(IntentKind::CancelPair, None);
            }
            Screen::Apps => self.on_apps(op, item, step),
            Screen::QuitConfirm => self.on_quit_confirm(op, item, step),
            Screen::Settings => self.on_settings(op, item, value, step),
            Screen::AppOptions => self.on_app_options(op, item, value, step),
            Screen::Launching if cancelled => {
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
        self.resume = self.host.zip(self.apps().iter().find(|app| app.id == current_game)).map(
            |(host, app)| Resume {
                address: host.address,
                app: app.name,
            },
        );
        self.app_page = self.app_page.min(last_page(self.app_count, APPS_PER_PAGE));
        self.pin = None;
        self.url = None;
        self.message = message(text);
        step.changed = true;
        step.add(IntentKind::Covers, self.host);
        if core::mem::take(&mut self.resume_pending)
            && let Some(index) = self.apps().iter().position(|app| app.id == current_game)
        {
            self.launch(index, step);
        }
    }

    fn on_connection_lost(&mut self, lost: Option<&Host>, reason: Option<&str>, step: &mut Step) {
        let index = lost.and_then(|lost| self.find_host(&lost.address));
        self.screen = Screen::ConnectionLost;
        self.app = None;
        self.app_count = 0;
        self.overlay = false;
        step.changed = true;

        let Some(index) = index else {
            self.host = None;
            self.back_apps = false;
            self.message = match reason {
                Some(reason) => formatted(format_args!("{reason}. Select a PC to reconnect.")),
                None => Some(Message::of("Connection lost. Select a PC to reconnect.")),
            };
            return;
        };

        let host = self.hosts[index];
        self.host = Some(host);
        self.host_index = index as u32;
        self.host_page = index as u32 / HOSTS_PER_PAGE;
        self.back_apps = true;
        self.message = match reason {
            Some(reason) => formatted(format_args!("{reason}. Press A to reconnect.")),
            None => formatted(format_args!(
                "The stream from {} was cut off. Press A to reconnect.",
                host.name
            )),
        };
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
            Event::ConnectionLost { host, reason } => self.on_connection_lost(host, reason, step),
            Event::Reopen { resume }
                if matches!(
                    screen,
                    Screen::ConnectionLost | Screen::Error | Screen::Apps
                ) =>
            {
                if let Some(host) = self.host {
                    self.resume_pending = resume;
                    self.open_host(host, self.host_index, step);
                }
            }
            Event::Hosts { hosts } => {
                self.set_hosts(hosts);
                self.presence.retain(hosts);
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
            Event::Pin {
                pin,
                url,
                timeout_s,
            } if screen == Screen::Pairing => {
                self.pin = message(pin);
                self.url = message(url);
                self.pin_timeout_s = timeout_s;
                self.pin_left_s = None;
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
            Event::Unpaired if screen == Screen::Unpairing && self.forgetting => {
                self.forgetting = false;
                match self.host {
                    Some(host) => self.remove_host(host, step),
                    None => self.back_to_hosts(step),
                }
            }
            Event::Failed { .. } if screen == Screen::Unpairing && self.forgetting => {
                self.forgetting = false;
                match self.host {
                    Some(host) => {
                        self.remove_host(host, step);
                        self.message = formatted(format_args!(
                            "Removed {}; the PC could not be asked to unpair",
                            host.name
                        ));
                    }
                    None => self.back_to_hosts(step),
                }
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
                    Screen::Hosts
                        | Screen::AddHost
                        | Screen::HostMenu
                        | Screen::RenameHost
                        | Screen::ForgetConfirm
                        | Screen::Settings
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

#[cfg(test)]
mod stream_menu_tests {
    use super::*;

    fn command(model: &mut Model, op: Op, item: u32) -> Step {
        model.reduce(&Event::Command { op, item, value: 0 })
    }

    #[test]
    fn menu_pauses_and_actions_are_distinct() {
        let mut model = Model::new(&[], Settings::default(), Capabilities::default());
        model.screen = Screen::Streaming;
        let opened = command(&mut model, Op::Chord, 0);
        assert!(model.overlay());
        assert!(opened.intents().any(|i| i.kind == IntentKind::PauseInput));
        assert!(!model.allow_input());
        let toggle = command(&mut model, Op::A, item::TOGGLE_STATS);
        assert_eq!(model.stats(), Stats::Compact);
        assert!(toggle.intents().any(|i| i.kind == IntentKind::SaveSettings));
        command(&mut model, Op::A, item::TOGGLE_STATS);
        assert_eq!(model.stats(), Stats::Full);
        assert!(model.settings().on(Setting::FrameCounter));
        command(&mut model, Op::A, item::TOGGLE_STATS);
        assert_eq!(model.stats(), Stats::Off);
        assert!(!model.settings().on(Setting::StreamInfo));
        let closed = command(&mut model, Op::B, 0);
        assert!(closed.intents().any(|i| i.kind == IntentKind::ResumeInput));
        assert!(model.allow_input());
        command(&mut model, Op::Chord, 0);
        assert!(!model.settings.on(Setting::QuitOnReturn));
        let disconnect = command(&mut model, Op::A, item::RETURN_TO_APPS);
        assert!(
            disconnect
                .intents()
                .any(|i| i.kind == IntentKind::StopStream)
        );
        assert!(!disconnect.intents().any(|i| i.kind == IntentKind::QuitHost));
        model.screen = Screen::Streaming;
        command(&mut model, Op::Chord, 0);
        let quit = command(&mut model, Op::A, item::QUIT_HOST);
        assert!(quit.intents().any(|i| i.kind == IntentKind::StopStream));
        assert!(quit.intents().any(|i| i.kind == IntentKind::QuitHost));
    }

    fn streaming_with(setting: Setting, direction: i32) -> Model {
        let mut model = Model::new(&[], Settings::default(), Capabilities::default());
        model.settings = model
            .settings
            .adjust(setting, direction, model.docked, &model.capabilities)
            .unwrap();
        model.screen = Screen::Streaming;
        model
    }

    #[test]
    fn disconnect_quits_the_host_app_when_quit_on_return_is_on() {
        let mut model = streaming_with(Setting::QuitOnReturn, 1);
        command(&mut model, Op::Chord, 0);
        let disconnect = command(&mut model, Op::A, item::RETURN_TO_APPS);
        assert_eq!(model.screen(), Screen::Quitting);
        let kinds: alloc::vec::Vec<_> = disconnect.intents().map(|i| i.kind).collect();
        assert_eq!(kinds, [IntentKind::StopStream, IntentKind::QuitHost]);
    }

    #[test]
    fn chord_is_ignored_when_the_menu_setting_is_off() {
        let mut model = streaming_with(Setting::MenuChord, -1);
        let step = command(&mut model, Op::Chord, 0);
        assert!(!model.overlay());
        assert_eq!(step.intents().count(), 0);
        assert!(model.allow_input());
    }
}

#[cfg(test)]
mod rename_ui_tests {
    use super::*;

    #[test]
    fn rename_emits_only_a_local_host_update() {
        let host = Host {
            name: Name::of("PC"),
            address: Address::of("192.168.1.4"),
            ..Host::default()
        };
        let mut model = Model::new(&[host], Settings::default(), Capabilities::default());
        model.screen = Screen::Hosts;
        let run =
            |model: &mut Model, op, item| model.reduce(&Event::Command { op, item, value: 0 });
        run(&mut model, Op::Y, item::HOST);
        run(&mut model, Op::A, item::RENAME_HOST);
        assert_eq!(model.screen(), Screen::RenameHost);
        run(&mut model, Op::A, item::KEY);
        let step = run(&mut model, Op::A, item::SAVE_NAME);
        let intents: alloc::vec::Vec<_> = step.intents().collect();
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].kind, IntentKind::RenameHost);
        assert_eq!(intents[0].host.unwrap().name.as_str(), "PCA");
        assert_eq!(model.screen(), Screen::Hosts);
    }
}

#[cfg(test)]
mod add_host_tests {
    use super::*;

    #[test]
    fn new_ip_is_not_remembered_until_the_pc_answers() {
        let mut model = Model::new(&[], Settings::default(), Capabilities::default());
        model.screen = Screen::AddHost;
        model.entry = Text::of("192.168.1.7");
        let step = model.reduce(&Event::Command {
            op: Op::A,
            item: item::CONNECT,
            value: 0,
        });
        let intents: alloc::vec::Vec<_> = step.intents().collect();
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].kind, IntentKind::List);
        assert_eq!(intents[0].host.unwrap().address.as_str(), "192.168.1.7");
        assert!(model.hosts().is_empty());
    }
}

#[cfg(test)]
mod app_options_tests {
    use super::*;
    use crate::settings::ButtonLayout;

    fn run(model: &mut Model, op: Op, item: u32, value: i32) -> Step {
        model.reduce(&Event::Command { op, item, value })
    }

    fn browsing() -> Model {
        let host = Host {
            name: Name::of("PC"),
            address: Address::of("192.168.1.4"),
            ..Host::default()
        };
        let apps = [
            App {
                id: 7,
                name: Name::of("Desktop"),
            },
            App {
                id: 8,
                name: Name::of("Game"),
            },
        ];
        let mut model = Model::new(&[host], Settings::default(), Capabilities::ALL);
        model.reduce(&Event::Attached);
        run(&mut model, Op::A, item::HOST, 0);
        model.reduce(&Event::Listed {
            apps: &apps,
            current_game: 0,
            message: None,
        });
        model
    }

    #[test]
    fn export_log_row_asks_the_host_to_copy_the_log() {
        let mut model = browsing();
        run(&mut model, Op::B, 0, 0);
        run(&mut model, Op::X, 0, 0);
        let step = run(&mut model, Op::A, item::EXPORT_LOGS, 0);
        assert!(step.intents().any(|i| i.kind == IntentKind::ExportLogs));
    }

    #[test]
    fn rumble_strength_scales_and_round_trips() {
        let mut json = crate::json::Json::new();
        let mut settings = Settings::default();
        assert_eq!(settings.rumble_percent(), 100);
        settings = settings
            .adjust(Setting::Rumble, -1, false, &Capabilities::ALL)
            .unwrap();
        assert_eq!(settings.rumble_percent(), 75);
        let saved = Settings::from_json(settings.to_json().as_str().as_bytes(), &mut json);
        assert_eq!(saved.rumble_percent(), 75);
    }

    #[test]
    fn rumble_defaults_on_and_off_silences_every_strength() {
        let mut json = crate::json::Json::new();
        let old = Settings::from_json(br#"{"version":8,"rumble":50}"#, &mut json);
        assert!(old.on(Setting::RumbleOn));
        assert_eq!(old.rumble_percent(), 50);
        let off = old
            .adjust(Setting::RumbleOn, -1, false, &Capabilities::ALL)
            .unwrap();
        assert_eq!(off.rumble_percent(), 0);
        let saved = Settings::from_json(off.to_json().as_str().as_bytes(), &mut json);
        assert!(!saved.on(Setting::RumbleOn));
        assert_eq!(saved.rumble_percent(), 0);
        let on = saved
            .adjust(Setting::RumbleOn, 1, false, &Capabilities::ALL)
            .unwrap();
        assert_eq!(on.rumble_percent(), 50);
        assert_eq!(Setting::RumbleOn.category(), Setting::Rumble.category());
    }

    #[test]
    fn settings_open_from_every_menu_page_and_return_to_it() {
        let mut model = browsing();
        for expected in [Screen::Apps, Screen::AppOptions] {
            if expected == Screen::AppOptions {
                run(&mut model, Op::Minus, 0, 0);
            }
            assert_eq!(model.screen(), expected);
            run(&mut model, Op::X, 0, 0);
            assert_eq!(model.screen(), Screen::Settings);
            run(&mut model, Op::B, 0, 0);
            assert_eq!(model.screen(), expected);
        }
        run(&mut model, Op::B, 0, 0);
        run(&mut model, Op::B, 0, 0);
        assert_eq!(model.screen(), Screen::Hosts);
        run(&mut model, Op::X, 0, 0);
        assert_eq!(model.screen(), Screen::Settings);
    }

    #[test]
    fn x_does_nothing_while_a_row_is_being_edited() {
        let mut model = browsing();
        run(&mut model, Op::Minus, 0, 0);
        run(&mut model, Op::Edit, item::SETTING + Setting::Fps as u32, 0);
        run(&mut model, Op::X, 0, 0);
        assert_eq!(model.screen(), Screen::AppOptions);
    }

    #[test]
    fn button_layout_defaults_to_xbox_and_round_trips() {
        let mut json = crate::json::Json::new();
        let old = Settings::from_json(br#"{"version":8,"touchMouse":true}"#, &mut json);
        assert_eq!(old.button_layout(), ButtonLayout::Xbox);
        let nintendo = old
            .adjust(Setting::ButtonLayout, 1, false, &Capabilities::ALL)
            .unwrap();
        assert_eq!(nintendo.button_layout(), ButtonLayout::Nintendo);
        let options = nintendo.stream_options(false, &Capabilities::ALL);
        assert_eq!(options.button_layout, ButtonLayout::Nintendo);
        let saved = Settings::from_json(nintendo.to_json().as_str().as_bytes(), &mut json);
        assert_eq!(saved.button_layout(), ButtonLayout::Nintendo);
        let xbox = saved
            .adjust(Setting::ButtonLayout, -1, false, &Capabilities::ALL)
            .unwrap();
        assert_eq!(xbox.button_layout(), ButtonLayout::Xbox);
    }

    fn lower_fps(model: &mut Model) -> Step {
        let fps = item::SETTING + Setting::Fps as u32;
        run(model, Op::Minus, 0, 0);
        run(model, Op::Edit, fps, 0);
        let step = run(model, Op::Adjust, fps, -1);
        run(model, Op::Edit, 0, 0);
        step
    }

    #[test]
    fn an_apps_own_choice_changes_its_plan_and_no_other() {
        let mut model = browsing();
        let global = model.planned_stream().fps;
        let step = lower_fps(&mut model);
        assert_eq!(model.screen(), Screen::AppOptions);
        assert!(step.intents().any(|i| i.kind == IntentKind::SaveExtras));
        assert_ne!(model.planned_stream().fps, global);
        assert_eq!(model.settings().fps(), global);
        assert_eq!(model.extras().overrides.len(), 1);

        run(&mut model, Op::B, 0, 0);
        run(&mut model, Op::Focus, item::APP + 1, 0);
        assert_eq!(model.planned_stream().fps, global);
        run(&mut model, Op::Focus, item::APP, 0);
        assert_ne!(model.planned_stream().fps, global);
    }

    #[test]
    fn launching_streams_with_the_apps_choice() {
        let mut model = browsing();
        let global = model.stream_settings().fps();
        lower_fps(&mut model);
        run(&mut model, Op::B, 0, 0);
        run(&mut model, Op::A, item::APP, 0);
        assert_eq!(model.screen(), Screen::Launching);
        assert_ne!(model.stream_settings().fps(), global);
    }

    #[test]
    fn reset_and_stepping_back_drop_the_override() {
        let mut model = browsing();
        lower_fps(&mut model);
        let step = run(&mut model, Op::Y, 0, 0);
        assert!(step.intents().any(|i| i.kind == IntentKind::SaveExtras));
        assert!(model.extras().overrides.is_empty());

        lower_fps(&mut model);
        let fps = item::SETTING + Setting::Fps as u32;
        run(&mut model, Op::Edit, fps, 0);
        run(&mut model, Op::Adjust, fps, 1);
        assert!(model.extras().overrides.is_empty());
    }

    #[test]
    fn saved_extras_come_back_with_the_model() {
        let mut model = browsing();
        lower_fps(&mut model);
        let overrides = model.extras().overrides.to_vec();
        let played = [(Address::of("192.168.1.4"), Name::of("Desktop"))];

        let mut fresh = browsing();
        fresh.load_extras(Extras {
            overrides: &overrides,
            played: &played,
        });
        assert_ne!(fresh.planned_stream().fps, fresh.settings().fps());
        assert_eq!(
            fresh.last_played(&Address::of("192.168.1.4")),
            Some("Desktop")
        );
    }

    #[test]
    fn launching_remembers_the_app_and_asks_for_a_save() {
        let mut model = browsing();
        let step = run(&mut model, Op::A, item::APP, 0);
        let kinds: alloc::vec::Vec<_> = step.intents().map(|i| i.kind).collect();
        assert_eq!(kinds, [IntentKind::Launch, IntentKind::SaveExtras]);
        assert_eq!(model.extras().played.len(), 1);
    }

    #[test]
    fn minus_resumes_the_running_app_unless_the_pc_went_quiet() {
        let mut model = browsing();
        model.current_game = 7;
        model.resume = Some(Resume {
            address: Address::of("192.168.1.4"),
            app: Name::of("Desktop"),
        });
        run(&mut model, Op::B, 0, 0);
        assert_eq!(model.screen(), Screen::Hosts);
        let address = Address::of("192.168.1.4");
        model.set_presence(&address, Presence::Offline);
        assert!(model.resume().is_none());
        run(&mut model, Op::Minus, 0, 0);
        assert_eq!(model.screen(), Screen::Hosts);

        model.set_presence(&address, Presence::Online);
        let step = run(&mut model, Op::Minus, 0, 0);
        assert_eq!(model.screen(), Screen::Connecting);
        assert!(step.intents().any(|i| i.kind == IntentKind::List));
    }
}
