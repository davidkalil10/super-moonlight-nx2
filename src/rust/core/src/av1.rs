//! AV1 OBU scanning for the codec configuration a decoder session is opened with.

const SEQUENCE_HEADER: u8 = 1;

/// OBUs of a low-overhead temporal unit, each with its header and size field.
pub struct Units<'a> {
    bytes: &'a [u8],
}

impl<'a> Units<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }
}

fn leb128(bytes: &[u8]) -> Option<(usize, usize)> {
    let mut value = 0;
    for (index, byte) in bytes.iter().take(8).enumerate() {
        value |= usize::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
    }
    None
}

impl<'a> Iterator for Units<'a> {
    type Item = (u8, &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        let header = *self.bytes.first()?;
        let kind = (header >> 3) & 0xf;
        let payload = if header & 0x04 != 0 { 2 } else { 1 };
        let end = if header & 0x02 != 0 {
            let (size, field) = leb128(self.bytes.get(payload..)?)?;
            payload.checked_add(field)?.checked_add(size)?
        } else {
            self.bytes.len()
        };
        let unit = self.bytes.get(..end)?;
        self.bytes = &self.bytes[end..];
        Some((kind, unit))
    }
}

/// The first sequence header OBU of a temporal unit, with its header and size field.
pub fn sequence_header(temporal_unit: &[u8]) -> Option<&[u8]> {
    Units::new(temporal_unit)
        .find(|(kind, _)| *kind == SEQUENCE_HEADER)
        .map(|(_, unit)| unit)
}
