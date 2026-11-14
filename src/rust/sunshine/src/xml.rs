//! Just enough XML for Sunshine's flat replies: the root's status and element text.

use alloc::string::String;

/// The `status_code` and `status_message` attributes of `<root>`.
pub fn root_status(document: &str) -> Option<(u16, String)> {
    let start = document.find("<root")?;
    let end = start + document[start..].find('>')?;
    let tag = &document[start..end];

    let code = attribute(tag, "status_code")?.parse().ok()?;
    let message = attribute(tag, "status_message")
        .and_then(unescape)
        .unwrap_or_default();
    Some((code, message))
}

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let mut rest = tag;
    loop {
        let at = rest.find(name)?;
        let before = rest[..at].chars().next_back();
        let after = &rest[at + name.len()..];
        rest = after;
        if before.is_some_and(|c| !c.is_whitespace()) {
            continue;
        }
        let Some(value) = after.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim_start();
        let quote = value.chars().next()?;
        if quote != '"' && quote != '\'' {
            return None;
        }
        let value = &value[1..];
        return value.find(quote).map(|end| &value[..end]);
    }
}

/// The raw inner text of each `<tag>` element, in document order.
pub fn elements<'a>(document: &'a str, tag: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let mut rest = document;
    core::iter::from_fn(move || {
        loop {
            let at = rest.find('<')?;
            let candidate = &rest[at + 1..];
            rest = candidate;
            let Some(after) = candidate.strip_prefix(tag) else {
                continue;
            };
            let open_end = after.find('>')?;
            let attributes = &after[..open_end];
            if attributes
                .chars()
                .next()
                .is_some_and(|c| !c.is_whitespace() && c != '/')
            {
                continue;
            }
            if attributes.ends_with('/') {
                rest = &after[open_end + 1..];
                return Some("");
            }
            let body = &after[open_end + 1..];
            let close = closing(body, tag)?;
            rest = &body[close..];
            return Some(&body[..close]);
        }
    })
}

/// Where `</tag>` starts in `body`; GameStream documents never nest a tag in itself.
fn closing(body: &str, tag: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = body[from..].find("</") {
        let at = from + found;
        if closes(&body[at..], tag) {
            return Some(at);
        }
        from = at + 2;
    }
    None
}

fn closes(text: &str, tag: &str) -> bool {
    text.strip_prefix("</")
        .and_then(|rest| rest.strip_prefix(tag))
        .is_some_and(|rest| rest.trim_start().starts_with('>'))
}

/// The first `<tag>`'s text with entities resolved.
pub fn text(document: &str, tag: &str) -> Option<String> {
    elements(document, tag).next().and_then(unescape)
}

pub fn unescape(raw: &str) -> Option<String> {
    let mut text = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(at) = rest.find('&') {
        text.push_str(&rest[..at]);
        let entity = &rest[at + 1..];
        let end = entity.find(';')?;
        let name = &entity[..end];
        let resolved = match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => numeric(name)?,
        };
        text.push(resolved);
        rest = &entity[end + 1..];
    }
    text.push_str(rest);
    Some(text)
}

fn numeric(name: &str) -> Option<char> {
    let digits = name.strip_prefix('#')?;
    let value = match digits.strip_prefix(['x', 'X']) {
        Some(hex) => u32::from_str_radix(hex, 16).ok()?,
        None => digits.parse().ok()?,
    };
    char::from_u32(value)
}
