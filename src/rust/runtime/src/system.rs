//! Applet focus, sleep and idle handling, and the battery, temperature and Wi-Fi readings.
//! C side: src/rust/nro/system.c. None of these SDK calls is proven inside the hijacked title,
//! so each one's first result is logged and a failure only leaves its feature out.

extern crate alloc;

use crate::{device::log, files::Directory, frontend::Frontend, net::NetSocket, render::Renderer};
use alloc::format;
use moonlight_nx2_app::{
    suspend::{self, Command, Snapshot, Suspend},
    system_status::{self, LowBattery, Network, Reading},
};
use moonlight_nx2_ui::model::{Event, Op, Screen, item};

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
    suspend: Suspend,
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
    reading: Reading,
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
            low_battery: LowBattery::default(),
            focus_reported: focus == FOCUS_IN,
            in_focus: true,
            awake_kept: false,
            last_tick_ms: now_ms,
            next_read_ms: now_ms,
            battery: Source::default(),
            temperature: Source::default(),
            network: Source::default(),
            reading: Reading::default(),
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
        let woke = resumed || stalled_ms >= STALL_MS;
        if woke {
            log(&format!(
                "system: woke resume_message={resumed} stalled_ms={stalled_ms}"
            ));
        }
        self.pause_or_resume(app, in_focus, woke, now_ms);
        self.keep_awake(suspend::keeps_awake(app.screen()) && in_focus);
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
            Command::Ended(reason) => {
                log(&format!("system: stream not resumed: {reason}"));
                app.notice(reason);
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

    pub fn stop(&mut self) {
        self.keep_awake(false);
        unsafe { moonlightSystemStop() };
    }
}
