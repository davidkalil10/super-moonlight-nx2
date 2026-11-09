use crate::codec::Size;

pub const MESSAGE_BYTES: usize = 256;
pub const INPUT_MAX: u32 = 1024 * 1024;
pub const LIBRARY_VERSION: u64 = 0x0000_0003_0003_0000;
const ADDRESS_LIMIT: u64 = 1 << 39;

fn buffer_fits(address: u64, bytes: u32) -> bool {
    (0x1000..ADDRESS_LIMIT).contains(&address)
        && address
            .checked_add(u64::from(bytes))
            .is_some_and(|end| end <= ADDRESS_LIMIT)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Malformed,
}

pub struct Message {
    bytes: [u8; MESSAGE_BYTES],
    length: usize,
}

impl Message {
    pub fn empty(wire: u16) -> Self {
        Self::header(wire.into(), 0)
    }

    fn header(first: u32, words: u32) -> Self {
        let mut message = Self {
            bytes: [0; MESSAGE_BYTES],
            length: 8 + (words & 0x3ff) as usize * 4,
        };
        message.put32(0, first);
        message.put32(4, words);
        message
    }

    fn put32(&mut self, at: usize, value: u32) {
        self.bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn put64(&mut self, at: usize, value: u64) {
        self.bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
    }
    fn buffer(&mut self, address: u64, bytes: u32) {
        self.put32(8, bytes);
        self.put32(12, address as u32);
        self.put32(
            16,
            (((address >> 36) & 7) << 2 | ((address >> 32) & 15) << 28) as u32,
        );
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes[..self.length]
    }
    pub fn storage(&self) -> &[u8; MESSAGE_BYTES] {
        &self.bytes
    }

    pub fn decoder_context(flag: u8) -> Self {
        let mut message = Self::header(922, 3);
        message.bytes[8] = flag;
        message.put64(12, LIBRARY_VERSION);
        message
    }

    pub fn initialize(transfer_handle: u32, transfer_bytes: u64, registration: u32) -> Self {
        let mut message = Self::header(217, 0x8000_0006);
        message.length += 8;
        message.put32(8, 2);
        message.put32(12, transfer_handle);
        message.put64(16, transfer_bytes);
        for (at, value) in [(24, registration), (28, 1), (32, 3), (36, 1)] {
            message.put32(at, value);
        }
        message
    }

    pub fn configure(mime_address: u64, mime_bytes: u32, size: Size) -> Result<Self, Error> {
        if !(1..=64).contains(&mime_bytes) || !buffer_fits(mime_address, mime_bytes) {
            return Err(Error::Invalid);
        }
        let mut message = Self::header(0x10_0000 | 117, 8);
        message.length += 12;
        message.buffer(mime_address, mime_bytes);
        for (at, value) in [
            (20, size.width()),
            (24, size.height()),
            (28, 60),
            (32, INPUT_MAX),
        ] {
            message.put32(at, value);
        }
        Ok(message)
    }

    pub fn submit(address: u64, length: u32, pts_us: u64, eos: bool) -> Result<Self, Error> {
        if !buffer_fits(address, length) || length > INPUT_MAX || (length == 0 && !eos) {
            return Err(Error::Invalid);
        }
        let mut message = Self::header(0x10_0000 | 125, 3);
        message.length += 12;
        message.buffer(address, length);
        message.put64(20, pts_us);
        message.bytes[28] = u8::from(eos);
        Ok(message)
    }

    pub fn image(wire: u16, image: u32) -> Self {
        let words = match wire {
            327 => 4,
            330 => 8,
            _ => 1,
        };
        let mut message = Self::header(wire.into(), words);
        message.put32(8, image);
        message
    }

    pub fn pool(size: Size, count: u32, memory: Option<u32>) -> Self {
        let (wire, words) = if memory.is_some() {
            (927, 18)
        } else {
            (1007, 17)
        };
        let mut message = Self::header(wire, words);
        message.bytes[8..72].copy_from_slice(&image_preference(size));
        message.put32(72, count);
        if let Some(memory) = memory {
            message.put32(76, memory);
        }
        message
    }

    pub fn memory_attach(memory: u32, address: u64, bytes: u64, flags: u64) -> Self {
        let mut message = Self::header(130, 9);
        message.put32(8, memory);
        message.put64(12, address);
        message.put64(20, bytes);
        message.put64(28, flags);
        message
    }
}

pub fn image_preference(size: Size) -> [u8; 64] {
    let mut bytes = [0; 64];
    bytes[..8].copy_from_slice(&0x1_0000_0000_u64.to_le_bytes());
    bytes[8..12].copy_from_slice(&((size.height() - 1) << 16 | (size.width() - 1)).to_le_bytes());
    bytes
}

pub fn av1_workspace_bytes(size: Size) -> u64 {
    const LEVELS: [(u32, u32, u64); 6] = [
        (256, 144, 9),
        (640, 360, 16),
        (854, 480, 22),
        (1280, 720, 40),
        (1920, 1080, 78),
        (3840, 2160, 272),
    ];
    let (_, _, mebibytes) = LEVELS
        .into_iter()
        .find(|(width, height, _)| size.width() <= *width && size.height() <= *height)
        .unwrap();
    mebibytes.max(64) << 20
}

pub struct Reply<'a> {
    pub result: u32,
    pub moved_handle: Option<u32>,
    pub data: &'a [u8],
}

