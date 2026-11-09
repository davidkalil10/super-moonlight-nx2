//! Bounded JSON reader for settings records: one parse into a fixed node table, no allocation.
//! Number coercion follows JavaScript `Number()`, as the JS settings code did.

pub const MAX_NODES: usize = 2048;
pub const MAX_DEPTH: u32 = 64;
pub const MAX_TEXT: usize = 4096;

const NONE: u16 = u16::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Null,
    False,
    True,
    Number,
    String,
    Array,
    Object,
}

#[derive(Clone, Copy)]
struct Node {
    kind: Kind,
    number: f64,
    text: u32,
    length: u32,
    key: u32,
    key_length: u32,
    start: u32,
    end: u32,
    first: u16,
    next: u16,
    count: u16,
}

const EMPTY: Node = Node {
    kind: Kind::Null,
    number: 0.0,
    text: 0,
    length: 0,
    key: 0,
    key_length: 0,
    start: 0,
    end: 0,
    first: NONE,
    next: NONE,
    count: 0,
};

/// Parsed document. About 100 KiB; keep one per owner rather than on a small stack.
pub struct Json {
    nodes: [Node; MAX_NODES],
    node_count: usize,
    strings: [u8; MAX_TEXT],
    strings_used: usize,
}

/// A node of a parsed document.
#[derive(Clone, Copy)]
pub struct Value<'a> {
    json: &'a Json,
    index: u16,
}

impl Json {
    pub const fn new() -> Self {
        Self {
            nodes: [EMPTY; MAX_NODES],
            node_count: 0,
            strings: [0; MAX_TEXT],
            strings_used: 0,
        }
    }

    /// Parses `text`, replacing any earlier document. Returns the root on success.
    pub fn parse(&mut self, text: &[u8]) -> Option<Value<'_>> {
        self.node_count = 0;
        self.strings_used = 0;
        if text.len() > MAX_TEXT || text.starts_with(b"\xef\xbb\xbf") {
            return None;
        }

        let mut parser = Parser {
            json: self,
            text,
            at: 0,
        };
        if parser.value(0) != Some(0) {
            return None;
        }
        parser.skip();
        if parser.at != text.len() {
            return None;
        }

        Some(Value {
            json: self,
            index: 0,
        })
    }
}

impl Default for Json {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> Value<'a> {
    fn node(&self) -> &'a Node {
        &self.json.nodes[self.index as usize]
    }

    fn at(&self, index: u16) -> Option<Value<'a>> {
        if index == NONE {
            return None;
        }
        Some(Value {
            json: self.json,
            index,
        })
    }

    pub fn kind(&self) -> Kind {
        self.node().kind
    }

    pub fn number(&self) -> Option<f64> {
        let node = self.node();
        if node.kind != Kind::Number {
            return None;
        }
        Some(node.number)
    }

    pub fn string(&self) -> Option<&'a [u8]> {
        let node = self.node();
        if node.kind != Kind::String {
            return None;
        }
        Some(self.bytes(node.text, node.length))
    }

    pub fn key(&self) -> &'a [u8] {
        let node = self.node();
        self.bytes(node.key, node.key_length)
    }

    /// Byte range of this value in the parsed source.
    pub fn span(&self) -> core::ops::Range<usize> {
        let node = self.node();
        node.start as usize..node.end as usize
    }

    pub fn count(&self) -> usize {
        self.node().count as usize
    }

    pub fn child(&self) -> Option<Value<'a>> {
        self.at(self.node().first)
    }

    pub fn next(&self) -> Option<Value<'a>> {
        self.at(self.node().next)
    }

    /// The last member named `key`, as JavaScript keeps for duplicate keys.
    pub fn member(&self, key: &str) -> Option<Value<'a>> {
        if self.kind() != Kind::Object {
            return None;
        }

        let mut found = None;
        let mut child = self.child();
        while let Some(value) = child {
            if value.key() == key.as_bytes() {
                found = Some(value);
            }
            child = value.next();
        }
        found
    }

    pub fn string_is(&self, text: &str) -> bool {
        self.string() == Some(text.as_bytes())
    }

    /// JavaScript `Number(value)`.
    pub fn to_number(&self) -> f64 {
        let node = self.node();
        match node.kind {
            Kind::Null | Kind::False => 0.0,
            Kind::True => 1.0,
            Kind::Number => node.number,
            Kind::String => string_number(self.bytes(node.text, node.length)),
            Kind::Object => f64::NAN,
            Kind::Array => self.array_number(),
        }
    }

    fn array_number(&self) -> f64 {
        match self.count() {
            0 => return 0.0,
            1 => {}
            _ => return f64::NAN,
        }

        let Some(only) = self.child() else {
            return f64::NAN;
        };
        match only.kind() {
            Kind::True | Kind::False | Kind::Object => f64::NAN,
            _ => only.to_number(),
        }
    }

    fn bytes(&self, offset: u32, length: u32) -> &'a [u8] {
        &self.json.strings[offset as usize..(offset + length) as usize]
    }
}

