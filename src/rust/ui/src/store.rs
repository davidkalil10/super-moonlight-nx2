//! Saved settings: two checksummed generation slots, with the old single file as a fallback.
//! Port of ui/store.c; the caller supplies the file access.

use core::fmt::Write;

use crate::hosts::{self, HostBook};
use crate::json::{Json, Kind};
use crate::settings::Settings;
use crate::text::Text;

pub const RECORD_BYTES: usize = 4096;
pub const SLOTS: [&str; 2] = ["settings-0.json", "settings-1.json"];
pub const LEGACY: &str = "settings.json";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Whole-file access by name.
pub trait Files {
    /// Fills `buffer` and returns the length; None when the file is missing, unreadable or
    /// does not fit with a byte to spare.
    fn read(&mut self, name: &str, buffer: &mut [u8]) -> Option<usize>;
    fn write(&mut self, name: &str, bytes: &[u8]) -> bool;

    /// Whether `name` exists, so a file that cannot be read is not taken for a missing one.
    /// The default treats every unreadable file as missing.
    fn exists(&mut self, _name: &str) -> bool {
        false
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Loaded,
    Migrated,
    Defaults,
}

pub struct Store<F> {
    pub files: F,
    pub generation: u64,
}

struct Fnv(u32);

impl Write for Fnv {
    fn write_str(&mut self, text: &str) -> core::fmt::Result {
        self.add(text.as_bytes());
        Ok(())
    }
}

impl Fnv {
    fn add(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 = (self.0 ^ u32::from(byte)).wrapping_mul(16_777_619);
        }
    }
}

/// FNV-1a over the record as it reads without its checksum member.
fn checksum(generation: u64, settings: &[u8]) -> u32 {
    let mut hash = Fnv(2_166_136_261);
    let _ = write!(hash, "{{\"generation\":{generation},\"settings\":");
    hash.add(settings);
    hash.add(b"}");
    hash.0
}

fn safe_generation(value: f64) -> Option<u64> {
    let whole = (1.0..=MAX_SAFE_INTEGER as f64).contains(&value) && value == value as u64 as f64;
    whole.then_some(value as u64)
}

fn read_record<F: Files>(files: &mut F, name: &str, json: &mut Json) -> Option<(u64, Settings)> {
    let mut text = [0u8; RECORD_BYTES + 1];
    let length = files.read(name, &mut text)?;
    if !(1..=RECORD_BYTES).contains(&length) {
        return None;
    }
    let text = &text[..length];
    let root = json.parse(text)?;

    let version = root.member("version")?;
    if version.number() != Some(1.0) {
        return None;
    }
    let generation = safe_generation(root.member("generation")?.number()?)?;

    let settings = root.member("settings")?;
    let sum = root.member("checksum")?;
    if sum.kind() != Kind::Number {
        return None;
    }
    let raw = &text[settings.span()];
    if sum.number() != Some(f64::from(checksum(generation, raw))) {
        return None;
    }

    let mut saved = Settings::default();
    saved.sanitize(settings);
    Some((generation, saved))
}

fn read_legacy<F: Files>(files: &mut F, json: &mut Json) -> Option<Settings> {
    let mut text = [0u8; RECORD_BYTES + 1];
    let length = files.read(LEGACY, &mut text)?;
    if length > RECORD_BYTES {
        return None;
    }
    Some(Settings::from_json(&text[..length], json))
}

impl<F: Files> Store<F> {
    pub fn new(files: F) -> Self {
        Self {
            files,
            generation: 0,
        }
    }

    /// The newest valid slot, else the old file, else defaults. Ties keep slot 0.
    pub fn load(&mut self, json: &mut Json) -> (Source, Settings) {
        let records = SLOTS.map(|name| read_record(&mut self.files, name, json));
        let mut newest: Option<(u64, Settings)> = None;
        for record in records.into_iter().flatten() {
            if newest.is_none_or(|(generation, _)| record.0 > generation) {
                newest = Some(record);
            }
        }
        if let Some((generation, settings)) = newest {
            self.generation = generation;
            return (Source::Loaded, settings);
        }

        self.generation = 0;
        match read_legacy(&mut self.files, json) {
            Some(settings) => (Source::Migrated, settings),
            None => (Source::Defaults, Settings::default()),
        }
    }

    /// Writes the next generation into the slot the current one is not in.
    pub fn save(&mut self, settings: &Settings, json: &mut Json) -> bool {
        if self.generation >= MAX_SAFE_INTEGER {
            return false;
        }

        let clean = Settings::from_json(settings.to_json().as_str().as_bytes(), json);
        let raw = clean.to_json();
        if raw.is_empty() {
            return false;
        }

        let next = self.generation + 1;
        let sum = checksum(next, raw.as_str().as_bytes());
        let mut record = Text::<{ RECORD_BYTES - 1 }>::new();
        let written = write!(
            record,
            "{{\"version\":1,\"generation\":{next},\"settings\":{raw},\"checksum\":{sum}}}"
        );
        if written.is_err() {
            return false;
        }
        if !self
            .files
            .write(SLOTS[(next & 1) as usize], record.as_str().as_bytes())
        {
            return false;
        }

        self.generation = next;
        true
    }

    /// The saved hosts. A missing file is an empty book; one that exists but cannot be read
    /// whole is an error, so the caller does not overwrite it.
    pub fn load_hosts(&mut self, json: &mut Json) -> Result<HostBook, hosts::Error> {
        let mut text = alloc::vec![0u8; hosts::MAX_BYTES + 1];
        match self.files.read(hosts::FILE, &mut text) {
            Some(length) => HostBook::parse(&text[..length], json),
            None if self.files.exists(hosts::FILE) => Err(hosts::Error::Unreadable),
            None => Ok(HostBook::default()),
        }
    }

    /// Writes the book when it changed; false when it does not fit or the write failed.
    pub fn save_hosts(&mut self, book: &mut HostBook) -> bool {
        if !book.dirty() {
            return true;
        }
        let Some(text) = book.to_json() else {
            return false;
        };
        if !self.files.write(hosts::FILE, text.as_bytes()) {
            return false;
        }
        book.saved();
        true
    }
}
