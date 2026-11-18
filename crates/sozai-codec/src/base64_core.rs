//! Shared base64 machinery for the [`crate::base64`] and [`crate::base64url`] modules.

use std::fmt;

/// Options for the base64, base64url and base32 decoders, as in `@sozai/codec`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeOptions {
    /// Reject non-zero unused bits in the final chunk. Defaults to `true`.
    ///
    /// Only turn this off for input whose exact encoding is immaterial: lenient decoding lets up
    /// to 16 distinct strings decode to the same bytes.
    pub strict: bool,
}

impl Default for DecodeOptions {
    fn default() -> Self {
        Self { strict: true }
    }
}

/// A string that is not a valid encoding. The TS codecs throw `Error` with the message
/// [`fmt::Display`] gives here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// `Invalid base64 encoding`
    Base64,
    /// `Invalid base64url encoding`
    Base64Url,
    /// `Invalid base32 encoding`
    Base32,
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Base64 => "Invalid base64 encoding",
            Self::Base64Url => "Invalid base64url encoding",
            Self::Base32 => "Invalid base32 encoding",
        })
    }
}

impl std::error::Error for DecodeError {}

pub(crate) const STANDARD: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub(crate) const URL_SAFE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub(crate) fn encode(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let triple = (b0 << 16) | (b1 << 8) | b2;
        let symbols = chunk.len() + 1;
        for index in 0..4 {
            if index < symbols {
                let value = (triple >> (18 - 6 * index)) & 0x3f;
                out.push(char::from(alphabet[value as usize]));
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn value_of(byte: u8, alphabet: &[u8; 64]) -> Option<u8> {
    alphabet
        .iter()
        .position(|&symbol| symbol == byte)
        .and_then(|index| u8::try_from(index).ok())
}

/// Validate and decode, accepting exactly the strings the TS patterns accept:
/// `^(?:X{4})*(?:X{2}(?:==)?|X{3}=?)?$`, with the last symbol of a 2- or 3-symbol tail limited
/// to unused bits of zero when `strict` is on.
pub(crate) fn decode(
    text: &str,
    alphabet: &[u8; 64],
    strict: bool,
    error: DecodeError,
) -> Result<Vec<u8>, DecodeError> {
    let bytes = text.as_bytes();
    let padding = bytes.iter().rev().take_while(|&&byte| byte == b'=').count();
    let data = &bytes[..bytes.len() - padding];
    let tail = data.len() % 4;
    let shape_ok = match padding {
        0 => tail != 1,
        1 => tail == 3,
        2 => tail == 2,
        _ => false,
    };
    if !shape_ok {
        return Err(error);
    }
    let values = data
        .iter()
        .map(|&byte| value_of(byte, alphabet))
        .collect::<Option<Vec<u8>>>()
        .ok_or(error)?;
    if strict {
        let unused_mask = match tail {
            2 => 0x0f,
            3 => 0x03,
            _ => 0,
        };
        if values.last().is_some_and(|last| last & unused_mask != 0) {
            return Err(error);
        }
    }
    let mut out = Vec::with_capacity(values.len() * 3 / 4);
    for chunk in values.chunks(4) {
        let mut group = 0u32;
        for (index, &value) in chunk.iter().enumerate() {
            group |= u32::from(value) << (18 - 6 * index);
        }
        let [_, b0, b1, b2] = group.to_be_bytes();
        out.extend_from_slice(&[b0, b1, b2][..chunk.len() - 1]);
    }
    Ok(out)
}