struct Parser<'j, 't> {
    json: &'j mut Json,
    text: &'t [u8],
    at: usize,
}

impl Parser<'_, '_> {
    fn peek(&self) -> Option<u8> {
        self.text.get(self.at).copied()
    }

    fn skip(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &[u8]) -> bool {
        if !self.text[self.at..].starts_with(word) {
            return false;
        }
        self.at += word.len();
        true
    }

    fn new_node(&mut self, kind: Kind) -> Option<u16> {
        let json = &mut *self.json;
        if json.node_count >= MAX_NODES {
            return None;
        }

        let index = json.node_count;
        json.node_count += 1;
        json.nodes[index] = Node { kind, ..EMPTY };
        Some(index as u16)
    }

    fn put(&mut self, bytes: &[u8]) -> bool {
        let json = &mut *self.json;
        let end = json.strings_used + bytes.len();
        if end > MAX_TEXT {
            return false;
        }

        json.strings[json.strings_used..end].copy_from_slice(bytes);
        json.strings_used = end;
        true
    }

    /// Lone surrogates are kept as their three-byte form, like the C reader.
    fn put_code_point(&mut self, code: u32) -> bool {
        let mut bytes = [0u8; 4];
        let size = if code < 0x80 {
            bytes[0] = code as u8;
            1
        } else if code < 0x800 {
            bytes[0] = 0xc0 | (code >> 6) as u8;
            bytes[1] = 0x80 | (code & 0x3f) as u8;
            2
        } else if code < 0x10000 {
            bytes[0] = 0xe0 | (code >> 12) as u8;
            bytes[1] = 0x80 | ((code >> 6) & 0x3f) as u8;
            bytes[2] = 0x80 | (code & 0x3f) as u8;
            3
        } else {
            bytes[0] = 0xf0 | (code >> 18) as u8;
            bytes[1] = 0x80 | ((code >> 12) & 0x3f) as u8;
            bytes[2] = 0x80 | ((code >> 6) & 0x3f) as u8;
            bytes[3] = 0x80 | (code & 0x3f) as u8;
            4
        };
        self.put(&bytes[..size])
    }

    fn hex4(&mut self) -> Option<u32> {
        if self.text.len() - self.at < 4 {
            return None;
        }

        let mut value = 0;
        for _ in 0..4 {
            let digit = (self.text[self.at] as char).to_digit(16);
            self.at += 1;
            value = (value << 4) | digit?;
        }
        Some(value)
    }

