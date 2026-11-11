//! One HTTP/1.1 GET and its response, read incrementally. Sunshine answers with a length or
//! chunks; a response without either ends at the close. RTSP replies use the same reader,
//! where a reply without a length has no body.

use alloc::{format, string::String, vec::Vec};

pub const MAX_HEAD_BYTES: usize = 8192;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Malformed,
    TooLarge,
    Truncated,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    /// The first header called `name`, ignoring case.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// A GET for `target` (path and query), closing the connection after the reply.
pub fn get(host: &str, port: u16, target: &str) -> Vec<u8> {
    format!(
        "GET {target} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: moonlight-nx2\r\n\
         Accept: */*\r\nConnection: close\r\n\r\n"
    )
    .into_bytes()
}

#[derive(Clone, Copy, Debug)]
enum Framing {
    Length(usize),
    Chunked,
    Close,
}

#[derive(Clone, Copy, Debug)]
struct Head {
    status: u16,
    body_start: usize,
    framing: Framing,
}

pub struct Reader {
    bytes: Vec<u8>,
    limit: usize,
    head: Option<Head>,
    rtsp: bool,
}

impl Reader {
    /// `limit` bounds the body; the head has its own bound.
    pub fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            head: None,
            rtsp: false,
        }
    }

    pub fn rtsp(limit: usize) -> Self {
        Self {
            rtsp: true,
            ..Self::new(limit)
        }
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<(), Error> {
        if self.bytes.len() + data.len() > self.limit + MAX_HEAD_BYTES {
            return Err(Error::TooLarge);
        }
        self.bytes.extend_from_slice(data);

        if self.head.is_none() {
            self.head = parse_head(&self.bytes, self.rtsp)?;
            if self.head.is_none() && self.bytes.len() > MAX_HEAD_BYTES {
                return Err(Error::TooLarge);
            }
        }
        let Some(head) = self.head else {
            return Ok(());
        };
        let body = self.bytes.len() - head.body_start;
        let too_large = match head.framing {
            Framing::Length(length) => length > self.limit,
            Framing::Chunked => body > self.limit + self.limit / 16 + 64,
            Framing::Close => body > self.limit,
        };
        if too_large {
            return Err(Error::TooLarge);
        }
        Ok(())
    }

    /// The response once it is whole; `eof` says the peer closed.
    pub fn complete(&self, eof: bool) -> Option<Result<Response, Error>> {
        let Some(head) = self.head else {
            return eof.then_some(Err(Error::Truncated));
        };
        let body = &self.bytes[head.body_start..];

        let decoded = match head.framing {
            Framing::Length(length) if body.len() >= length => Ok(body[..length].to_vec()),
            Framing::Length(_) if eof => Err(Error::Truncated),
            Framing::Length(_) => return None,
            Framing::Chunked => match dechunk(body) {
                Ok(Some(body)) => Ok(body),
                Ok(None) if eof => Err(Error::Truncated),
                Ok(None) => return None,
                Err(error) => Err(error),
            },
            Framing::Close if eof => Ok(body.to_vec()),
            Framing::Close => return None,
        };
        let headers = headers(&self.bytes[..head.body_start]);
        Some(decoded.map(|body| Response {
            status: head.status,
            headers,
            body,
        }))
    }
}

fn headers(head: &[u8]) -> Vec<(String, String)> {
    let text = core::str::from_utf8(head).unwrap_or_default();
    text.split("\r\n")
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (String::from(name.trim()), String::from(value.trim())))
        .collect()
}

fn parse_head(bytes: &[u8], rtsp: bool) -> Result<Option<Head>, Error> {
    let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Ok(None);
    };
    let head = core::str::from_utf8(&bytes[..end]).map_err(|_| Error::Malformed)?;
    let mut lines = head.split("\r\n");

    let status_line = lines.next().ok_or(Error::Malformed)?;
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    let status = parts.next().and_then(|code| code.parse().ok());
    let protocol = if rtsp { "RTSP/1." } else { "HTTP/1." };
    let Some(status) = status.filter(|_| version.starts_with(protocol)) else {
        return Err(Error::Malformed);
    };

    let mut framing = if rtsp { Framing::Length(0) } else { Framing::Close };
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(Error::Malformed)?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            let length = value.parse().map_err(|_| Error::Malformed)?;
            framing = Framing::Length(length);
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            && value.eq_ignore_ascii_case("chunked")
        {
            framing = Framing::Chunked;
        }
    }
    Ok(Some(Head {
        status,
        body_start: end + 4,
        framing,
    }))
}

fn dechunk(mut body: &[u8]) -> Result<Option<Vec<u8>>, Error> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = body.windows(2).position(|window| window == b"\r\n") else {
            return Ok(None);
        };
        let line = core::str::from_utf8(&body[..line_end]).map_err(|_| Error::Malformed)?;
        let size = line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size, 16).map_err(|_| Error::Malformed)?;
        let data = &body[line_end + 2..];

        if size == 0 {
            return Ok(Some(out));
        }
        if data.len() < size + 2 {
            return Ok(None);
        }
        if &data[size..size + 2] != b"\r\n" {
            return Err(Error::Malformed);
        }
        out.extend_from_slice(&data[..size]);
        body = &data[size + 2..];
    }
}
