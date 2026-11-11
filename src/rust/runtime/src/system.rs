//! Applet focus, sleep and idle handling, and the battery, temperature and Wi-Fi readings.
//! C side: src/rust/nro/system.c. None of these SDK calls is proven inside the hijacked title,
//! so each one's first result is logged and a failure only leaves its feature out.

extern crate alloc;

use crate::{device::log, files::Directory, frontend::Frontend, net::NetSocket, render::Renderer};
use alloc::format;
use moonlight_nx2_app::{
    reconnect::{self, Reconnect},
    suspend::{self, Command, Snapshot, Suspend},
    system_status::{self, LowBattery, Network, Reading},
};
use moonlight_nx2_ui::model::{Event, Op, Screen, item};
use moonlight_nx2_ui::readout::{self as ui_readout, Readout};

unsafe extern "C" {
    fn moonlightSystemAppletType() -> u32;
    fn moonlightSystemWatchResume() -> u32;
    fn moonlightSystemKeepRunning() -> u32;
    fn moonlightSystemFocusState() -> u32;
    fn moonlightSystemTakeResumed() -> bool;
    fn moonlightSystemMediaPlayback(playing: bool) -> u32;
    fn moonlightSystemAutoSleepDisabled(disabled: bool) -> u32;
    fn moonlightSystemBattery(percent: *mut u32, charger: *mut u32) -> u32;
    fn moonlightSystemTemperature(celsius: *mut i32) -> u32;
    fn moonlightSystemNetwork(kind: *mut u32, bars: *mut u32, status: *mut u32) -> u32;
    fn moonlightSystemSubnet(address: *mut [u8; 4], mask: *mut [u8; 4]) -> u32;
    fn moonlightSystemClock(hour: *mut u32, minute: *mut u32) -> u32;
    fn moonlightSystemColorSet(dark: *mut u32) -> u32;
    fn moonlightSystemNickname(out: *mut u8, bytes: usize) -> u32;
    fn moonlightSystemStop();
}

const APPLET_APPLICATION: u32 = 0;
const APPLET_SYSTEM_APPLICATION: u32 = 4;
const FOCUS_IN: u32 = 1;
const CHARGER_UNCONNECTED: u32 = 0;
const CONNECTION_WIFI: u32 = 1;
const CONNECTION_ETHERNET: u32 = 2;
const CONNECTED: u32 = 4;
const READ_MS: u64 = 2_000;
/// The main loop standing still this long means the process was suspended or the console slept.
const STALL_MS: u64 = 5_000;
/// Out of focus the process keeps running so the stream stops cleanly at once. Off, the system
/// suspends it as before and the stream is stopped and resumed after the return instead.
const KEEP_RUNNING: bool = true;
/// Reads that fail this many times in a row are given up.
const READ_ATTEMPTS: u8 = 3;

/// The console's address and netmask, for the Wake-on-LAN broadcast.
pub fn subnet() -> Option<([u8; 4], [u8; 4])> {
    let (mut address, mut mask) = ([0; 4], [0; 4]);
    let result = unsafe { moonlightSystemSubnet(&mut address, &mut mask) };
    (result == 0).then_some((address, mask))
}

/// The console's name from System Settings; none when it cannot be read or is empty.
pub fn nickname() -> Option<alloc::string::String> {
    let mut name = [0u8; 0x81];
    let result = unsafe { moonlightSystemNickname(name.as_mut_ptr(), name.len()) };
    let length = name.iter().position(|&byte| byte == 0)?;
    let name = core::str::from_utf8(&name[..length]).ok()?.trim();
    (result == 0 && !name.is_empty()).then(|| alloc::string::String::from(name))
}

/// One reading that is dropped after repeated failures and logs its first result.
#[derive(Default)]
struct Source {
    failures: u8,
    logged: bool,
}

impl Source {
    fn active(&self) -> bool {
        self.failures < READ_ATTEMPTS
    }

    fn record(&mut self, name: &str, result: u32, value: &dyn core::fmt::Debug) -> bool {
        if result == 0 {
            self.failures = 0;
        } else {
            self.failures += 1;
        }
        if !self.logged || (result != 0 && !self.active()) {
            self.logged = true;
            let dropped = if self.active() { "" } else { "; left out" };
            log(&format!(
                "system: {name} result=0x{result:x} value={value:?}{dropped}"
            ));
        }
        result == 0
    }
}

pub struct System {
    clocks: crate::clocks::Clocks,
    suspend: Suspend,
    reconnect: Reconnect,
    low_battery: LowBattery,
    /// The app was seen in focus once, so a later change means something.
    focus_reported: bool,
    in_focus: bool,
    awake_kept: bool,
    last_tick_ms: u64,
    next_read_ms: u64,
    battery: Source,
    temperature: Source,
    network: Source,
    clock: Source,
    color_set: Source,
    reading: Reading,
    clock_reading: Option<(u8, u8)>,
}

