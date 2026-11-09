#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Truncated,
    Invalid,
}

struct Bits<'a> {
    data: &'a [u8],
    position: usize,
}
impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }
    fn read(&mut self, count: usize) -> Result<u32, Error> {
        let mut value = 0u32;
        for _ in 0..count {
            let byte = *self.data.get(self.position / 8).ok_or(Error::Truncated)?;
            value = (value << 1) | u32::from((byte >> (7 - self.position % 8)) & 1);
            self.position += 1;
        }
        Ok(value)
    }
    fn flag(&mut self) -> Result<bool, Error> {
        Ok(self.read(1)? != 0)
    }
    fn uvlc(&mut self) -> Result<(), Error> {
        let mut zeros = 0;
        while !self.flag()? {
            zeros += 1;
            if zeros >= 32 {
                return Err(Error::Invalid);
            }
        }
        if zeros > 0 {
            self.read(zeros)?;
        }
        Ok(())
    }
}

fn sequence(payload: &[u8]) -> Result<bool, Error> {
    let mut bits = Bits::new(payload);
    let profile = bits.read(3)?;
    bits.read(1)?;
    let reduced = bits.flag()?;
    if reduced {
        bits.read(5)?;
    } else {
        let mut model = false;
        let mut delay_bits = 0;
        if bits.flag()? {
            bits.read(32)?;
            bits.read(32)?;
            if bits.flag()? {
                bits.uvlc()?;
            }
            model = bits.flag()?;
            if model {
                delay_bits = bits.read(5)? as usize + 1;
                bits.read(32)?;
                bits.read(5)?;
                bits.read(5)?;
            }
        }
        let initial_delay = bits.flag()?;
        let count = bits.read(5)? + 1;
        for _ in 0..count {
            bits.read(12)?;
            if bits.read(5)? > 7 {
                bits.read(1)?;
            }
            if model && bits.flag()? {
                bits.read(delay_bits)?;
                bits.read(delay_bits)?;
                bits.read(1)?;
            }
            if initial_delay && bits.flag()? {
                bits.read(4)?;
            }
        }
    }
    let width_bits = bits.read(4)? as usize + 1;
    let height_bits = bits.read(4)? as usize + 1;
    bits.read(width_bits)?;
    bits.read(height_bits)?;
    if !reduced && bits.flag()? {
        bits.read(4)?;
        bits.read(3)?;
    }
    bits.read(3)?;
    if !reduced {
        bits.read(4)?;
        let order_hint = bits.flag()?;
        if order_hint {
            bits.read(2)?;
        }
        let screen_content = if bits.flag()? { 2 } else { bits.read(1)? };
        if screen_content > 0 && !bits.flag()? {
            bits.read(1)?;
        }
        if order_hint {
            bits.read(3)?;
        }
    }
    bits.read(3)?;
    let high_bit_depth = bits.flag()?;
    if profile == 2 && high_bit_depth {
        bits.read(1)?;
    }
    if profile != 1 {
        bits.read(1)?;
    }
    Ok(reduced)
}

#[derive(Default)]
pub struct Keyframes {
    sequence: Option<bool>,
}
impl Keyframes {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn classify(&mut self, bytes: &[u8]) -> Result<bool, Error> {
        let mut offset = 0usize;
        let mut found_sequence = None;
        let mut first_frame = None;
        while offset < bytes.len() {
            let header = bytes[offset];
            if header & 0x80 != 0 {
                return Err(Error::Invalid);
            }
            let mut at = offset + 1;
            if header & 0x04 != 0 {
                if at >= bytes.len() {
                    return Err(Error::Truncated);
                }
                at += 1;
            }
            let size = if header & 0x02 != 0 {
                let mut value = 0usize;
                let mut ended = false;
                for index in 0..8 {
                    let byte = *bytes.get(at).ok_or(Error::Truncated)?;
                    at += 1;
                    value = value
                        .checked_add(
                            usize::from(byte & 0x7f)
                                .checked_shl(index * 7)
                                .ok_or(Error::Invalid)?,
                        )
                        .ok_or(Error::Invalid)?;
                    if byte & 0x80 == 0 {
                        ended = true;
                        break;
                    }
                }
                if !ended {
                    return Err(Error::Invalid);
                }
                value
            } else {
                bytes.len() - at
            };
            let end = at.checked_add(size).ok_or(Error::Invalid)?;
            let payload = bytes.get(at..end).ok_or(Error::Truncated)?;
            let kind = (header >> 3) & 15;
            if kind == 1 {
                found_sequence = Some(sequence(payload)?);
            }
            if (kind == 3 || kind == 6) && first_frame.is_none() {
                let governing = found_sequence.or(self.sequence);
                let key = if governing == Some(true) {
                    true
                } else {
                    let mut bits = Bits::new(payload);
                    !bits.flag()? && bits.read(2)? == 0
                };
                first_frame = Some(key);
            }
            offset = end;
        }
        let current = found_sequence.or(self.sequence);
        self.sequence = current;
        Ok(first_frame.unwrap_or(false) && current.is_some())
    }
}
