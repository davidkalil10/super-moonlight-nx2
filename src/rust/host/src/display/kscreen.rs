//! KDE Plasma through `kscreen-doctor`, which covers Wayland and X11 sessions.

use super::{Backend, Change, Failure, RATE_TOLERANCE_MHZ, Reason, Setting, config, process};
use serde_json::Value;
use std::os::unix::fs::FileTypeExt;
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const SETTLE_TIMEOUT: Duration = Duration::from_secs(2);

pub struct Kscreen {
    program: PathBuf,
    output: Option<String>,
    wayland_display: Option<String>,
    custom_modes: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    pub name: String,
    pub primary: bool,
    pub scale: f64,
    pub current: Option<String>,
    pub modes: Vec<OutputMode>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OutputMode {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub refresh_mhz: u32,
}

impl Output {
    fn setting(&self) -> Result<Setting, Failure> {
        let mode = self
            .current
            .as_ref()
            .and_then(|id| self.modes.iter().find(|mode| &mode.id == id))
            .ok_or_else(|| {
                Failure::new(Reason::NoOutput, format!("{} reports no mode", self.name))
            })?;
        Ok(Setting {
            output: self.name.clone(),
            mode: Some(mode.id.clone()),
            width: mode.width,
            height: mode.height,
            refresh_mhz: mode.refresh_mhz,
            scale: self.scale,
        })
    }

    /// The listed mode for `wanted`: its own mode when still listed, else the nearest rate.
    fn mode_for(&self, wanted: &Setting) -> Option<&OutputMode> {
        let fits = |mode: &&OutputMode| {
            mode.width == wanted.width
                && mode.height == wanted.height
                && mode.refresh_mhz.abs_diff(wanted.refresh_mhz) < RATE_TOLERANCE_MHZ
        };
        self.modes
            .iter()
            .filter(fits)
            .find(|mode| wanted.mode.as_ref() == Some(&mode.id))
            .or_else(|| {
                self.modes
                    .iter()
                    .filter(fits)
                    .min_by_key(|mode| mode.refresh_mhz.abs_diff(wanted.refresh_mhz))
            })
    }
}

/// Reads the enabled, connected outputs from `kscreen-doctor -j`.
pub fn parse_outputs(json: &str) -> Result<Vec<Output>, String> {
    let root: Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let outputs = root
        .get("outputs")
        .and_then(Value::as_array)
        .ok_or("no outputs list")?;
    let text = |value: Option<&Value>| match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        _ => None,
    };
    let dimension = |mode: &Value, name: &str| {
        mode.get("size")
            .and_then(|size| size.get(name))
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
    };
    let mut found = Vec::new();
    for output in outputs {
        let flag = |name: &str| output.get(name).and_then(Value::as_bool) == Some(true);
        if !flag("connected") || !flag("enabled") {
            continue;
        }
        let name = text(output.get("name")).ok_or("an output has no name")?;
        let mut modes = Vec::new();
        for mode in output
            .get("modes")
            .and_then(Value::as_array)
            .ok_or("an output has no modes")?
        {
            let rate = mode.get("refreshRate").and_then(Value::as_f64);
            let (Some(id), Some(width), Some(height), Some(rate)) = (
                text(mode.get("id")),
                dimension(mode, "width"),
                dimension(mode, "height"),
                rate.filter(|rate| rate.is_finite() && *rate > 0.0 && *rate < 10_000.0),
            ) else {
                return Err(format!("{name} lists a mode that cannot be read"));
            };
            modes.push(OutputMode {
                id,
                width,
                height,
                refresh_mhz: (rate * 1000.0).round() as u32,
            });
        }
        found.push(Output {
            name,
            primary: output.get("priority").and_then(Value::as_u64) == Some(1),
            scale: output
                .get("scale")
                .and_then(Value::as_f64)
                .filter(|scale| scale.is_finite() && *scale > 0.0)
                .ok_or("an output has no scale")?,
            current: text(output.get("currentModeId")),
            modes,
        });
    }
    Ok(found)
}

fn set_arguments(output: &str, mode: &str, scale: f64) -> Vec<String> {
    vec![
        format!("output.{output}.mode.{mode}"),
        format!("output.{output}.scale.{scale}"),
    ]
}

fn custom_mode_argument(wanted: &Setting) -> String {
    format!(
        "output.{}.addCustomMode.{}.{}.{}.reduced",
        wanted.output, wanted.width, wanted.height, wanted.refresh_mhz
    )
}

