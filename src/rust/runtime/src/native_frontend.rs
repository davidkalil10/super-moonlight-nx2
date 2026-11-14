//! Runs the native Switch frontend and its device services.

extern crate alloc;

use crate::{
    device::log,
    display::{FrameRates, Probe, WindowMode},
    files::Directory,
    frontend::{Connections, Frontend, MediaRequest},
    frontend_stream::{Control, Stream},
    hid::{InputGate, Sampler},
    net::NetSocket,
    render::{Config, Renderer},
    sdk,
};
use alloc::{boxed::Box, format};
use moonlight_nx2_app::{dock::Monitor, input::ExitPress, policy::DisplayCapabilities};
use moonlight_nx2_core::codec::Capabilities;
use moonlight_nx2_ui::{
    json::Json,
    model::{Event, Screen},
    store::{Source, Store},
};

unsafe extern "C" {
    fn moonlightPlatformNetStart() -> bool;
    fn moonlightPlatformRandom(out: *mut u8, bytes: usize);
    fn moonlightPlatformNetStop();
    fn moonlightPlatformNetReport() -> *const core::ffi::c_char;
    fn moonlightPlatformUdpReceiveLimit() -> u32;
    fn moonlightPlatformStackAvailable() -> u64;
}

struct NativeConnections {
    network: bool,
}

fn start_network() -> bool {
    let started = unsafe { moonlightPlatformNetStart() };
    let tried = unsafe { core::ffi::CStr::from_ptr(moonlightPlatformNetReport()) };
    log(&alloc::format!(
        "net: socket service started={started} udp limit={} (tried {})",
        unsafe { moonlightPlatformUdpReceiveLimit() },
        tried.to_str().unwrap_or("?")
    ));
    started
}

impl Connections for NativeConnections {
    type Socket = NetSocket;
    fn connect(
        &mut self,
        address: [u8; 4],
        port: u16,
    ) -> Result<NetSocket, moonlight_nx2_io::socket::IoError> {
        if !self.network {
            self.network = start_network();
            if !self.network {
                return Err(moonlight_nx2_io::socket::IoError::Failed);
            }
        }
        NetSocket::connect(address, port)
    }
    fn wake(&mut self, mac: [u8; 6], address: Option<[u8; 4]>) {
        if !self.network {
            self.network = start_network();
        }
        let subnet = crate::system::subnet();
        let directed = subnet.map(|(console, mask)| {
            moonlight_nx2_ui::presence::directed_broadcast(console, Some(mask))
        });
        let mut targets = alloc::vec![[255; 4]];
        for target in [directed, address].into_iter().flatten() {
            if !targets.contains(&target) {
                targets.push(target);
            }
        }
        let report = if self.network {
            crate::net::DiscoverySocket::wake(mac, &targets)
        } else {
            Err(moonlight_nx2_io::socket::IoError::Failed)
        };
        log(&format!(
            "wake: mac={} targets={targets:?} netmask={:?} result={report:?}",
            moonlight_nx2_ui::model::Mac(mac).text().as_str(),
            subnet.map(|subnet| subnet.1)
        ));
    }
    fn discovery(
        &mut self,
    ) -> Result<Box<dyn moonlight_nx2_io::udp::Datagram>, moonlight_nx2_io::socket::IoError> {
        if !self.network {
            self.network = start_network();
            if !self.network {
                return Err(moonlight_nx2_io::socket::IoError::Failed);
            }
        }
        Ok(Box::new(crate::net::DiscoverySocket::open()?))
    }
    fn dialer(&mut self) -> Option<crate::upstream::Dialer<NetSocket>> {
        if !self.network {
            self.network = start_network();
        }
        self.network
            .then(|| Box::new(NativeDial) as crate::upstream::Dialer<NetSocket>)
    }
}

/// Reaches Sunshine once the network is up; `NativeConnections::dialer` starts it.
struct NativeDial;

const DEVICE_NAME: &str = "Nintendo Switch 2";

fn platform_random(bytes: &mut [u8]) -> bool {
    unsafe { moonlightPlatformRandom(bytes.as_mut_ptr(), bytes.len()) };
    true
}

impl moonlight_nx2_app::direct::Dial for NativeDial {
    type Socket = NetSocket;

    fn dial(
        &mut self,
        address: [u8; 4],
        port: u16,
    ) -> Result<NetSocket, moonlight_nx2_io::socket::IoError> {
        NetSocket::connect(address, port)
    }

