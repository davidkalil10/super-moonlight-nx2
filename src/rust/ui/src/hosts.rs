//! The saved hosts and the removed list of hosts.json. Port of
//! dev legacy/src/streamer/ui/hosts.js and the remember/remove steps of service.js; rules in
//! dev docs/src/streamer/ui/CLAUDE.md, "Hosts".

use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write;

use crate::extras::{AppOverride, Extras, INHERIT, MAX_OVERRIDES};
use crate::json::{Json, Kind, Value};
use crate::model::{Address, Host, MAX_HOSTS, Mac, Name};

pub const FILE: &str = "hosts.json";

/// The keys of `AppOverride::values`, in order.
const OVERRIDE_KEYS: [&str; 4] = ["size", "fps", "bitrate", "codec"];

/// The written file stays within what the JSON reader takes back.
pub const MAX_BYTES: usize = crate::json::MAX_TEXT;

/// A removed host: discovery does not add it back until it is listed again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Removed {
    pub address: Address,
    pub uniqueid: Address,
}

#[cfg(test)]
mod mac_tests {
    use super::*;

    #[test]
    fn first_mac_survives_host_roundtrip_and_old_updates() {
        let mut json = Json::new();
        let mut book = HostBook::parse(
            br#"[{"name":"PC","address":"192.168.0.2","mac":"02:12:34:56:78:9a"}]"#,
            &mut json,
        )
        .unwrap();
        let mac = Mac::parse("02:12:34:56:78:9a").unwrap();
        let packet = mac.magic_packet();
        assert_eq!(&packet[..6], &[0xff; 6]);
        assert!(packet[6..].chunks_exact(6).all(|chunk| chunk == mac.0));
        assert_eq!(book.hosts()[0].mac, Some(mac));
        let mut host = book.hosts()[0];
        host.mac = None;
        host.uniqueid = Address::of("new-id");
        assert!(book.remember(&host).unwrap());
        let encoded = book.to_json().unwrap();
        let read = HostBook::parse(encoded.as_bytes(), &mut json).unwrap();
        assert_eq!(read.hosts()[0].mac, Some(mac));
        assert!(Mac::parse("ff:ff:ff:ff:ff:ff").is_none());
        assert!(Mac::parse("02:12:34:56:78:9A").is_none());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// The file exists but could not be read whole, so it must not be overwritten.
    Unreadable,
    /// More saved hosts than the model shows.
    TooMany,
}

impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Self::Unreadable => "hosts.json could not be read",
            Self::TooMany => "hosts.json has more hosts than the console shows",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostBook {
    hosts: Vec<Host>,
    removed: Vec<Removed>,
    overrides: Vec<AppOverride>,
    played: Vec<(Address, Name)>,
    dirty: bool,
}

/// JavaScript's `String.prototype.trim` set: Rust's White_Space without U+0085, plus U+FEFF.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

fn string<'a>(value: Option<Value<'a>>) -> Option<&'a str> {
    core::str::from_utf8(value?.string()?).ok()
}

/// `same`: the same uniqueid when both know one, else the same address.
fn same(a: (&Address, &Address), b: (&Address, &Address)) -> bool {
    if !a.1.is_empty() && !b.1.is_empty() {
        return a.1.as_str() == b.1.as_str();
    }
    a.0.as_str() == b.0.as_str()
}

/// Entries with an address, trimmed, each address once with the first kept. Addresses and
/// uniqueids too long for the model are dropped rather than cut into another host's address.
fn entries<'a>(list: Option<Value<'a>>) -> Vec<(Value<'a>, Removed)> {
    let mut kept: Vec<(Value<'a>, Removed)> = Vec::new();
    let Some(list) = list.filter(|list| list.kind() == Kind::Array) else {
        return kept;
    };

    let mut entry = list.child();
    while let Some(value) = entry {
        entry = value.next();
        let Some(address) = string(value.member("address")).map(|text| text.trim_matches(js_space))
        else {
            continue;
        };
        let uniqueid = string(value.member("uniqueid")).unwrap_or("");
        let fits = address.len() <= 63 && uniqueid.len() <= 63;
        let seen = kept
            .iter()
            .any(|(_, host)| host.address.as_str() == address);
        if address.is_empty() || seen || !fits {
            continue;
        }
        let host = Removed {
            address: Address::of(address),
            uniqueid: Address::of(uniqueid),
        };
        kept.push((value, host));
    }
    kept
}

/// JSON string quoting as `JSON.stringify` writes it.
fn quote(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        let _ = match c {
            '"' => out.write_str("\\\""),
            '\\' => out.write_str("\\\\"),
            '\u{8}' => out.write_str("\\b"),
            '\u{c}' => out.write_str("\\f"),
            '\n' => out.write_str("\\n"),
            '\r' => out.write_str("\\r"),
            '\t' => out.write_str("\\t"),
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32),
            c => out.write_char(c),
        };
    }
    out.push('"');
}

