//! The PC helpers this console is paired with: its own identity and one key per saved PC,
//! kept in the `pairings` file. Format: lead/PERSISTENT-SESSION.md, section 5.

use moonlight_nx2_ui::{
    model::{Address, is_address},
    store::Files,
};

pub const FILE: &str = "pairings";
pub const MAX_PCS: usize = 8;
pub const MAX_BYTES: usize = 2048;
pub const ID_BYTES: usize = 16;
pub const KEY_BYTES: usize = 32;

pub type Id = [u8; ID_BYTES];
pub type Key = [u8; KEY_BYTES];

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Pairing {
    pub address: Address,
    pub helper: Id,
    pub key: Key,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loaded {
    Missing,
    Read,
    /// The file is there but cannot be used; its PCs have to be paired again.
    Damaged,
}

pub struct Pairings {
    console: Option<Id>,
    pcs: [Option<Pairing>; MAX_PCS],
}

impl Drop for Pairings {
    fn drop(&mut self) {
        for pairing in self.pcs.iter_mut().flatten() {
            wipe(&mut pairing.key);
        }
    }
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { core::ptr::write_volatile(byte, 0) };
    }
}

fn unhex<const N: usize>(text: &str) -> Option<[u8; N]> {
    let text = text.as_bytes();
    if text.len() != N * 2 {
        return None;
    }
    let digit = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let mut bytes = [0; N];
    for (out, pair) in bytes.iter_mut().zip(text.chunks_exact(2)) {
        *out = digit(pair[0])? << 4 | digit(pair[1])?;
    }
    Some(bytes)
}

struct Writer<'a> {
    out: &'a mut [u8],
    used: usize,
}

impl Writer<'_> {
    fn text(&mut self, text: &str) -> Option<()> {
        let end = self.used.checked_add(text.len())?;
        self.out
            .get_mut(self.used..end)?
            .copy_from_slice(text.as_bytes());
        self.used = end;
        Some(())
    }

    fn hex(&mut self, bytes: &[u8]) -> Option<()> {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        for byte in bytes {
            let pair = [
                DIGITS[usize::from(byte >> 4)],
                DIGITS[usize::from(byte & 15)],
            ];
            self.text(core::str::from_utf8(&pair).ok()?)?;
        }
        Some(())
    }
}

impl Default for Pairings {
    fn default() -> Self {
        Self {
            console: None,
            pcs: [None; MAX_PCS],
        }
    }
}

impl Pairings {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let mut lines = core::str::from_utf8(bytes).ok()?.lines();
        if lines.next()? != "version=1" {
            return None;
        }
        let mut pairings = Self {
            console: Some(unhex(lines.next()?.strip_prefix("console=")?)?),
            pcs: [None; MAX_PCS],
        };
        for line in lines {
            let mut fields = line.strip_prefix("pc=")?.split(' ');
            let address = fields.next().filter(|address| is_address(address))?;
            let pairing = Pairing {
                address: Address::of(address),
                helper: unhex(fields.next()?)?,
                key: unhex(fields.next()?)?,
            };
            if fields.next().is_some() || pairings.find(&pairing.address).is_some() {
                return None;
            }
            *pairings.pcs.iter_mut().find(|slot| slot.is_none())? = Some(pairing);
        }
        Some(pairings)
    }

    /// Writes the file text into `out`; None when there is nothing to save or no room.
    pub fn format(&self, out: &mut [u8]) -> Option<usize> {
        let mut writer = Writer { out, used: 0 };
        writer.text("version=1\nconsole=")?;
        writer.hex(&self.console?)?;
        writer.text("\n")?;
        for pairing in self.pcs.iter().flatten() {
            writer.text("pc=")?;
            writer.text(pairing.address.as_str())?;
            writer.text(" ")?;
            writer.hex(&pairing.helper)?;
            writer.text(" ")?;
            writer.hex(&pairing.key)?;
            writer.text("\n")?;
        }
        Some(writer.used)
    }

    pub fn load(files: &mut impl Files) -> (Self, Loaded) {
        if !files.exists(FILE) {
            return (Self::default(), Loaded::Missing);
        }
        let mut text = [0; MAX_BYTES + 1];
        let parsed = files
            .read(FILE, &mut text)
            .and_then(|length| Self::parse(&text[..length]));
        wipe(&mut text);
        match parsed {
            Some(pairings) => (pairings, Loaded::Read),
            None => (Self::default(), Loaded::Damaged),
        }
    }

    pub fn save(&self, files: &mut impl Files) -> bool {
        let mut text = [0; MAX_BYTES];
        let saved = self
            .format(&mut text)
            .is_some_and(|length| files.write(FILE, &text[..length]));
        wipe(&mut text);
        saved
    }

    /// This console's identity, made from `random` the first time it is needed.
    pub fn console(&mut self, random: impl FnOnce(&mut [u8])) -> Id {
        *self.console.get_or_insert_with(|| {
            let mut id = [0; ID_BYTES];
            random(&mut id);
            id
        })
    }

    pub fn find(&self, address: &Address) -> Option<&Pairing> {
        self.pcs
            .iter()
            .flatten()
            .find(|pairing| pairing.address == *address)
    }

    pub fn count(&self) -> usize {
        self.pcs.iter().flatten().count()
    }

    /// Stores the key for a PC, replacing an earlier one. The first PC makes room when the
    /// list is full.
    pub fn add(&mut self, pairing: Pairing) {
        self.forget(&pairing.address);
        if self.count() == MAX_PCS {
            self.pcs.rotate_left(1);
            self.pcs[MAX_PCS - 1] = None;
        }
        if let Some(slot) = self.pcs.iter_mut().find(|slot| slot.is_none()) {
            *slot = Some(pairing);
        }
    }

    pub fn forget(&mut self, address: &Address) -> bool {
        let Some(index) = self
            .pcs
            .iter()
            .position(|slot| slot.is_some_and(|pairing| pairing.address == *address))
        else {
            return false;
        };
        if let Some(pairing) = &mut self.pcs[index] {
            wipe(&mut pairing.key);
        }
        self.pcs[index..].rotate_left(1);
        self.pcs[MAX_PCS - 1] = None;
        true
    }
}
