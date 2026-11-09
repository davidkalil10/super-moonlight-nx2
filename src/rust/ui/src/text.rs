use core::fmt;

/// Fixed-capacity UTF-8 text. Writes past the capacity are cut at a character boundary.
#[derive(Clone, Copy)]
pub struct Text<const N: usize> {
    bytes: [u8; N],
    length: usize,
}

impl<const N: usize> Text<N> {
    pub const fn new() -> Self {
        Self {
            bytes: [0; N],
            length: 0,
        }
    }

    /// `text`, cut to the capacity.
    pub fn of(text: &str) -> Self {
        let mut out = Self::new();
        out.push_str(text);
        out
    }

    pub fn as_str(&self) -> &str {
        // Only whole characters are ever copied in.
        core::str::from_utf8(&self.bytes[..self.length]).unwrap_or("")
    }

    pub fn len(&self) -> usize {
        self.length
    }

    pub fn is_empty(&self) -> bool {
        self.length == 0
    }

    pub fn clear(&mut self) {
        self.length = 0;
    }

    pub fn push_str(&mut self, text: &str) -> bool {
        let room = N - self.length;
        let mut take = text.len().min(room);
        while !text.is_char_boundary(take) {
            take -= 1;
        }

        self.bytes[self.length..self.length + take].copy_from_slice(&text.as_bytes()[..take]);
        self.length += take;
        take == text.len()
    }
}

impl<const N: usize> Default for Text<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> fmt::Write for Text<N> {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        if self.push_str(text) {
            Ok(())
        } else {
            Err(fmt::Error)
        }
    }
}

impl<const N: usize> fmt::Display for Text<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl<const N: usize> fmt::Debug for Text<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.as_str(), f)
    }
}

impl<const N: usize> PartialEq for Text<N> {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}

impl<const N: usize> Eq for Text<N> {}

impl<const N: usize> PartialEq<str> for Text<N> {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}

impl<const N: usize> PartialEq<&str> for Text<N> {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}
