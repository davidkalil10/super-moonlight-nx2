//! What the console keeps for the Sunshine hosts it paired with itself: its GameStream
//! identity and each host's pinned certificate, in the `sunshine` file.
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
pub const MAX_BYTES: usize = 64 * 1024;
const HEADER: &str = "sunshine 1";

pub use crate::pairings::Loaded;

pub struct Stored {
    pub uniqueid: String,
    pub key: Zeroizing<Vec<u8>>,
    pub cert: Vec<u8>,
}

#[derive(Default)]
pub struct Keys {
    identity: Option<Stored>,
    hosts: Vec<(Address, Vec<u8>)>,
}

impl Keys {
    pub fn parse(text: &[u8]) -> Option<Self> {
        let text = core::str::from_utf8(text).ok()?;
        let mut lines = text.lines();
        if lines.next()? != HEADER {
            return None;
        }

        let mut keys = Self::default();
        for line in lines.filter(|line| !line.is_empty()) {
            let mut words = line.split(' ');
            match (words.next()?, words.next()?, words.next()?) {
                ("identity", uniqueid, key) if keys.identity.is_none() => {
                    keys.identity = Some(Stored {
                        uniqueid: String::from(uniqueid),
                        key: Zeroizing::new(hex::decode(key)?),
                        cert: hex::decode(words.next()?)?,
                    });
                }
                ("host", address, cert) if is_address(address) => {
                    let address = Address::of(address);
                    let fits = keys.hosts.len() < MAX_HOSTS && keys.server(&address).is_none();
                    fits.then_some(())?;
                    keys.hosts.push((address, hex::decode(cert)?));
                }
                _ => return None,
            }
            words.next().is_none().then_some(())?;
        }
        Some(keys)
    }

    pub fn format(&self) -> Option<Zeroizing<Vec<u8>>> {
        let mut text = Zeroizing::new(String::from(HEADER));
        text.push('\n');
        if let Some(identity) = &self.identity {
            text.push_str("identity ");
            text.push_str(&identity.uniqueid);
            text.push(' ');
            text.push_str(&Zeroizing::new(hex::encode(&identity.key)));
            text.push(' ');
            text.push_str(&hex::encode(&identity.cert));
            text.push('\n');
        }
        for (address, cert) in &self.hosts {
            text.push_str("host ");
            text.push_str(address.as_str());
            text.push(' ');
            text.push_str(&hex::encode(cert));
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

    pub fn identity(&self) -> Option<&Stored> {
        self.identity.as_ref()
    }

    pub fn set_identity(&mut self, identity: &Identity) -> bool {
        let Some(key) = identity.key_der() else {
            return false;
        };
        self.identity = Some(Stored {
            uniqueid: String::from(identity.uniqueid()),
            key,
            cert: identity.cert_der().to_vec(),
        });
        true
    }

    pub fn server(&self, address: &Address) -> Option<&[u8]> {
        self.hosts
            .iter()
            .find(|(host, _)| host == address)
            .map(|(_, cert)| cert.as_slice())
    }

    /// Pins `cert` for `address`; false when the book is full.
    pub fn pin(&mut self, address: &Address, cert: &[u8]) -> bool {
        if let Some((_, pinned)) = self.hosts.iter_mut().find(|(host, _)| host == address) {
            *pinned = cert.to_vec();
            return true;
        }
        if self.hosts.len() == MAX_HOSTS {
            return false;
        }
        self.hosts.push((*address, cert.to_vec()));
        true
    }

    pub fn forget(&mut self, address: &Address) -> bool {
        let before = self.hosts.len();
        self.hosts.retain(|(host, _)| host != address);
        self.hosts.len() != before
    }
}
