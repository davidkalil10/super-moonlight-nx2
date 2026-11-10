//! The stream shape Auto settled on after the network test, applied over the saved settings.

use crate::settings::StreamOptions;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Grade {
    Good,
    Fair,
    Weak,
}

/// What the network test picked for this link, and what it measured.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkChoice {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub grade: Grade,
    pub rtt_us: u32,
    pub throughput_kbps: u32,
    /// The size and rate the settings asked for when the choice was made. It says nothing
    /// about any other: after a dock change the old choice must not shape the new stream.
    pub wanted: (u32, u32, u32),
}

impl LinkChoice {
    /// Auto bitrate takes the measured bitrate; it never goes above what the settings ask for.
    /// The size and rate the settings ask for are kept: the test only chose a size when it
    /// was made for these very options with the size left to it. A fixed bitrate is the
    /// user's override and is left alone.
    pub fn apply(&self, mut options: StreamOptions) -> StreamOptions {
        if !options.bitrate_auto || (options.width, options.height, options.fps) != self.wanted {
            return options;
        }
        if options.size_auto && self.height < options.height {
            options.width = self.width;
            options.height = self.height;
        }
        options.bitrate_kbps = options.bitrate_kbps.min(self.bitrate_kbps);
        options
    }
}
