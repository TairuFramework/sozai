//! Standard base64 (RFC 4648 §4), as `toB64` and `fromB64` in `@sozai/codec`.

use crate::base64_core::{self, STANDARD};
pub use crate::base64_core::{DecodeError, DecodeOptions};

/// Encode bytes as padded standard base64.
pub fn encode(bytes: &[u8]) -> String {
    base64_core::encode(bytes, STANDARD, true)
}

/// Decode strict standard base64. See [`decode_with`].
pub fn decode(text: &str) -> Result<Vec<u8>, DecodeError> {
    decode_with(text, DecodeOptions::default())
}

/// Decode standard base64.
///
/// Surrounding whitespace (ECMAScript `String#trim` whitespace) is trimmed first; a non-empty,
/// whitespace-only string is rejected while the empty string decodes to no bytes. Padding is
/// optional. Embedded whitespace, characters outside the alphabet, misplaced padding and (when
/// `strict`) non-zero unused bits fail with [`DecodeError::Base64`].
pub fn decode_with(text: &str, options: DecodeOptions) -> Result<Vec<u8>, DecodeError> {
    let trimmed = js_trim(text);
    if !text.is_empty() && trimmed.is_empty() {
        return Err(DecodeError::Base64);
    }
    base64_core::decode(trimmed, STANDARD, options.strict, DecodeError::Base64)
}

/// ECMAScript `WhiteSpace` and `LineTerminator`, the set `String#trim` removes. It differs from
/// Rust's `char::is_whitespace`: it includes U+FEFF and excludes U+0085.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    ) || ('\u{2000}'..='\u{200A}').contains(&c)
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_js_whitespace_only() {
        assert_eq!(decode(" +w==\n"), Ok(vec![0xfb]));
        assert_eq!(decode("\u{FEFF}+w=="), Ok(vec![0xfb]));
        assert_eq!(decode("\u{0085}+w=="), Err(DecodeError::Base64));
        assert_eq!(decode("  "), Err(DecodeError::Base64));
        assert_eq!(decode(""), Ok(vec![]));
    }

    #[test]
    fn rejects_bad_shapes() {
        for bad in ["+w=", "+", "+w===", "+w=a", "+ w==", "+x==", "AAB="] {
            assert_eq!(decode(bad), Err(DecodeError::Base64), "{bad}");
        }
        assert_eq!(
            decode_with("+x==", DecodeOptions { strict: false }),
            Ok(vec![0xfb])
        );
        assert_eq!(decode("+w"), Ok(vec![0xfb]));
    }
}
