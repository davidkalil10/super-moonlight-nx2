//! PNG decoding to RGBA8 and the box-art cover tile: the art fitted whole over a blurred, dimmed
//! fill of itself. Port of decodePng and tile in dev legacy/src/streamer/ui/glyph-raster.js;
//! the resampling (triangle filter through premultiplied alpha) and the blur (three box passes
//! per axis) only approximate Pillow's Lanczos and Gaussian, they are not bit exact.

use alloc::vec;
use alloc::vec::Vec;

use crate::glyphs::Bitmap;
use crate::inflate::inflate;

pub const MAX_SIDE: u32 = 4096;
/// Pixels decoded at most (memory bound on the console): width*height must be <= this.
pub const MAX_PIXELS: u64 = 2_500_000;

/// The blurred fill keeps 35 % of its brightness (FILL_LEVEL in glyph-raster.js).
const FILL_PERCENT: u32 = 35;
const SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
/// Adam7 passes as x0, y0, dx, dy.
const ADAM7: [[u32; 4]; 7] = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
];
const PROGRESSIVE: [[u32; 4]; 1] = [[0, 0, 1, 1]];
/// Fixed-point bits of the resampling weights.
const WEIGHT_BITS: u32 = 14;

const CRC_TABLE: [u32; 256] = crc_table();

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for &byte in bytes {
        crc = CRC_TABLE[((crc ^ u32::from(byte)) & 0xff) as usize] ^ (crc >> 8);
    }
    !crc
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let word = bytes.get(at..at.checked_add(4)?)?;
    Some(u32::from_be_bytes([word[0], word[1], word[2], word[3]]))
}

/// The chunks the decoder reads, IDAT joined; None unless the PNG is whole with good CRCs.
struct Parts<'a> {
    header: &'a [u8],
    palette: Option<&'a [u8]>,
    transparency: Option<&'a [u8]>,
    data: Vec<u8>,
}

fn parts(png: &[u8]) -> Option<Parts<'_>> {
    if png.get(..8)? != SIGNATURE {
        return None;
    }

    let mut header = None;
    let mut palette = None;
    let mut transparency = None;
    let mut data = Vec::new();
    let mut at = 8usize;
    loop {
        let length = usize::try_from(be_u32(png, at)?).ok()?;
        let typed_start = at.checked_add(4)?;
        let end = typed_start.checked_add(4)?.checked_add(length)?;
        let crc = be_u32(png, end)?;
        let typed = png.get(typed_start..end)?;
        if crc32(typed) != crc {
            return None;
        }

        let (kind, body) = typed.split_at_checked(4)?;
        if header.is_none() && kind != b"IHDR" {
            return None;
        }
        match kind {
            b"IHDR" if header.is_none() => header = Some(body),
            b"PLTE" if palette.is_none() => palette = Some(body),
            b"tRNS" if transparency.is_none() => transparency = Some(body),
            b"IDAT" => data.extend_from_slice(body),
            b"IEND" => {
                return Some(Parts {
                    header: header?,
                    palette,
                    transparency,
                    data,
                });
            }
            _ => {}
        }
        at = end.checked_add(4)?;
    }
}

/// How one row's samples become RGBA.
struct Format<'a> {
    color: u8,
    depth: u8,
    palette: &'a [u8],
    alphas: &'a [u8],
    key: Option<[u16; 3]>,
}

impl Format<'_> {
    /// The raw sample at index i of a row; 16-bit samples whole.
    fn sample(&self, row: &[u8], i: usize) -> u16 {
        let byte = |at: usize| u16::from(row.get(at).copied().unwrap_or(0));
        match self.depth {
            16 => byte(2 * i) << 8 | byte(2 * i + 1),
            8 => byte(i),
            depth => {
                let depth = usize::from(depth);
                let per_byte = 8 / depth;
                let shift = 8 - depth * (i % per_byte + 1);
                (byte(i / per_byte) >> shift) & ((1 << depth) - 1)
            }
        }
    }

    /// A raw sample scaled to 8 bits; 16-bit samples keep their high byte.
    fn level(&self, value: u16) -> u8 {
        match self.depth {
            16 => (value >> 8) as u8,
            8 => value as u8,
            depth => (u32::from(value) * 255 / ((1u32 << depth) - 1)) as u8,
        }
    }

    fn pixel(&self, row: &[u8], x: usize) -> [u8; 4] {
        match self.color {
            0 => {
                let raw = self.sample(row, x);
                let level = self.level(raw);
                let keyed = self.key.is_some_and(|key| key[0] == raw);
                [level, level, level, if keyed { 0 } else { 255 }]
            }
            2 => {
                let raw = [0, 1, 2].map(|c| self.sample(row, 3 * x + c));
                let keyed = self.key == Some(raw);
                let [r, g, b] = raw.map(|value| self.level(value));
                [r, g, b, if keyed { 0 } else { 255 }]
            }
            3 => {
                let index = usize::from(self.sample(row, x));
                let rgb = index
                    .checked_mul(3)
                    .and_then(|at| self.palette.get(at..at + 3))
                    .unwrap_or(&[0, 0, 0]);
                let alpha = self.alphas.get(index).copied().unwrap_or(255);
                [rgb[0], rgb[1], rgb[2], alpha]
            }
            4 => {
                let level = self.level(self.sample(row, 2 * x));
                [level, level, level, self.level(self.sample(row, 2 * x + 1))]
            }
            _ => [0, 1, 2, 3].map(|c| self.level(self.sample(row, 4 * x + c))),
        }
    }
}

