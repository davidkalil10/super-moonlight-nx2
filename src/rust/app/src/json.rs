//! Strict, borrowed JSON reader for control-v1 replies (NATIVE-CONTROL-V1.md).
//! `ui::json` is sized for 4 KiB settings records and keeps the last duplicate key; replies run to
//! 64 KiB and must refuse duplicates, so this validates in place and walks the original bytes.

pub const MAX_DEPTH: usize = 8;
pub const MAX_MEMBERS: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Syntax,
    Encoding,
    Depth,
    DuplicateKey,
    TooManyMembers,
    Trailing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Kind {
    Null,
    Bool,
    Number,
    String,
    Array,
    Object,
}

/// A validated value: a span of the original document.
#[derive(Clone, Copy, Debug)]
pub struct Value<'a> {
    text: &'a [u8],
    start: usize,
    end: usize,
}

/// Validates the whole document and returns its root.
pub fn parse(text: &[u8]) -> Result<Value<'_>, Error> {
    parse_with_duplicates(text, true)
}

pub(crate) fn classify(text: &[u8]) -> Result<Value<'_>, Error> {
    parse_with_duplicates(text, false)
}

fn parse_with_duplicates(text: &[u8], reject_duplicates: bool) -> Result<Value<'_>, Error> {
    if core::str::from_utf8(text).is_err() {
        return Err(Error::Encoding);
    }

    let mut cursor = Cursor {
        text,
        at: 0,
        reject_duplicates,
    };
    cursor.space();
    let start = cursor.at;
    cursor.value(0)?;
    let end = cursor.at;
    cursor.space();
    if cursor.at != text.len() {
        return Err(Error::Trailing);
    }

    Ok(Value { text, start, end })
}

impl<'a> Value<'a> {
    pub fn kind(&self) -> Kind {
        match self.text[self.start] {
            b'n' => Kind::Null,
            b't' | b'f' => Kind::Bool,
            b'"' => Kind::String,
            b'[' => Kind::Array,
            b'{' => Kind::Object,
            _ => Kind::Number,
        }
    }

    pub fn raw(&self) -> &'a [u8] {
        &self.text[self.start..self.end]
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self.raw() {
            b"true" => Some(true),
            b"false" => Some(false),
            _ => None,
        }
    }

    /// A non-negative integer without fraction or exponent.
    pub fn as_u64(&self) -> Option<u64> {
        let raw = self.raw();
        let digits_only = !raw.is_empty() && raw.iter().all(u8::is_ascii_digit);
        if !digits_only {
            return None;
        }

        let mut value: u64 = 0;
        for digit in raw {
            value = value
                .checked_mul(10)?
                .checked_add(u64::from(digit - b'0'))?;
        }
        Some(value)
    }

    /// An integer without fraction or exponent.
    pub fn as_i64(&self) -> Option<i64> {
        let raw = self.raw();
        let (negative, digits) = match raw.split_first() {
            Some((b'-', rest)) => (true, rest),
            _ => (false, raw),
        };
        let magnitude = Value {
            text: digits,
            start: 0,
            end: digits.len(),
        }
        .as_u64()?;

        if negative {
            0i64.checked_sub_unsigned(magnitude)
        } else {
            i64::try_from(magnitude).ok()
        }
    }

    /// The string's contents when it has no escapes, so it can be borrowed as is.
    pub fn as_plain_str(&self) -> Option<&'a str> {
        if self.kind() != Kind::String {
            return None;
        }
        let inner = &self.text[self.start + 1..self.end - 1];
        if inner.contains(&b'\\') {
            return None;
        }
        core::str::from_utf8(inner).ok()
    }

    /// Decodes the string into `out`; `None` when it is not a string or does not fit.
    pub fn decode_str<'b>(&self, out: &'b mut [u8]) -> Option<&'b str> {
        if self.kind() != Kind::String {
            return None;
        }

        let inner = &self.text[self.start + 1..self.end - 1];
        let mut read = 0;
        let mut written = 0;
        while read < inner.len() {
            let byte = inner[read];
            if byte != b'\\' {
                *out.get_mut(written)? = byte;
                written += 1;
                read += 1;
                continue;
            }

            let (code, used) = escape(&inner[read..])?;
            let mut utf8 = [0u8; 4];
            let encoded = code.encode_utf8(&mut utf8).as_bytes();
            out.get_mut(written..written + encoded.len())?
                .copy_from_slice(encoded);
            written += encoded.len();
            read += used;
        }

        core::str::from_utf8(&out[..written]).ok()
    }

    /// True when the string equals `expected` after decoding.
    pub fn string_is(&self, expected: &str) -> bool {
        let mut buffer = [0u8; 64];
        if expected.len() > buffer.len() {
            return false;
        }
        self.decode_str(&mut buffer) == Some(expected)
    }

    pub fn members(&self) -> Members<'a> {
        let at = if self.kind() == Kind::Object {
            self.start + 1
        } else {
            self.end
        };
        Members {
            cursor: Cursor {
                text: self.text,
                at,
                reject_duplicates: true,
            },
            end: self.end,
        }
    }

    pub fn elements(&self) -> Elements<'a> {
        let at = if self.kind() == Kind::Array {
            self.start + 1
        } else {
            self.end
        };
        Elements {
            cursor: Cursor {
                text: self.text,
                at,
                reject_duplicates: true,
            },
            end: self.end,
        }
    }

    pub fn member(&self, key: &str) -> Option<Value<'a>> {
        self.members()
            .find(|(name, _)| name.string_is(key))
            .map(|(_, value)| value)
    }
}

