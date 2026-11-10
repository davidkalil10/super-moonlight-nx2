//! Runs the native Switch frontend and its device services.

extern crate alloc;

use crate::{
    client_session::Session,
    control_link::Access,
    device::log,
    display::{FrameRates, Probe, WindowMode},
    files::Directory,
    frontend::{AuthError, Connections, Frontend, MediaRequest},
    frontend_stream::Stream,
    hid::{InputGate, Sampler},
    net::NetSocket,
    render::{Config, Renderer},
    sdk,
};
use alloc::{boxed::Box, format};
use core::ffi::{CStr, c_char};
use moonlight_nx2_app::{dock::Monitor, policy::DisplayCapabilities};
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
    fn moonlightPlatformStackAvailable() -> u64;
    fn moonlightIoTakeSession(
        path: *const c_char,
        data: *mut u8,
        capacity: usize,
        bytes: *mut usize,
    ) -> u32;
}

struct Secret([u8; 512]);
impl Drop for Secret {
    fn drop(&mut self) {
        for byte in &mut self.0 {
            unsafe { core::ptr::write_volatile(byte, 0) };
        }
    }
}

struct NativeConnections {
    session_path: &'static CStr,
    blocked: bool,
    network: bool,
}

impl Connections for NativeConnections {
    type Socket = NetSocket;
    fn authorization(&mut self) -> Result<Session, AuthError> {
        if self.blocked {
            return Err(AuthError::Uncertain);
        }
        let mut secret = Secret([0; 512]);
        let mut bytes = 0;
        let status = unsafe {
            moonlightIoTakeSession(
                self.session_path.as_ptr(),
                secret.0.as_mut_ptr(),
                secret.0.len(),
                &mut bytes,
            )
        };
        match status {
            0 if bytes < secret.0.len() => {
                Session::parse(&secret.0[..bytes]).ok_or(AuthError::Invalid)
            }
            1 => Err(AuthError::Missing),
            2 => Err(AuthError::Invalid),
            _ => {
                self.blocked = true;
                Err(AuthError::Uncertain)
            }
        }
    }
    fn connect(
        &mut self,
        address: [u8; 4],
        port: u16,
    ) -> Result<NetSocket, moonlight_nx2_io::socket::IoError> {
        if !self.network {
            self.network = unsafe { moonlightPlatformNetStart() };
            if !self.network {
                return Err(moonlight_nx2_io::socket::IoError::Failed);
            }
        }
        NetSocket::connect(address, port)
    }
    fn random(&mut self, bytes: &mut [u8]) -> bool {
        unsafe { moonlightPlatformRandom(bytes.as_mut_ptr(), bytes.len()) };
        true
    }
    fn wake(&mut self, mac: [u8; 6], address: Option<[u8; 4]>) {
        if !self.network {
            self.network = unsafe { moonlightPlatformNetStart() };
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
    fn now_us(&mut self) -> u64 {
        let now_ns = unsafe { sdk::moonlightNowNs() };
        now_ns / 1000
    }
    fn discovery(
        &mut self,
    ) -> Result<Box<dyn moonlight_nx2_io::udp::Datagram>, moonlight_nx2_io::socket::IoError> {
        if !self.network {
            self.network = unsafe { moonlightPlatformNetStart() };
            if !self.network {
                return Err(moonlight_nx2_io::socket::IoError::Failed);
            }
        }
        Ok(Box::new(crate::net::DiscoverySocket::open()?))
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
    let mut connections = NativeConnections {
        session_path: c"sdmc:/switch/moonlight-nx2/rust-client/auth-session",
        blocked: false,
        network: false,
    };
    let authorization = connections.authorization();
    let authorization_error = authorization.as_ref().err().copied();
    log(&format!(
        "frontend: one-time authorization imported={}",
        authorization.is_ok()
    ));
    let (_, saved_settings) = Store::new(files.clone()).load(&mut Box::new(Json::new()));
    let low_latency = saved_settings.on(moonlight_nx2_ui::settings::Setting::LowLatency);
    let mut renderer = match Renderer::open(render_config(low_latency)) {
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
    let launch = Launch {
        files,
        authorization: authorization.ok(),
        authorization_error,
        verified,
        start,
    };
    let result = execute(&mut renderer, &mut connections, launch);
    let closed = renderer.close();
    log(&format!("frontend: renderer close {closed:?}"));
    result && closed.is_ok()
}

struct Launch {
    files: Directory,
    authorization: Option<Session>,
    authorization_error: Option<AuthError>,
    verified: bool,
    start: u64,
}

fn execute(renderer: &mut Renderer, connections: &mut NativeConnections, launch: Launch) -> bool {
    let Launch {
        files,
        authorization,
        authorization_error,
        verified,
        start,
    } = launch;
    const ATLAS: &[u8] = include_bytes!("../../ui/fonts/glyphs.bin");
    let mut snapshot = renderer.display().ok();
    let docked = snapshot.is_some_and(|display| display.operation_mode == 1);
    let mut app = match renderer.storage_mut().ok().and_then(|bytes| {
        Frontend::<_, NetSocket>::new(
            bytes,
            ATLAS,
            files.clone(),
            authorization,
            if verified {
                Access::Streaming
            } else {
                Access::User
            },
            docked,
        )
        .ok()
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
    if authorization_error == Some(AuthError::Invalid) {
        app.notice("The PC connection file is invalid");
    }
    if authorization_error == Some(AuthError::Uncertain) {
        app.notice("The PC connection file could not be consumed; restart before trying again");
    }
    let original = *app.client.bridge.model().settings();
    let mut sampler = match Sampler::open() {
        Ok(sampler) => sampler,
        Err(_) => return false,
    };
    let (mut last_screen, mut failed, mut blocked_start) = (None, false, false);
    let mut input_gate = InputGate::default();
    let mut dock = Monitor::new(docked);
    let mut probe = Probe::new(docked, unsafe { sdk::moonlightNowNs() }, 0);
    let (mut polled, mut last_mode, mut pending) = (start, None, false);
    display_context(&mut app, docked, probe.capabilities());
    let mut stream = Stream::new(stream_capabilities());
    let mut system = crate::system::System::start(unsafe { sdk::moonlightNowNs() } / 1_000_000);
    let mut second = start;
    while unsafe { sdk::appletMainLoop() } && !app.exiting() && !sdk::process_retired() {
        let now = unsafe { sdk::moonlightNowNs() };
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
        if renderer
            .storage_mut()
            .ok()
            .and_then(|bytes| app.client.menu_input(&input, now / 1_000_000, bytes).ok())
            .is_none()
        {
            failed = true;
            break;
        }
        if input.raw_buttons & (1 << 10) != 0 && app.screen() != Screen::Streaming {
            app.client.event(&Event::AppGone);
        }
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
        }
        let now_ms = now / 1_000_000;
        for request in app.take_media() {
            match request {
                MediaRequest::Open(descriptor) => {
                    let peer = app.peer();
                    stream.open(&mut app.client, *descriptor, peer, now_ms);
                }
                MediaRequest::Close => stream.begin_close(&mut app.client, now_ms),
            }
        }
        stream.pump(&mut app.client, now_ms);
        let compute = app.client.needs_ui_compute(&input, &frame);
        let presented = stream.step(&mut app.client, renderer, &input, now_ms, compute);
        system.tick(&mut app, renderer, now_ms);
        app.client
            .update_native_stats(crate::stream_stats::latest());
        if !system.in_focus() {
            unsafe { sdk::svcSleepThread(16_000_000) };
        } else if !presented
            && let Err(error) = renderer.present(compute)
            && error != crate::render::Error::Busy
        {
            failed = true;
            break;
        }
        let screen = app.screen();
        if now.saturating_sub(polled) >= 250_000_000 {
            polled = now;
            if let Ok(display) = renderer.display() {
                snapshot = Some(display);
                if let Some(docked) = dock.sample(display.operation_mode(), now_ms) {
                    log(&format!("display: dock change docked={docked}"));
                    probe.set_docked(docked);
                    display_context(&mut app, docked, probe.capabilities());
                    pending = false;
                }
            }
        }
        if let Ok(info) = renderer.info()
            && let Some(rate) = probe.second(now, info.presented)
        {
            let hz = snapshot.map_or(0, |display| display.nominal_hz);
            if probe.cap_at_60(hz) {
                log(&format!(
                    "display: 120 Hz lost docked={}; modes capped at 60",
                    dock.current()
                ));
                display_context(&mut app, dock.current(), probe.capabilities());
                pending = false;
            }
            let every_refresh = snapshot.is_some_and(|display| {
                (display.interval_numerator, display.interval_denominator) == (1, 120)
            });
            pending |= probe.verify(info.width, info.height, hz, every_refresh);
            if pending && screen != Screen::Streaming {
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
            log(&format!(
                "display: presents={rate}/s {}x{}@{hz} docked={}",
                info.width,
                info.height,
                dock.current()
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
                "frontend: frames={} requests={} media_opened={}",
                app.stats().frames,
                app.stats().requests,
                app.stats().media_opened
            ));
            stream.report();
            second = now;
        }
    }
    stream.close(&mut app.client);
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
    !failed && closed && stats.frames > 0 && !stats.rejected
}

/// Docked, the window takes the size the console outputs (0x0), and follows it: a TV that goes
/// to 120 Hz may do so at a smaller size than its 60 Hz mode, and a layer left at 4K is then
/// shown unscaled. The window presents every refresh, which also asks the display for 120 Hz:
/// the handheld panel has it, a TV has it or stays at 60.
fn render_config(low_latency: bool) -> Config {
    Config {
        window_mode: WindowMode::PerMode {
            docked_width: 0,
            docked_height: 0,
        },
        frame_rates: Some(FrameRates::EVERY_REFRESH),
        present: present_mode(low_latency),
        ..Config::default()
    }
}

fn present_mode(low_latency: bool) -> crate::render::PresentMode {
    if low_latency {
        crate::render::PresentMode::LowLatency
    } else {
        crate::render::PresentMode::Fifo
    }
}

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
