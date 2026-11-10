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
use alloc::{boxed::Box, ffi::CString, format};
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
    fn wake(&mut self, mac: [u8; 6]) -> Result<(), moonlight_nx2_io::socket::IoError> {
        if !self.network {
            self.network = unsafe { moonlightPlatformNetStart() };
            if !self.network {
                return Err(moonlight_nx2_io::socket::IoError::Failed);
            }
        }
        crate::net::DiscoverySocket::wake(mac)
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
    let checked = cfg!(feature = "diagnostic-frontend-check");
    let stack = unsafe { moonlightPlatformStackAvailable() };
    log(&format!(
        "frontend: stack available={stack} required=786432"
    ));
    if stack < 786_432 {
        return false;
    }
    let start = unsafe { sdk::moonlightNowNs() };
    let directory = if checked {
        CString::new(format!(
            "sdmc:/switch/moonlight-nx2/rust/frontend-{start:016x}"
        ))
        .unwrap()
    } else {
        CString::from(c"sdmc:/switch/moonlight-nx2/rust-client")
    };
    let files = if checked {
        Directory::create(&directory)
    } else {
        Directory::open(&directory)
    };
    let Some(files) = files else {
        log(if checked {
            "frontend: namespace refused; no existing directory was reused by the check"
        } else {
            "frontend: cannot open the app directory on the SD card"
        });
        return false;
    };
    log(&format!(
        "frontend: namespace {}",
        directory.to_str().unwrap()
    ));
    let mut connections = NativeConnections {
        session_path: if checked {
            c"sdmc:/switch/moonlight-nx2/rust/frontend-session"
        } else {
            c"sdmc:/switch/moonlight-nx2/rust-client/auth-session"
        },
        blocked: false,
        network: false,
    };
    let authorization = connections.authorization();
    let authorization_error = authorization.as_ref().err().copied();
    log(&format!(
        "frontend: one-time authorization imported={} checked={checked}",
        authorization.is_ok()
    ));
    #[cfg(feature = "diagnostic-native-decode")]
    log("b2ar: before renderer/GPU open; no explicit second gsvOpenGpu or nvOpen");
    let (_, saved_settings) = Store::new(files.clone()).load(&mut Box::new(Json::new()));
    let low_latency = saved_settings.on(moonlight_nx2_ui::settings::Setting::LowLatency);
    let mut renderer = match Renderer::open(render_config(low_latency)) {
        Ok(renderer) => renderer,
        Err(error) => {
            log(&format!("frontend: renderer open failed {error:?}"));
            return false;
        }
    };
    #[cfg(feature = "diagnostic-native-decode")]
    log("b2ar: renderer/GPU open returned success");
    #[cfg(feature = "diagnostic-ref-replay")]
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
        checked,
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
    checked: bool,
    verified: bool,
    start: u64,
}