fn put_uniqueid(out: &mut String, uniqueid: &Address) {
    if !uniqueid.is_empty() {
        out.push_str(",\"uniqueid\":");
        quote(out, uniqueid.as_str());
    }
}

impl HostBook {
    /// hosts.json as written, `{hosts, removed}`, or the plain host array of older versions.
    /// Anything malformed reads as no hosts, as in hosts.js.
    pub fn parse(text: &[u8], json: &mut Json) -> Result<Self, Error> {
        let mut book = Self::default();
        let Some(root) = json.parse(text) else {
            return Ok(book);
        };
        let (hosts, removed) = match root.kind() {
            Kind::Array => (Some(root), None),
            Kind::Object => (root.member("hosts"), root.member("removed")),
            _ => (None, None),
        };

        let hosts = entries(hosts);
        if hosts.len() > MAX_HOSTS {
            return Err(Error::TooMany);
        }
        for (value, host) in hosts {
            let name = string(value.member("name")).filter(|name| !name.is_empty());
            book.hosts.push(Host {
                name: Name::of(name.unwrap_or(host.address.as_str())),
                address: host.address,
                uniqueid: host.uniqueid,
                mac: string(value.member("mac")).and_then(Mac::parse),
            });
            book.read_extras(&value, host.address);
        }
        book.removed = entries(removed).into_iter().map(|(_, host)| host).collect();
        Ok(book)
    }

    pub fn hosts(&self) -> &[Host] {
        &self.hosts
    }

    fn read_extras(&mut self, entry: &Value<'_>, address: Address) {
        if let Some(name) = string(entry.member("lastPlayed")).filter(|name| !name.is_empty()) {
            self.played.push((address, Name::of(name)));
        }
        let mut app = entry
            .member("apps")
            .filter(|a| a.kind() == Kind::Array)
            .and_then(|a| a.child());
        while let Some(value) = app {
            app = value.next();
            let Some(id) = value.member("id").and_then(|id| id.number()) else {
                continue;
            };
            let mut stored = AppOverride::new(address, id as u32);
            for (slot, key) in OVERRIDE_KEYS.iter().enumerate() {
                if let Some(index) = value.member(key).and_then(|index| index.number()) {
                    stored.values[slot] = (index as u32).min(u32::from(INHERIT - 1)) as u8;
                }
            }
            if !stored.is_empty() && self.overrides.len() < MAX_OVERRIDES {
                self.overrides.push(stored);
            }
        }
    }

