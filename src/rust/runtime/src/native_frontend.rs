extern crate alloc;

use crate::{
    client_session::Session,
    control_link::Access,
    device::log,
    display::Probe,
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
}

impl Drop for NativeConnections {
    fn drop(&mut self) {
        if self.network && !sdk::process_retired() {
            unsafe { moonlightPlatformNetStop() };
        }
    }
}

pub fn run(checked: bool) -> bool {
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
        log("frontend: namespace refused; no existing directory was reused by the check");
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
        "frontend: one-time authorization imported={} checked={checked}; native codecs disabled; Start denied before wire",
        authorization.is_ok()
    ));
    let mut renderer = match Renderer::open(render_config()) {
        Ok(renderer) => renderer,
        Err(error) => {
            log(&format!("frontend: renderer open failed {error:?}"));
            return false;
        }
    };
    let result = execute(
        &mut renderer,
        files,
        authorization.ok(),
        authorization_error,
        &mut connections,
        checked,
        start,
    );
    let closed = renderer.close();
    log(&format!("frontend: renderer close {closed:?}"));
    result && closed.is_ok()
}

fn execute(
    renderer: &mut Renderer,
    files: Directory,
    authorization: Option<Session>,
    authorization_error: Option<AuthError>,
    connections: &mut NativeConnections,
    checked: bool,
    start: u64,
) -> bool {
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
                    stream.open(&mut app.client, descriptor, peer, now_ms);
                }
                MediaRequest::Close => stream.begin_close(&mut app.client, now_ms),
            }
        }
        stream.pump(&mut app.client, now_ms);
        stream.step(&mut app.client, renderer, &input, now_ms, frame.interactive);
        let compute = app.client.needs_ui_compute(&input, &frame);
        if let Err(error) = renderer.present(compute) {
            if error != crate::render::Error::Busy {
                failed = true;
                break;
            }
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
        && (stats.media_opened == 0 || cfg!(feature = "diagnostic-frontend"))
        && !stats.rejected
        && (!checked
            || (stats.requests == 1
                && stats.authenticated == 1
                && listed_at.is_some()
                && changed
                && persisted
                && blocked_start))
}

/// The sink build presents at up to 120 Hz and asks for a 4K layer when docked.
#[cfg(feature = "diagnostic-frontend")]
fn render_config() -> Config {
    Config {
        window_mode: crate::display::WindowMode::PerMode {
            docked_width: 3840,
            docked_height: 2160,
        },
        frame_rates: Some(crate::display::FrameRates {
            at_120hz: 120,
            at_60hz: 60,
            vrr: false,
        }),
        ..Config::default()
    }
}

#[cfg(not(feature = "diagnostic-frontend"))]
fn render_config() -> Config {
    Config::default()
}

/// Hands the operation mode and the display modes verified for it to the client; a live stream
/// restarts in the new context.
#[cfg(feature = "diagnostic-frontend")]
fn display_context(
    app: &mut Frontend<Directory, NetSocket>,
    docked: bool,
    display: DisplayCapabilities,
) {
    let accepted = app
        .client
        .context_changed(moonlight_nx2_app::policy::Context {
            docked,
            decoder: crate::video_sink::capabilities(),
            display,
        });
    log(&format!(
        "display: context docked={docked} accepted={accepted}; video sink receives and discards up to 1440p120 and 4K60"
    ));
}

/// Without a decoder nothing can be offered; only the operation mode reaches the model.
#[cfg(not(feature = "diagnostic-frontend"))]
fn display_context(app: &mut Frontend<Directory, NetSocket>, docked: bool, _: DisplayCapabilities) {
    app.client.event(&Event::OperationMode { docked });
}

#[cfg(feature = "diagnostic-frontend")]
fn stream_capabilities() -> Capabilities {
    crate::video_sink::capabilities()
}

#[cfg(not(feature = "diagnostic-frontend"))]
fn stream_capabilities() -> Capabilities {
    Capabilities::default()
}
