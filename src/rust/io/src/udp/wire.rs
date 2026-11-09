use moonlight_nx2_core::media::Header;

pub const DATA_MAGIC: u32 = 0x3156_4455;
pub const HELLO_MAGIC: u32 = 0x4856_4455;
pub const NACK_MAGIC: u32 = 0x314e_4455;
pub const STATS_MAGIC: u32 = 0x3153_4455;
pub const DROP_MAGIC: u32 = 0x3150_5244;
pub const HEADER_BYTES: usize = 40;
pub const FRAGMENT_BYTES: usize = 1360;
pub const NACK_RANGES: usize = 16;
pub const NACK_RANGE_LIMIT: u32 = 256;
pub const STATS_COUNTERS: usize = 12;
pub const KEYFRAME: u8 = 1;
pub const END: u8 = 2;
pub const RESEND: u8 = 4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Truncated,
    TooLarge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DropReason {
    Late = 1,
    Skipped = 2,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Range {
    pub first: u32,
    pub length: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Fragment<'a> {
    pub index: usize,
    pub count: usize,
    pub flags: u8,
    pub datagram_sequence: u32,
    pub transport_frame: u32,
    pub header: Header,
    pub sent_us: u32,
    pub payload: &'a [u8],
}

impl Fragment<'_> {
    pub fn keyframe(&self) -> bool {
        self.flags & KEYFRAME != 0
    }

    pub fn first_sequence(&self) -> u32 {
        self.datagram_sequence.wrapping_sub(self.index as u32)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Packet<'a> {
    Data(Fragment<'a>),
    End { sequence: u32, frames: u32 },
}

fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn put(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

pub fn parse(bytes: &[u8], max_payload: usize) -> Result<Packet<'_>, Error> {
    if bytes.len() < HEADER_BYTES {
        return Err(Error::Truncated);
    }
    if bytes.len() > HEADER_BYTES + FRAGMENT_BYTES {
        return Err(Error::TooLarge);
    }
    if word(bytes, 0) != DATA_MAGIC || word(bytes, 36) != 0 {
        return Err(Error::Invalid);
    }
    let packed = word(bytes, 4);
    let index = (packed & 0xfff) as usize;
    let count = ((packed >> 12) & 0xfff) as usize;
    let flags = (packed >> 24) as u8;
    if flags & !(KEYFRAME | END | RESEND) != 0 {
        return Err(Error::Invalid);
    }
    let sequence = word(bytes, 8);
    let frame = word(bytes, 12);
    if flags & END != 0 {
        let end_only = flags == END && index == 0 && count == 0;
        let empty = bytes.len() == HEADER_BYTES && bytes[16..].iter().all(|byte| *byte == 0);
        return if end_only && empty {
            Ok(Packet::End {
                sequence,
                frames: frame,
            })
        } else {
            Err(Error::Invalid)
        };
    }
    let length = word(bytes, 16) as usize;
    if max_payload == 0 || max_payload > super::MAX_PAYLOAD || length > max_payload {
        return Err(Error::TooLarge);
    }
    if length == 0 || count != length.div_ceil(FRAGMENT_BYTES) || index >= count {
        return Err(Error::Invalid);
    }
    let payload_length = FRAGMENT_BYTES.min(length - index * FRAGMENT_BYTES);
    if bytes.len() != HEADER_BYTES + payload_length {
        return Err(Error::Truncated);
    }
    Ok(Packet::Data(Fragment {
        index,
        count,
        flags,
        datagram_sequence: sequence,
        transport_frame: frame,
        header: Header {
            payload_bytes: length as u32,
            sequence: word(bytes, 20),
            pts_us: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
        },
        sent_us: word(bytes, 32),
        payload: &bytes[HEADER_BYTES..],
    }))
}

pub fn hello(token: &[u8; 64]) -> Result<[u8; 68], Error> {
    if !token
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(Error::Invalid);
    }
    let mut bytes = [0; 68];
    put(&mut bytes, 0, HELLO_MAGIC);
    bytes[4..].copy_from_slice(token);
    Ok(bytes)
}

pub fn nack(ranges: &[Range], out: &mut [u8]) -> Result<usize, Error> {
    let length = 8 + ranges.len() * 8;
    if ranges.len() > NACK_RANGES || out.len() < length {
        return Err(Error::TooLarge);
    }
    if ranges
        .iter()
        .any(|range| !(1..=NACK_RANGE_LIMIT).contains(&range.length))
    {
        return Err(Error::Invalid);
    }
    put(out, 0, NACK_MAGIC);
    put(out, 4, ranges.len() as u32);
    for (index, range) in ranges.iter().enumerate() {
        put(out, 8 + index * 8, range.first);
        put(out, 12 + index * 8, range.length);
    }
    Ok(length)
}

pub fn stats(counters: &[u32], out: &mut [u8]) -> Result<usize, Error> {
    let length = 8 + counters.len() * 4;
    if counters.len() > STATS_COUNTERS || out.len() < length {
        return Err(Error::TooLarge);
    }
    put(out, 0, STATS_MAGIC);
    put(out, 4, counters.len() as u32);
    for (index, counter) in counters.iter().enumerate() {
        put(out, 8 + index * 4, *counter);
    }
    Ok(length)
}

pub fn drop_record(frame: u32, reason: DropReason) -> [u8; 16] {
    let mut bytes = [0; 16];
    put(&mut bytes, 0, DROP_MAGIC);
    put(&mut bytes, 4, frame);
    put(&mut bytes, 8, reason as u32);
    bytes
}

/// RFC1982 ordering for a window smaller than half the u32 sequence space.
pub fn serial_delta(left: u32, right: u32) -> Option<i32> {
    let delta = left.wrapping_sub(right);
    (delta != 0x8000_0000).then_some(delta as i32)
}
