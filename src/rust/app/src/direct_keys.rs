//! What the console keeps for the Sunshine hosts it paired with itself: for each host, the
//! GameStream identity made when pairing it and the host's pinned certificate, in the
//! `sunshine` file. A host gets a new identity each time it is paired, so an entry Sunshine
//! still lists for an older pairing never matches the console's certificate.
//! Format: moonlight-nx2-dev/src/rust/sunshine/README.md, "Keys file".

extern crate alloc;

use alloc::{string::String, vec::Vec};

use moonlight_nx2_sunshine::{hex, identity::Identity};
use moonlight_nx2_ui::{
    model::{Address, is_address},
    store::Files,
};
use zeroize::Zeroizing;

pub const FILE: &str = "sunshine";
pub const MAX_HOSTS: usize = 16;
/// Each host line holds an RSA-2048 key, its certificate and the host's own, about 6 KB.
pub const MAX_BYTES: usize = 128 * 1024;
const HEADER: &str = "sunshine 2";
/// One identity for every host, before each host got its own.
const HEADER_V1: &str = "sunshine 1";

pub use crate::pairings::Loaded;

#[derive(Clone)]
pub struct Stored {
    pub uniqueid: String,
    pub key: Zeroizing<Vec<u8>>,
    pub cert: Vec<u8>,
}

impl Stored {
    fn of(identity: &Identity) -> Option<Self> {
        Some(Self {
            uniqueid: String::from(identity.uniqueid()),
            key: identity.key_der()?,
            cert: identity.cert_der().to_vec(),
        })
    }

    pub fn identity(&self) -> Option<Identity> {
        Identity::from_der(&self.key, &self.cert, &self.uniqueid).ok()
    }
}

/// A paired host: the identity this console shows it and the certificate it pinned.
struct Host {
    address: Address,
    identity: Stored,
    server: Vec<u8>,
}

#[derive(Default)]
pub struct Keys {
    hosts: Vec<Host>,
}

fn stored(uniqueid: &str, key: &str, cert: &str) -> Option<Stored> {
    Some(Stored {
        uniqueid: String::from(uniqueid),
        key: Zeroizing::new(hex::decode(key)?),
        cert: hex::decode(cert)?,
    })
}

impl Keys {
    pub fn parse(text: &[u8]) -> Option<Self> {
        let text = core::str::from_utf8(text).ok()?;
        let mut lines = text.lines();
        match lines.next()? {
            HEADER => {}
            HEADER_V1 => return Self::parse_v1(lines),
            _ => return None,
        }

        let mut keys = Self::default();
        for line in lines.filter(|line| !line.is_empty()) {
            let words: Vec<&str> = line.split(' ').collect();
            let ["host", address, uniqueid, key, cert, server] = words[..] else {
                return None;
            };
            let identity = stored(uniqueid, key, cert)?;
            keys.add(address, identity, hex::decode(server)?)?;
        }
        Some(keys)
    }

