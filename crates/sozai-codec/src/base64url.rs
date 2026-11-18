//! URL-safe base64 (RFC 4648 §5), as `toB64U` and `fromB64U` in `@sozai/codec`.

use crate::base64_core::{self, URL_SAFE};
pub use crate::base64_core::{DecodeError, DecodeOptions};

/// Encode bytes as unpadded base64url, as RFC 7515 (JWS) requires.
pub fn encode(bytes: &[u8]) -> String {
    base64_core::encode(bytes, URL_SAFE, false)
}

/// Decode strict base64url. See [`decode_with`].
pub fn decode(text: &str) -> Result<Vec<u8>, DecodeError> {
    decode_with(text, DecodeOptions::default())
}

/// Decode base64url.
///
/// Padded input is accepted either way. Unlike [`crate::base64::decode`], nothing is trimmed:
/// whitespace anywhere, characters outside the URL-safe alphabet, misplaced padding and (when
/// `strict`) non-zero unused bits fail with [`DecodeError::Base64Url`].
pub fn decode_with(text: &str, options: DecodeOptions) -> Result<Vec<u8>, DecodeError> {
    base64_core::decode(text, URL_SAFE, options.strict, DecodeError::Base64Url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_padding_rejects_whitespace_and_dirty_bits() {
        assert_eq!(decode("-w=="), Ok(vec![0xfb]));
        assert_eq!(decode("-w"), Ok(vec![0xfb]));
        assert_eq!(decode(" -w"), Err(DecodeError::Base64Url));
        assert_eq!(decode("+w"), Err(DecodeError::Base64Url));
        assert_eq!(decode("-x"), Err(DecodeError::Base64Url));
        assert_eq!(
            decode_with("-x", DecodeOptions { strict: false }),
            Ok(vec![0xfb])
        );
        assert_eq!(decode("AAB"), Err(DecodeError::Base64Url));
        assert_eq!(decode("AAE"), Ok(vec![0, 1]));
    }
}
