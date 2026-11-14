//! `/launch` and `/resume`: start the app with the stream key, and learn where RTSP is.

use alloc::{format, string::String};

use crate::{
    hex,
    serverinfo::Error,
    stream::{Request, StreamKey},
    xml,
};

pub const DEFAULT_RTSP_PORT: u16 = 48010;

/// Options the user picked that are not part of the stream shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Options {
    /// Let Sunshine change the PC's display mode to the stream's.
    pub sops: bool,
    /// Keep playing the sound on the PC too.
    pub local_audio: bool,
}

pub fn channel_mask(channels: u8) -> u16 {
    match channels {
        6 => 0x3f,
        8 => 0x63f,
        _ => 0x3,
    }
}

/// The path and query after the common `uniqueid` and `uuid` arguments.
pub fn target(
    app: u32,
    resume: bool,
    request: &Request,
    key: &StreamKey,
    options: Options,
) -> String {
    let path = if resume { "resume" } else { "launch" };
    let surround =
        u32::from(channel_mask(request.audio_channels)) << 16 | u32::from(request.audio_channels);
    let mut target = format!(
        "/{path}?appid={app}&mode={}x{}x{}&additionalStates=1&sops={}&rikey={}&rikeyid={}\
         &localAudioPlayMode={}&surroundAudioInfo={surround}&remoteControllersBitmap={}&gcmap={}\
         &gcpersist=0",
        request.width,
        request.height,
        request.fps,
        u8::from(options.sops),
        hex::encode(&key.key),
        key.key_id,
        u8::from(options.local_audio),
        request.controllers,
        request.controllers,
    );
    if request.hdr {
        target.push_str(
            "&hdrMode=1&clientHdrCapVersion=0&clientHdrCapSupportedFlagsInUint32=0\
             &clientHdrCapMetaDataId=NV_STATIC_METADATA_TYPE_1\
             &clientHdrCapDisplayData=0x0x0x0x0x0x0x0x0x0x0",
        );
    }
    target
}

/// The RTSP port from the reply, after checking the host started or resumed the app.
pub fn parse(body: &str, resume: bool) -> Result<u16, Error> {
    match xml::root_status(body) {
        Some((200, _)) => {}
        Some((code, _)) => return Err(Error::Status(code)),
        None => return Err(Error::Malformed),
    }
    let flag = if resume { "resume" } else { "gamesession" };
    if xml::text(body, flag).is_none_or(|value| value.trim() == "0") {
        return Err(Error::Status(0));
    }
    let Some(url) = xml::text(body, "sessionUrl0") else {
        return Ok(DEFAULT_RTSP_PORT);
    };
    let authority = url
        .strip_prefix("rtsp://")
        .ok_or(Error::Malformed)?
        .split('/')
        .next()
        .unwrap_or_default();
    match authority.rsplit_once(':') {
        Some((_, port)) => port.parse().map_err(|_| Error::Malformed),
        None => Ok(DEFAULT_RTSP_PORT),
    }
}