/// Undoes the row filters of one pass in place; `data` holds its rows, each a filter byte and
/// `row_bytes` bytes.
fn unfilter(data: &mut [u8], rows: usize, row_bytes: usize, pixel_bytes: usize) -> Option<()> {
    let stride = row_bytes.checked_add(1)?;
    for y in 0..rows {
        let start = y.checked_mul(stride)?;
        let (before, rest) = data.split_at_mut_checked(start)?;
        let (&mut filter, line) = rest.split_first_mut()?;
        let line = line.get_mut(..row_bytes)?;
        let up_row = if y == 0 {
            None
        } else {
            Some(before.get(start - row_bytes..)?)
        };
        if filter > 4 {
            return None;
        }
        if filter == 0 {
            continue;
        }

        for x in 0..row_bytes {
            let left = if x >= pixel_bytes {
                line.get(x - pixel_bytes).copied().unwrap_or(0)
            } else {
                0
            };
            let up = up_row.and_then(|row| row.get(x)).copied().unwrap_or(0);
            let corner = if x >= pixel_bytes {
                up_row
                    .and_then(|row| row.get(x - pixel_bytes))
                    .copied()
                    .unwrap_or(0)
            } else {
                0
            };
            let predicted = match filter {
                1 => left,
                2 => up,
                3 => ((u16::from(left) + u16::from(up)) >> 1) as u8,
                _ => paeth(left, up, corner),
            };
            if let Some(byte) = line.get_mut(x) {
                *byte = byte.wrapping_add(predicted);
            }
        }
    }
    Some(())
}

fn paeth(left: u8, up: u8, corner: u8) -> u8 {
    let (a, b, c) = (i16::from(left), i16::from(up), i16::from(corner));
    let p = a + b - c;
    let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
    if pa <= pb && pa <= pc {
        left
    } else if pb <= pc {
        up
    } else {
        corner
    }
}