    /// The single identity of a version 1 book goes to each host it paired.
    fn parse_v1<'a>(lines: impl Iterator<Item = &'a str>) -> Option<Self> {
        let mut identity = None;
        let mut servers = Vec::new();
        for line in lines.filter(|line| !line.is_empty()) {
            let words: Vec<&str> = line.split(' ').collect();
            match words[..] {
                ["identity", uniqueid, key, cert] if identity.is_none() => {
                    identity = Some(stored(uniqueid, key, cert)?);
                }
                ["host", address, server] => servers.push((address, hex::decode(server)?)),
                _ => return None,
            }
        }
        let mut keys = Self::default();
        if let Some(identity) = identity {
            for (address, server) in servers {
                keys.add(address, identity.clone(), server)?;
            }
        }
        Some(keys)
    }

    fn add(&mut self, address: &str, identity: Stored, server: Vec<u8>) -> Option<()> {
        is_address(address).then_some(())?;
        let address = Address::of(address);
        (self.hosts.len() < MAX_HOSTS && self.server(&address).is_none()).then_some(())?;
        self.hosts.push(Host {
            address,
            identity,
            server,
        });
        Some(())
    }

    pub fn format(&self) -> Option<Zeroizing<Vec<u8>>> {
        let mut text = Zeroizing::new(String::from(HEADER));
        text.push('\n');
        for host in &self.hosts {
            text.push_str("host ");
            text.push_str(host.address.as_str());
            text.push(' ');
            text.push_str(&host.identity.uniqueid);
            text.push(' ');
            text.push_str(&Zeroizing::new(hex::encode(&host.identity.key)));
            text.push(' ');
            text.push_str(&hex::encode(&host.identity.cert));
            text.push(' ');
            text.push_str(&hex::encode(&host.server));
            text.push('\n');
        }
        (text.len() <= MAX_BYTES).then(|| Zeroizing::new(text.as_bytes().to_vec()))
    }

    pub fn load(files: &mut impl Files) -> (Self, Loaded) {
        if !files.exists(FILE) {
            return (Self::default(), Loaded::Missing);
        }
        let mut text = Zeroizing::new(alloc::vec![0; MAX_BYTES + 1]);
        let parsed = files
            .read(FILE, &mut text)
            .and_then(|length| Self::parse(&text[..length]));
        match parsed {
            Some(keys) => (keys, Loaded::Read),
            None => (Self::default(), Loaded::Damaged),
        }
    }

    pub fn save(&self, files: &mut impl Files) -> bool {
        self.format().is_some_and(|text| files.write(FILE, &text))
    }

    fn host(&self, address: &Address) -> Option<&Host> {
        self.hosts.iter().find(|host| host.address == *address)
    }

    /// The identity this console shows the host at `address`.
    pub fn identity(&self, address: &Address) -> Option<&Stored> {
        self.host(address).map(|host| &host.identity)
    }

    pub fn server(&self, address: &Address) -> Option<&[u8]> {
        self.host(address).map(|host| host.server.as_slice())
    }

    /// Keeps `identity` and the host's `server` certificate for `address`, replacing what it
    /// had; false when the book is full or the key cannot be encoded.
    pub fn pin(&mut self, address: &Address, identity: &Identity, server: &[u8]) -> bool {
        let Some(identity) = Stored::of(identity) else {
            return false;
        };
        if let Some(host) = self.hosts.iter_mut().find(|host| host.address == *address) {
            host.identity = identity;
            host.server = server.to_vec();
            return true;
        }
        if self.hosts.len() == MAX_HOSTS {
            return false;
        }
        self.hosts.push(Host {
            address: *address,
            identity,
            server: server.to_vec(),
        });
        true
    }

    /// Drops the host's identity with its pin, so pairing it again shows a new certificate.
    pub fn forget(&mut self, address: &Address) -> bool {
        let before = self.hosts.len();
        self.hosts.retain(|host| host.address != *address);
        self.hosts.len() != before
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use moonlight_nx2_sunshine::random::Random;

    fn fill(bytes: &mut [u8]) -> bool {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(bytes))
            .is_ok()
    }

    fn rig() -> Address {
        Address::of("192.168.8.245")
    }

    #[test]
    fn a_version_1_book_gives_its_identity_to_each_paired_host() {
        let v1 = b"sunshine 1\nidentity 93DD5A0B8D24E4E0 0a0b 0c0d\nhost 192.168.8.245 0e0f\nhost 192.168.8.9 1011\n";
        let keys = Keys::parse(v1).unwrap();
        for (host, server) in [
            (rig(), [0x0e, 0x0f]),
            (Address::of("192.168.8.9"), [0x10, 0x11]),
        ] {
            let identity = keys.identity(&host).unwrap();
            assert_eq!(identity.uniqueid, "93DD5A0B8D24E4E0");
            assert_eq!(
                (identity.key.as_slice(), identity.cert.as_slice()),
                (&[0x0a, 0x0b][..], &[0x0c, 0x0d][..])
            );
            assert_eq!(keys.server(&host), Some(&server[..]));
        }

        let migrated = Keys::parse(&keys.format().unwrap()).unwrap();
        assert!(
            migrated
                .format()
                .unwrap()
                .starts_with(b"sunshine 2\nhost 192.168.8.245 93DD5A0B8D24E4E0 0a0b 0c0d 0e0f\n")
        );
        assert_eq!(
            migrated.identity(&rig()).unwrap().uniqueid,
            "93DD5A0B8D24E4E0"
        );

        let unpaired = Keys::parse(b"sunshine 1\nidentity 93DD5A0B8D24E4E0 0a0b 0c0d\n").unwrap();
        assert!(unpaired.identity(&rig()).is_none());
    }

    #[test]
    fn forgetting_a_host_makes_its_next_pairing_show_a_new_certificate() {
        let first = Identity::generate(Random(fill)).unwrap();
        let mut keys = Keys::default();
        assert!(keys.pin(&rig(), &first, b"server"));
        assert!(keys.forget(&rig()));
        assert!(keys.identity(&rig()).is_none() && keys.server(&rig()).is_none());

        let second = Identity::generate(Random(fill)).unwrap();
        assert!(keys.pin(&rig(), &second, b"server"));
        let loaded = Keys::parse(&keys.format().unwrap()).unwrap();
        let kept = loaded.identity(&rig()).unwrap();
        assert_eq!(kept.uniqueid, second.uniqueid());
        assert_ne!(kept.cert, first.cert_der());
        assert_eq!(kept.identity().unwrap().cert_der(), second.cert_der());
    }

    #[test]
    fn the_book_holds_every_host_with_its_own_key() {
        let identity = Identity::generate(Random(fill)).unwrap();
        let mut keys = Keys::default();
        for host in 0..MAX_HOSTS {
            let address = Address::of(&alloc::format!("192.168.8.{}", host + 1));
            assert!(keys.pin(&address, &identity, &alloc::vec![0xab; 1400]));
        }
        assert!(!keys.pin(&Address::of("192.168.9.1"), &identity, b"server"));
        let size = keys.format().map(|text| text.len());
        assert!(size.is_some(), "a full book fits in {MAX_BYTES} bytes");
    }
}
