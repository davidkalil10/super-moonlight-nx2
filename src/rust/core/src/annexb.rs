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
