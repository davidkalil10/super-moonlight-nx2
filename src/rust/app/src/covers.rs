//! Bounded, sequential assembly of cover chunks from the PC helper.

extern crate alloc;

use crate::json::{self, Kind};
use alloc::vec::Vec;

pub const MAX_BYTES: usize = 4_194_304;
pub const CHUNK_BYTES: usize = 48_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Malformed,
    Unsupported,
    Backend,
    TooLarge,
    NoMemory,
}

pub struct Cover {
    app: u32,
    total: Option<usize>,
    data: Vec<u8>,
}

impl Cover {
    pub fn new(app: u32) -> Option<Self> {
        (app != 0).then(|| Self {
            app,
            total: None,
            data: Vec::new(),
        })
    }

    pub fn offset(&self) -> usize {
        self.data.len()
    }

    pub fn bytes(&self) -> Option<&[u8]> {
        (self.total == Some(self.data.len())).then_some(&self.data)
    }

    pub fn into_bytes(self) -> Option<Vec<u8>> {
        (self.total == Some(self.data.len())).then_some(self.data)
    }

    pub fn accept(&mut self, payload: &[u8]) -> Result<bool, Error> {
        let root = json::parse(payload).map_err(|_| Error::Malformed)?;
        if root.member("code").is_some() {
            let code = root.member("code").and_then(|x| x.as_plain_str());
            return Err(match code {
                Some("unsupported" | "invalid_request") => Error::Unsupported,
                Some("backend_failed") => Error::Backend,
                Some("too_large") => Error::TooLarge,
                _ => Error::Malformed,
            });
        }
        if root.kind() != Kind::Object
            || !root.member("event").is_some_and(|x| x.string_is("result"))
            || !root.member("op").is_some_and(|x| x.string_is("cover"))
        {
            return Err(Error::Malformed);
        }
        let ok = root
            .member("ok")
            .and_then(|x| x.as_bool())
            .ok_or(Error::Malformed)?;
        if !ok {
            let code = root.member("code").and_then(|x| x.as_plain_str());
            return Err(match code {
                Some("unsupported" | "invalid_request") => Error::Unsupported,
                Some("backend_failed") => Error::Backend,
                Some("too_large") => Error::TooLarge,
                _ => Error::Malformed,
            });
        }
        let value = root
            .member("value")
            .filter(|v| v.kind() == Kind::Object)
            .ok_or(Error::Malformed)?;
        let number = |key| {
            value
                .member(key)
                .and_then(|v| v.as_u64())
                .ok_or(Error::Malformed)
        };
        let app = u32::try_from(number("app")?).map_err(|_| Error::Malformed)?;
        let total = usize::try_from(number("total")?).map_err(|_| Error::Malformed)?;
        let offset = usize::try_from(number("offset")?).map_err(|_| Error::Malformed)?;
        let text = value
            .member("data")
            .and_then(|v| v.as_plain_str())
            .ok_or(Error::Malformed)?;
        if app != self.app
            || total == 0
            || total > MAX_BYTES
            || offset != self.data.len()
            || self.total.is_some_and(|previous| previous != total)
            || !value
                .member("mime")
                .is_some_and(|v| v.string_is("image/png"))
        {
            return Err(Error::Malformed);
        }
        let chunk = decode_base64(text.as_bytes())?;
        if chunk.is_empty()
            || chunk.len() > CHUNK_BYTES
            || offset
                .checked_add(chunk.len())
                .is_none_or(|end| end > total)
        {
            return Err(Error::Malformed);
        }
        self.data
            .try_reserve(chunk.len())
            .map_err(|_| Error::NoMemory)?;
        self.data.extend_from_slice(&chunk);
        self.total = Some(total);
        Ok(self.data.len() == total)
    }
}

fn decode_base64(text: &[u8]) -> Result<Vec<u8>, Error> {
    if text.is_empty() || text.len() % 4 != 0 || text.len() > CHUNK_BYTES.div_ceil(3) * 4 {
        return Err(Error::Malformed);
    }
    let mut out = Vec::new();
    out.try_reserve(text.len() / 4 * 3)
        .map_err(|_| Error::NoMemory)?;
    let value = |b| match b {
        b'A'..=b'Z' => Some(b - b'A'),
        b'a'..=b'z' => Some(b - b'a' + 26),
        b'0'..=b'9' => Some(b - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    for (index, group) in text.chunks_exact(4).enumerate() {
        let a = value(group[0]).ok_or(Error::Malformed)?;
        let b = value(group[1]).ok_or(Error::Malformed)?;
        let last = index + 1 == text.len() / 4;
        let c = if group[2] == b'=' {
            0
        } else {
            value(group[2]).ok_or(Error::Malformed)?
        };
        let d = if group[3] == b'=' {
            0
        } else {
            value(group[3]).ok_or(Error::Malformed)?
        };
        if (group[2] == b'=' && (group[3] != b'=' || b & 15 != 0))
            || (group[3] == b'=' && group[2] != b'=' && c & 3 != 0)
            || (!last && (group[2] == b'=' || group[3] == b'='))
        {
            return Err(Error::Malformed);
        }
        out.push(a << 2 | b >> 4);
        if group[2] != b'=' {
            out.push(b << 4 | c >> 2);
        }
        if group[3] != b'=' {
            out.push(c << 6 | d);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chunks_validate_offsets_and_padding() {
        let mut cover = Cover::new(7).unwrap();
        assert_eq!(cover.accept(br#"{"event":"result","op":"cover","ok":true,"value":{"app":7,"mime":"image/png","total":4,"offset":0,"data":"AQID"}}"#), Ok(false));
        assert_eq!(cover.accept(br#"{"event":"result","op":"cover","ok":true,"value":{"app":7,"mime":"image/png","total":4,"offset":2,"data":"BA=="}}"#), Err(Error::Malformed));
        assert_eq!(cover.accept(br#"{"event":"result","op":"cover","ok":true,"value":{"app":7,"mime":"image/png","total":4,"offset":3,"data":"BA=="}}"#), Ok(true));
        assert_eq!(cover.bytes(), Some(&[1, 2, 3, 4][..]));
        assert!(decode_base64(b"AB==").is_err());
    }
}
