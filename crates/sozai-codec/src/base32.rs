//! Lowercase, unpadded base32 (RFC 4648 §6), as `toB32` and `fromB32` in `@sozai/codec`.

pub use crate::base64_core::{DecodeError, DecodeOptions};

const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Encode bytes as lowercase, unpadded base32.
pub fn encode(bytes: &[u8]) -> String {
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(char::from(ALPHABET[((buffer >> bits) & 31) as usize]));
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[(buffer << (5 - bits)) as usize]));
    }
    out
}

/// Decode strict base32. See [`decode_with`].
pub fn decode(text: &str) -> Result<Vec<u8>, DecodeError> {
    decode_with(text, DecodeOptions::default())
}

/// Decode lowercase, unpadded base32.
///
/// Uppercase, padding, whitespace, characters outside the alphabet and impossible lengths fail
/// with [`DecodeError::Base32`], as do non-zero unused bits when `strict`. Input is not trimmed.
pub fn decode_with(text: &str, options: DecodeOptions) -> Result<Vec<u8>, DecodeError> {
    // Any non-ASCII character fails the alphabet check below, so byte length stands in for the
    // UTF-16 length the TS checks without changing which inputs fail.
    if matches!(text.len() % 8, 1 | 3 | 6) {
        return Err(DecodeError::Base32);
    }
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in text.bytes() {
        let value = ALPHABET
            .iter()
            .position(|&symbol| symbol == byte)
            .ok_or(DecodeError::Base32)?;
        buffer = (buffer << 5) | value as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    if options.strict && buffer != 0 {
        return Err(DecodeError::Base32);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_input() {
        for bad in ["7", "7mq", "7mqek2", "7M", "7m=", " 7m", "7n"] {
            assert_eq!(decode(bad), Err(DecodeError::Base32), "{bad}");
        }
        assert_eq!(
            decode_with("7n", DecodeOptions { strict: false }),
            Ok(vec![0xfb])
        );
        assert_eq!(decode(""), Ok(vec![]));
    }
}
