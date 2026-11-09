#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Codec {
    H264,
    Hevc,
    Vp9,
    Av1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Depth {
    Eight,
    Ten,
}

impl Codec {
    pub fn protocol_mask(self, depth: Depth) -> Option<u32> {
        match (self, depth) {
            (Self::H264, Depth::Eight) => Some(0x0001),
            (Self::Hevc, Depth::Eight) => Some(0x0100),
            (Self::Hevc, Depth::Ten) => Some(0x0200),
            (Self::Av1, Depth::Eight) => Some(0x1000),
            (Self::Av1, Depth::Ten) => Some(0x2000),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Size {
    width: u32,
    height: u32,
}

impl Size {
    pub fn new(width: u32, height: u32) -> Option<Self> {
        let bounded = (2..=3840).contains(&width) && (2..=2160).contains(&height);
        (bounded && width.is_multiple_of(2) && height.is_multiple_of(2))
            .then_some(Self { width, height })
    }
    pub fn width(self) -> u32 {
        self.width
    }
    pub fn height(self) -> u32 {
        self.height
    }
    pub fn contains(self, other: Self) -> bool {
        other.width <= self.width && other.height <= self.height
    }
    pub fn nv12_bytes(self) -> usize {
        self.width as usize * self.height as usize * 3 / 2
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Mode {
    pub codec: Codec,
    pub depth: Depth,
    pub maximum: Size,
    pub fps: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Evidence {
    Unverified,
    Rejected,
    PixelsAndCloseVerified,
}

#[derive(Default)]
pub struct Capabilities {
    modes: [Option<Mode>; 8],
    retired: bool,
}

impl Capabilities {
    pub fn record(&mut self, mode: Mode, evidence: Evidence) -> bool {
        if self.retired {
            return false;
        }
        if evidence != Evidence::PixelsAndCloseVerified {
            self.revoke(mode.codec, mode.depth);
            return false;
        }
        if mode.fps == 0 || mode.fps > 120 {
            return false;
        }
        let found = self.modes.iter().position(|entry| {
            entry.is_some_and(|old| {
                old.codec == mode.codec && old.depth == mode.depth && old.maximum == mode.maximum
            })
        });
        let index = found.or_else(|| self.modes.iter().position(Option::is_none));
        let Some(index) = index else {
            return false;
        };
        self.modes[index] = Some(mode);
        true
    }

    pub fn revoke(&mut self, codec: Codec, depth: Depth) -> bool {
        let mut removed = false;
        for entry in &mut self.modes {
            if entry.is_some_and(|mode| mode.codec == codec && mode.depth == depth) {
                *entry = None;
                removed = true;
            }
        }
        removed
    }

    pub fn retire(&mut self) {
        self.modes.fill(None);
        self.retired = true;
    }

    pub fn supports(&self, codec: Codec, depth: Depth, size: Size, fps: u32) -> bool {
        fps != 0
            && self.modes.iter().flatten().any(|mode| {
                mode.codec == codec
                    && mode.depth == depth
                    && mode.maximum.contains(size)
                    && fps <= mode.fps
            })
    }

    pub fn stream_formats(&self, size: Size, fps: u32) -> u32 {
        self.modes
            .iter()
            .flatten()
            .filter(|mode| mode.maximum.contains(size) && fps != 0 && fps <= mode.fps)
            .filter_map(|mode| mode.codec.protocol_mask(mode.depth))
            .fold(0, |mask, codec| mask | codec)
    }
}
