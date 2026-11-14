use std::collections::{HashMap, VecDeque};

pub const MAX_COVER_BYTES: usize = 4 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 48_000;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 8;
const MAX_HISTORY_ENTRIES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    InvalidRequest,
    BackendFailed,
    TooLarge,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct Key {
    host: String,
    app: u32,
}

struct Entry {
    key: Key,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct Cache {
    entries: VecDeque<Entry>,
    history: HashMap<Key, [u8; 32]>,
    bytes: usize,
}

impl Cache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains(&self, host: &str, app: u32) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.key.host == host && entry.key.app == app)
    }

    pub fn insert(
        &mut self,
        host: &str,
        app: u32,
        offset: usize,
        bytes: Vec<u8>,
        sha256: [u8; 32],
    ) -> Result<(), Error> {
        if host.is_empty() || host.len() > 255 || app == 0 {
            return Err(Error::InvalidRequest);
        }
        validate_png(&bytes)?;
        let key = Key {
            host: host.into(),
            app,
        };
        if offset != 0 && self.history.get(&key).is_some_and(|old| old != &sha256) {
            return Err(Error::BackendFailed);
        }
        if offset >= bytes.len() {
            return Err(Error::InvalidRequest);
        }
        if !self.history.contains_key(&key) && self.history.len() == MAX_HISTORY_ENTRIES {
            return Err(Error::BackendFailed);
        }
        if let Some(index) = self.entries.iter().position(|entry| entry.key == key) {
            self.bytes -= self.entries.remove(index).expect("cache entry").bytes.len();
        }
        while self.entries.len() >= MAX_CACHE_ENTRIES || self.bytes + bytes.len() > MAX_CACHE_BYTES
        {
            self.bytes -= self
                .entries
                .pop_front()
                .expect("nonempty cache")
                .bytes
                .len();
        }
        self.bytes += bytes.len();
        self.history.insert(key.clone(), sha256);
        self.entries.push_back(Entry { key, bytes });
        Ok(())
    }

    pub fn chunk(
        &mut self,
        host: &str,
        app: u32,
        offset: usize,
    ) -> Result<Option<serde_json::Value>, Error> {
        let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.key.host == host && entry.key.app == app)
        else {
            return Ok(None);
        };
        let entry = self.entries.remove(index).expect("cache entry");
        if offset >= entry.bytes.len() {
            self.entries.push_back(entry);
            return Err(Error::InvalidRequest);
        }
        let end = (offset + CHUNK_BYTES).min(entry.bytes.len());
        let result = serde_json::json!({"app":app,"mime":"image/png","total":entry.bytes.len(),"offset":offset,"data":encode_base64(&entry.bytes[offset..end])});
        self.entries.push_back(entry);
        Ok(Some(result))
    }
}

pub fn validate_png(bytes: &[u8]) -> Result<(), Error> {
    if bytes.len() > MAX_COVER_BYTES {
        return Err(Error::TooLarge);
    }
    if bytes.len() < 33 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[8..16] != b"\0\0\0\rIHDR" {
        return Err(Error::BackendFailed);
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().expect("IHDR width"));
    let height = u32::from_be_bytes(bytes[20..24].try_into().expect("IHDR height"));
    if width > 4096 || height > 4096 {
        return Err(Error::TooLarge);
    }
    if width == 0 || height == 0 {
        return Err(Error::BackendFailed);
    }
    Ok(())
}

pub fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        result.push(char::from(ALPHABET[((value >> 18) & 63) as usize]));
        result.push(char::from(ALPHABET[((value >> 12) & 63) as usize]));
        result.push(if chunk.len() > 1 {
            char::from(ALPHABET[((value >> 6) & 63) as usize])
        } else {
            '='
        });
        result.push(if chunk.len() > 2 {
            char::from(ALPHABET[(value & 63) as usize])
        } else {
            '='
        });
    }
    result
}

