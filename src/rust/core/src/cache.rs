pub const HEADER_BYTES: usize = 104;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const HASH_START: u64 = 0xcbf2_9ce4_8422_2325;

pub fn hash(state: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(state, |state, byte| {
        (state ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3)
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Magic,
    Version,
    Shaders,
    Device,
    Driver,
    Contract,
    Size,
    Truncated,
    Trailing,
    Checksum,
}

impl Error {
    pub fn name(self) -> &'static str {
        match self {
            Self::Magic => "magic",
            Self::Version => "version",
            Self::Shaders => "shaders",
            Self::Device => "device",
            Self::Driver => "driver",
            Self::Contract => "contract",
            Self::Size => "size",
            Self::Truncated => "truncated",
            Self::Trailing => "trailing",
            Self::Checksum => "checksum",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Identity {
    pub vendor: u32,
    pub device: u32,
    pub driver: u32,
    pub uuid: [u8; 16],
    pub width: u32,
    pub height: u32,
    pub video_path: u32,
    pub format: u32,
    pub abi: u32,
    pub storage_bytes: u32,
    pub frame_bytes: u32,
    pub frames_offset: u32,
    pub shaders: u64,
}

fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn double(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

impl Identity {
    pub fn encode(&self) -> [u8; 72] {
        let mut bytes = [0; 72];
        for (offset, value) in [
            (0, self.vendor),
            (4, self.device),
            (8, self.driver),
            (28, self.width),
            (32, self.height),
            (36, self.video_path),
            (40, self.format),
            (44, self.abi),
            (48, self.storage_bytes),
            (52, self.frame_bytes),
            (56, self.frames_offset),
        ] {
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes[12..28].copy_from_slice(&self.uuid);
        bytes[64..72].copy_from_slice(&self.shaders.to_le_bytes());
        bytes
    }

    pub fn check_header(&self, header: &[u8]) -> Result<usize, Error> {
        if header.len() < HEADER_BYTES {
            return Err(Error::Truncated);
        }
        if &header[..8] != b"MLPCACH1" {
            return Err(Error::Magic);
        }
        if word(header, 8) != 1 || word(header, 12) != HEADER_BYTES as u32 {
            return Err(Error::Version);
        }
        let expected = self.encode();
        let identity = &header[16..88];
        if double(identity, 64) != self.shaders {
            return Err(Error::Shaders);
        }
        if identity[..8] != expected[..8] {
            return Err(Error::Device);
        }
        if identity[8..28] != expected[8..28] {
            return Err(Error::Driver);
        }
        if identity != expected {
            return Err(Error::Contract);
        }
        let bytes = double(header, 88);
        if bytes == 0 || bytes > (MAX_BYTES - HEADER_BYTES) as u64 {
            return Err(Error::Size);
        }
        Ok(bytes as usize)
    }

    pub fn decode<'a>(&self, bytes: &'a [u8]) -> Result<&'a [u8], Error> {
        let length = self.check_header(bytes)?;
        let expected = HEADER_BYTES + length;
        if bytes.len() < expected {
            return Err(Error::Truncated);
        }
        if bytes.len() > expected {
            return Err(Error::Trailing);
        }
        let data = &bytes[HEADER_BYTES..];
        if hash(HASH_START, data) != double(bytes, 96) {
            return Err(Error::Checksum);
        }
        Ok(data)
    }

    pub fn encode_header(&self, payload: &[u8]) -> Result<[u8; HEADER_BYTES], Error> {
        if payload.is_empty() || payload.len() > MAX_BYTES - HEADER_BYTES {
            return Err(Error::Size);
        }
        let mut bytes = [0; HEADER_BYTES];
        bytes[..8].copy_from_slice(b"MLPCACH1");
        bytes[8..12].copy_from_slice(&1u32.to_le_bytes());
        bytes[12..16].copy_from_slice(&(HEADER_BYTES as u32).to_le_bytes());
        bytes[16..88].copy_from_slice(&self.encode());
        bytes[88..96].copy_from_slice(&(payload.len() as u64).to_le_bytes());
        bytes[96..104].copy_from_slice(&hash(HASH_START, payload).to_le_bytes());
        Ok(bytes)
    }
}
