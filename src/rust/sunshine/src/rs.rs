//! Reed-Solomon erasure coding over GF(2^8), compatible with nanors as Sunshine uses it and
//! with moonlight-common-c's rs.c: a systematic code whose parity row j, column i is
//! 1 / ((parity + i) ^ j). Workspaces are allocated once; encoding and recovery do not allocate.

use alloc::{vec, vec::Vec};

pub const MAX_SHARDS: usize = 255;

const POLYNOMIAL: u16 = 0x11d;

struct Tables {
    exp: [u8; 512],
    log: [u8; 256],
}

const TABLES: Tables = tables();

const fn tables() -> Tables {
    let mut exp = [0u8; 512];
    let mut log = [0u8; 256];
    let mut value: u16 = 1;
    let mut i = 0;
    while i < 255 {
        exp[i] = value as u8;
        log[value as usize] = i as u8;
        value <<= 1;
        if value & 0x100 != 0 {
            value ^= POLYNOMIAL;
        }
        i += 1;
    }
    while i < 512 {
        exp[i] = exp[i - 255];
        i += 1;
    }
    Tables { exp, log }
}

pub fn mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        return 0;
    }
    TABLES.exp[TABLES.log[a as usize] as usize + TABLES.log[b as usize] as usize]
}

pub fn inverse(a: u8) -> u8 {
    if a == 0 {
        return 0;
    }
    TABLES.exp[255 - TABLES.log[a as usize] as usize]
}

fn row_table(c: u8, table: &mut [u8; 256]) {
    for (x, entry) in table.iter_mut().enumerate() {
        *entry = mul(c, x as u8);
    }
}

