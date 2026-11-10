//! Battery, temperature and Wi-Fi for the stream menu, and the low-battery warning. A reading
//! the console did not give is left out of the line.

use core::fmt::Write;

use moonlight_nx2_ui::text::Text;

pub const LOW_PERCENT: u32 = 15;
pub const CRITICAL_PERCENT: u32 = 5;
/// Charge at which a new warning becomes possible again.
pub const REARM_PERCENT: u32 = 20;
pub const WIFI_BARS: u32 = 3;

pub type Line = Text<95>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Network {
    /// Signal bars, 0 to 3.
    Wifi(u32),
    Wired,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Reading {
    pub battery_percent: Option<u32>,
    pub charging: Option<bool>,
    pub temperature_c: Option<i32>,
    pub network: Option<Network>,
}

fn part(out: &mut Line) {
    if !out.is_empty() {
        out.push_str(" | ");
    }
}

pub fn line(reading: &Reading) -> Line {
    let mut out = Line::new();
    if let Some(percent) = reading.battery_percent {
        let _ = write!(out, "Battery {percent}%");
        if reading.charging == Some(true) {
            out.push_str(" charging");
        }
    }
    if let Some(celsius) = reading.temperature_c {
        part(&mut out);
        let _ = write!(out, "{celsius} \u{b0}C");
    }
    match reading.network {
        Some(Network::Wifi(bars)) => {
            part(&mut out);
            let _ = write!(out, "Wi-Fi {}/{WIFI_BARS}", bars.min(WIFI_BARS));
        }
        Some(Network::Wired) => {
            part(&mut out);
            out.push_str("Wired");
        }
        None => {}
    }
    out
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, PartialOrd, Ord)]
enum Warned {
    #[default]
    No,
    Low,
    Critical,
}

/// Warns once at 15 % and once at 5 % while a stream plays on battery.
#[derive(Clone, Copy, Debug, Default)]
pub struct LowBattery {
    warned: Warned,
}

impl LowBattery {
    pub fn check(&mut self, reading: &Reading, streaming: bool) -> Option<Line> {
        let percent = reading.battery_percent?;
        if reading.charging == Some(true) || percent >= REARM_PERCENT {
            self.warned = Warned::No;
            return None;
        }
        let level = if percent <= CRITICAL_PERCENT {
            Warned::Critical
        } else if percent <= LOW_PERCENT {
            Warned::Low
        } else {
            return None;
        };
        if !streaming || level <= self.warned {
            return None;
        }
        self.warned = level;
        let mut out = Line::new();
        let _ = match level {
            Warned::Critical => write!(out, "Battery {percent}%: the console will sleep soon"),
            _ => write!(out, "Battery {percent}%: connect the charger"),
        };
        Some(out)
    }
}
