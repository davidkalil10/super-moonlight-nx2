//! RTP framing as Sunshine sends it: a 12-byte big-endian header, 4 more bytes when the
//! extension bit is set, and the serial-number comparisons moonlight-common-c uses.

pub const FIXED_HEADER_BYTES: usize = 12;
pub const MAX_HEADER_BYTES: usize = 16;
const FLAG_EXTENSION: u8 = 0x10;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Header {
    pub flags: u8,
    pub payload_type: u8,
    pub sequence: u16,
    pub timestamp: u32,
    pub ssrc: u32,
    /// Offset of the payload: 12, or 16 with the extension bit.
    pub length: usize,
}

impl Header {
    pub fn parse(packet: &[u8]) -> Option<Self> {
        let fixed: &[u8; FIXED_HEADER_BYTES] = packet.get(..FIXED_HEADER_BYTES)?.try_into().ok()?;
        let length = if fixed[0] & FLAG_EXTENSION != 0 {
            MAX_HEADER_BYTES
        } else {
            FIXED_HEADER_BYTES
        };
        if packet.len() < length {
            return None;
        }
        Some(Self {
            flags: fixed[0],
            payload_type: fixed[1],
            sequence: u16::from_be_bytes([fixed[2], fixed[3]]),
            timestamp: u32::from_be_bytes([fixed[4], fixed[5], fixed[6], fixed[7]]),
            ssrc: u32::from_be_bytes([fixed[8], fixed[9], fixed[10], fixed[11]]),
            length,
        })
    }
}

pub fn before16(x: u16, y: u16) -> bool {
    x.wrapping_sub(y) > u16::MAX / 2
}

pub fn before24(x: u32, y: u32) -> bool {
    x.wrapping_sub(y) & 0xff_ffff > 0xff_ffff / 2
}

pub fn before32(x: u32, y: u32) -> bool {
    x.wrapping_sub(y) > u32::MAX / 2
}

/// RTP 90 kHz video timestamps to microseconds, extended past the 32-bit wrap.
#[derive(Default)]
pub struct Clock90k {
    last: Option<u32>,
    epochs: u64,
}

impl Clock90k {
    pub fn micros(&mut self, timestamp: u32) -> u64 {
        if let Some(last) = self.last
            && timestamp < last
            && last - timestamp > u32::MAX / 2
        {
            self.epochs += 1;
        }
        self.last = Some(timestamp);
        ((self.epochs << 32) | u64::from(timestamp)) * 1000 / 90
    }
}