    fn random(&self) -> moonlight_nx2_app::sunshine::random::Random {
        moonlight_nx2_app::sunshine::random::Random(platform_random)
    }

    fn device_name(&self) -> alloc::string::String {
        crate::system::nickname().unwrap_or_else(|| alloc::string::String::from(DEVICE_NAME))
    }

    fn log(&mut self, line: &str) {
        crate::render_platform::log(line);
    }

    fn now_ms(&self) -> u64 {
        (unsafe { sdk::moonlightNowNs() }) / 1_000_000
    }

    fn datagram(
        &mut self,
        address: [u8; 4],
        port: u16,
    ) -> Result<Box<dyn moonlight_nx2_io::udp::Datagram>, moonlight_nx2_io::socket::IoError> {
        Ok(Box::new(crate::net::UdpSocket::connect(address, port)?))
    }
}

impl Drop for NativeConnections {
    fn drop(&mut self) {
        if self.network && !sdk::process_retired() {
            unsafe { moonlightPlatformNetStop() };
        }
    }
}

pub fn run() -> bool {
    let stack = unsafe { moonlightPlatformStackAvailable() };
    log(&format!(
        "frontend: stack available={stack} required=786432"
    ));
    if stack < 786_432 {
        return false;
    }
    let start = unsafe { sdk::moonlightNowNs() };
    let directory = c"sdmc:/switch/moonlight-nx2/rust-client";
    let Some(files) = Directory::open(directory) else {
        log("frontend: cannot open the app directory on the SD card");
        return false;
    };
    log(&format!(
        "frontend: namespace {}",
        directory.to_str().unwrap()
    ));
    let mut connections = NativeConnections { network: false };
    let mut renderer = match Renderer::open(render_config()) {
        Ok(renderer) => renderer,
        Err(error) => {
            log(&format!("frontend: renderer open failed {error:?}"));
            return false;
        }
    };
    #[cfg(feature = "diagnostic-sdk-decode")]
    crate::ref_replay::run(&mut renderer);
    let verified = stream_capabilities().supports(
        moonlight_nx2_core::codec::Codec::H264,
        moonlight_nx2_core::codec::Depth::Eight,
        moonlight_nx2_core::codec::Size::new(1920, 1080).unwrap(),
        60,
    );
    log(&format!("frontend: native decoder verified={verified}"));
    if sdk::process_retired() {
        return false;
    }
    let result = execute(&mut renderer, &mut connections, files, start);
    let closed = renderer.close();
    log(&format!("frontend: renderer close {closed:?}"));
    result && closed.is_ok()
}

