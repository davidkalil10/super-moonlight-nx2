use super::{Failure, Reason};
use std::path::PathBuf;

/// Not `host-display.json`: that name is the Civ7 service's hook file in the same directory.
pub const FILE: &str = "display.json";
const VERSION: u32 = 1;

/// Optional settings from `display.json`; without the file everything is detected.
#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    version: u32,
    /// The output Sunshine captures, when the PC has several.
    #[serde(default)]
    pub output: Option<String>,
    /// The desktop's Wayland socket, when the host runs outside the session.
    #[serde(default)]
    pub wayland_display: Option<String>,
    /// Lets the backend add a mode the display does not list.
    #[serde(default)]
    pub custom_modes: bool,
    /// Logs every change without making it.
    #[serde(default)]
    pub dry_run: bool,
}

impl Config {
    pub fn path() -> Option<PathBuf> {
        base("XDG_CONFIG_HOME", ".config").map(|base| base.join("moonlight-nx2").join(FILE))
    }

    pub fn load() -> Result<Self, Failure> {
        let Some(path) = Self::path() else {
            return Ok(Self::default());
        };
        match std::fs::read(&path) {
            Ok(bytes) => Self::parse(&bytes).map_err(|detail| {
                Failure::new(Reason::Config, format!("{}: {detail}", path.display()))
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(Failure::new(
                Reason::Config,
                format!("{}: {error}", path.display()),
            )),
        }
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let config: Self = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        if config.version != VERSION {
            return Err(format!("version must be {VERSION}"));
        }
        for name in [&config.output, &config.wayland_display]
            .into_iter()
            .flatten()
        {
            if !plain_name(name) {
                return Err(format!("{name:?} is not a plain name"));
            }
        }
        Ok(config)
    }
}

/// Output and socket names end up in command arguments and paths.
pub fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// An XDG base directory: the variable when it holds an absolute path, else under the home.
pub fn base(variable: &str, fallback: &str) -> Option<PathBuf> {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .map(|home| home.join(fallback))
        })
}
