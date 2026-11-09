use moonlight_nx2_core::codec::{Capabilities, Codec, Depth, Evidence, Mode, Size};

/// A production capability is published only after decoded pixels and teardown match.
pub fn capabilities(verified: bool) -> Capabilities {
    let mut caps = Capabilities::default();
    caps.record(
        Mode {
            codec: Codec::H264,
            depth: Depth::Eight,
            maximum: Size::new(1920, 1080).unwrap(),
            fps: 60,
        },
        if verified {
            Evidence::PixelsAndCloseVerified
        } else {
            Evidence::Unverified
        },
    );
    caps
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unverified_backend_refuses_all_formats() {
        let size = Size::new(1920, 1080).unwrap();
        assert_eq!(capabilities(false).stream_formats(size, 60), 0);
        assert_eq!(capabilities(true).stream_formats(size, 60), 1);
        assert_eq!(capabilities(true).stream_formats(size, 120), 0);
    }
}