/// A PNG as RGBA8, or None for anything malformed, unsupported or bigger than the limits.
pub fn decode(png: &[u8]) -> Option<Bitmap> {
    let parts = parts(png)?;
    let header = parts.header;
    if header.len() != 13 {
        return None;
    }

    let width = be_u32(header, 0)?;
    let height = be_u32(header, 4)?;
    let (depth, color) = (header[8], header[9]);
    let (compression, filtering, interlace) = (header[10], header[11], header[12]);
    let channels: u64 = match color {
        0 | 3 => 1,
        2 => 3,
        4 => 2,
        6 => 4,
        _ => return None,
    };
    let size_ok = width > 0
        && height > 0
        && width <= MAX_SIDE
        && height <= MAX_SIDE
        && u64::from(width) * u64::from(height) <= MAX_PIXELS;
    let depth_ok = matches!(depth, 1 | 2 | 4 | 8 | 16) && !(color == 3 && depth == 16);
    let type_ok = depth >= 8 || color == 0 || color == 3;
    let method_ok = compression == 0 && filtering == 0 && interlace <= 1;
    if !size_ok || !depth_ok || !type_ok || !method_ok {
        return None;
    }
    if color == 3 && parts.palette.is_none() {
        return None;
    }

    let trns = parts.transparency.unwrap_or(&[]);
    let pair = |at: usize| be_u32(&[0, 0, *trns.get(at)?, *trns.get(at + 1)?], 0);
    let key = match color {
        0 => pair(0).map(|gray| [gray as u16, 0, 0]),
        2 => match (pair(0), pair(2), pair(4)) {
            (Some(r), Some(g), Some(b)) => Some([r as u16, g as u16, b as u16]),
            _ => None,
        },
        _ => None,
    };
    let format = Format {
        color,
        depth,
        palette: parts.palette.unwrap_or(&[]),
        alphas: if color == 3 { trns } else { &[] },
        key,
    };

    let bits_per_pixel = channels * u64::from(depth);
    let pixel_bytes = usize::try_from(bits_per_pixel.div_ceil(8)).ok()?;
    let passes: &[[u32; 4]] = if interlace == 1 { &ADAM7 } else { &PROGRESSIVE };
    let mut expected = 0u64;
    for &[x0, y0, dx, dy] in passes {
        let columns = u64::from(width.saturating_sub(x0).div_ceil(dx));
        let rows = u64::from(height.saturating_sub(y0).div_ceil(dy));
        if columns > 0 && rows > 0 {
            let row_bytes = (columns * bits_per_pixel).div_ceil(8);
            expected = expected.checked_add(rows.checked_mul(row_bytes + 1)?)?;
        }
    }
    let expected = usize::try_from(expected).ok()?;
    let mut raw = inflate(&parts.data, expected.checked_add(1)?)?;
    if raw.len() < expected {
        return None;
    }

    let width_px = usize::try_from(width).ok()?;
    let pixels = width_px.checked_mul(usize::try_from(height).ok()?)?;
    let mut rgba = vec![0u8; pixels.checked_mul(4)?];
    let mut at = 0usize;
    for &[x0, y0, dx, dy] in passes {
        let columns = usize::try_from(width.saturating_sub(x0).div_ceil(dx)).ok()?;
        let rows = usize::try_from(height.saturating_sub(y0).div_ceil(dy)).ok()?;
        if columns == 0 || rows == 0 {
            continue;
        }

        let row_bytes = usize::try_from((columns as u64 * bits_per_pixel).div_ceil(8)).ok()?;
        let stride = row_bytes + 1;
        let end = at.checked_add(rows.checked_mul(stride)?)?;
        let pass = raw.get_mut(at..end)?;
        unfilter(pass, rows, row_bytes, pixel_bytes)?;

        let (x0, y0, dx, dy) = (x0 as usize, y0 as usize, dx as usize, dy as usize);
        for (y, line) in pass.chunks_exact(stride).enumerate() {
            let row = line.get(1..)?;
            let target_row = (y0 + y * dy) * width_px;
            for x in 0..columns {
                let target = (target_row + x0 + x * dx) * 4;
                if let Some(out) = rgba.get_mut(target..target + 4) {
                    out.copy_from_slice(&format.pixel(row, x));
                }
            }
        }
        at = end;
    }

    Some(Bitmap {
        width,
        height,
        channels: 4,
        bytes: rgba,
    })
}

/// One axis of a resampling: for each output pixel, its first source pixel and weights.
struct Kernel {
    taps: Vec<(usize, usize, usize)>,
    weights: Vec<i32>,
}

impl Kernel {
    /// Triangle-filter weights mapping source span in0..in1 of in_size pixels to out_size.
    fn new(in_size: usize, in0: f64, in1: f64, out_size: usize) -> Kernel {
        let scale = (in1 - in0) / out_size as f64;
        let support = if scale > 1.0 { scale } else { 1.0 };
        let last = in_size.saturating_sub(1);
        let mut taps = Vec::with_capacity(out_size);
        let mut weights = Vec::new();
        let mut floats = Vec::new();
        for xx in 0..out_size {
            let center = in0 + (xx as f64 + 0.5) * scale;
            let low = ((center - support + 0.5).max(0.0) as usize).min(last);
            let high = ((center + support + 0.5).max(0.0) as usize).clamp(low + 1, in_size.max(1));

            floats.clear();
            let mut total = 0.0;
            for x in low..high {
                let distance = (x as f64 - center + 0.5) / support;
                let distance = if distance < 0.0 { -distance } else { distance };
                let weight = if distance < 1.0 { 1.0 - distance } else { 0.0 };
                floats.push(weight);
                total += weight;
            }

            let first = weights.len();
            if total > 0.0 {
                let one = f64::from(1u32 << WEIGHT_BITS);
                weights.extend(floats.iter().map(|w| (w / total * one + 0.5) as i32));
                taps.push((low, first, high - low));
            } else {
                let nearest = (center.max(0.0) as usize).min(last);
                weights.push(1 << WEIGHT_BITS);
                taps.push((nearest, first, 1));
            }
        }
        Kernel { taps, weights }
    }

    fn rows(&self) -> (usize, usize) {
        let low = self.taps.iter().map(|tap| tap.0).min().unwrap_or(0);
        let high = self.taps.iter().map(|tap| tap.0 + tap.2).max().unwrap_or(0);
        (low, high)
    }
}

fn clip(sum: i64) -> u8 {
    (sum >> WEIGHT_BITS).clamp(0, 255) as u8
}