fn execute(
    renderer: &mut Renderer,
    connections: &mut NativeConnections,
    files: Directory,
    start: u64,
) -> bool {
    const ATLAS: &[u8] = include_bytes!("../../ui/fonts/glyphs.bin");
    let mut snapshot = renderer.display().ok();
    let docked = snapshot.is_some_and(|display| display.operation_mode == 1);
    let mut app =
        match renderer.storage_mut().ok().and_then(|bytes| {
            Frontend::<_, NetSocket>::new(bytes, ATLAS, files.clone(), docked).ok()
        }) {
            Some(app) => app,
            None => {
                log("frontend: UI or local files unavailable");
                return false;
            }
        };
    if let Some(cache) = crate::files::CoverDirectory::open(c"sdmc:/switch/moonlight-nx2/covers") {
        app.set_cover_cache(cache);
    }
    let original = *app.client.bridge.model().settings();
    let mut sampler = match Sampler::open() {
        Ok(sampler) => sampler,
        Err(_) => return false,
    };
    let (mut last_screen, mut failed, mut blocked_start) = (None, false, false);
    let mut input_gate = InputGate::default();
    let mut exit_press = ExitPress::default();
    let mut dock = Monitor::new(docked);
    let mut probe = Probe::new(docked, unsafe { sdk::moonlightNowNs() }, 0);
    let (mut polled, mut last_mode, mut pending) = (start, None, false);
    let mut dock_deadline = None;
    display_context(&mut app, docked, probe.capabilities());
    let mut stream = Stream::new(stream_capabilities());
    let mut system = crate::system::System::start(unsafe { sdk::moonlightNowNs() } / 1_000_000);
    let mut second = start;
    let (mut publishes, mut busy_publishes) = ([0u32; 2], [0u32; 2]);
    let mut turns = Turns::default();
    while unsafe { sdk::appletMainLoop() } && !app.exiting() && !sdk::process_retired() {
        let now = unsafe { sdk::moonlightNowNs() };
        turns.begin(now);
        let input = match sampler
            .read(renderer, app.screen() != Screen::Streaming)
            .and_then(|_| input_gate.filter(renderer.input_mut()?))
        {
            Ok(input) => input,
            Err(_) => {
                failed = true;
                break;
            }
        };
        #[cfg(feature = "ui-pattern")]
        {
            if input_gate.take_pattern_edge() {
                app.client.cycle_pattern();
            }
            if input_gate.take_filter_edge()
                && let Ok(bytes) = renderer.storage_mut()
            {
                app.client.cycle_filter(bytes);
            }
        }
        if renderer
            .storage_mut()
            .ok()
            .and_then(|bytes| app.client.menu_input(&input, now / 1_000_000, bytes).ok())
            .is_none()
        {
            failed = true;
            break;
        }
        if exit_press.update(input.raw_buttons, app.screen()) {
            app.client.event(&Event::AppGone);
        }
        turns.lap(Phase::Input);
        let used = app.client.bridge.model().stream_settings();
        crate::hid::pointer::set_joycon_mouse(
            if app.screen() == Screen::Streaming {
                used.joycon_mouse()
            } else {
                moonlight_nx2_ui::settings::MouseSide::Off
            },
            used.mouse_sensitivity(),
        );
        let frame = match renderer
            .storage_mut()
            .ok()
            .and_then(|bytes| app.frame(bytes, connections, now / 1_000_000).ok())
        {
            Some(frame) => frame,
            None => {
                failed = true;
                break;
            }
        };
        if frame.published {
            let _ = renderer.flush_page(app.client.bridge.shown_page());
            let slot = app.client.bridge.shown_slot();
            publishes[slot] += 1;
            busy_publishes[slot] += u32::from(renderer.last_write_busy());
            log(&format!(
                "ui: publish slot={slot} gpu_busy_at_write={} slot0={}/{} slot1={}/{}",
                renderer.last_write_busy(),
                busy_publishes[0],
                publishes[0],
                busy_publishes[1],
                publishes[1]
            ));
        }
        turns.lap(Phase::Frame);
        let now_ms = now / 1_000_000;
        for request in app.take_media() {
            match request {
                MediaRequest::Open => match app.direct_media() {
                    Some((negotiated, outbox)) => {
                        let control = Control(outbox);
                        stream.open_direct(&mut app.client, &negotiated, control, now_ms);
                    }
                    None => stream.refuse(&mut app.client),
                },
                MediaRequest::Close => stream.begin_close(&mut app.client, now_ms),
            }
        }
        stream.pump(&mut app.client, renderer, now_ms);
        let compute = app.client.needs_ui_compute(&input, &frame);
        let presented = stream.step(&mut app.client, renderer, &input, now_ms, compute);
        let clocked = stream
            .clock_inputs()
            .map(|((width, height, fps), signals)| crate::clocks::Streaming {
                mode: moonlight_nx2_app::clocks::Mode {
                    width,
                    height,
                    fps,
                    docked: dock.current(),
                },
                signals,
            });
        system.tick(&mut app, renderer, clocked, now_ms);
        app.client
            .update_native_stats(crate::stream_stats::latest());
        turns.lap(Phase::Stream);
        if !system.in_focus() {
            unsafe { sdk::svcSleepThread(16_000_000) };
        } else if !presented {
            match renderer.present(compute) {
                Ok(()) => turns.ui_presents += 1,
                Err(crate::render::Error::Busy) => {}
                Err(_) => {
                    failed = true;
                    break;
                }
            }
        }
        turns.lap(Phase::Present);
        let screen = app.screen();
        if now.saturating_sub(polled) >= 250_000_000 {
            polled = now;
            if let Ok(display) = renderer.display() {
                snapshot = Some(display);
                crate::stream_stats::set_refresh_hz(display.nominal_hz);
                crate::stream_stats::set_vrr(display.vrr && display.operation_mode == 0);
                if let Some(docked) = dock.sample(display.operation_mode(), now_ms) {
                    log(&format!("display: dock change docked={docked}"));
                    probe.set_docked(docked);
                    let settings = app.client.bridge.model().stream_settings();
                    let size = settings.size();
                    let faster = moonlight_nx2_app::dock::requests_120hz(
                        docked,
                        (!settings.size_auto()).then(|| (size.width(), size.height())),
                        settings.fps(),
                        probe.output(),
                    ) && probe.verified_fps() < 120;
                    if faster {
                        log("display: context waits for 120 Hz to be shown");
                        dock_deadline = Some(now.saturating_add(DOCK_VERIFY_NS));
                    } else {
                        dock_deadline = None;
                        display_context(&mut app, docked, probe.capabilities());
                    }
                    pending = false;
                }
                let output = probe.output();
                pending |= probe.observe_output(now, display.width, display.height);
                if probe.output() != output {
                    log(&format!(
                        "display: console output {}x{}@{} docked=true; Auto up to {:?}",
                        display.width,
                        display.height,
                        display.nominal_hz,
                        moonlight_nx2_app::dock::output_ceiling(probe.output())
                    ));
                }
            }
            let settings = app.client.bridge.model().stream_settings();
            let size = settings.size();
            let wanted = moonlight_nx2_app::dock::requests_120hz(
                dock.current(),
                (!settings.size_auto()).then(|| (size.width(), size.height())),
                settings.fps(),
                probe.output(),
            );
            if wanted != probe.requested()
                && renderer
                    .set_frame_rates(wanted.then_some(FrameRates::EVERY_REFRESH))
                    .is_ok()
            {
                pending |= probe.set_requested(wanted);
            }
        }
        turns.lap(Phase::Display);
        if let Ok(info) = renderer.info()
            && let Some(rate) = probe.second(now, info.presented)
        {
            let hz = snapshot.map_or(0, |display| display.nominal_hz);
            if probe.cap_at_60(hz) {
                log(&format!(
                    "display: 120 Hz lost docked={}; modes capped at 60",
                    dock.current()
                ));
                dock_deadline = None;
                display_context(&mut app, dock.current(), probe.capabilities());
                pending = false;
            }
            let every_refresh = snapshot.is_some_and(|display| {
                (display.interval_numerator, display.interval_denominator) == (1, 120)
            });
            pending |= probe.verify(info.width, info.height, hz, every_refresh);
            let waited = dock_deadline.is_some_and(|deadline| pending || now >= deadline);
            if waited || (pending && screen != Screen::Streaming && dock_deadline.is_none()) {
                if waited {
                    log(&format!(
                        "display: context after dock change at {} fps",
                        probe.verified_fps()
                    ));
                }
                dock_deadline = None;
                display_context(&mut app, dock.current(), probe.capabilities());
                pending = false;
            }
            let shown = snapshot.map(|display| {
                (
                    display.width,
                    display.height,
                    display.resolution_level,
                    display.interval_denominator,
                )
            });
            let mode = (info.width, info.height, hz, dock.current(), shown);
            if last_mode != Some(mode)
                && let Some(display) = snapshot
            {
                log(&format!(
                    "display: mode {}x{}@{hz} docked={} window={}x{} vrr={} interval={}/{} level={} caps=0x{:x}",
                    info.width,
                    info.height,
                    dock.current(),
                    display.width,
                    display.height,
                    display.vrr,
                    display.interval_numerator,
                    display.interval_denominator,
                    display.resolution_level,
                    display.capabilities.refresh_rates
                ));
                last_mode = Some(mode);
            }
            let (ui, longest_ms, phase) = turns.take();
            log(&format!(
                "display: presents={rate}/s {}x{}@{hz} docked={} ui={ui} longest_ms={longest_ms} in={} log_write_ms={}",
                info.width,
                info.height,
                dock.current(),
                phase.name(),
                crate::device::log_longest_write_us() / 1000
            ));
        }
        if last_screen != Some(screen) {
            log(&format!("frontend: screen {}", screen.name()));
            last_screen = Some(screen);
        }
        blocked_start |=
            app.client.bridge.model().message() == Some("This console cannot play a stream yet");
        if now.saturating_sub(second) >= 1_000_000_000 {
            log(&format!(
                "frontend: frames={} media_opened={}",
                app.stats().frames,
                app.stats().media_opened
            ));
            stream.report();
            if let Some((counters, waiting)) = app.take_input_counters() {
                log(&format!(
                    "input: direct records={} rejected={} pad_changes={} pads={:#x} touches={} as_mouse={} mouse_moves={} mouse_sensitivity={}.{:02} sent={} waiting={waiting} send_errors={}",
                    counters.records,
                    counters.rejected,
                    counters.pad_changes,
                    counters.pads,
                    counters.touches,
                    counters.mouse_touches,
                    counters.mouse_moves,
                    crate::hid::pointer::sensitivity() / 100,
                    crate::hid::pointer::sensitivity() % 100,
                    counters.sent,
                    counters.send_errors
                ));
            }
            second = now;
        }
        turns.lap(Phase::Other);
        turns.end();
    }
    stream.close(&mut app.client, renderer);
    crate::hid::pointer::stop();
    system.stop();
    let changed = *app.client.bridge.model().settings() != original;
    let final_settings = *app.client.bridge.model().settings();
    let closed = app.close(renderer);
    let stats = app.stats();
    let (source, saved) = Store::new(files).load(&mut Box::new(Json::new()));
    let persisted = source == Source::Loaded && saved == final_settings;
    log(&format!(
        "frontend: summary {stats:?} settings_changed={changed} settings_persisted={persisted} local_start_blocked={blocked_start} close={closed}"
    ));
    !failed && closed && stats.frames > 0
}

