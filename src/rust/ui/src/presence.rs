//! Whether each saved PC answers on Sunshine's port, for the hosts page and Wake-on-LAN.
//! Follows the r5-wol service: a 1 s TCP connect to 47989 says a PC is awake.

use crate::model::{Address, Host, MAX_HOSTS};

/// Sunshine's HTTP port at the default port base, which the helper also assumes.
pub const SUNSHINE_PORT: u16 = 47989;
/// A connect that has not finished by now counts as no answer.
pub const ANSWER_TIMEOUT_MS: u64 = 1_000;
/// Pause between two passes over the saved PCs.
pub const ROUND_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Presence {
    #[default]
    Unknown,
    Online,
    Offline,
    Waking,
}

impl Presence {
    pub fn label(self) -> Option<&'static str> {
        match self {
            Self::Unknown => None,
            Self::Online => Some("Online"),
            Self::Offline => Some("Offline"),
            Self::Waking => Some("Waking\u{2026}"),
        }
    }
}

/// A dotted IPv4 address as bytes; names are not resolved on the console.
pub fn ipv4(address: &str) -> Option<[u8; 4]> {
    let mut out = [0; 4];
    let mut parts = address.split('.');
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        *slot = part.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// The subnet broadcast address of `address`, or the limited broadcast without a usable mask.
pub fn directed_broadcast(address: [u8; 4], mask: Option<[u8; 4]>) -> [u8; 4] {
    match mask {
        Some(mask) if mask != [0; 4] && mask != [255; 4] => {
            core::array::from_fn(|index| address[index] | !mask[index])
        }
        _ => [255; 4],
    }
}

/// What is known about each saved PC, by address.
#[derive(Clone)]
pub struct Table {
    entries: [(Address, Presence); MAX_HOSTS],
    count: usize,
}

impl Default for Table {
    fn default() -> Self {
        Self {
            entries: [(Address::new(), Presence::Unknown); MAX_HOSTS],
            count: 0,
        }
    }
}

impl Table {
    pub fn get(&self, address: &Address) -> Presence {
        self.entries[..self.count]
            .iter()
            .find(|(known, _)| known == address)
            .map_or(Presence::Unknown, |(_, presence)| *presence)
    }

    /// True when the stored state changed.
    pub fn set(&mut self, address: &Address, presence: Presence) -> bool {
        if let Some((_, known)) = self.entries[..self.count]
            .iter_mut()
            .find(|(known, _)| known == address)
        {
            let changed = *known != presence;
            *known = presence;
            return changed;
        }
        if presence == Presence::Unknown {
            return false;
        }
        if self.count == MAX_HOSTS {
            self.entries.copy_within(1.., 0);
            self.count -= 1;
        }
        self.entries[self.count] = (*address, presence);
        self.count += 1;
        true
    }

    /// Forgets PCs that are no longer saved.
    pub fn retain(&mut self, hosts: &[Host]) {
        let mut kept = 0;
        for index in 0..self.count {
            let entry = self.entries[index];
            if hosts.iter().any(|host| host.address == entry.0) {
                self.entries[kept] = entry;
                kept += 1;
            }
        }
        self.count = kept;
    }
}

/// Picks which saved PC to ask next: one at a time, a pause after each full pass.
#[derive(Clone, Copy, Debug, Default)]
pub struct Rounds {
    next: usize,
    resume_ms: u64,
}

impl Rounds {
    /// The index of the PC to ask now, if any is due.
    pub fn next(&mut self, hosts: usize, now_ms: u64) -> Option<usize> {
        if hosts == 0 || now_ms < self.resume_ms {
            return None;
        }
        if self.next >= hosts {
            self.next = 0;
            self.resume_ms = now_ms.saturating_add(ROUND_MS);
            return None;
        }
        let index = self.next;
        self.next += 1;
        Some(index)
    }

    /// Starts a new pass at once, after the saved PCs changed.
    pub fn restart(&mut self) {
        *self = Self::default();
    }
}
