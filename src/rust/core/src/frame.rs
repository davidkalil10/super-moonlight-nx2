pub const WIDTH: u32 = 1920;
pub const HEIGHT: u32 = 1080;
pub const INPUT_BYTES: usize = 4096;
pub const STORAGE_BYTES: usize = 48_418_816;
pub const FRAME_BYTES: usize = 12_533_760;
/// Slot memory is uncached: reading every eighth row held a turn 25 ms at 1080p and 90 ms at
/// 4K, so the measure reads this many rows at any size.
const DETAIL_ROWS: usize = 16;
pub const FRAMES_OFFSET: usize = 2_424_832;
pub const VIDEO_SLOTS: usize = 2;
pub const UI_OFFSET: usize = 40_030_208;
pub const UI_INSTANCES: u32 = 128;
pub const BADGE_INSTANCE: u32 = 128;
pub const BADGE_OFFSET: usize = 27_492_352;
/// The on-screen gamepad's two areas and its two stick knobs, drawn after the badge on a bare
/// stream.
pub const PAD_INSTANCES: u32 = 4;
pub const PAD_VISIBLE: usize = 0xb114;
/// Where each knob sprite sits, in display pixels: x in the low half, y in the high half; 0
/// hides it.
pub const PAD_KNOBS: usize = 0xb118;
pub const PAD_OFFSET: usize = BADGE_OFFSET + 960 * 128 * 4;
pub const VIDEO_BASE: usize = 0xb000;
pub const VIDEO_SLOT_BYTES: usize = 32;
pub const TARGET_WIDTH: usize = 0xb120;
pub const TARGET_HEIGHT: usize = 0xb124;
pub const TARGET_BACKING_WIDTH: usize = 0xb128;
pub const TARGET_BACKING_HEIGHT: usize = 0xb12c;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Invalid,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Matrix {
    Bt601,
    Bt709,
}

pub struct Plane<'a> {
    pub bytes: &'a [u8],
    pub stride: u32,
}

pub struct Frame<'a> {
    pub luma: Plane<'a>,
    pub chroma: Plane<'a>,
    pub coded_width: u32,
    pub coded_height: u32,
    pub crop_left: u32,
    pub crop_top: u32,
    pub display_width: u32,
    pub display_height: u32,
    pub matrix: Matrix,
    pub full_range: bool,
    pub timestamp_ns: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Detail {
    pub across: u32,
    pub down: u32,
    pub luma: u32,
    pub blue: u32,
    pub red: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Layout {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub slice_height: u32,
    pub chroma_rows: u32,
    pub chroma_bytes: u32,
    pub color: u32,
}

fn round_up(value: u32, step: u32) -> Result<u32, Error> {
    value
        .checked_add(step - 1)
        .map(|value| value / step * step)
        .ok_or(Error::Invalid)
}

fn extent(stride: u32, rows: u32, width: u32) -> Result<usize, Error> {
    if rows == 0 {
        return Err(Error::Invalid);
    }
    (stride as usize)
        .checked_mul(rows as usize - 1)
        .and_then(|offset| offset.checked_add(width as usize))
        .ok_or(Error::Invalid)
}

impl Frame<'_> {
    pub fn plan(&self) -> Result<Layout, Error> {
        let right = self
            .crop_left
            .checked_add(self.display_width)
            .ok_or(Error::Invalid)?;
        let bottom = self
            .crop_top
            .checked_add(self.display_height)
            .ok_or(Error::Invalid)?;
        let coded_chroma = round_up(self.coded_width, 2)?;
        if self.display_width == 0
            || self.display_height == 0
            || right > self.coded_width
            || bottom > self.coded_height
            || self.luma.stride < self.coded_width
            || self.chroma.stride < coded_chroma
            || self.luma.bytes.len()
                < extent(self.luma.stride, self.coded_height, self.coded_width)?
            || self.chroma.bytes.len()
                < extent(
                    self.chroma.stride,
                    round_up(self.coded_height, 2)? / 2,
                    coded_chroma,
                )?
        {
            return Err(Error::Invalid);
        }
        if (self.crop_left | self.crop_top) & 1 != 0 || self.full_range {
            return Err(Error::Unsupported);
        }
        let stride = round_up(self.display_width, 64)?;
        let slice_height = round_up(self.display_height, 2)?;
        let bytes = stride as u64 * slice_height as u64 / 2 * 3;
        if stride > 8192 || slice_height > 8192 || bytes > FRAME_BYTES as u64 {
            return Err(Error::Unsupported);
        }
        Ok(Layout {
            width: self.display_width,
            height: self.display_height,
            stride,
            slice_height,
            chroma_rows: slice_height / 2,
            chroma_bytes: round_up(self.display_width, 2)?,
            color: u32::from(self.matrix == Matrix::Bt709),
        })
    }

    /// Copies the shown picture into a slot and clears only the padding around it, so a
    /// 1080p frame costs one pass over its bytes.
    pub fn copy_to(&self, slot: &mut [u8]) -> Result<Layout, Error> {
        let layout = self.plan()?;
        if slot.len() < layout.bytes() {
            return Err(Error::Invalid);
        }
        let stride = layout.stride as usize;
        let (luma, chroma) =
            slot[..layout.bytes()].split_at_mut(stride * layout.slice_height as usize);
        let luma_source = &self.luma.bytes[self.crop_top as usize * self.luma.stride as usize..];
        copy_plane(
            luma_source,
            self.luma.stride as usize,
            self.crop_left as usize,
            layout.height as usize,
            layout.width as usize,
            luma,
            stride,
        );
        let chroma_source =
            &self.chroma.bytes[self.crop_top as usize / 2 * self.chroma.stride as usize..];
        copy_plane(
            chroma_source,
            self.chroma.stride as usize,
            self.crop_left as usize,
            layout.height.div_ceil(2) as usize,
            layout.chroma_bytes as usize,
            chroma,
            stride,
        );
        Ok(layout)
    }
}