fn mul_add(dst: &mut [u8], src: &[u8], c: u8, table: &mut [u8; 256]) {
    match c {
        0 => {}
        1 => dst.iter_mut().zip(src).for_each(|(d, s)| *d ^= s),
        _ => {
            row_table(c, table);
            dst.iter_mut()
                .zip(src)
                .for_each(|(d, s)| *d ^= table[*s as usize]);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Shape,
    TooFewShards,
    Singular,
}

/// One code shape. `with_parity_rows` overrides the generated parity matrix (audio uses a
/// fixed one); `new` does not allocate.
pub struct Code {
    data: usize,
    parity: usize,
    rows: Option<Vec<u8>>,
}

impl Code {
    pub fn new(data: usize, parity: usize) -> Result<Self, Error> {
        if data == 0 || data + parity > MAX_SHARDS {
            return Err(Error::Shape);
        }
        Ok(Self {
            data,
            parity,
            rows: None,
        })
    }

    pub fn with_parity_rows(data: usize, parity: usize, rows: &[u8]) -> Result<Self, Error> {
        if data == 0 || data + parity > MAX_SHARDS || rows.len() != data * parity {
            return Err(Error::Shape);
        }
        Ok(Self {
            data,
            parity,
            rows: Some(rows.to_vec()),
        })
    }

    pub fn data_shards(&self) -> usize {
        self.data
    }

    pub fn parity_shards(&self) -> usize {
        self.parity
    }

    fn row(&self, shard: usize, column: usize) -> u8 {
        if shard < self.data {
            u8::from(shard == column)
        } else {
            let j = shard - self.data;
            match &self.rows {
                Some(rows) => rows[j * self.data + column],
                None => inverse(((self.parity + column) ^ j) as u8),
            }
        }
    }

    /// Fills each parity shard from the data shards; all shards share one length.
    pub fn encode(&self, data: &[&[u8]], parity: &mut [&mut [u8]]) -> Result<(), Error> {
        if data.len() != self.data || parity.len() != self.parity {
            return Err(Error::Shape);
        }
        let mut table = [0; 256];
        for (j, out) in parity.iter_mut().enumerate() {
            out.fill(0);
            for (i, shard) in data.iter().enumerate() {
                mul_add(out, shard, self.row(self.data + j, i), &mut table);
            }
        }
        Ok(())
    }
}

/// Scratch for recovery, sized for the largest code once.
pub struct Workspace {
    matrix: Vec<u8>,
    inverse: Vec<u8>,
    chosen: Vec<u8>,
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

impl Workspace {
    pub fn new() -> Self {
        Self {
            matrix: vec![0; MAX_SHARDS * MAX_SHARDS],
            inverse: vec![0; MAX_SHARDS * MAX_SHARDS],
            chosen: vec![0; MAX_SHARDS],
        }
    }

    /// Rebuilds every missing data shard in place. Shards are data then parity, all of one
    /// length. Parity shards used for recovery are overwritten; missing parity is untouched.
    pub fn reconstruct<S: Shards + ?Sized>(
        &mut self,
        code: &Code,
        shards: &mut S,
    ) -> Result<(), Error> {
        let (k, total) = (code.data, code.data + code.parity);
        if shards.count() != total {
            return Err(Error::Shape);
        }
        let mut missing = 0;
        for i in (0..k).filter(|&i| !shards.present(i)) {
            self.chosen[missing] = i as u8;
            missing += 1;
        }
        if missing == 0 {
            return Ok(());
        }
        let mut parity = 0;
        for p in (k..total).filter(|&p| shards.present(p)) {
            if parity == missing {
                break;
            }
            self.chosen[missing + parity] = p as u8;
            parity += 1;
        }
        if parity < missing {
            return Err(Error::TooFewShards);
        }

        let m = missing;
        for r in 0..m {
            let shard = self.chosen[m + r] as usize;
            for c in 0..m {
                self.matrix[r * m + c] = code.row(shard, self.chosen[c] as usize);
                self.inverse[r * m + c] = u8::from(r == c);
            }
        }
        invert(&mut self.matrix[..m * m], &mut self.inverse[..m * m], m)?;

        let mut table = [0; 256];
        for r in 0..m {
            let p = self.chosen[m + r] as usize;
            for i in 0..k {
                if !shards.present(i) {
                    continue;
                }
                let (syndrome, data) = shards.pair(p, i);
                mul_add(syndrome, data, code.row(p, i), &mut table);
            }
        }
        for c in 0..m {
            let out = self.chosen[c] as usize;
            shards.shard(out).fill(0);
            for r in 0..m {
                let p = self.chosen[m + r] as usize;
                let (out, syndrome) = shards.pair(out, p);
                mul_add(out, syndrome, self.inverse[c * m + r], &mut table);
            }
        }
        Ok(())
    }
}

/// Shard storage for recovery. `pair` returns two distinct shards, the first writable.
pub trait Shards {
    fn count(&self) -> usize;
    fn present(&self, shard: usize) -> bool;
    fn shard(&mut self, shard: usize) -> &mut [u8];
    fn pair(&mut self, write: usize, read: usize) -> (&mut [u8], &[u8]);
}

/// Shards as separate slices with a presence mask.
pub struct Slices<'a, 'b> {
    pub shards: &'a mut [&'b mut [u8]],
    pub present: &'a [bool],
}

impl Shards for Slices<'_, '_> {
    fn count(&self) -> usize {
        if self.shards.len() == self.present.len() {
            self.shards.len()
        } else {
            0
        }
    }

    fn present(&self, shard: usize) -> bool {
        self.present[shard]
    }

    fn shard(&mut self, shard: usize) -> &mut [u8] {
        self.shards[shard]
    }

    fn pair(&mut self, write: usize, read: usize) -> (&mut [u8], &[u8]) {
        pair(self.shards, write, read)
    }
}

fn pair<'s>(shards: &'s mut [&mut [u8]], write: usize, read: usize) -> (&'s mut [u8], &'s [u8]) {
    if write < read {
        let (low, high) = shards.split_at_mut(read);
        (&mut *low[write], &*high[0])
    } else {
        let (low, high) = shards.split_at_mut(write);
        (&mut *high[0], &*low[read])
    }
}

fn invert(matrix: &mut [u8], inverse: &mut [u8], k: usize) -> Result<(), Error> {
    for col in 0..k {
        let pivot = (col..k)
            .find(|&r| matrix[r * k + col] != 0)
            .ok_or(Error::Singular)?;
        if pivot != col {
            for c in 0..k {
                matrix.swap(pivot * k + c, col * k + c);
                inverse.swap(pivot * k + c, col * k + c);
            }
        }
        let scale = self::inverse(matrix[col * k + col]);
        for c in 0..k {
            matrix[col * k + c] = mul(matrix[col * k + c], scale);
            inverse[col * k + c] = mul(inverse[col * k + c], scale);
        }
        for r in (0..k).filter(|&r| r != col) {
            let factor = matrix[r * k + col];
            if factor == 0 {
                continue;
            }
            for c in 0..k {
                matrix[r * k + c] ^= mul(factor, matrix[col * k + c]);
                inverse[r * k + c] ^= mul(factor, inverse[col * k + c]);
            }
        }
    }
    Ok(())
}