/// Weighted RGBA sum of `count` pixels from `src`, `stride` bytes apart, starting at `at`.
fn convolve(src: &[u8], at: usize, stride: usize, weights: &[i32]) -> [u8; 4] {
    let mut sum = [1i64 << (WEIGHT_BITS - 1); 4];
    for (k, &weight) in weights.iter().enumerate() {
        if let Some(pixel) = src.get(at + k * stride..at + k * stride + 4) {
            for (total, &value) in sum.iter_mut().zip(pixel) {
                *total += i64::from(value) * i64::from(weight);
            }
        }
    }
    sum.map(clip)
}

/// Resamples premultiplied RGBA from the source box (x0, y0, x1, y1) to width x height.
fn resample(
    src: &[u8],
    src_width: usize,
    src_height: usize,
    width: usize,
    height: usize,
    area: [f64; 4],
) -> Vec<u8> {
    let horizontal = Kernel::new(src_width, area[0], area[2], width);
    let vertical = Kernel::new(src_height, area[1], area[3], height);
    let (first_row, end_row) = vertical.rows();

    let rows = end_row.saturating_sub(first_row);
    let mut wide = vec![0u8; width * rows * 4];
    for y in 0..rows {
        let src_row = (first_row + y) * src_width * 4;
        for (x, &(start, first, count)) in horizontal.taps.iter().enumerate() {
            let weights = horizontal.weights.get(first..first + count).unwrap_or(&[]);
            let pixel = convolve(src, src_row + start * 4, 4, weights);
            let at = (y * width + x) * 4;
            if let Some(out) = wide.get_mut(at..at + 4) {
                out.copy_from_slice(&pixel);
            }
        }
    }

    let mut out = vec![0u8; width * height * 4];
    for (y, &(start, first, count)) in vertical.taps.iter().enumerate() {
        let weights = vertical.weights.get(first..first + count).unwrap_or(&[]);
        let base = start.saturating_sub(first_row) * width * 4;
        for x in 0..width {
            let pixel = convolve(&wide, base + x * 4, width * 4, weights);
            let at = (y * width + x) * 4;
            if let Some(target) = out.get_mut(at..at + 4) {
                target.copy_from_slice(&pixel);
            }
        }
    }
    out
}

fn premultiply(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    for pixel in out.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        for value in &mut pixel[..3] {
            *value = ((u32::from(*value) * alpha + 127) / 255) as u8;
        }
    }
    out
}

fn unpremultiply(bytes: &mut [u8]) {
    for pixel in bytes.chunks_exact_mut(4) {
        let alpha = u32::from(pixel[3]);
        if alpha == 0 || alpha == 255 {
            continue;
        }
        for value in &mut pixel[..3] {
            *value = ((u32::from(*value) * 255 + alpha / 2) / alpha).min(255) as u8;
        }
    }
}

/// The box radius b whose three passes best match a Gaussian of radius height / 12:
/// three boxes of 2b + 1 have variance b(b + 1), so b(b + 1) ~ (height / 12)^2.
fn box_radius(height: usize) -> usize {
    let target = (height * height) as i64;
    let guess = height / 12;
    let error = |b: usize| (144 * (b * (b + 1)) as i64 - target).abs();
    [guess.saturating_sub(1), guess, guess + 1]
        .into_iter()
        .min_by_key(|&b| error(b))
        .unwrap_or(guess)
}

/// One box blur pass of radius `radius` along each line of the RGB channels, edges clamped.
fn box_pass(
    bytes: &mut [u8],
    lines: usize,
    length: usize,
    pixel_stride: usize,
    line_stride: usize,
    radius: usize,
    line: &mut Vec<u8>,
) {
    if length == 0 {
        return;
    }
    let window = (2 * radius + 1) as u32;
    let (last, radius) = (length as i64 - 1, radius as i64);
    for l in 0..lines {
        for c in 0..3 {
            let base = l * line_stride + c;
            line.clear();
            line.extend(
                (0..length).map(|x| bytes.get(base + x * pixel_stride).copied().unwrap_or(0)),
            );
            let at = |x: i64| u32::from(line.get(x.clamp(0, last) as usize).copied().unwrap_or(0));

            let mut sum: u32 = (-radius..=radius).map(at).sum();
            for x in 0..length {
                if let Some(value) = bytes.get_mut(base + x * pixel_stride) {
                    *value = ((sum + window / 2) / window) as u8;
                }
                let x = x as i64;
                sum = sum + at(x + radius + 1) - at(x - radius);
            }
        }
    }
}

/// Gaussian-like blur of RGBA in place: three box passes per axis.
fn blur(bytes: &mut [u8], width: usize, height: usize, radius: usize) {
    if radius == 0 {
        return;
    }
    let mut line = Vec::with_capacity(width.max(height));
    for _ in 0..3 {
        box_pass(bytes, height, width, 4, width * 4, radius, &mut line);
    }
    for _ in 0..3 {
        box_pass(bytes, width, height, width * 4, 4, radius, &mut line);
    }
}