fn copy_plane(
    source: &[u8],
    source_stride: usize,
    left: usize,
    rows: usize,
    width: usize,
    target: &mut [u8],
    stride: usize,
) {
    for (row, line) in target.chunks_exact_mut(stride).enumerate() {
        if row >= rows {
            line.fill(0);
            continue;
        }
        let start = row * source_stride + left;
        line[..width].copy_from_slice(&source[start..start + width]);
        line[width..].fill(0);
    }
}

impl Layout {
    /// The layout of a coded NV12 frame written into a slot as it is: both planes keep the
    /// coded width as their stride and the picture sits at the top left.
    pub fn coded(
        coded_width: u32,
        coded_height: u32,
        display_width: u32,
        display_height: u32,
        matrix: Matrix,
    ) -> Result<Self, Error> {
        if display_width == 0
            || display_height == 0
            || display_width > coded_width
            || display_height > coded_height
            || (coded_width | coded_height) & 1 != 0
        {
            return Err(Error::Invalid);
        }
        let layout = Self {
            width: display_width,
            height: display_height,
            stride: coded_width,
            slice_height: coded_height,
            chroma_rows: coded_height / 2,
            chroma_bytes: round_up(display_width, 2)?,
            color: u32::from(matrix == Matrix::Bt709),
        };
        if coded_width > 8192 || coded_height > 8192 || layout.bytes() > FRAME_BYTES {
            return Err(Error::Unsupported);
        }
        Ok(layout)
    }

    pub fn bytes(&self) -> usize {
        self.stride as usize * self.slice_height as usize * 3 / 2
    }

    /// The mean step between neighbouring pixels across and down the picture in `slot`, in
    /// hundredths, over `DETAIL_ROWS` rows spread down it, and its mean luma and chroma. A
    /// softer copy of the same picture steps less.
    pub fn detail(&self, slot: &[u8]) -> Option<Detail> {
        let (width, height, stride) = (
            self.width as usize,
            self.height as usize,
            self.stride as usize,
        );
        if width < 2 || height < 2 || slot.len() < self.bytes() {
            return None;
        }
        let chroma = &slot[stride * self.slice_height as usize..];
        let mut sums = [0u64; 5];
        let mut rows = 0u64;
        for y in (0..height - 1).step_by((height / DETAIL_ROWS).max(1)) {
            let line = &slot[y * stride..y * stride + width];
            let below = &slot[(y + 1) * stride..(y + 1) * stride + width];
            let pairs = &chroma[y / 2 * stride..y / 2 * stride + width / 2 * 2];
            for x in 0..width {
                if x + 1 < width {
                    sums[0] += u64::from(line[x].abs_diff(line[x + 1]));
                }
                sums[1] += u64::from(line[x].abs_diff(below[x]));
                sums[2] += u64::from(line[x]);
            }
            for pair in pairs.chunks_exact(2) {
                sums[3] += u64::from(pair[0]);
                sums[4] += u64::from(pair[1]);
            }
            rows += 1;
        }
        let mean = |sum: u64, count: u64| (sum * 100 / count) as u32;
        Some(Detail {
            across: mean(sums[0], rows * (width as u64 - 1)),
            down: mean(sums[1], rows * width as u64),
            luma: mean(sums[2], rows * width as u64),
            blue: mean(sums[3], rows * (width as u64 / 2).max(1)),
            red: mean(sums[4], rows * (width as u64 / 2).max(1)),
        })
    }