/// Iterates an object's `(key, value)` pairs.
pub struct Members<'a> {
    cursor: Cursor<'a>,
    end: usize,
}

impl<'a> Iterator for Members<'a> {
    type Item = (Value<'a>, Value<'a>);

    fn next(&mut self) -> Option<Self::Item> {
        let key = self.cursor.next_item(self.end)?;
        self.cursor.space();
        self.cursor.at += 1;
        self.cursor.space();
        let start = self.cursor.at;
        self.cursor.skip();
        let value = Value {
            text: self.cursor.text,
            start,
            end: self.cursor.at,
        };
        Some((key, value))
    }
}

/// Iterates an array's elements.
pub struct Elements<'a> {
    cursor: Cursor<'a>,
    end: usize,
}

impl<'a> Iterator for Elements<'a> {
    type Item = Value<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        self.cursor.next_item(self.end)
    }
}

struct Cursor<'a> {
    text: &'a [u8],
    at: usize,
    reject_duplicates: bool,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> Option<u8> {
        self.text.get(self.at).copied()
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), Error> {
        if self.peek() != Some(byte) {
            return Err(Error::Syntax);
        }
        self.at += 1;
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Result<(), Error> {
        if depth >= MAX_DEPTH {
            return Err(Error::Depth);
        }

        match self.peek().ok_or(Error::Syntax)? {
            b'{' => self.object(depth),
            b'[' => self.array(depth),
            b'"' => self.string(),
            b't' => self.literal(b"true"),
            b'f' => self.literal(b"false"),
            b'n' => self.literal(b"null"),
            _ => self.number(),
        }
    }

    fn literal(&mut self, word: &[u8]) -> Result<(), Error> {
        if !self.text[self.at..].starts_with(word) {
            return Err(Error::Syntax);
        }
        self.at += word.len();
        Ok(())
    }

    fn digits(&mut self) -> Result<(), Error> {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        if self.at == start {
            return Err(Error::Syntax);
        }
        Ok(())
    }

    fn number(&mut self) -> Result<(), Error> {
        if self.peek() == Some(b'-') {
            self.at += 1;
        }

        if self.peek() == Some(b'0') {
            self.at += 1;
        } else {
            self.digits()?;
        }

        if self.peek() == Some(b'.') {
            self.at += 1;
            self.digits()?;
        }

        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            self.digits()?;
        }

        Ok(())
    }

    fn string(&mut self) -> Result<(), Error> {
        self.expect(b'"')?;
        loop {
            match self.peek().ok_or(Error::Syntax)? {
                b'"' => {
                    self.at += 1;
                    return Ok(());
                }
                b'\\' => {
                    let (_, used) = escape(&self.text[self.at..]).ok_or(Error::Syntax)?;
                    self.at += used;
                }
                0..=0x1f => return Err(Error::Syntax),
                _ => self.at += 1,
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<(), Error> {
        self.expect(b'[')?;
        self.space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(());
        }

        loop {
            self.space();
            self.value(depth + 1)?;
            self.space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(());
                }
                _ => return Err(Error::Syntax),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<(), Error> {
        self.expect(b'{')?;
        self.space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(());
        }

        let mut keys = [(0usize, 0usize); MAX_MEMBERS];
        let mut count = 0;
        loop {
            self.space();
            let start = self.at;
            self.string()?;
            let key = (start, self.at);
            if self.reject_duplicates {
                if count == MAX_MEMBERS {
                    return Err(Error::TooManyMembers);
                }
                if keys[..count].iter().any(|seen| self.same_key(*seen, key)) {
                    return Err(Error::DuplicateKey);
                }
                keys[count] = key;
                count += 1;
            }

            self.space();
            self.expect(b':')?;
            self.space();
            self.value(depth + 1)?;
            self.space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(());
                }
                _ => return Err(Error::Syntax),
            }
        }
    }

    fn same_key(&self, a: (usize, usize), b: (usize, usize)) -> bool {
        let first = Chars {
            text: &self.text[a.0 + 1..a.1 - 1],
            at: 0,
        };
        let second = Chars {
            text: &self.text[b.0 + 1..b.1 - 1],
            at: 0,
        };
        first.eq(second)
    }

    /// Skips one already-validated value.
    fn skip(&mut self) {
        let mut depth = 0usize;
        let mut in_string = false;
        while let Some(byte) = self.peek() {
            if in_string {
                match byte {
                    b'\\' => self.at += 1,
                    b'"' => in_string = false,
                    _ => {}
                }
                self.at += 1;
                if !in_string && depth == 0 {
                    return;
                }
                continue;
            }

            match byte {
                b'"' => in_string = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    if depth == 0 {
                        return;
                    }
                    depth -= 1;
                    if depth == 0 {
                        self.at += 1;
                        return;
                    }
                }
                b',' if depth == 0 => return,
                b' ' | b'\t' | b'\n' | b'\r' if depth == 0 => return,
                _ => {}
            }
            self.at += 1;
        }
    }

    /// Steps over separators and returns the next validated item before `end`.
    fn next_item(&mut self, end: usize) -> Option<Value<'a>> {
        self.space();
        if self.peek() == Some(b',') {
            self.at += 1;
            self.space();
        }
        if self.at + 1 >= end {
            return None;
        }

        let start = self.at;
        self.skip();
        Some(Value {
            text: self.text,
            start,
            end: self.at,
        })
    }
}

