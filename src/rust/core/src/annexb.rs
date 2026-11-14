//! Annex-B scanning for the codec configuration a decoder session is opened with.

const START_CODE: [u8; 4] = [0, 0, 0, 1];
const H264_SPS: u8 = 7;
const H264_PPS: u8 = 8;

/// NAL units of an Annex-B byte stream, without start codes or trailing zero bytes.
pub struct Units<'a> {
    bytes: &'a [u8],
}

impl<'a> Units<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }
}

fn start_code(bytes: &[u8]) -> Option<usize> {
    bytes.windows(3).position(|window| window == [0, 0, 1])
}

impl<'a> Iterator for Units<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<Self::Item> {
        let begin = start_code(self.bytes)? + 3;
        let rest = &self.bytes[begin..];
        let end = start_code(rest).unwrap_or(rest.len());
        self.bytes = &rest[end..];
        let unit = &rest[..end];
        let length = unit
            .iter()
            .rposition(|byte| *byte != 0)
            .map_or(0, |last| last + 1);
        Some(&unit[..length])
    }
}

/// Bits of a NAL unit payload, with the emulation prevention bytes left out.
struct Bits<'a> {
    bytes: &'a [u8],
    bit: usize,
    zeros: u32,
}

impl Bits<'_> {
    fn bit(&mut self) -> Option<u32> {
        if self.bit.is_multiple_of(8) {
            let byte = *self.bytes.get(self.bit / 8)?;
            if self.zeros >= 2 && byte == 3 {
                self.bit += 8;
                self.zeros = 0;
                return self.bit();
            }
            self.zeros = if byte == 0 { self.zeros + 1 } else { 0 };
        }
        let byte = *self.bytes.get(self.bit / 8)?;
        let value = (byte >> (7 - self.bit % 8)) & 1;
        self.bit += 1;
        Some(u32::from(value))
    }

    fn bits(&mut self, count: u32) -> Option<u32> {
        (0..count).try_fold(0, |value, _| Some((value << 1) | self.bit()?))
    }

    fn unsigned(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some((1 << zeros) - 1 + self.bits(zeros)?)
    }

    fn signed(&mut self) -> Option<i32> {
        let code = self.unsigned()?;
        let magnitude = code.div_ceil(2) as i32;
        Some(if code % 2 == 0 { -magnitude } else { magnitude })
    }

    fn scaling_list(&mut self, entries: u32) -> Option<()> {
        let (mut last, mut next) = (8, 8);
        for _ in 0..entries {
            if next != 0 {
                next = (last + self.signed()?).rem_euclid(256);
            }
            if next != 0 {
                last = next;
            }
        }
        Some(())
    }
}

/// The coded size the first H.264 SPS of an access unit declares, in whole macroblocks and
/// before cropping. `None` without an SPS or when it ends early.
pub fn h264_coded_size(access_unit: &[u8]) -> Option<(u32, u32)> {
    let sps =
        Units::new(access_unit).find(|unit| unit.first().map(|h| h & 0x1f) == Some(H264_SPS))?;
    let mut bits = Bits {
        bytes: sps.get(1..)?,
        bit: 0,
        zeros: 0,
    };
    let profile = bits.bits(8)?;
    bits.bits(16)?;
    bits.unsigned()?;
    if matches!(
        profile,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        let chroma_format = bits.unsigned()?;
        if chroma_format == 3 {
            bits.bit()?;
        }
        bits.unsigned()?;
        bits.unsigned()?;
        bits.bit()?;
        if bits.bit()? == 1 {
            for list in 0..if chroma_format == 3 { 12 } else { 8 } {
                if bits.bit()? == 1 {
                    bits.scaling_list(if list < 6 { 16 } else { 64 })?;
                }
            }
        }
    }
    bits.unsigned()?;
    match bits.unsigned()? {
        0 => {
            bits.unsigned()?;
        }
        1 => {
            bits.bit()?;
            bits.signed()?;
            bits.signed()?;
            for _ in 0..bits.unsigned()?.min(255) {
                bits.signed()?;
            }
        }
        _ => {}
    }
    bits.unsigned()?;
    bits.bit()?;
    let width = bits.unsigned()?.checked_add(1)?.checked_mul(16)?;
    let map_units = bits.unsigned()?.checked_add(1)?;
    let frame_only = bits.bit()?;
    Some((width, map_units.checked_mul(16 * (2 - frame_only))?))
}

/// Copies the first H.264 SPS and PPS of an access unit into `out`, each after a four-byte
/// start code, and returns the length. `None` when either is absent or `out` is too small.
pub fn h264_parameter_sets(access_unit: &[u8], out: &mut [u8]) -> Option<usize> {
    let kind = |unit: &&[u8]| unit.first().map(|header| header & 0x1f);
    let sps = Units::new(access_unit).find(|unit| kind(unit) == Some(H264_SPS))?;
    let pps = Units::new(access_unit).find(|unit| kind(unit) == Some(H264_PPS))?;
    let mut length = 0;
    for unit in [sps, pps] {
        let end = length + START_CODE.len() + unit.len();
        let target = out.get_mut(length..end)?;
        target[..START_CODE.len()].copy_from_slice(&START_CODE);
        target[START_CODE.len()..].copy_from_slice(unit);
        length = end;
    }
    Some(length)
}