impl Kscreen {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            output: None,
            wayland_display: None,
            custom_modes: false,
        }
    }

    pub fn from_config(config: &config::Config) -> Self {
        Self {
            program: "kscreen-doctor".into(),
            output: config.output.clone(),
            wayland_display: config.wayland_display.clone(),
            custom_modes: config.custom_modes,
        }
    }

    pub fn output(mut self, name: impl Into<String>) -> Self {
        self.output = Some(name.into());
        self
    }

    pub fn custom_modes(mut self, allowed: bool) -> Self {
        self.custom_modes = allowed;
        self
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        let runtime = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })));
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            command.env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={}", runtime.join("bus").display()),
            );
        }
        let socket = self
            .wayland_display
            .clone()
            .or_else(|| std::env::var("WAYLAND_DISPLAY").ok())
            .or_else(|| only_wayland_socket(&runtime));
        if let Some(socket) = socket {
            command.env("WAYLAND_DISPLAY", socket);
            command.env("QT_QPA_PLATFORM", "wayland");
        }
        command
    }

    fn outputs(&self) -> Result<Vec<Output>, Failure> {
        let mut command = self.command();
        command.arg("-j");
        let json = process::run(command, COMMAND_TIMEOUT)
            .map_err(|detail| Failure::new(Reason::Unsupported, detail))?;
        parse_outputs(&json).map_err(|detail| {
            Failure::new(Reason::Unsupported, format!("kscreen-doctor -j: {detail}"))
        })
    }

    fn change(&self, arguments: &[String]) -> Result<(), Failure> {
        let mut command = self.command();
        command.args(arguments);
        process::run(command, COMMAND_TIMEOUT)
            .map(|_| ())
            .map_err(|detail| Failure::new(Reason::Failed, detail))
    }

    fn find(&self, name: &str) -> Result<Output, Failure> {
        self.outputs()?
            .into_iter()
            .find(|output| output.name == name)
            .ok_or_else(|| Failure::new(Reason::NoOutput, format!("{name} is not in use")))
    }

    /// The configured output, the only one, or the primary one.
    fn streamed(&self) -> Result<Output, Failure> {
        let mut outputs = self.outputs()?;
        if let Some(name) = &self.output {
            return outputs
                .into_iter()
                .find(|output| &output.name == name)
                .ok_or_else(|| Failure::new(Reason::NoOutput, format!("{name} is not in use")));
        }
        if outputs.len() > 1 {
            outputs.retain(|output| output.primary);
        }
        if outputs.len() == 1 {
            return Ok(outputs.remove(0));
        }
        Err(Failure::new(
            Reason::NoOutput,
            "cannot tell which display Sunshine streams; name it as output in display.json",
        ))
    }
}

/// The desktop's socket when the host was started outside the session, as a service is.
fn only_wayland_socket(runtime: &std::path::Path) -> Option<String> {
    let mut sockets = std::fs::read_dir(runtime)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_socket()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            name.strip_prefix("wayland-").is_some_and(|number| {
                !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())
            })
        });
    let socket = sockets.next()?;
    sockets.next().is_none().then_some(socket)
}

impl Backend for Kscreen {
    fn name(&self) -> &'static str {
        "kscreen-doctor"
    }

    fn current(&mut self) -> Result<Setting, Failure> {
        self.streamed()?.setting()
    }

    fn plan(&mut self, wanted: &Setting) -> Result<Change, Failure> {
        if !config::plain_name(&wanted.output) {
            return Err(Failure::new(Reason::NoOutput, "output name is not plain"));
        }
        let output = self.find(&wanted.output)?;
        let mut target = wanted.clone();
        let mut commands = Vec::new();
        match output.mode_for(wanted) {
            Some(mode) => {
                target.mode = Some(mode.id.clone());
                target.refresh_mhz = mode.refresh_mhz;
                if !output.setting()?.matches(&target) {
                    commands.push(set_arguments(&output.name, &mode.id, target.scale).join(" "));
                }
            }
            None if self.custom_modes => {
                target.mode = None;
                commands.push(custom_mode_argument(wanted));
                commands.push(set_arguments(&output.name, "NEW", target.scale).join(" "));
            }
            None => {
                return Err(Failure::new(
                    Reason::NoMode,
                    format!(
                        "{} has no {}x{}@{} mode",
                        output.name,
                        wanted.width,
                        wanted.height,
                        f64::from(wanted.refresh_mhz) / 1000.0
                    ),
                ));
            }
        }
        for command in &mut commands {
            command.insert_str(0, "kscreen-doctor ");
        }
        Ok(Change { target, commands })
    }

    fn commit(&mut self, change: &Change) -> Result<(), Failure> {
        if change.commands.is_empty() {
            return Ok(());
        }
        let target = &change.target;
        let mode = match &target.mode {
            Some(mode) => mode.clone(),
            None => {
                self.change(&[custom_mode_argument(target)])?;
                self.find(&target.output)?
                    .mode_for(target)
                    .map(|mode| mode.id.clone())
                    .ok_or_else(|| Failure::new(Reason::NoMode, "the custom mode was not added"))?
            }
        };
        self.change(&set_arguments(&target.output, &mode, target.scale))?;
        let deadline = Instant::now() + SETTLE_TIMEOUT;
        loop {
            if self.find(&target.output)?.setting()?.matches(target) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(Failure::new(
                    Reason::Failed,
                    format!("the display did not take {target}"),
                ));
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}
