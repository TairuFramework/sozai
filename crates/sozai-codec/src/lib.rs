#![forbid(unsafe_code)]
//! Rust ports of the sozai codecs: canonical JSON (`@sozai/json`), base64, base64url, base32 and
//! varints (`@sozai/codec`), hybrid logical clocks (`@sozai/hlc`) and JSON Patch (`@sozai/patch`).
//!
//! Each module matches its TypeScript package byte for byte on the golden vectors the TS tests
//! record under `packages/*/test/golden/`.

pub mod base32;
pub mod base64;
pub mod base64url;
pub mod canonical;
pub mod hlc;
pub mod json;
pub mod patch;
pub mod varint;

mod base64_core;

/// Compare two strings by UTF-16 code unit, as JavaScript's `<` and `Array#sort` do.
///
/// This differs from Rust's byte (code point) order when one string holds a character above
/// U+FFFF and the other a character in U+E000..=U+FFFF at the same position.
pub fn compare_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}