#[derive(Clone, Copy, Default)]
enum Phase {
    #[default]
    Input,
    Frame,
    Stream,
    Present,
    Display,
    Other,
}

impl Phase {
    const ALL: [Phase; 6] = [
        Phase::Input,
        Phase::Frame,
        Phase::Stream,
        Phase::Present,
        Phase::Display,
        Phase::Other,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Input => "input",
            Self::Frame => "frame",
            Self::Stream => "stream",
            Self::Present => "present",
            Self::Display => "display",
            Self::Other => "other",
        }
    }
}

/// The longest frame loop turn since the last report, the phase that took most of it, and the
/// presents the loop made itself rather than the stream. A stream's own present and its wait
/// for the refresh count in `Stream`, a UI screen's in `Present`.
#[derive(Default)]
struct Turns {
    start: u64,
    mark: u64,
    phases: [u64; 6],
    longest: (u64, Phase),
    ui_presents: u32,
}

impl Turns {
    fn begin(&mut self, now: u64) {
        self.start = now;
        self.mark = now;
        self.phases = [0; 6];
    }

    fn lap(&mut self, phase: Phase) {
        let now = unsafe { sdk::moonlightNowNs() };
        self.phases[phase as usize] += now.saturating_sub(self.mark);
        self.mark = now;
    }

