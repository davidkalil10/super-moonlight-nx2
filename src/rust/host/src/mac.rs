pub fn normalize(value: &str) -> Option<String> {
    let mut bytes = [0u8; 6];
    let mut parts = value.split(':');
    for byte in &mut bytes {
        let part = parts.next()?;
        if part.len() != 2 || !part.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        *byte = u8::from_str_radix(part, 16).ok()?;
    }
    if parts.next().is_some() || bytes == [0; 6] || bytes[0] & 1 != 0 {
        return None;
    }
    Some(
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn accepts_only_valid_unicast_mac() {
        assert_eq!(
            normalize("AA:BB:CC:DD:EE:F0").as_deref(),
            Some("aa:bb:cc:dd:ee:f0")
        );
        assert_eq!(normalize("00:00:00:00:00:00"), None);
        assert_eq!(normalize("ff:ff:ff:ff:ff:ff"), None);
        assert_eq!(normalize("01:00:00:00:00:01"), None);
        assert_eq!(normalize("00:11:22:33:44"), None);
        assert_eq!(normalize("00:11:22:33:44:gg"), None);
    }
}
