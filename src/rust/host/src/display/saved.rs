use super::{Failure, Reason, Setting, config};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;

const VERSION: u32 = 1;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    setting: Setting,
}

/// The mode to go back to, kept on disk from the first change until it is restored.
pub struct Store {
    path: Option<PathBuf>,
}

impl Store {
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Some(path.into()),
        }
    }

    /// `$XDG_STATE_HOME/moonlight-nx2/display-saved.json`.
    pub fn default_location() -> Self {
        Self {
            path: config::base("XDG_STATE_HOME", ".local/state")
                .map(|base| base.join("moonlight-nx2").join("display-saved.json")),
        }
    }

    pub fn path(&self) -> Option<&std::path::Path> {
        self.path.as_deref()
    }

    pub fn load(&self) -> Result<Option<Setting>, Failure> {
        let Some(path) = &self.path else {
            return Ok(None);
        };
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(failure(path, error)),
        };
        let record: Record =
            serde_json::from_slice(&bytes).map_err(|error| failure(path, error))?;
        let setting = record.setting;
        let valid = record.version == VERSION
            && config::plain_name(&setting.output)
            && setting.width > 0
            && setting.height > 0
            && setting.refresh_mhz > 0
            && setting.scale.is_finite()
            && setting.scale > 0.0;
        if !valid {
            return Err(failure(path, "not a saved display mode"));
        }
        Ok(Some(setting))
    }

    /// Written before the display changes: a change without a way back is refused.
    pub fn save(&self, setting: &Setting) -> Result<(), Failure> {
        let Some(path) = &self.path else {
            return Err(Failure::new(
                Reason::Failed,
                "no state directory to save the current mode in",
            ));
        };
        let write = || -> std::io::Result<()> {
            let directory = path.parent().expect("state file in a directory");
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(directory)?;
            let temporary = path.with_extension("tmp");
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?;
            let record = Record {
                version: VERSION,
                setting: setting.clone(),
            };
            file.write_all(&serde_json::to_vec(&record).map_err(std::io::Error::other)?)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            std::fs::rename(&temporary, path)
        };
        write().map_err(|error| failure(path, error))
    }

    pub fn clear(&self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn failure(path: &std::path::Path, error: impl std::fmt::Display) -> Failure {
    Failure::new(Reason::Failed, format!("{}: {error}", path.display()))
}