    fn end(&mut self) {
        let total = self.mark.saturating_sub(self.start);
        if total > self.longest.0 {
            let slowest = Phase::ALL
                .into_iter()
                .max_by_key(|phase| self.phases[*phase as usize])
                .unwrap_or_default();
            self.longest = (total, slowest);
        }
    }

    fn take(&mut self) -> (u32, u64, Phase) {
        let report = (self.ui_presents, self.longest.0 / 1_000_000, self.longest.1);
        self.longest = (0, Phase::default());
        self.ui_presents = 0;
        report
    }
}

/// Docked, the window takes the size the console outputs (0x0), and follows it: a TV that goes
/// to 120 Hz may do so at a smaller size than its 60 Hz mode, and a layer left at 4K is then
/// shown unscaled. The window opens without a 120 Hz or VRR request, so the console picks its
/// own output mode; the frontend asks for 120 Hz only where `dock::requests_120hz` says so.
fn render_config() -> Config {
    Config {
        window_mode: WindowMode::PerMode {
            docked_width: 0,
            docked_height: 0,
        },
        ..Config::default()
    }
}

/// How long a dock change waits for the new display to show 120 Hz before its context is
/// handed over at 60, so a stream restarts once and at the rate the display takes.
const DOCK_VERIFY_NS: u64 = 3_000_000_000;

/// Hands the operation mode and the display modes verified for it to the client; a live stream
/// restarts in the new context.
fn display_context(
    app: &mut Frontend<Directory, NetSocket>,
    docked: bool,
    display: DisplayCapabilities,
) {
    let accepted = app.context_changed(moonlight_nx2_app::policy::Context {
        docked,
        decoder: stream_capabilities(),
        display,
    });
    log(&format!(
        "display: context docked={docked} accepted={accepted}; native decoder capability is runtime gated"
    ));
}

fn stream_capabilities() -> Capabilities {
    crate::frontend_stream::decoder_capabilities()
}
