//! `/serverinfo`: who the host is, whether it knows this console, and what it is running.

use alloc::string::String;

use crate::xml;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    /// The body's own status, as Sunshine reports 401 for an unknown certificate.
    Status(u16),
    Malformed,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ServerInfo {
    pub hostname: String,
    pub uniqueid: String,
    pub app_version: String,
    pub https_port: u16,
    pub http_port: u16,
    /// Always false over HTTP; over HTTPS a reply at all means the certificate is known.
    pub paired: bool,
    pub current_game: u32,
    pub state: String,
    pub mac: Option<[u8; 6]>,
    pub codec_support: u32,
}

impl ServerInfo {
    /// The host's major version; Sunshine reports 7.
    pub fn generation(&self) -> Option<u32> {
        self.app_version.split('.').next()?.trim().parse().ok()
    }

    pub fn busy(&self) -> bool {
        self.state.ends_with("_SERVER_BUSY")
    }
}

fn mac(text: &str) -> Option<[u8; 6]> {
    let mut bytes = [0; 6];
    let mut parts = text.trim().split(':');
    for byte in &mut bytes {
        *byte = u8::from_str_radix(parts.next()?, 16).ok()?;
    }
    let real = parts.next().is_none() && bytes != [0; 6];
    real.then_some(bytes)
}

pub fn parse(body: &str) -> Result<ServerInfo, Error> {
    match xml::root_status(body) {
        Some((200, _)) => {}
        Some((code, _)) => return Err(Error::Status(code)),
        None => return Err(Error::Malformed),
    }

    let number = |tag: &str| xml::text(body, tag).and_then(|text| text.trim().parse::<u64>().ok());
    let port = |tag: &str| number(tag).and_then(|port| u16::try_from(port).ok());
    let word = |tag: &str| number(tag).and_then(|value| u32::try_from(value).ok());
    let uniqueid = xml::text(body, "uniqueid").ok_or(Error::Malformed)?;
    let app_version = xml::text(body, "appversion").ok_or(Error::Malformed)?;
    Ok(ServerInfo {
        hostname: xml::text(body, "hostname").unwrap_or_default(),
        uniqueid,
        app_version,
        https_port: port("HttpsPort").unwrap_or(crate::HTTPS_PORT),
        http_port: port("ExternalPort").unwrap_or(crate::HTTP_PORT),
        paired: number("PairStatus") == Some(1),
        current_game: word("currentgame").unwrap_or(0),
        state: xml::text(body, "state").unwrap_or_default(),
        mac: xml::text(body, "mac").as_deref().and_then(mac),
        codec_support: word("ServerCodecModeSupport").unwrap_or(0),
    })
}