    /// What is remembered per PC, for the model.
    pub fn extras(&self) -> Extras<'_> {
        Extras {
            overrides: &self.overrides,
            played: &self.played,
        }
    }

    /// Replaces the remembered extras with the model's; true when they differ.
    pub fn set_extras(&mut self, extras: Extras<'_>) -> bool {
        let known = |address: &Address| self.hosts.iter().any(|host| host.address == *address);
        let overrides: Vec<AppOverride> = extras
            .overrides
            .iter()
            .filter(|stored| known(&stored.host) && !stored.is_empty())
            .copied()
            .collect();
        let played: Vec<(Address, Name)> = extras
            .played
            .iter()
            .filter(|(address, _)| known(address))
            .copied()
            .collect();
        if overrides == self.overrides && played == self.played {
            return false;
        }
        self.overrides = overrides;
        self.played = played;
        self.dirty = true;
        true
    }

    pub fn removed(&self) -> &[Removed] {
        &self.removed
    }

    /// Whether the book changed since it was read or last saved.
    pub fn dirty(&self) -> bool {
        self.dirty
    }

    pub fn saved(&mut self) {
        self.dirty = false;
    }

    /// A host answered a list: it leaves the removed list, and a known uniqueid at a new
    /// address moves that entry there (a new DHCP lease) and drops any other entry at the
    /// address; an unknown host is appended. True when the host list changed.
    pub fn remember(&mut self, host: &Host) -> Result<bool, Error> {
        let before = self.removed.len();
        self.removed.retain(|entry| {
            !same(
                (&entry.address, &entry.uniqueid),
                (&host.address, &host.uniqueid),
            )
        });
        self.dirty |= self.removed.len() != before;

        let at_address = self
            .hosts
            .iter()
            .position(|entry| entry.address == host.address);
        let by_id = (!host.uniqueid.is_empty())
            .then(|| {
                self.hosts
                    .iter()
                    .position(|entry| entry.uniqueid == host.uniqueid)
            })
            .flatten();
        let Some(target) = by_id.or(at_address) else {
            if self.hosts.len() >= MAX_HOSTS {
                return Err(Error::TooMany);
            }
            self.hosts.push(*host);
            self.dirty = true;
            return Ok(true);
        };

        let entry = self.hosts[target];
        let moved = entry.address != host.address;
        let learned = (!host.uniqueid.is_empty() && entry.uniqueid != host.uniqueid)
            || (host.mac.is_some() && entry.mac != host.mac);
        if !moved && !learned {
            return Ok(false);
        }

        let mut updated = entry;
        updated.address = host.address;
        if !host.uniqueid.is_empty() {
            updated.uniqueid = host.uniqueid;
        }
        if host.mac.is_some() {
            updated.mac = host.mac;
        }
        let hosts = core::mem::take(&mut self.hosts);
        self.hosts = hosts
            .into_iter()
            .enumerate()
            .filter_map(|(index, other)| {
                if index == target {
                    return Some(updated);
                }
                (other.address != host.address).then_some(other)
            })
            .collect();
        self.dirty = true;
        Ok(true)
    }

    pub fn rename(&mut self, host: &Host) -> bool {
        let Some(entry) = self.hosts.iter_mut().find(|entry| {
            same(
                (&entry.address, &entry.uniqueid),
                (&host.address, &host.uniqueid),
            )
        }) else {
            return false;
        };
        if host.name.is_empty() || entry.name == host.name {
            return false;
        }
        entry.name = host.name;
        self.dirty = true;
        true
    }

    /// Hosts mDNS found are appended unless they are the same PC as a saved or removed one
    /// (merge in dev legacy/src/streamer/ui/discover.js); saved entries stay unchanged. True
    /// when added.
    pub fn discovered(&mut self, found: &[Host]) -> Result<bool, Error> {
        let mut added = false;
        for host in found {
            let key = (&host.address, &host.uniqueid);
            let known = self
                .hosts
                .iter()
                .any(|entry| same((&entry.address, &entry.uniqueid), key))
                || self
                    .removed
                    .iter()
                    .any(|entry| same((&entry.address, &entry.uniqueid), key));
            if known || host.address.is_empty() {
                continue;
            }
            if self.hosts.len() >= MAX_HOSTS {
                return Err(Error::TooMany);
            }
            self.hosts.push(*host);
            self.dirty = true;
            added = true;
        }
        Ok(added)
    }

    /// Drops the host and keeps it on the removed list; its pairing stays on the PC.
    pub fn forget(&mut self, host: &Host) {
        let entry = self
            .hosts
            .iter()
            .find(|other| other.address == host.address);
        let gone = Removed {
            address: entry.map_or(host.address, |entry| entry.address),
            uniqueid: entry.map_or(host.uniqueid, |entry| entry.uniqueid),
        };
        self.hosts.retain(|other| other.address != host.address);
        self.overrides.retain(|stored| stored.host != host.address);
        self.played.retain(|(address, _)| *address != host.address);
        self.removed.retain(|other| {
            !same(
                (&other.address, &other.uniqueid),
                (&gone.address, &gone.uniqueid),
            )
        });
        self.removed.push(gone);
        self.dirty = true;
    }

    /// Takes the host off the removed list so discovery can list it again.
    pub fn unremove(&mut self, host: &Host) {
        let before = self.removed.len();
        self.removed.retain(|other| {
            !same(
                (&other.address, &other.uniqueid),
                (&host.address, &host.uniqueid),
            )
        });
        self.dirty |= self.removed.len() != before;
    }

    fn write_extras(&self, out: &mut String, address: &Address) {
        if let Some((_, name)) = self.played.iter().find(|(known, _)| known == address) {
            out.push_str(",\"lastPlayed\":");
            quote(out, name.as_str());
        }
        let mut first = true;
        for stored in self
            .overrides
            .iter()
            .filter(|stored| stored.host == *address)
        {
            out.push_str(if first { ",\"apps\":[{" } else { ",{" });
            first = false;
            let _ = write!(out, "\"id\":{}", stored.app);
            for (key, value) in OVERRIDE_KEYS.iter().zip(stored.values) {
                if value != INHERIT {
                    let _ = write!(out, ",\"{key}\":{value}");
                }
            }
            out.push('}');
        }
        if !first {
            out.push(']');
        }
    }

    fn write(&self, removed: &[Removed]) -> String {
        let mut out = String::from("{\"hosts\":[");
        for (index, host) in self.hosts.iter().enumerate() {
            out.push_str(if index == 0 {
                "{\"name\":"
            } else {
                ",{\"name\":"
            });
            quote(&mut out, host.name.as_str());
            out.push_str(",\"address\":");
            quote(&mut out, host.address.as_str());
            put_uniqueid(&mut out, &host.uniqueid);
            if let Some(mac) = host.mac {
                out.push_str(",\"mac\":");
                quote(&mut out, mac.text().as_str());
            }
            self.write_extras(&mut out, &host.address);
            out.push('}');
        }
        out.push_str("],\"removed\":[");
        for (index, host) in removed.iter().enumerate() {
            out.push_str(if index == 0 {
                "{\"address\":"
            } else {
                ",{\"address\":"
            });
            quote(&mut out, host.address.as_str());
            put_uniqueid(&mut out, &host.uniqueid);
            out.push('}');
        }
        out.push_str("]}");
        out
    }

    /// The file, compact, as `JSON.stringify({hosts, removed})`. When it would not fit
    /// `MAX_BYTES` the oldest removed entries go first; None when the hosts alone do not fit.
    pub fn to_json(&self) -> Option<String> {
        (0..=self.removed.len())
            .map(|dropped| self.write(&self.removed[dropped..]))
            .find(|text| text.len() <= MAX_BYTES)
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    #[test]
    fn renamed_host_is_saved_and_discovery_does_not_overwrite_it() {
        let mut json = Json::new();
        let mut book = HostBook::parse(
            br#"[{"name":"Old","address":"192.168.0.5","uniqueid":"one"}]"#,
            &mut json,
        )
        .unwrap();
        let mut renamed = book.hosts()[0];
        renamed.name = Name::of("Game PC");
        assert!(book.rename(&renamed));
        let saved = book.to_json().unwrap();
        let mut restored = HostBook::parse(saved.as_bytes(), &mut json).unwrap();
        assert_eq!(restored.hosts()[0].name.as_str(), "Game PC");
        let mut discovered = renamed;
        discovered.name = Name::of("Other name");
        assert!(!restored.discovered(&[discovered]).unwrap());
        assert_eq!(restored.hosts()[0].name.as_str(), "Game PC");
    }
}

