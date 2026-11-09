//! A small zlib inflate after puff's canonical-code decoder: stored, fixed and dynamic blocks,
//! the zlib header and its Adler-32. Port of ui/inflate.c.

use alloc::vec::Vec;

const MAX_BITS: usize = 15;
const MAX_LITERALS: usize = 288;
const MAX_DISTANCES: usize = 30;
const CODE_LENGTH_CODES: usize = 19;
const END_OF_BLOCK: i32 = 256;
const ADLER_MODULUS: u32 = 65521;
const FIRST_CAPACITY: usize = 65536;

const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE: [u16; MAX_DISTANCES] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA: [u8; MAX_DISTANCES] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];
const CODE_LENGTH_ORDER: [usize; CODE_LENGTH_CODES] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];

struct Huffman {
    counts: [u16; MAX_BITS + 1],
    symbols: [u16; MAX_LITERALS],
}

impl Huffman {
    /// None when the lengths over-subscribe the code; incomplete codes are allowed.
    fn new(lengths: &[u8]) -> Option<Self> {
        let mut huffman = Self {
            counts: [0; MAX_BITS + 1],
            symbols: [0; MAX_LITERALS],
        };
        for &length in lengths {
            huffman.counts[length as usize] += 1;
        }

        let mut left = 1i32;
        for &count in &huffman.counts[1..] {
            left = left * 2 - i32::from(count);
            if left < 0 {
                return None;
            }
        }

        let mut offsets = [0u16; MAX_BITS + 1];
        for length in 1..MAX_BITS {
            offsets[length + 1] = offsets[length] + huffman.counts[length];
        }
        for (symbol, &length) in lengths.iter().enumerate() {
            if length != 0 {
                huffman.symbols[offsets[length as usize] as usize] = symbol as u16;
                offsets[length as usize] += 1;
            }
        }
        Some(huffman)
    }
}

struct Stream<'a> {
    input: &'a [u8],
    at: usize,
    bits: u32,
    bit_count: u32,
    out: Vec<u8>,
    limit: usize,
    failed: bool,
}