    pub fn publish(&self, storage: &mut [u8], slot: usize, sequence: u32) -> Result<(), Error> {
        if slot >= VIDEO_SLOTS || storage.len() < VIDEO_BASE + VIDEO_SLOTS * VIDEO_SLOT_BYTES {
            return Err(Error::Invalid);
        }
        for (offset, value) in [
            (4, self.width),
            (8, self.height),
            (12, self.stride),
            (16, self.slice_height),
            (20, self.color),
            (0, sequence),
        ] {
            let start = VIDEO_BASE + slot * VIDEO_SLOT_BYTES + offset;
            storage[start..start + 4].copy_from_slice(&value.to_le_bytes());
        }
        storage[8..12].copy_from_slice(&3u32.to_le_bytes());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_handheld_window_is_the_1080p_panel_the_ui_draws_for() {
        assert_eq!((WIDTH, HEIGHT), (1920, 1080));
    }

    #[test]
    fn a_copy_crops_the_picture_and_clears_the_padding() {
        let luma: [u8; 160] = core::array::from_fn(|byte| byte as u8);
        let chroma: [u8; 80] = core::array::from_fn(|byte| 200 - byte as u8);
        let frame = Frame {
            luma: Plane {
                bytes: &luma,
                stride: 16,
            },
            chroma: Plane {
                bytes: &chroma,
                stride: 16,
            },
            coded_width: 12,
            coded_height: 10,
            crop_left: 2,
            crop_top: 2,
            display_width: 6,
            display_height: 5,
            matrix: Matrix::Bt709,
            full_range: false,
            timestamp_ns: 0,
        };
        let mut slot = [0xaa; 1024];
        let layout = frame.copy_to(&mut slot).unwrap();
        let stride = layout.stride as usize;
        let chroma_start = stride * layout.slice_height as usize;
        for row in 0..layout.slice_height as usize {
            for column in 0..stride {
                let expected = if row < 5 && column < 6 {
                    luma[(row + 2) * 16 + column + 2]
                } else {
                    0
                };
                assert_eq!(slot[row * stride + column], expected, "luma {row},{column}");
            }
        }
        for row in 0..layout.chroma_rows as usize {
            for column in 0..stride {
                let expected = if row < 3 && column < 6 {
                    chroma[(row + 1) * 16 + column + 2]
                } else {
                    0
                };
                assert_eq!(
                    slot[chroma_start + row * stride + column],
                    expected,
                    "chroma {row},{column}"
                );
            }
        }
    }

    #[test]
    fn a_blurred_picture_has_less_detail() {
        let layout = Layout::coded(64, 16, 64, 16, Matrix::Bt709).unwrap();
        let mut sharp = [128u8; 64 * 16 * 3 / 2];
        for (index, byte) in sharp[..64 * 16].iter_mut().enumerate() {
            *byte = if (index % 64 + index / 64) % 2 == 0 {
                0
            } else {
                200
            };
        }
        let mut soft = sharp;
        for byte in &mut soft[..64 * 16] {
            *byte = *byte / 4 + 75;
        }
        let sharp = layout.detail(&sharp).unwrap();
        let soft = layout.detail(&soft).unwrap();
        assert_eq!(
            (sharp.across, sharp.down, sharp.blue, sharp.red),
            (20000, 20000, 12800, 12800)
        );
        assert!(soft.across < sharp.across && soft.down < sharp.down);
    }
}
