//! What the console and the running stream report, for the page header and the stream sheet.
//! Every field is optional: a reading the console did not give is left out of the page.

use crate::text::Text;

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailscaleReadout {
    pub enabled: bool,
    pub state: u8,
    pub has_auth_key: bool,
    pub qr_size: u8,
    pub peer_count: u32,
    pub self_ip: Text<47>,
    pub hostname: Text<63>,
    pub control_url: Text<127>,
    pub login_url: Text<191>,
    pub peer_path: Text<95>,
    pub last_error: Text<127>,
    pub qr_modules: [u8; 64 * 64],
}

impl Default for TailscaleReadout {
    fn default() -> Self {
        Self {
            enabled: false,
            state: 0,
            has_auth_key: false,
            qr_size: 0,
            peer_count: 0,
            self_ip: Text::new(),
            hostname: Text::of("switch2"),
            control_url: Text::of("https://controlplane.tailscale.com"),
            login_url: Text::new(),
            peer_path: Text::new(),
            last_error: Text::new(),
            qr_modules: [0; 64 * 64],
        }
    }
}
