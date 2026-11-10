//! The stream shape Auto settled on after the network test, applied over the saved settings.

use crate::settings::StreamOptions;

/// What the network test picked for this link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkChoice {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
}

impl LinkChoice {
    /// Auto bitrate takes the measured choice; it never goes above what the settings ask for.
    /// A fixed bitrate is the user's override and is left alone.
    pub fn apply(&self, mut options: StreamOptions) -> StreamOptions {
        if !options.bitrate_auto {
            return options;
        }
        if self.height < options.height {
            options.width = self.width;
            options.height = self.height;
        }
        options.fps = options.fps.min(self.fps);
        options.bitrate_kbps = options.bitrate_kbps.min(self.bitrate_kbps);
        options
    }
}
