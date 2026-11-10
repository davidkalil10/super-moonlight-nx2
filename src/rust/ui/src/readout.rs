//! What the console and the running stream report, for the page header and the stream sheet.
//! Every field is optional: a reading the console did not give is left out of the page.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Network {
    /// Signal bars, 0 to 3.
    Wifi(u32),
    Wired,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Readout {
    pub battery_percent: Option<u32>,
    pub charging: bool,
    pub network: Option<Network>,
    pub clock: Option<(u8, u8)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StreamReadout {
    pub fps_x10: Option<u32>,
    pub bitrate_kbps: Option<u32>,
    /// Time from submitting a unit to its picture being read back.
    pub decode_us: Option<u32>,
    pub network_us: Option<u32>,
    pub session_s: u32,
}
