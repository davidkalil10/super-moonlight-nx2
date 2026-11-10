//! Answers the console's `probe` request, which measures the link before a launch: an empty
//! reply times the round trip, a padded one the throughput.

use serde_json::{Value, json};

/// Padding one reply may carry; with its envelope it stays inside one control frame.
pub const MAX_BYTES: u32 = 48_000;

pub fn reply(sequence: u32, bytes: u32) -> Value {
    let pad = "x".repeat(bytes.min(MAX_BYTES) as usize);
    json!({"sequence": sequence, "bytes": pad.len(), "pad": pad})
}