pub(crate) fn decode_base64(text: &str) -> Result<Vec<u8>, Error> {
    fn digit(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let input = text.as_bytes();
    if input.is_empty() || !input.len().is_multiple_of(4) || input.len() > CHUNK_BYTES * 4 / 3 {
        return Err(Error::BackendFailed);
    }
    let mut bytes = Vec::with_capacity(input.len() / 4 * 3);
    for (index, block) in input.as_chunks::<4>().0.iter().enumerate() {
        let last = index == input.len() / 4 - 1;
        let a = digit(block[0]).ok_or(Error::BackendFailed)?;
        let b = digit(block[1]).ok_or(Error::BackendFailed)?;
        let c = if block[2] == b'=' {
            0
        } else {
            digit(block[2]).ok_or(Error::BackendFailed)?
        };
        let d = if block[3] == b'=' {
            0
        } else {
            digit(block[3]).ok_or(Error::BackendFailed)?
        };
        if (block[2] == b'=' && (block[3] != b'=' || b & 15 != 0))
            || (block[3] == b'=' && block[2] != b'=' && c & 3 != 0)
            || (!last && (block[2] == b'=' || block[3] == b'='))
        {
            return Err(Error::BackendFailed);
        }
        bytes.push((a << 2) | (b >> 4));
        if block[2] != b'=' {
            bytes.push((b << 4) | (c >> 2));
        }
        if block[3] != b'=' {
            bytes.push((c << 6) | d);
        }
    }
    Ok(bytes)
}

pub(crate) fn parse_digest(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut result = [0; 32];
    for (index, value) in result.iter_mut().enumerate() {
        *value = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(size: usize) -> Vec<u8> {
        let mut bytes = vec![0; size];
        bytes[..16].copy_from_slice(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
        bytes[16..20].copy_from_slice(&600u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&800u32.to_be_bytes());
        bytes
    }

    #[test]
    fn chunks_and_rejects_bad_bounds_and_png() {
        let mut cache = Cache::new();
        let bytes = png(CHUNK_BYTES + 1);
        cache.insert("pc", 7, 0, bytes, [1; 32]).unwrap();
        let first = cache.chunk("pc", 7, 0).unwrap().unwrap();
        assert_eq!(first["total"], CHUNK_BYTES + 1);
        assert_eq!(first["data"].as_str().unwrap().len(), CHUNK_BYTES * 4 / 3);
        assert_eq!(
            cache.chunk("pc", 7, CHUNK_BYTES).unwrap().unwrap()["data"],
            "AA=="
        );
        assert_eq!(
            cache.chunk("pc", 7, CHUNK_BYTES + 1),
            Err(Error::InvalidRequest)
        );
        assert_eq!(
            cache.insert("pc", 8, 0, vec![0; 33], [0; 32]),
            Err(Error::BackendFailed)
        );
        let mut large = png(33);
        large[16..20].copy_from_slice(&4097u32.to_be_bytes());
        assert_eq!(
            cache.insert("pc", 8, 0, large, [0; 32]),
            Err(Error::TooLarge)
        );
    }

    #[test]
    fn lru_eviction_preserves_fingerprint_for_resume() {
        let mut cache = Cache::new();
        for app in 1..=8 {
            cache
                .insert("pc", app, 0, png(33), [app as u8; 32])
                .unwrap();
        }
        cache.chunk("pc", 1, 0).unwrap();
        cache.insert("pc", 9, 0, png(33), [9; 32]).unwrap();
        assert!(cache.contains("pc", 1));
        assert!(!cache.contains("pc", 2));
        assert_eq!(
            cache.insert("pc", 2, 1, png(33), [99; 32]),
            Err(Error::BackendFailed)
        );
        cache.insert("pc", 2, 1, png(33), [2; 32]).unwrap();
    }

    #[test]
    fn shortened_evicted_cover_requests_restart_instead_of_disabling_covers() {
        let mut cache = Cache::new();
        cache.insert("pc", 1, 0, png(100), [1; 32]).unwrap();
        for app in 2..=9 {
            cache
                .insert("pc", app, 0, png(33), [app as u8; 32])
                .unwrap();
        }
        assert!(!cache.contains("pc", 1));
        assert_eq!(
            cache.insert("pc", 1, 50, png(33), [9; 32]),
            Err(Error::BackendFailed)
        );
        assert_eq!(
            cache.insert("pc", 1, 50, png(33), [1; 32]),
            Err(Error::InvalidRequest)
        );
        cache.insert("pc", 1, 0, png(33), [9; 32]).unwrap();
    }

    #[test]
    fn cache_enforces_byte_budget_and_base64_is_canonical() {
        let mut cache = Cache::new();
        for app in 1..=3 {
            cache
                .insert("pc", app, 0, png(MAX_COVER_BYTES), [app as u8; 32])
                .unwrap();
        }
        assert!(!cache.contains("pc", 1));
        assert!(cache.contains("pc", 2));
        assert!(cache.contains("pc", 3));
        assert_eq!(decode_base64("AA==").unwrap(), [0]);
        assert_eq!(decode_base64("AQI=").unwrap(), [1, 2]);
        assert!(decode_base64("AB==").is_err());
        assert!(decode_base64("AA=A").is_err());
    }
}