fn execute(renderer: &mut Renderer, connections: &mut NativeConnections, launch: Launch) -> bool {
    let Launch {
        files,
        authorization,
        authorization_error,
        checked,
        verified,
        start,
    } = launch;
    const ATLAS: &[u8] = include_bytes!("../../../streamer/ui/fonts/glyphs.bin");
    let mut snapshot = renderer.display().ok();
    let docked = snapshot.is_some_and(|display| display.operation_mode == 1);
    let mut app = match renderer.storage_mut().ok().and_then(|bytes| {
        Frontend::<_, NetSocket>::new(
            bytes,
            ATLAS,
            files.clone(),
            authorization,
            if checked {
                Access::SingleList
            } else if verified {
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
    if !checked
        && let Some(cache) =
            crate::files::CoverDirectory::open(c"sdmc:/switch/moonlight-nx2/covers")
    {
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
    let (mut last_screen, mut listed_at, mut failed, mut blocked_start) =
        (None, None, false, false);
    let mut input_gate = InputGate::default();
    let mut dock = Monitor::new(docked);
    let mut probe = Probe::new(docked, unsafe { sdk::moonlightNowNs() }, 0);
    let (mut polled, mut last_mode, mut pending) = (start, None, false);
    display_context(&mut app, docked, probe.capabilities());
    let mut stream = Stream::new(stream_capabilities());
    let mut second = start;
    while unsafe { sdk::appletMainLoop() } && !app.exiting() && !sdk::process_retired() {
        let now = unsafe { sdk::moonlightNowNs() };
        if checked && now.saturating_sub(start) >= 60_000_000_000 {
            break;
        }
        if checked && listed_at.is_some_and(|at| now.saturating_sub(at) >= 8_000_000_000) {
            break;
        }
        let input = match sampler
            .read(renderer)
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
        let now_ms = now / 1_000_000;
        for request in app.take_media() {
            match request {
                MediaRequest::Open(descriptor) => {
                    let peer = app.peer();
                    stream.open(
                        &mut app.client,
                        *descriptor,
                        peer,
                        now_ms,
                        #[cfg(feature = "native-video")]
                        renderer,
                    );
                }
                MediaRequest::Close => stream.begin_close(&mut app.client, now_ms),
            }
        }
        stream.pump(&mut app.client, now_ms);
        let compute = app.client.needs_ui_compute(&input, &frame);
        let presented = stream.step(&mut app.client, renderer, &input, now_ms, compute);
        app.client
            .update_native_stats(crate::stream_stats::latest());
        if !presented
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
            pending |= probe.verify(info.width, info.height, hz);
            if pending && screen != Screen::Streaming {
                display_context(&mut app, dock.current(), probe.capabilities());
                pending = false;
            }
            let mode = (info.width, info.height, hz, dock.current());
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
        if screen == Screen::Apps && listed_at.is_none() {
            listed_at = Some(now);
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
    let changed = *app.client.bridge.model().settings() != original;
    let final_settings = *app.client.bridge.model().settings();
    let closed = app.close(renderer);
    let stats = app.stats();
    let (source, saved) = Store::new(files).load(&mut Box::new(Json::new()));
    let persisted = source == Source::Loaded && saved == final_settings;
    log(&format!(
        "frontend: summary {stats:?} settings_changed={changed} settings_persisted={persisted} local_start_blocked={blocked_start} close={closed}"
    ));
    !failed
        && closed
        && stats.frames > 0
        && (stats.media_opened == 0 || !checked)
        && !stats.rejected
        && (!checked
            || (stats.requests == 1
                && stats.authenticated == 1
                && listed_at.is_some()
                && changed
                && persisted
                && blocked_start))
}

/// The sink and docked-modes builds ask for a 4K layer when docked, so 1440p and 4K can be
/// verified. The 120 Hz build asks for 1440p there, the largest size a TV shows at 120 Hz. The
/// sink and 120 Hz builds present every refresh, which also asks the display for 120 Hz.
fn render_config(low_latency: bool) -> Config {
    let docked_4k = cfg!(any(
        feature = "diagnostic-frontend",
        feature = "sdk-video-docked-modes"
    ));
    let fast = cfg!(any(
        feature = "diagnostic-frontend",
        feature = "sdk-video-120hz"
    ));
    let window_mode = if docked_4k {
        WindowMode::PerMode {
            docked_width: 3840,
            docked_height: 2160,
        }
    } else if fast {
        WindowMode::PerMode {
            docked_width: 2560,
            docked_height: 1440,
        }
    } else {
        WindowMode::Fixed
    };
    Config {
        window_mode,
        frame_rates: fast.then_some(FrameRates::EVERY_REFRESH),
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
#[cfg(any(
    feature = "diagnostic-frontend",
    feature = "native-video",
    feature = "sdk-video"
))]
fn display_context(
    app: &mut Frontend<Directory, NetSocket>,
    docked: bool,
    display: DisplayCapabilities,
) {
    let accepted = app
        .client
        .context_changed(moonlight_nx2_app::policy::Context {
            docked,
            decoder: stream_capabilities(),
            display,
        });
    #[cfg(not(any(feature = "native-video", feature = "sdk-video")))]
    log(&format!(
        "display: context docked={docked} accepted={accepted}; video sink receives and discards up to 1440p120 and 4K60"
    ));
    #[cfg(any(feature = "native-video", feature = "sdk-video"))]
    log(&format!(
        "display: context docked={docked} accepted={accepted}; native decoder capability is runtime gated"
    ));
}

/// Without a decoder nothing can be offered; only the operation mode reaches the model.
#[cfg(not(any(
    feature = "diagnostic-frontend",
    feature = "native-video",
    feature = "sdk-video"
)))]
fn display_context(app: &mut Frontend<Directory, NetSocket>, docked: bool, _: DisplayCapabilities) {
    app.client.event(&Event::OperationMode { docked });
}

#[cfg(any(
    feature = "diagnostic-frontend",
    feature = "native-video",
    feature = "sdk-video"
))]
fn stream_capabilities() -> Capabilities {
    crate::frontend_stream::decoder_capabilities()
}

#[cfg(not(any(
    feature = "diagnostic-frontend",
    feature = "native-video",
    feature = "sdk-video"
)))]
fn stream_capabilities() -> Capabilities {
    Capabilities::default()
}
