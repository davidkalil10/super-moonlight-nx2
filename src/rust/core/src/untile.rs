#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Pitch,
    BlockLinear { rows: u32 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Plane {
    pub kind: Kind,
    pub offset: u64,
    pub pitch: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Image {
    pub luma: Plane,
    pub chroma: Plane,
}

impl Image {
    pub fn decode(bytes: &[u8; 128]) -> Result<Self, Error> {
        let plane = |offset: usize, fields: usize, element: u32| -> Result<Plane, Error> {
            let base = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as u64;
            if bytes[0] == 0x0d {
                let read = |at| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as u32;
                let blocks = read(fields);
                let width = read(fields + 4);
                let rows = read(fields + 6);
                if blocks == 0
                    || width * element != 64
                    || rows == 0
                    || rows > 256
                    || !rows.is_multiple_of(8)
                {
                    return Err(Error::Invalid);
                }
                Ok(Plane {
                    kind: Kind::BlockLinear { rows },
                    offset: base,
                    pitch: blocks as u64 * 64,
                })
            } else {
                Ok(Plane {
                    kind: Kind::Pitch,
                    offset: base,
                    pitch: u64::from_le_bytes(bytes[fields..fields + 8].try_into().unwrap()),
                })
            }
        };
        if ![0x0a, 0x14, 0x0d].contains(&bytes[0]) {
            return Err(Error::Unsupported);
        }
        Ok(Self {
            luma: plane(0x08, 0x10, 1)?,
            chroma: plane(0x18, 0x20, 2)?,
        })
    }
}

impl Plane {
    pub fn byte_offset(self, x: u32, y: u32) -> Result<u64, Error> {
        if u64::from(x) >= self.pitch {
            return Err(Error::Invalid);
        }
        let inside = match self.kind {
            Kind::Pitch => u64::from(y)
                .checked_mul(self.pitch)
                .and_then(|base| base.checked_add(x.into())),
            Kind::BlockLinear { rows } => {
                if rows == 0
                    || rows > 256
                    || !rows.is_multiple_of(8)
                    || !self.pitch.is_multiple_of(64)
                {
                    return Err(Error::Invalid);
                }
                let block = u64::from(y / rows)
                    .checked_mul(self.pitch / 64)
                    .and_then(|value| value.checked_add(u64::from(x / 64)))
                    .ok_or(Error::Invalid)?;
                let gob = u64::from((y % rows) / 8);
                let gx = x % 64;
                let gy = y % 8;
                let swizzled = (gx / 32) * 256
                    + ((gy >> 2) & 1) * 128
                    + ((gx % 32) / 16) * 64
                    + (gy & 3) * 16
                    + gx % 16;
                block
                    .checked_mul(64 * u64::from(rows))
                    .and_then(|value| value.checked_add(gob * 512))
                    .and_then(|value| value.checked_add(swizzled.into()))
            }
        }
        .ok_or(Error::Invalid)?;
        self.offset.checked_add(inside).ok_or(Error::Invalid)
    }

    pub fn copy(
        self,
        image: &[u8],
        row_bytes: u32,
        rows: u32,
        out: &mut [u8],
        stride: u32,
    ) -> Result<(), Error> {
        if rows == 0 || row_bytes == 0 || row_bytes > stride || u64::from(row_bytes) > self.pitch {
            return Err(Error::Invalid);
        }
        let stored_rows = match self.kind {
            Kind::Pitch => u64::from(rows),
            Kind::BlockLinear { rows: block } => {
                if block == 0
                    || block > 256
                    || !block.is_multiple_of(8)
                    || !self.pitch.is_multiple_of(64)
                {
                    return Err(Error::Invalid);
                }
                u64::from(rows).div_ceil(u64::from(block)) * u64::from(block)
            }
        };
        let available = (image.len() as u64)
            .checked_sub(self.offset)
            .ok_or(Error::Invalid)?;
        if stored_rows > available / self.pitch {
            return Err(Error::Invalid);
        }
        let required = u64::from(rows - 1) * u64::from(stride) + u64::from(row_bytes);
        if required > out.len() as u64 {
            return Err(Error::Invalid);
        }
        for y in 0..rows {
            let target = y as usize * stride as usize;
            match self.kind {
                Kind::Pitch => {
                    let source = self.byte_offset(0, y)? as usize;
                    out[target..target + row_bytes as usize]
                        .copy_from_slice(&image[source..source + row_bytes as usize]);
                }
                Kind::BlockLinear { .. } => {
                    for x in (0..row_bytes).step_by(16) {
                        let bytes = (row_bytes - x).min(16) as usize;
                        let source = self.byte_offset(x, y)? as usize;
                        out[target + x as usize..target + x as usize + bytes]
                            .copy_from_slice(&image[source..source + bytes]);
                    }
                }
            }
        }
        Ok(())
    }
}