    fn escape(&mut self) -> bool {
        let Some(c) = self.peek() else {
            return false;
        };
        self.at += 1;

        let simple = match c {
            b'"' | b'\\' | b'/' => Some(c),
            b'b' => Some(0x08),
            b'f' => Some(0x0c),
            b'n' => Some(b'\n'),
            b'r' => Some(b'\r'),
            b't' => Some(b'\t'),
            _ => None,
        };
        if let Some(byte) = simple {
            return self.put(&[byte]);
        }
        if c != b'u' {
            return false;
        }

        let Some(code) = self.hex4() else {
            return false;
        };
        if let Some(pair) = self.low_surrogate(code) {
            return self.put_code_point(pair);
        }
        self.put_code_point(code)
    }

    fn low_surrogate(&mut self, high: u32) -> Option<u32> {
        let is_high = (0xd800..0xdc00).contains(&high);
        let follows = self.text[self.at..].len() >= 6 && self.text[self.at..].starts_with(b"\\u");
        if !is_high || !follows {
            return None;
        }

        let mark = self.at;
        self.at += 2;
        match self.hex4() {
            Some(low) if (0xdc00..0xe000).contains(&low) => {
                Some(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00))
            }
            _ => {
                self.at = mark;
                None
            }
        }
    }

    /// Returns the decoded string's offset and length in the string table.
    fn string(&mut self) -> Option<(u32, u32)> {
        if self.peek() != Some(b'"') {
            return None;
        }
        self.at += 1;

        let offset = self.json.strings_used;
        while let Some(c) = self.peek() {
            self.at += 1;
            if c == b'"' {
                let length = self.json.strings_used - offset;
                return self.put(&[0]).then_some((offset as u32, length as u32));
            }

            let stored = match c {
                0..0x20 => false,
                b'\\' => self.escape(),
                _ => self.put(&[c]),
            };
            if !stored {
                return None;
            }
        }
        None
    }

    fn digits(&mut self) -> bool {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at > start
    }

    fn number(&mut self) -> Option<f64> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        if self.peek() == Some(b'0') {
            self.at += 1;
        } else if !self.digits() {
            return None;
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if !self.digits() {
                return None;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if !self.digits() {
                return None;
            }
        }

        let source = &self.text[start..self.at];
        if source.len() >= 64 {
            return None;
        }
        core::str::from_utf8(source).ok()?.parse().ok()
    }

    fn members(&mut self, parent: u16, depth: u32, object: bool) -> bool {
        let close = if object { b'}' } else { b']' };
        self.skip();
        if self.peek() == Some(close) {
            self.at += 1;
            return true;
        }

        let mut last = NONE;
        loop {
            let mut key = (0, 0);
            if object {
                self.skip();
                let Some(found) = self.string() else {
                    return false;
                };
                key = found;
                self.skip();
                if self.peek() != Some(b':') {
                    return false;
                }
                self.at += 1;
            }

            let Some(child) = self.value(depth + 1) else {
                return false;
            };
            let nodes = &mut self.json.nodes;
            nodes[child as usize].key = key.0;
            nodes[child as usize].key_length = key.1;
            if last == NONE {
                nodes[parent as usize].first = child;
            } else {
                nodes[last as usize].next = child;
            }
            last = child;
            nodes[parent as usize].count += 1;

            self.skip();
            let Some(c) = self.peek() else {
                return false;
            };
            self.at += 1;
            if c == close {
                return true;
            }
            if c != b',' {
                return false;
            }
        }
    }

    fn value(&mut self, depth: u32) -> Option<u16> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.skip();
        let c = self.peek()?;
        let start = self.at;

        let node = match c {
            b'{' | b'[' => {
                let object = c == b'{';
                let node = self.new_node(if object { Kind::Object } else { Kind::Array })?;
                self.at += 1;
                if !self.members(node, depth, object) {
                    return None;
                }
                node
            }
            b'"' => {
                let node = self.new_node(Kind::String)?;
                let (text, length) = self.string()?;
                self.json.nodes[node as usize].text = text;
                self.json.nodes[node as usize].length = length;
                node
            }
            _ if self.literal(b"null") => self.new_node(Kind::Null)?,
            _ if self.literal(b"true") => self.new_node(Kind::True)?,
            _ if self.literal(b"false") => self.new_node(Kind::False)?,
            _ => {
                let number = self.number()?;
                let node = self.new_node(Kind::Number)?;
                self.json.nodes[node as usize].number = number;
                node
            }
        };

        self.json.nodes[node as usize].start = start as u32;
        self.json.nodes[node as usize].end = self.at as u32;
        Some(node)
    }
}

