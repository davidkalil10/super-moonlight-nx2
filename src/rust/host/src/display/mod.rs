//! Makes the PC display follow the stream while "Optimise game settings" is on and puts
//! the previous mode back afterwards. The mode in use before the first change is kept on
//! disk until it is restored, so a host that died mid-stream restores it on its next start.

pub mod cli;
pub mod config;
pub mod kscreen;
mod process;
pub mod saved;

use crate::StreamOptions;
use std::net::{IpAddr, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

/// How long a stopped stream keeps its mode, so a relaunch does not switch twice.
pub const RESTORE_DELAY: Duration = Duration::from_secs(5);
/// Modes within this many millihertz of the request count as the requested rate.
pub const RATE_TOLERANCE_MHZ: u32 = 500;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

impl Mode {
    /// Reads `WIDTHxHEIGHT@FPS`.
    pub fn parse(text: &str) -> Option<Self> {
        let (size, fps) = text.split_once('@')?;
        let (width, height) = size.split_once('x')?;
        let mode = Self {
            width: width.parse().ok()?,
            height: height.parse().ok()?,
            fps: fps.parse().ok()?,
        };
        (mode.width > 0 && mode.height > 0 && mode.fps > 0).then_some(mode)
    }
}

/// One output's mode and scale. `mode` is the backend's own mode name, when it has one.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Setting {
    pub output: String,
    pub mode: Option<String>,
    pub width: u32,
    pub height: u32,
    pub refresh_mhz: u32,
    pub scale: f64,
}

impl Setting {
    pub fn for_stream(output: &str, mode: Mode) -> Self {
        Self {
            output: output.into(),
            mode: None,
            width: mode.width,
            height: mode.height,
            refresh_mhz: mode.fps.saturating_mul(1000),
            scale: 1.0,
        }
    }

    pub fn matches(&self, other: &Self) -> bool {
        self.output == other.output
            && self.width == other.width
            && self.height == other.height
            && self.refresh_mhz.abs_diff(other.refresh_mhz) < RATE_TOLERANCE_MHZ
            && (self.scale - other.scale).abs() < 0.01
    }
}

impl std::fmt::Display for Setting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {}x{}@{:.3} scale {}",
            self.output,
            self.width,
            self.height,
            f64::from(self.refresh_mhz) / 1000.0,
            self.scale
        )
    }
}

/// Why the display was left alone; the console shows a note for each.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reason {
    /// No display control this host knows how to drive.
    Unsupported,
    /// Sunshine runs on another computer.
    RemotePc,
    /// `display.json` cannot be used.
    Config,
    /// The output to switch is missing or cannot be told apart.
    NoOutput,
    /// The output has no mode for the stream.
    NoMode,
    /// The change was refused, timed out or did not take.
    Failed,
}

impl Reason {
    pub const ALL: [Self; 6] = [
        Self::Unsupported,
        Self::RemotePc,
        Self::Config,
        Self::NoOutput,
        Self::NoMode,
        Self::Failed,
    ];

    /// The name the console knows the reason by.
    pub fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::RemotePc => "remote_pc",
            Self::Config => "config",
            Self::NoOutput => "no_output",
            Self::NoMode => "no_mode",
            Self::Failed => "failed",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub reason: Reason,
    pub detail: String,
}

impl Failure {
    pub fn new(reason: Reason, detail: impl Into<String>) -> Self {
        Self {
            reason,
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.reason.code(), self.detail)
    }
}

/// A resolved change: where the output ends up and the commands that take it there.
/// No commands means the output is already there.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub target: Setting,
    pub commands: Vec<String>,
}

/// One way of driving the PC display. `plan` only reads; `commit` changes the display and
/// returns once the output reports the target.
pub trait Backend {
    fn name(&self) -> &'static str;
    fn current(&mut self) -> Result<Setting, Failure>;
    fn plan(&mut self, wanted: &Setting) -> Result<Change, Failure>;
    fn commit(&mut self, change: &Change) -> Result<(), Failure>;
}

/// Stands in when no backend can be used, so every request reports why.
pub struct Unavailable(pub Failure);

impl Backend for Unavailable {
    fn name(&self) -> &'static str {
        "none"
    }
    fn current(&mut self) -> Result<Setting, Failure> {
        Err(self.0.clone())
    }
    fn plan(&mut self, _: &Setting) -> Result<Change, Failure> {
        Err(self.0.clone())
    }
    fn commit(&mut self, _: &Change) -> Result<(), Failure> {
        Err(self.0.clone())
    }
}

pub struct Session {
    backend: Box<dyn Backend + Send>,
    store: saved::Store,
    dry_run: bool,
    applied: Option<Mode>,
    restore_at: Option<Instant>,
}

