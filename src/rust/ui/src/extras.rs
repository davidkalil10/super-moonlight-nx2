//! What the console remembers per PC beyond its address: the last app played and the stream
//! options set for single apps. Both live in the host's entry of hosts.json.

use crate::model::{Address, Name};
use crate::settings::Setting;

pub const MAX_OVERRIDES: usize = 32;

/// An override value of INHERIT keeps the global setting.
pub const INHERIT: u8 = 0xff;

/// The settings an app can override, in the order of `AppOverride::values`.
pub const OVERRIDABLE: [Setting; 4] = [
    Setting::Size,
    Setting::Fps,
    Setting::Bitrate,
    Setting::Codec,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppOverride {
    pub host: Address,
    pub app: u32,
    pub values: [u8; 4],
}

impl AppOverride {
    pub fn new(host: Address, app: u32) -> Self {
        Self {
            host,
            app,
            values: [INHERIT; 4],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.values.iter().all(|value| *value == INHERIT)
    }
}

/// The remembered extras as the model hands them to be saved, and takes them back.
#[derive(Clone, Copy, Debug, Default)]
pub struct Extras<'a> {
    pub overrides: &'a [AppOverride],
    pub played: &'a [(Address, Name)],
}