fn read32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn read64(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

impl<'a> Reply<'a> {
    pub fn parse(
        message: &'a [u8; MESSAGE_BYTES],
        wire: u16,
        minimum_words: u32,
        moved: bool,
    ) -> Result<Self, Error> {
        let first = read32(message, 0);
        let second = read32(message, 4);
        let words = second & 0x3ff;
        if first != u32::from(wire)
            || (second & 0x8000_0000 != 0) != moved
            || words < minimum_words
            || words > 60
        {
            return Err(Error::Malformed);
        }
        if !moved && words == 0 {
            return Ok(Self {
                result: 0,
                moved_handle: None,
                data: &[],
            });
        }
        let (at, handle) = if moved {
            if read32(message, 8) != 0x20 {
                return Err(Error::Malformed);
            }
            (16, Some(read32(message, 12)))
        } else {
            (8, None)
        };
        let length = words.saturating_sub(1) as usize * 4;
        let start = at + 4;
        let end = start + length;
        if end > message.len() {
            return Err(Error::Malformed);
        }
        Ok(Self {
            result: read32(message, at),
            moved_handle: handle,
            data: &message[start..end],
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fence {
    pub counter: u32,
    pub mode: u32,
    pub value: u64,
}

impl Fence {
    pub fn parse(reply: &Reply<'_>) -> Result<Self, Error> {
        if reply.data.len() < 16 {
            return Err(Error::Malformed);
        }
        let fence = Self {
            counter: read32(reply.data, 0),
            mode: read32(reply.data, 4),
            value: read64(reply.data, 8),
        };
        if fence.mode > 1 {
            return Err(Error::Malformed);
        }
        Ok(fence)
    }
    pub fn reached(self, counter: u64) -> bool {
        if counter == u64::MAX {
            return false;
        }
        if self.mode == 1 {
            counter >= self.value
        } else {
            (counter as u32).wrapping_sub(self.value as u32) as i32 >= 0
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Output {
    pub image: u32,
    pub width: u32,
    pub height: u32,
    pub display_width: u32,
    pub display_height: u32,
    pub color: u32,
    pub timestamp_ns: u64,
    pub end_of_stream: bool,
}

impl Output {
    pub fn parse(reply: &Reply<'_>) -> Result<Self, Error> {
        if reply.data.len() < 40 {
            return Err(Error::Malformed);
        }
        let data = reply.data;
        Ok(Self {
            image: read32(data, 0),
            width: read32(data, 4),
            height: read32(data, 8),
            display_width: read32(data, 12),
            display_height: read32(data, 16),
            color: read32(data, 20),
            timestamp_ns: read64(data, 24),
            end_of_stream: data[32] & 1 != 0,
        })
    }
}