impl System {
    pub fn start(now_ms: u64) -> Self {
        let applet = unsafe { moonlightSystemAppletType() };
        let resume = unsafe { moonlightSystemWatchResume() };
        let application = matches!(applet, APPLET_APPLICATION | APPLET_SYSTEM_APPLICATION);
        log(&format!(
            "system: applet type={applet} application={application} resume message result=0x{resume:x}"
        ));
        if application && KEEP_RUNNING {
            let result = unsafe { moonlightSystemKeepRunning() };
            log(&format!(
                "system: keep running out of focus result=0x{result:x}"
            ));
        } else {
            log("system: focus mode left alone; a stall of the main loop stands in for focus loss");
        }
        let focus = unsafe { moonlightSystemFocusState() };
        log(&format!(
            "system: focus state={focus} at start; changes count once it has been {FOCUS_IN}"
        ));
        Self {
            suspend: Suspend::default(),
            reconnect: Reconnect::default(),
            low_battery: LowBattery::default(),
            focus_reported: focus == FOCUS_IN,
            in_focus: true,
            awake_kept: false,
            last_tick_ms: now_ms,
            next_read_ms: now_ms,
            battery: Source::default(),
            temperature: Source::default(),
            network: Source::default(),
            clock: Source::default(),
            color_set: Source::default(),
            reading: Reading::default(),
            clock_reading: None,
            clocks: crate::clocks::Clocks::default(),
        }
    }

    /// Nothing is presented while the HOME menu or another applet covers the app.
    pub fn in_focus(&self) -> bool {
        self.in_focus
    }

    pub fn tick(
        &mut self,
        app: &mut Frontend<Directory, NetSocket>,
        renderer: &mut Renderer,
        now_ms: u64,
    ) {
        let stalled_ms = now_ms.saturating_sub(self.last_tick_ms);
        self.last_tick_ms = now_ms;
        let resumed = unsafe { moonlightSystemTakeResumed() };
        let focus = unsafe { moonlightSystemFocusState() };
        self.focus_reported |= focus == FOCUS_IN;
        let in_focus = !self.focus_reported || focus == FOCUS_IN;
        if in_focus != self.in_focus {
            self.in_focus = in_focus;
            log(&format!("system: focus state={focus} in_focus={in_focus}"));
        }
        let covered = app.keyboard_covers(now_ms);
        let in_focus = in_focus || covered;
        let woke = (resumed && !covered) || stalled_ms >= STALL_MS;
        if woke {
            log(&format!(
                "system: woke resume_message={resumed} stalled_ms={stalled_ms}"
            ));
        }
        self.pause_or_resume(app, in_focus, woke, now_ms);
        self.reconnect(app, in_focus, now_ms);
        self.keep_awake(suspend::keeps_awake(app.screen()) && in_focus);
        self.clocks.tick(app.screen() == Screen::Streaming, now_ms);
        if now_ms >= self.next_read_ms {
            self.next_read_ms = now_ms.saturating_add(READ_MS);
            self.read(app, renderer, now_ms);
        }
    }

    fn pause_or_resume(
        &mut self,
        app: &mut Frontend<Directory, NetSocket>,
        in_focus: bool,
        woke: bool,
        now_ms: u64,
    ) {
        let model = app.client.bridge.model();
        let screen = model.screen();
        let snapshot = Snapshot {
            in_focus,
            woke,
            screen,
            playing: model.app().map(|playing| playing.id),
            apps_ready: screen == Screen::Apps && app.client.driver.service().idle(),
            running: model.current_game(),
            link_up: app.link_up(),
            paired: app.paired_host(),
            now_ms,
        };
        match self.suspend.tick(snapshot) {
            Command::None => {}
            Command::Pause => {
                log(&format!(
                    "system: pausing the stream in_focus={in_focus} woke={woke}"
                ));
                app.client.stop_stream();
            }
            Command::Resume(id) => {
                let index = app
                    .client
                    .bridge
                    .model()
                    .apps()
                    .iter()
                    .position(|listed| listed.id == id);
                log(&format!("system: resuming app {id} listed={index:?}"));
                match index {
                    Some(index) => app.client.event(&Event::Command {
                        op: Op::A,
                        item: item::APP + index as u32,
                        value: 0,
                    }),
                    None => app.notice(suspend::ENDED_APP),
                }
            }
            Command::Reconnect => {
                log("system: the PC connection is gone; reconnecting to resume");
                self.reconnect.start(now_ms, true);
            }
            Command::Ended(reason) => {
                log(&format!("system: stream not resumed: {reason}"));
                app.notice(reason);
            }
        }
    }