#[cfg(test)]
mod extras_tests {
    use super::*;

    const SAVED: &[u8] = br#"{"hosts":[{"name":"Desktop PC","address":"192.168.0.5","uniqueid":"one","lastPlayed":"Desktop","apps":[{"id":12,"size":3,"codec":1},{"id":30,"fps":1}]}],"removed":[]}"#;

    #[test]
    fn extras_round_trip_through_the_file() {
        let mut json = Json::new();
        let book = HostBook::parse(SAVED, &mut json).unwrap();
        let extras = book.extras();
        assert_eq!(extras.played[0].1.as_str(), "Desktop");
        assert_eq!(extras.overrides.len(), 2);
        assert_eq!(extras.overrides[0].app, 12);
        assert_eq!(extras.overrides[0].values, [3, INHERIT, INHERIT, 1]);

        let again = HostBook::parse(book.to_json().unwrap().as_bytes(), &mut json).unwrap();
        assert_eq!(again.extras().overrides, extras.overrides);
        assert_eq!(again.extras().played, extras.played);
    }

    #[test]
    fn files_without_extras_still_read_and_write_as_before() {
        let mut json = Json::new();
        let old = br#"[{"name":"Old","address":"192.168.0.5","uniqueid":"one"}]"#;
        let book = HostBook::parse(old, &mut json).unwrap();
        assert!(book.extras().overrides.is_empty());
        let text = book.to_json().unwrap();
        assert!(!text.contains("lastPlayed") && !text.contains("apps"));
    }

    #[test]
    fn forgetting_a_host_drops_its_extras() {
        let mut json = Json::new();
        let mut book = HostBook::parse(SAVED, &mut json).unwrap();
        let host = book.hosts()[0];
        book.forget(&host);
        assert!(book.extras().overrides.is_empty());
        assert!(book.extras().played.is_empty());
    }

    #[test]
    fn extras_of_unknown_hosts_are_not_kept() {
        let mut json = Json::new();
        let mut book = HostBook::parse(SAVED, &mut json).unwrap();
        let stray = AppOverride::new(Address::of("10.0.0.9"), 1);
        let kept = book.extras().overrides.to_vec();
        let mut all = kept.clone();
        all.push(AppOverride {
            values: [1, INHERIT, INHERIT, INHERIT],
            ..stray
        });
        let played = book.extras().played.to_vec();
        assert!(!book.set_extras(Extras {
            overrides: &all,
            played: &played,
        }));
        assert_eq!(book.extras().overrides, kept);
    }
}