impl Stream<'_> {
    fn take_bits(&mut self, need: u32) -> u32 {
        let mut value = self.bits;
        while self.bit_count < need {
            let Some(&byte) = self.input.get(self.at) else {
                self.failed = true;
                return 0;
            };
            value |= u32::from(byte) << self.bit_count;
            self.at += 1;
            self.bit_count += 8;
        }

        self.bits = value.checked_shr(need).unwrap_or(0);
        self.bit_count -= need;
        value & ((1u32 << need) - 1)
    }

    fn reserve(&mut self, extra: usize) -> bool {
        if extra > self.limit - self.out.len() {
            return false;
        }
        let needed = self.out.len() + extra;
        if needed <= self.out.capacity() {
            return true;
        }

        let mut capacity = self.out.capacity().max(FIRST_CAPACITY);
        while capacity < needed {
            capacity *= 2;
        }
        let capacity = capacity.min(self.limit);
        self.out
            .try_reserve_exact(capacity - self.out.len())
            .is_ok()
    }

    fn decode(&mut self, huffman: &Huffman) -> Option<i32> {
        let mut code = 0i32;
        let mut first = 0i32;
        let mut index = 0i32;
        for &count in &huffman.counts[1..] {
            code |= self.take_bits(1) as i32;
            if self.failed {
                return None;
            }

            let count = i32::from(count);
            if code - first < count {
                return Some(i32::from(huffman.symbols[(index + code - first) as usize]));
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        None
    }

    fn copy_match(&mut self, length: usize, distance: usize) -> bool {
        if distance > self.out.len() || !self.reserve(length) {
            return false;
        }
        for _ in 0..length {
            self.out.push(self.out[self.out.len() - distance]);
        }
        true
    }

    fn codes(&mut self, literals: &Huffman, distances: &Huffman) -> bool {
        loop {
            let Some(symbol) = self.decode(literals) else {
                return false;
            };
            if symbol == END_OF_BLOCK {
                return true;
            }

            if symbol < END_OF_BLOCK {
                if !self.reserve(1) {
                    return false;
                }
                self.out.push(symbol as u8);
                continue;
            }

            let length_code = (symbol - END_OF_BLOCK - 1) as usize;
            if length_code >= LENGTH_BASE.len() {
                return false;
            }
            let length = u32::from(LENGTH_BASE[length_code])
                + self.take_bits(LENGTH_EXTRA[length_code].into());

            let Some(distance_code) = self.decode(distances) else {
                return false;
            };
            let distance_code = distance_code as usize;
            if distance_code >= MAX_DISTANCES {
                return false;
            }
            let distance = u32::from(DISTANCE_BASE[distance_code])
                + self.take_bits(DISTANCE_EXTRA[distance_code].into());
            if self.failed || !self.copy_match(length as usize, distance as usize) {
                return false;
            }
        }
    }

    fn stored(&mut self) -> bool {
        self.bits = 0;
        self.bit_count = 0;
        let Some(header) = self.input.get(self.at..self.at + 4) else {
            return false;
        };
        let length = usize::from(u16::from_le_bytes([header[0], header[1]]));
        let complement = u16::from_le_bytes([header[2], header[3]]);
        self.at += 4;
        if length != usize::from(!complement) {
            return false;
        }

        let Some(bytes) = self.input.get(self.at..self.at + length) else {
            return false;
        };
        if !self.reserve(length) {
            return false;
        }
        self.out.extend_from_slice(bytes);
        self.at += length;
        true
    }

    fn fixed(&mut self) -> bool {
        let mut lengths = [8u8; MAX_LITERALS];
        lengths[144..256].fill(9);
        lengths[256..280].fill(7);
        let (Some(literals), Some(distances)) =
            (Huffman::new(&lengths), Huffman::new(&[5; MAX_DISTANCES]))
        else {
            return false;
        };
        self.codes(&literals, &distances)
    }

    fn code_lengths(&mut self, lengths: &mut [u8]) -> bool {
        let code_count = self.take_bits(4) as usize + 4;
        let mut code_lengths = [0u8; CODE_LENGTH_CODES];
        for &symbol in &CODE_LENGTH_ORDER[..code_count] {
            code_lengths[symbol] = self.take_bits(3) as u8;
        }
        if self.failed {
            return false;
        }
        let Some(codes) = Huffman::new(&code_lengths) else {
            return false;
        };

        let mut at = 0;
        while at < lengths.len() {
            let Some(symbol) = self.decode(&codes) else {
                return false;
            };
            if symbol < 16 {
                lengths[at] = symbol as u8;
                at += 1;
                continue;
            }

            let (repeated, repeat) = match symbol {
                16 if at == 0 => return false,
                16 => (lengths[at - 1], 3 + self.take_bits(2)),
                17 => (0, 3 + self.take_bits(3)),
                _ => (0, 11 + self.take_bits(7)),
            };
            let repeat = repeat as usize;
            if self.failed || repeat > lengths.len() - at {
                return false;
            }
            lengths[at..at + repeat].fill(repeated);
            at += repeat;
        }
        true
    }

    fn dynamic(&mut self) -> bool {
        let literal_count = self.take_bits(5) as usize + 257;
        let distance_count = self.take_bits(5) as usize + 1;
        if self.failed || literal_count > 286 || distance_count > MAX_DISTANCES {
            return false;
        }

        let mut lengths = [0u8; MAX_LITERALS + MAX_DISTANCES];
        let lengths = &mut lengths[..literal_count + distance_count];
        if !self.code_lengths(lengths) || lengths[END_OF_BLOCK as usize] == 0 {
            return false;
        }

        let (literal_lengths, distance_lengths) = lengths.split_at(literal_count);
        let (Some(literals), Some(distances)) = (
            Huffman::new(literal_lengths),
            Huffman::new(distance_lengths),
        ) else {
            return false;
        };
        self.codes(&literals, &distances)
    }

    fn blocks(&mut self) -> bool {
        let mut last = false;
        while !last {
            last = self.take_bits(1) == 1;
            let kind = self.take_bits(2);
            if self.failed {
                return false;
            }

            let inflated = match kind {
                0 => self.stored(),
                1 => self.fixed(),
                2 => self.dynamic(),
                _ => false,
            };
            if !inflated {
                return false;
            }
        }
        true
    }

    fn adler_matches(&mut self) -> bool {
        self.bits = 0;
        self.bit_count = 0;
        let Some(trailer) = self.input.get(self.at..self.at + 4) else {
            return false;
        };
        let expected = u32::from_be_bytes([trailer[0], trailer[1], trailer[2], trailer[3]]);
        adler32(&self.out) == expected
    }
}

fn adler32(bytes: &[u8]) -> u32 {
    let (mut low, mut high) = (1u32, 0u32);
    for &byte in bytes {
        low = (low + u32::from(byte)) % ADLER_MODULUS;
        high = (high + low) % ADLER_MODULUS;
    }
    high << 16 | low
}

fn header_ok(input: &[u8]) -> bool {
    let [first, second, ..] = *input else {
        return false;
    };
    let method = first & 15;
    let window = first >> 4;
    let preset_dictionary = second & 0x20 != 0;
    let checked = (u32::from(first) << 8 | u32::from(second)) % 31 == 0;
    method == 8 && window <= 7 && !preset_dictionary && checked
}

/// Inflates a zlib stream of less than `limit` bytes; like C, the output must stay under it.
pub fn inflate(input: &[u8], limit: usize) -> Option<Vec<u8>> {
    if !header_ok(input) {
        return None;
    }

    let mut stream = Stream {
        input,
        at: 2,
        bits: 0,
        bit_count: 0,
        out: Vec::new(),
        limit,
        failed: false,
    };
    let inflated = stream.blocks() && stream.reserve(1) && stream.adler_matches();
    if !inflated {
        return None;
    }
    stream.out.shrink_to_fit();
    Some(stream.out)
}