/// Length of the JavaScript whitespace or BOM at `at`, scanning no further than `s`.
fn js_space(s: &[u8], at: usize) -> Option<usize> {
    let c = s[at];
    let rest = &s[at + 1..];
    if c == b' ' || (b'\t'..=b'\r').contains(&c) {
        return Some(1);
    }
    if c == 0xc2 && rest.starts_with(&[0xa0]) {
        return Some(2);
    }
    if rest.len() < 2 {
        return None;
    }

    let (b1, b2) = (rest[0], rest[1]);
    let space = match c {
        0xef => b1 == 0xbb && b2 == 0xbf,
        0xe2 if b1 == 0x80 => matches!(b2, 0xa8 | 0xa9 | 0xaf) || b2 <= 0x8a,
        0xe2 => b1 == 0x81 && b2 == 0x9f,
        0xe3 => b1 == 0x80 && b2 == 0x80,
        0xe1 => b1 == 0x9a && b2 == 0x80,
        _ => false,
    };
    space.then_some(3)
}

fn trailing_space(s: &[u8], start: usize) -> Option<usize> {
    let end = s.len();
    (1..=3.min(end - start)).find(|&candidate| js_space(s, end - candidate) == Some(candidate))
}

fn radix_number(s: &[u8], base: u32) -> f64 {
    if s.is_empty() {
        return f64::NAN;
    }

    let mut value = 0.0;
    for &c in s {
        let Some(digit) = (c as char).to_digit(36).filter(|&digit| digit < base) else {
            return f64::NAN;
        };
        value = value * base as f64 + digit as f64;
    }
    value
}

fn count_digits(s: &[u8], at: &mut usize) -> usize {
    let start = *at;
    while s.get(*at).is_some_and(u8::is_ascii_digit) {
        *at += 1;
    }
    *at - start
}

fn decimal_number(s: &[u8]) -> f64 {
    let mut at = usize::from(matches!(s.first(), Some(b'+' | b'-')));
    if &s[at..] == b"Infinity" {
        return if s[0] == b'-' {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }

    let whole = count_digits(s, &mut at);
    let mut fraction = 0;
    if s.get(at) == Some(&b'.') {
        at += 1;
        fraction = count_digits(s, &mut at);
    }
    if whole == 0 && fraction == 0 {
        return f64::NAN;
    }
    if matches!(s.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(s.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        if count_digits(s, &mut at) == 0 {
            return f64::NAN;
        }
    }
    if at != s.len() || s.len() >= 512 {
        return f64::NAN;
    }

    core::str::from_utf8(s)
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(f64::NAN)
}

/// JavaScript `Number(string)`.
pub fn string_number(text: &[u8]) -> f64 {
    let mut start = 0;
    let mut end = text.len();
    while start < end {
        let Some(size) = js_space(&text[..end], start) else {
            break;
        };
        start += size;
    }
    while end > start {
        let Some(size) = trailing_space(&text[..end], start) else {
            break;
        };
        end -= size;
    }

    let t = &text[start..end];
    if t.is_empty() {
        return 0.0;
    }
    if t.len() > 2 && t[0] == b'0' {
        match t[1] {
            b'x' | b'X' => return radix_number(&t[2..], 16),
            b'o' | b'O' => return radix_number(&t[2..], 8),
            b'b' | b'B' => return radix_number(&t[2..], 2),
            _ => {}
        }
    }
    decimal_number(t)
}
