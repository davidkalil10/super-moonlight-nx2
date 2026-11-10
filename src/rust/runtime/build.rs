use std::{env, fs, path::PathBuf};

fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(2_166_136_261u32, |hash, bytes| {
        let mut value = [0; 4];
        value[..bytes.len()].copy_from_slice(bytes);
        (hash ^ u32::from_le_bytes(value)).wrapping_mul(16_777_619)
    })
}

fn main() {
    let source = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../renderer/civ7/prebuilt/shaders.bin");
    println!("cargo:rerun-if-changed={}", source.display());
    let bytes = fs::read(source).expect("existing Civ7 shader bundle");
    assert!(bytes.len() >= 544);
    assert_eq!(word(&bytes, 0), 0x4241_4c4d);
    assert_eq!(word(&bytes, 4), 1);
    assert_eq!(word(&bytes, 8), 544);
    assert_eq!(word(&bytes, 12) as usize, bytes.len());
    assert_eq!(word(&bytes, 16), 2);
    assert_eq!(word(&bytes, 20), 6);
    assert_eq!(&bytes[32..44], b"input\0\0\0\0\0\0\0");
    assert_eq!(word(&bytes, 44), 4096);
    assert_eq!(&bytes[48..60], b"storage\0\0\0\0\0");
    assert_eq!(word(&bytes, 60), 48_418_816);
    let mut header = bytes[..544].to_vec();
    header[24..28].fill(0);
    assert_eq!(checksum(&header), word(&bytes, 24));
    let names = [
        "publish",
        "video-vertex",
        "video-fragment",
        "video-storage-fragment",
        "ui-vertex",
        "ui-fragment",
    ];
    let mut generated = String::new();
    let mut previous_end = 544;
    for (index, name) in names.iter().enumerate() {
        let at = 64 + index * 80;
        let field = &bytes[at..at + 24];
        let length = field.iter().position(|byte| *byte == 0).unwrap();
        assert_eq!(&field[..length], name.as_bytes());
        assert_eq!(word(&bytes, at + 32), 0);
        assert_eq!(word(&bytes, at + 36), 0);
        let offset = word(&bytes, at + 24) as usize;
        let length = word(&bytes, at + 28) as usize;
        assert!(offset >= previous_end && offset.is_multiple_of(16));
        assert!(length >= 20 && length.is_multiple_of(4));
        let shader = &bytes[offset..offset.checked_add(length).unwrap()];
        assert_eq!(word(shader, 0), 0x0723_0203);
        assert_eq!(checksum(shader), word(&bytes, at + 40));
        let identifier = name.replace('-', "_").to_uppercase();
        generated.push_str(&format!("pub static {identifier}: &[u32] = &[\n"));
        for chunk in shader.as_chunks::<4>().0 {
            generated.push_str(&format!("0x{:08x},", u32::from_le_bytes(*chunk)));
        }
        generated.push_str("\n];\n");
        previous_end = offset + length;
    }
    for (name, identifier) in [("ui-alpha", "UI_ALPHA"), ("ui-text", "UI_TEXT")] {
        let probe = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join(format!("prebuilt/{name}.spv"));
        println!("cargo:rerun-if-changed={}", probe.display());
        let bytes = fs::read(probe).expect("generated Rust shader");
        assert!(bytes.len() >= 20 && bytes.len() <= 256 * 1024 && bytes.len().is_multiple_of(4));
        assert_eq!(word(&bytes, 0), 0x0723_0203);
        generated.push_str(&format!("pub static {identifier}: &[u32] = &[\n"));
        for chunk in bytes.as_chunks::<4>().0 {
            generated.push_str(&format!("0x{:08x},", u32::from_le_bytes(*chunk)));
        }
        generated.push_str("\n];\n");
    }
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("shaders.rs"),
        generated,
    )
    .unwrap();
}
