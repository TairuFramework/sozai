//! Unsigned LEB128 varints (multiformats `unsigned-varint`), as `encodeVarint` and
//! `decodeVarint` in `@sozai/codec`, limited to JavaScript safe integers.

use std::fmt;

/// The largest value a varint may carry: `Number.MAX_SAFE_INTEGER`, 2^53 - 1.
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A varint failure. The TS functions throw `RangeError` for each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VarintError {
    /// `encode` was given a value above [`MAX_SAFE_INTEGER`].
    InvalidValue(u64),
    /// The decoded value would exceed [`MAX_SAFE_INTEGER`].
    Overflow,
    /// The bytes ended before a byte without the continuation bit.
    Truncated,
}

impl fmt::Display for VarintError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidValue(value) => write!(f, "Invalid varint value: {value}"),
            Self::Overflow => f.write_str("Varint exceeds safe integer range"),
            Self::Truncated => f.write_str("Truncated varint"),
        }
    }
}

impl std::error::Error for VarintError {}

/// A decoded varint and the number of bytes it occupied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodedVarint {
    /// The decoded value, at most [`MAX_SAFE_INTEGER`].
    pub value: u64,
    /// How many bytes the varint occupied.
    pub length: usize,
}

/// Encode a value up to [`MAX_SAFE_INTEGER`] as a minimal varint.
pub fn encode(value: u64) -> Result<Vec<u8>, VarintError> {
    if value > MAX_SAFE_INTEGER {
        return Err(VarintError::InvalidValue(value));
    }
    let mut out = Vec::with_capacity(8);
    let mut rest = value;
    while rest >= 0x80 {
        out.push((rest & 0x7f) as u8 | 0x80);
        rest >>= 7;
    }
    out.push(rest as u8);
    Ok(out)
}

/// Decode a varint starting at `offset`.
///
/// Non-minimal encodings (`[0x81, 0x00]` for 1) decode, as in TS; callers needing the canonical
/// form re-encode and compare. Zero-payload continuation bytes are accepted for as long as the
/// TS float multiplier stays finite (147 bytes); after that TS computes `0 * Infinity`, gets
/// `NaN`, and reports an overflow, and so does this.
pub fn decode(bytes: &[u8], offset: usize) -> Result<DecodedVarint, VarintError> {
    let mut value: u64 = 0;
    for (shift_index, index) in (offset..bytes.len()).enumerate() {
        let byte = bytes[index];
        // TS multiplies by 128^k in doubles; 128^147 = 2^1029 is Infinity.
        if shift_index >= 147 {
            return Err(VarintError::Overflow);
        }
        let payload = u64::from(byte & 0x7f);
        if payload != 0 {
            let shift = 7 * shift_index as u32;
            if shift >= 53 {
                return Err(VarintError::Overflow);
            }
            value = value
                .checked_add(payload << shift)
                .filter(|&sum| sum <= MAX_SAFE_INTEGER)
                .ok_or(VarintError::Overflow)?;
        }
        if byte & 0x80 == 0 {
            return Ok(DecodedVarint {
                value,
                length: shift_index + 1,
            });
        }
    }
    Err(VarintError::Truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges() {
        assert_eq!(
            encode(MAX_SAFE_INTEGER + 1),
            Err(VarintError::InvalidValue(1 << 53))
        );
        assert_eq!(
            decode(&[0x81, 0x00], 0),
            Ok(DecodedVarint {
                value: 1,
                length: 2
            })
        );
        assert_eq!(decode(&[0x80], 0), Err(VarintError::Truncated));
        assert_eq!(decode(&[0x01], 1), Err(VarintError::Truncated));
        assert_eq!(
            decode(&[0xff, 0x01], 1),
            Ok(DecodedVarint {
                value: 1,
                length: 1
            })
        );
        // 2^53 itself.
        let over = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10];
        assert_eq!(decode(&over, 0), Err(VarintError::Overflow));
        let mut padded = vec![0x80; 146];
        padded.push(0x00);
        assert_eq!(
            decode(&padded, 0),
            Ok(DecodedVarint {
                value: 0,
                length: 147
            })
        );
        let mut too_long = vec![0x80; 147];
        too_long.push(0x00);
        assert_eq!(decode(&too_long, 0), Err(VarintError::Overflow));
    }
}