/// Decoded characters of a validated string body, compared without a buffer.
struct Chars<'a> {
    text: &'a [u8],
    at: usize,
}

impl Iterator for Chars<'_> {
    type Item = char;

    fn next(&mut self) -> Option<char> {
        let rest = self.text.get(self.at..)?;
        if rest.is_empty() {
            return None;
        }
        if rest[0] == b'\\' {
            let (code, used) = escape(rest)?;
            self.at += used;
            return Some(code);
        }

        let width = utf8_width(rest[0]);
        let code = core::str::from_utf8(rest.get(..width)?)
            .ok()?
            .chars()
            .next()?;
        self.at += width;
        Some(code)
    }
}

fn utf8_width(lead: u8) -> usize {
    match lead {
        0xf0.. => 4,
        0xe0.. => 3,
        0xc0.. => 2,
        _ => 1,
    }
}

/// Decodes one escape at the start of `text`; returns the character and bytes used.
fn escape(text: &[u8]) -> Option<(char, usize)> {
    let simple = match *text.get(1)? {
        b'"' => Some('"'),
        b'\\' => Some('\\'),
        b'/' => Some('/'),
        b'b' => Some('\u{8}'),
        b'f' => Some('\u{c}'),
        b'n' => Some('\n'),
        b'r' => Some('\r'),
        b't' => Some('\t'),
        b'u' => None,
        _ => return None,
    };
    if let Some(code) = simple {
        return Some((code, 2));
    }

    let high = hex4(text.get(2..6)?)?;
    if !(0xd800..0xdc00).contains(&high) {
        return char::from_u32(high).map(|code| (code, 6));
    }

    if text.get(6..8)? != b"\\u" {
        return None;
    }
    let low = hex4(text.get(8..12)?)?;
    if !(0xdc00..0xe000).contains(&low) {
        return None;
    }
    let code = 0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00);
    char::from_u32(code).map(|code| (code, 12))
}

fn hex4(digits: &[u8]) -> Option<u32> {
    let mut value = 0;
    for digit in digits {
        value = value * 16 + char::from(*digit).to_digit(16)?;
    }
    Some(value)
}