impl Session {
    pub fn new(backend: Box<dyn Backend + Send>, store: saved::Store, dry_run: bool) -> Self {
        Self {
            backend,
            store,
            dry_run,
            applied: None,
            restore_at: None,
        }
    }

    /// The backend and options `display.json` and this desktop session give.
    pub fn from_environment() -> Self {
        let store = saved::Store::default_location();
        match config::Config::load() {
            Ok(config) => {
                let dry_run = config.dry_run;
                Self::new(
                    Box::new(kscreen::Kscreen::from_config(&config)),
                    store,
                    dry_run,
                )
            }
            Err(failure) => Self::new(Box::new(Unavailable(failure)), store, false),
        }
    }

    pub fn backend(&mut self) -> &mut (dyn Backend + Send) {
        self.backend.as_mut()
    }

    pub fn saved(&self) -> Result<Option<Setting>, Failure> {
        self.store.load()
    }

    /// Follows a stream that asks for it. Returns why the display stays as it is, if it does.
    pub fn match_stream(&mut self, host: &str, options: &StreamOptions) -> Option<Reason> {
        if !options.sops {
            return None;
        }
        let mode = Mode {
            width: options.width,
            height: options.height,
            fps: options.fps,
        };
        let result = if is_local(host) {
            self.apply(mode)
        } else {
            Err(Failure::new(
                Reason::RemotePc,
                format!("{host} is not this computer"),
            ))
        };
        match result {
            Ok(()) => None,
            Err(failure) => {
                eprintln!("display: not matched, {failure}");
                Some(failure.reason)
            }
        }
    }

    pub fn apply(&mut self, mode: Mode) -> Result<(), Failure> {
        self.restore_at = None;
        if self.applied == Some(mode) {
            return Ok(());
        }
        let current = self.backend.current()?;
        let change = self
            .backend
            .plan(&Setting::for_stream(&current.output, mode))?;
        if self.dry_run {
            eprintln!("display: dry run, {current} would become {}", change.target);
            for command in &change.commands {
                eprintln!("display: dry run, {command}");
            }
            return Ok(());
        }
        if change.commands.is_empty() {
            self.applied = Some(mode);
            return Ok(());
        }
        if self.store.load()?.is_none() {
            self.store.save(&current)?;
        }
        if let Err(failure) = self.backend.commit(&change) {
            self.restore();
            return Err(failure);
        }
        eprintln!("display: {current} -> {}", change.target);
        self.applied = Some(mode);
        Ok(())
    }

    /// Leaves the applied mode in place when the session goes away; the saved mode stays
    /// on disk for a later restore.
    pub fn keep(&mut self) {
        self.applied = None;
        self.restore_at = None;
    }

    /// The stream ended: restore once `RESTORE_DELAY` passes without another one.
    pub fn release(&mut self, now: Instant) {
        if self.applied.is_some() && self.restore_at.is_none() {
            self.restore_at = Some(now + RESTORE_DELAY);
        }
    }

    pub fn poll(&mut self, now: Instant) {
        if self.restore_at.is_some_and(|due| now >= due) {
            self.restore();
        }
    }

    /// Puts the saved mode back. The saved mode stays on disk when that fails.
    pub fn restore(&mut self) -> bool {
        self.restore_at = None;
        self.applied = None;
        let saved = match self.store.load() {
            Ok(Some(saved)) => saved,
            Ok(None) => return true,
            Err(failure) => {
                eprintln!("display: dropping the saved mode, {failure}");
                self.store.clear();
                return false;
            }
        };
        let change = match self.backend.plan(&saved) {
            Ok(change) => change,
            Err(failure) => {
                eprintln!("display: restore of {saved} failed, {failure}");
                return false;
            }
        };
        if self.dry_run {
            for command in &change.commands {
                eprintln!("display: dry run, {command}");
            }
            return false;
        }
        match self.backend.commit(&change) {
            Ok(()) => {
                self.store.clear();
                eprintln!("display: restored {saved}");
                true
            }
            Err(failure) => {
                eprintln!("display: restore of {saved} failed, {failure}");
                false
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.applied.is_some() {
            self.restore();
        }
    }
}

/// Whether `host` names this computer, which is the only display the host can switch.
pub fn is_local(host: &str) -> bool {
    let addresses: Vec<IpAddr> = match host.parse() {
        Ok(address) => vec![address],
        Err(_) => (host, 0)
            .to_socket_addrs()
            .map(|found| found.map(|address| address.ip()).collect())
            .unwrap_or_default(),
    };
    addresses
        .iter()
        .any(|address| address.is_loopback() || UdpSocket::bind((*address, 0)).is_ok())
}