/// The cover fitted whole inside a width x height tile over a blurred, darkened fill of
/// itself, as opaque RGBA; None when the PNG does not decode or the tile is empty or too big.
pub fn tile(png: &[u8], width: u32, height: u32) -> Option<Bitmap> {
    let size_ok = width > 0
        && height > 0
        && width <= MAX_SIDE
        && height <= MAX_SIDE
        && u64::from(width) * u64::from(height) <= MAX_PIXELS;
    if !size_ok {
        return None;
    }

    let art = decode(png)?;
    let premultiplied = premultiply(&art.bytes);
    drop(art.bytes);
    let (art_w, art_h) = (art.width as usize, art.height as usize);
    let (w, h) = (width as usize, height as usize);
    // Compare art_w / art_h with w / h exactly.
    let (wide, tall) = (art_w * h, w * art_h);

    let (aw, ah) = (art_w as f64, art_h as f64);
    let area = if wide > tall {
        let crop = w as f64 * ah / h as f64;
        let left = (aw - crop) * 0.5;
        [left, 0.0, left + crop, ah]
    } else if wide < tall {
        let crop = aw * h as f64 / w as f64;
        let top = (ah - crop) * 0.5;
        [0.0, top, aw, top + crop]
    } else {
        [0.0, 0.0, aw, ah]
    };
    let mut fill = resample(&premultiplied, art_w, art_h, w, h, area);
    unpremultiply(&mut fill);
    blur(&mut fill, w, h, box_radius(h));
    for pixel in fill.chunks_exact_mut(4) {
        for value in &mut pixel[..3] {
            *value = (u32::from(*value) * FILL_PERCENT / 100) as u8;
        }
        pixel[3] = 255;
    }

    let (cover_w, cover_h) = if wide > tall {
        (w, ((art_h * w * 2 + art_w) / (2 * art_w)).clamp(1, h))
    } else if wide < tall {
        (((art_w * h * 2 + art_h) / (2 * art_h)).clamp(1, w), h)
    } else {
        (w, h)
    };
    let cover = resample(
        &premultiplied,
        art_w,
        art_h,
        cover_w,
        cover_h,
        [0.0, 0.0, aw, ah],
    );
    drop(premultiplied);

    // Premultiplied source over the opaque fill.
    let (left, top) = ((w - cover_w) / 2, (h - cover_h) / 2);
    for (y, row) in cover.chunks_exact(cover_w * 4).enumerate() {
        for (x, pixel) in row.chunks_exact(4).enumerate() {
            let alpha = u32::from(pixel[3]);
            if alpha == 0 {
                continue;
            }
            let at = ((top + y) * w + left + x) * 4;
            if let Some(target) = fill.get_mut(at..at + 3) {
                for (out, &value) in target.iter_mut().zip(pixel) {
                    let under = (u32::from(*out) * (255 - alpha) + 127) / 255;
                    *out = (u32::from(value) + under).min(255) as u8;
                }
            }
        }
    }

    Some(Bitmap {
        width,
        height,
        channels: 4,
        bytes: fill,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adler32(bytes: &[u8]) -> u32 {
        let (mut low, mut high) = (1u32, 0u32);
        for &byte in bytes {
            low = (low + u32::from(byte)) % 65521;
            high = (high + low) % 65521;
        }
        high << 16 | low
    }

    /// A zlib stream of stored deflate blocks.
    fn zlib(raw: &[u8]) -> Vec<u8> {
        let mut out = vec![0x78, 0x01];
        let blocks: Vec<&[u8]> = if raw.is_empty() {
            vec![raw]
        } else {
            raw.chunks(65535).collect()
        };
        for (i, block) in blocks.iter().enumerate() {
            out.push(u8::from(i + 1 == blocks.len()));
            let length = block.len() as u16;
            out.extend(length.to_le_bytes());
            out.extend((!length).to_le_bytes());
            out.extend_from_slice(block);
        }
        out.extend(adler32(raw).to_be_bytes());
        out
    }

    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
        out.extend((body.len() as u32).to_be_bytes());
        let mut typed = kind.to_vec();
        typed.extend_from_slice(body);
        out.extend_from_slice(&typed);
        out.extend(crc32(&typed).to_be_bytes());
    }

    fn header(width: u32, height: u32, depth: u8, color: u8, interlace: u8) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend(width.to_be_bytes());
        body.extend(height.to_be_bytes());
        body.extend([depth, color, 0, 0, interlace]);
        body
    }

    /// A PNG of the IHDR, extra chunks and the already filtered raw scanlines.
    fn encode(ihdr: &[u8], extra: &[(&[u8; 4], &[u8])], raw: &[u8]) -> Vec<u8> {
        let mut out = SIGNATURE.to_vec();
        chunk(&mut out, b"IHDR", ihdr);
        for (kind, body) in extra {
            chunk(&mut out, kind, body);
        }
        let stream = zlib(raw);
        let (first, second) = stream.split_at(stream.len() / 2);
        chunk(&mut out, b"IDAT", first);
        chunk(&mut out, b"IDAT", second);
        chunk(&mut out, b"IEND", &[]);
        out
    }

    /// Rows (unfiltered bytes) filtered with filters[y % len].
    fn filtered(rows: &[Vec<u8>], pixel_bytes: usize, filters: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for (y, row) in rows.iter().enumerate() {
            let filter = filters[y % filters.len()];
            out.push(filter);
            for x in 0..row.len() {
                let left = if x >= pixel_bytes {
                    row[x - pixel_bytes]
                } else {
                    0
                };
                let up = if y > 0 { rows[y - 1][x] } else { 0 };
                let corner = if y > 0 && x >= pixel_bytes {
                    rows[y - 1][x - pixel_bytes]
                } else {
                    0
                };
                let predicted = match filter {
                    0 => 0,
                    1 => left,
                    2 => up,
                    3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
                    _ => paeth(left, up, corner),
                };
                out.push(row[x].wrapping_sub(predicted));
            }
        }
        out
    }

    /// Packs sub-byte samples MSB first.
    fn pack(samples: &[u8], depth: usize) -> Vec<u8> {
        let mut out = vec![0u8; (samples.len() * depth).div_ceil(8)];
        for (i, &value) in samples.iter().enumerate() {
            let bit = i * depth;
            out[bit / 8] |= value << (8 - depth - bit % 8);
        }
        out
    }

    fn rgba_image(width: usize, height: usize) -> Vec<Vec<u8>> {
        (0..height)
            .map(|y| {
                (0..width * 4)
                    .map(|i| ((y * 53 + i * 31 + (i % 4) * 17) % 256) as u8)
                    .collect()
            })
            .collect()
    }

    #[test]
    fn rgba8_decodes_exactly() {
        let rows = rgba_image(3, 2);
        let png = encode(&header(3, 2, 8, 6, 0), &[], &filtered(&rows, 4, &[0]));
        let bitmap = decode(&png).unwrap();
        assert_eq!((bitmap.width, bitmap.height, bitmap.channels), (3, 2, 4));
        assert_eq!(bitmap.bytes, rows.concat());
    }

    #[test]
    fn palette_with_transparency_decodes() {
        let palette = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
        let trns = [0, 128];
        let indices = [[0u8, 1, 2], [3, 1, 0]];
        let expect = |i: u8| {
            let i = usize::from(i);
            let alpha = trns.get(i).copied().unwrap_or(255);
            [
                palette[3 * i],
                palette[3 * i + 1],
                palette[3 * i + 2],
                alpha,
            ]
        };
        let wanted: Vec<u8> = indices.iter().flatten().flat_map(|&i| expect(i)).collect();
        for depth in [4u8, 8] {
            let rows: Vec<Vec<u8>> = indices.iter().map(|row| pack(row, depth.into())).collect();
            let extra: [(&[u8; 4], &[u8]); 2] = [(b"PLTE", &palette), (b"tRNS", &trns)];
            let png = encode(
                &header(3, 2, depth, 3, 0),
                &extra,
                &filtered(&rows, 1, &[0]),
            );
            assert_eq!(decode(&png).unwrap().bytes, wanted, "depth {depth}");
        }
        // A palette image without PLTE is refused.
        let rows: Vec<Vec<u8>> = indices.iter().map(|row| row.to_vec()).collect();
        assert!(
            decode(&encode(
                &header(3, 2, 8, 3, 0),
                &[],
                &filtered(&rows, 1, &[0])
            ))
            .is_none()
        );
    }

    #[test]
    fn filters_round_trip() {
        let rows: Vec<Vec<u8>> = rgba_image(4, 3)
            .iter()
            .map(|row| row.chunks(4).flat_map(|px| [px[0], px[1], px[2]]).collect())
            .collect();
        let plain = decode(&encode(
            &header(4, 3, 8, 2, 0),
            &[],
            &filtered(&rows, 3, &[0]),
        ))
        .unwrap();
        let expected: Vec<u8> = rows
            .concat()
            .chunks(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect();
        assert_eq!(plain.bytes, expected);
        for filters in [&[1u8][..], &[2], &[3], &[4], &[4, 3, 1], &[2, 0, 4]] {
            let png = encode(&header(4, 3, 8, 2, 0), &[], &filtered(&rows, 3, filters));
            assert_eq!(
                decode(&png).unwrap().bytes,
                plain.bytes,
                "filters {filters:?}"
            );
        }
        let mut bad = filtered(&rows, 3, &[0]);
        bad[0] = 5;
        assert!(decode(&encode(&header(4, 3, 8, 2, 0), &[], &bad)).is_none());
    }

    /// Adam7 scanlines of an image given as pixel rows of `pixel_bytes` bytes (or sub-byte
    /// samples when depth < 8).
    fn interlaced(samples: &[Vec<u8>], width: usize, per_pixel: usize, depth: usize) -> Vec<u8> {
        let mut out = Vec::new();
        for [x0, y0, dx, dy] in ADAM7.map(|pass| pass.map(|v| v as usize)) {
            let rows: Vec<Vec<u8>> = (y0..samples.len())
                .step_by(dy)
                .map(|y| {
                    let picked: Vec<u8> = (x0..width)
                        .step_by(dx)
                        .flat_map(|x| samples[y][x * per_pixel..(x + 1) * per_pixel].to_vec())
                        .collect();
                    if depth < 8 {
                        pack(&picked, depth)
                    } else {
                        picked
                    }
                })
                .filter(|row| !row.is_empty())
                .collect();
            out.extend(filtered(&rows, (per_pixel * depth).div_ceil(8), &[4, 1]));
        }
        out
    }

    #[test]
    fn interlaced_matches_progressive() {
        let rows = rgba_image(9, 10);
        let progressive = decode(&encode(
            &header(9, 10, 8, 6, 0),
            &[],
            &filtered(&rows, 4, &[0]),
        ));
        let adam7 = decode(&encode(
            &header(9, 10, 8, 6, 1),
            &[],
            &interlaced(&rows, 9, 4, 8),
        ));
        assert_eq!(adam7.unwrap().bytes, progressive.unwrap().bytes);

        // 2-bit gray, interlaced, small enough for empty passes.
        let gray: Vec<Vec<u8>> = (0..3)
            .map(|y| (0..5).map(|x| ((x + y) % 4) as u8).collect())
            .collect();
        let packed: Vec<Vec<u8>> = gray.iter().map(|row| pack(row, 2)).collect();
        let progressive = decode(&encode(
            &header(5, 3, 2, 0, 0),
            &[],
            &filtered(&packed, 1, &[0]),
        ));
        let adam7 = decode(&encode(
            &header(5, 3, 2, 0, 1),
            &[],
            &interlaced(&gray, 5, 1, 2),
        ));
        let progressive = progressive.unwrap();
        assert_eq!(adam7.unwrap().bytes, progressive.bytes);
        assert_eq!(&progressive.bytes[..8], &[0, 0, 0, 255, 85, 85, 85, 255]);
    }

    #[test]
    fn sixteen_bit_keeps_high_byte_and_key() {
        // RGB16, second pixel matches the tRNS key exactly.
        let row = vec![
            0x12, 0x34, 0xab, 0xcd, 0xff, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
        ];
        let trns = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
        let png = encode(
            &header(2, 1, 16, 2, 0),
            &[(b"tRNS", &trns)],
            &filtered(&[row], 6, &[1]),
        );
        assert_eq!(
            decode(&png).unwrap().bytes,
            [0x12, 0xab, 0xff, 255, 0x01, 0x03, 0x05, 0]
        );
    }

    #[test]
    fn malformed_is_refused() {
        let rows = rgba_image(3, 2);
        let good = encode(&header(3, 2, 8, 6, 0), &[], &filtered(&rows, 4, &[0]));
        assert!(decode(&good).is_some());

        let mut bad_crc = good.clone();
        let idat_crc = good.len() - 12 - 1;
        bad_crc[idat_crc] ^= 1;
        assert!(decode(&bad_crc).is_none());
        for cut in [0, 7, 8, 20, 33, good.len() / 2, good.len() - 1] {
            assert!(decode(&good[..cut]).is_none(), "cut at {cut}");
        }
        // Too few scanline bytes inside a valid stream.
        let short = filtered(&rows, 4, &[0]);
        assert!(
            decode(&encode(
                &header(3, 2, 8, 6, 0),
                &[],
                &short[..short.len() - 1]
            ))
            .is_none()
        );

        let raw = filtered(&rows, 4, &[0]);
        for (width, height) in [(0, 2), (3, 0), (MAX_SIDE + 1, 1), (2000, 2000)] {
            assert!(decode(&encode(&header(width, height, 8, 6, 0), &[], &raw)).is_none());
        }
        for (depth, color) in [(16, 3), (4, 2), (8, 5), (3, 0)] {
            assert!(decode(&encode(&header(3, 2, depth, color, 0), &[], &raw)).is_none());
        }
        let mut long_ihdr = header(3, 2, 8, 6, 0);
        long_ihdr.push(0);
        assert!(decode(&encode(&long_ihdr, &[], &raw)).is_none());
        assert!(decode(&encode(&header(3, 2, 8, 6, 2), &[], &raw)).is_none());
    }

    fn gray_gradient(width: usize, height: usize) -> Vec<Vec<u8>> {
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| (30 + (x * 120 / width + y * 120 / height) / 2) as u8)
                    .collect()
            })
            .collect()
    }

    #[test]
    fn gray_cover_with_mixed_filters_decodes_exactly_and_tiles_smoothly() {
        let rows = gray_gradient(60, 80);
        let expected: Vec<u8> = rows
            .concat()
            .iter()
            .flat_map(|&gray| [gray, gray, gray, 255])
            .collect();
        for filters in [&[4u8, 1, 2, 3, 0][..], &[4], &[3, 4, 4, 2]] {
            let png = encode(&header(60, 80, 8, 0, 0), &[], &filtered(&rows, 1, filters));
            assert_eq!(decode(&png).unwrap().bytes, expected, "filters {filters:?}");
            let tile = tile(&png, 40, 60).unwrap();
            let gray = |x: usize, y: usize| i32::from(tile.bytes[(y * 40 + x) * 4]);
            for y in 1..59 {
                for x in 1..39 {
                    let around = [
                        gray(x - 1, y),
                        gray(x + 1, y),
                        gray(x, y - 1),
                        gray(x, y + 1),
                    ];
                    assert!(
                        around.iter().any(|&other| (gray(x, y) - other).abs() <= 3),
                        "isolated pixel at {x},{y} with filters {filters:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_damaged_cover_is_refused_instead_of_decoded_wrongly() {
        let rows = gray_gradient(60, 80);
        let raw = filtered(&rows, 1, &[4]);
        let mut stream = zlib(&raw);
        stream[2 + 5 + 1000] ^= 0x40;
        let mut damaged = SIGNATURE.to_vec();
        chunk(&mut damaged, b"IHDR", &header(60, 80, 8, 0, 0));
        chunk(&mut damaged, b"IDAT", &stream);
        chunk(&mut damaged, b"IEND", &[]);
        assert!(decode(&damaged).is_none());
        assert!(tile(&damaged, 40, 60).is_none());
    }

    fn solid(width: usize, height: usize, rgba: [u8; 4]) -> Vec<u8> {
        let rows: Vec<Vec<u8>> = (0..height).map(|_| rgba.repeat(width)).collect();
        encode(
            &header(width as u32, height as u32, 8, 6, 0),
            &[],
            &filtered(&rows, 4, &[0]),
        )
    }

    #[test]
    fn tile_dims_fill_and_centres_art() {
        let white = tile(&solid(6, 8, [255; 4]), 240, 135).unwrap();
        assert_eq!((white.width, white.height, white.channels), (240, 135, 4));
        assert_eq!(white.bytes.len(), 240 * 135 * 4);
        let pixel = |bitmap: &Bitmap, x: usize, y: usize| {
            let at = (y * bitmap.width as usize + x) * 4;
            [0, 1, 2, 3].map(|c| bitmap.bytes[at + c])
        };
        let limit = (0.35f64 * 255.0 + 1.0) as u8;
        for (x, y) in [(0, 0), (239, 0), (0, 134), (239, 134)] {
            let [r, g, b, a] = pixel(&white, x, y);
            assert_eq!(a, 255);
            assert!(
                r <= limit && g <= limit && b <= limit,
                "corner {x},{y}: {r} {g} {b}"
            );
            assert!(r >= 80, "corner {x},{y} too dark: {r}");
        }
        for y in [0, 67, 134] {
            assert_eq!(pixel(&white, 120, y), [255; 4]);
        }

        let red = tile(&solid(6, 8, [200, 30, 40, 255]), 240, 135).unwrap();
        assert_eq!(pixel(&red, 120, 67), [200, 30, 40, 255]);
        assert_eq!(pixel(&red, 0, 0), [70, 10, 14, 255]);

        // Transparent art leaves the black fill.
        let clear = tile(&solid(4, 4, [255, 255, 255, 0]), 16, 9).unwrap();
        assert!(clear.bytes.chunks(4).all(|p| p == [0, 0, 0, 255]));

        assert!(tile(&solid(6, 8, [255; 4]), 0, 135).is_none());
        assert!(tile(&solid(6, 8, [255; 4]), 240, 0).is_none());
        assert!(tile(b"not a png", 240, 135).is_none());
        // Landscape art in a portrait tile, and an exact-ratio one.
        assert!(tile(&solid(9, 2, [1, 2, 3, 255]), 50, 80).is_some());
        assert!(tile(&solid(16, 9, [1, 2, 3, 255]), 32, 18).is_some());
    }
}