    /// Opens a paired PC again after its connection was cut off.
    fn reconnect(&mut self, app: &mut Frontend<Directory, NetSocket>, in_focus: bool, now_ms: u64) {
        let was_active = self.reconnect.active();
        let command = self.reconnect.tick(reconnect::Snapshot {
            screen: app.screen(),
            link_up: app.link_up(),
            paired: app.paired_host(),
            in_focus,
            now_ms,
        });
        if self.reconnect.active() && !was_active {
            log("system: connection lost; reconnecting");
            app.notice(reconnect::RECONNECTING);
        }
        match command {
            reconnect::Command::None => {}
            reconnect::Command::Reopen { resume } => {
                log(&format!("system: reopening the PC resume={resume}"));
                app.client.event(&Event::Reopen { resume });
            }
            reconnect::Command::GaveUp => {
                log("system: the PC did not come back");
                app.notice(reconnect::GAVE_UP);
            }
        }
    }

    /// Keeps the screen lit and the console awake while a stream plays.
    fn keep_awake(&mut self, wanted: bool) {
        if wanted == self.awake_kept {
            return;
        }
        self.awake_kept = wanted;
        let playback = unsafe { moonlightSystemMediaPlayback(wanted) };
        let auto_sleep = unsafe { moonlightSystemAutoSleepDisabled(wanted) };
        log(&format!(
            "system: keep awake={wanted} media playback result=0x{playback:x} auto sleep result=0x{auto_sleep:x}"
        ));
    }

    fn read(
        &mut self,
        app: &mut Frontend<Directory, NetSocket>,
        renderer: &mut Renderer,
        now_ms: u64,
    ) {
        if self.battery.active() {
            let (mut percent, mut charger) = (0, 0);
            let result = unsafe { moonlightSystemBattery(&mut percent, &mut charger) };
            let read = self.battery.record("battery", result, &(percent, charger));
            self.reading.battery_percent = read.then_some(percent);
            self.reading.charging = read.then_some(charger != CHARGER_UNCONNECTED);
        }
        if self.temperature.active() {
            let mut celsius = 0;
            let result = unsafe { moonlightSystemTemperature(&mut celsius) };
            let read = self.temperature.record("temperature", result, &celsius);
            self.reading.temperature_c = read.then_some(celsius);
        }
        if self.network.active() {
            let (mut kind, mut bars, mut status) = (0, 0, 0);
            let result = unsafe { moonlightSystemNetwork(&mut kind, &mut bars, &mut status) };
            let read = self
                .network
                .record("network", result, &(kind, bars, status));
            self.reading.network = match kind {
                CONNECTION_WIFI if read && status == CONNECTED => Some(Network::Wifi(bars)),
                CONNECTION_ETHERNET if read && status == CONNECTED => Some(Network::Wired),
                _ => None,
            };
        }
        if self.clock.active() {
            let (mut hour, mut minute) = (0, 0);
            let result = unsafe { moonlightSystemClock(&mut hour, &mut minute) };
            let read = self.clock.record("clock", result, &(hour, minute));
            self.clock_reading = read.then_some((hour as u8, minute as u8));
        }
        if self.color_set.active() {
            let mut dark = 0;
            let result = unsafe { moonlightSystemColorSet(&mut dark) };
            let read = self
                .color_set
                .record("color set (1 is dark)", result, &dark);
            app.client.set_console_dark(read.then_some(dark != 0));
        }
        app.client.set_readout(self.readout());
        app.client
            .set_system_status(system_status::line(&self.reading).as_str());
        let streaming = app.screen() == Screen::Streaming;
        if let Some(warning) = self.low_battery.check(&self.reading, streaming) {
            let shown = renderer.storage_mut().ok().and_then(|bytes| {
                app.client
                    .toast(bytes, warning.as_str(), now_ms * 1_000_000)
                    .ok()
            });
            log(&format!(
                "system: low battery toast \"{}\" shown={shown:?}",
                warning.as_str()
            ));
        }
    }

    fn readout(&self) -> Readout {
        Readout {
            battery_percent: self.reading.battery_percent,
            charging: self.reading.charging == Some(true),
            network: self.reading.network.map(|network| match network {
                Network::Wifi(bars) => ui_readout::Network::Wifi(bars),
                Network::Wired => ui_readout::Network::Wired,
            }),
            clock: self.clock_reading,
        }
    }

    pub fn stop(&mut self) {
        self.keep_awake(false);
        unsafe { moonlightSystemStop() };
    }
}
