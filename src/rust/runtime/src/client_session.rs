//! Parses the one-time PC control session from local storage.

use moonlight_nx2_ui::model::{Address, Host, Name, is_address};

pub struct Session {
    pub address: [u8; 4],
    pub port: u16,
    pub token: [u8; 64],
    pub host: Host,
}

impl Drop for Session {
    fn drop(&mut self) {
        for byte in &mut self.token {
            unsafe { core::ptr::write_volatile(byte, 0) };
        }
    }
}

impl Session {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() >= 512 {
            return None;
        }
        let text = core::str::from_utf8(bytes).ok()?;
        let mut session = Self {
            address: [0; 4],
            port: 0,
            token: [0; 64],
            host: Host {
                name: Name::of("PC"),
                ..Host::default()
            },
        };
        let mut seen = 0u8;
        for line in text.lines().filter(|line| !line.is_empty()) {
            let (key, value) = line.split_once('=')?;
            let bit = match key {
                "address" => {
                    if !is_address(value) {
                        return None;
                    }
                    for (out, part) in session.address.iter_mut().zip(value.split('.')) {
                        *out = part.parse().ok()?;
                    }
                    1
                }
                "port" => {
                    if value.is_empty()
                        || value.len() > 5
                        || !value.bytes().all(|b| b.is_ascii_digit())
                    {
                        return None;
                    }
                    session.port = value.parse().ok()?;
                    if session.port == 0 {
                        return None;
                    }
                    2
                }
                "token" => {
                    if value.len() != 64
                        || !value
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    {
                        return None;
                    }
                    session.token.copy_from_slice(value.as_bytes());
                    4
                }
                "host" => {
                    if !is_address(value) {
                        return None;
                    }
                    session.host.address = Address::of(value);
                    8
                }
                _ => return None,
            };
            if seen & bit != 0 {
                return None;
            }
            seen |= bit;
        }
        (seen == 15).then_some(session)
    }
}
