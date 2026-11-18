//! Canonical JSON per RFC 8785 (JCS), as `canonicalize` in `@sozai/json` and
//! `canonicalStringify` in `@sozai/codec`.
//!
//! Object keys are ordered by UTF-16 code unit, strings are escaped as `JSON.stringify` escapes
//! them, and numbers are formatted by the ECMAScript `Number::toString` algorithm.

use std::fmt;
use std::fmt::Write as _;

use serde_json::Value;

/// A value with no canonical JSON form. All but [`CanonicalError::InvalidJSON`] are the cases
/// where the TS functions throw a `TypeError`, with the message [`fmt::Display`] gives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CanonicalError {
    /// `NaN is not allowed`
    NaN,
    /// `Infinity is not allowed` (either sign)
    Infinity,
    /// `Lone UTF-16 surrogate is not allowed`: a `\uD800`-`\uDFFF` escape in JSON text that is
    /// not part of a high-low pair.
    LoneSurrogate,
    /// The text given to [`stringify_text`] is not JSON. TS has no equivalent, since it
    /// canonicalizes values rather than text.
    InvalidJSON(String),
}

impl fmt::Display for CanonicalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NaN => f.write_str("NaN is not allowed"),
            Self::Infinity => f.write_str("Infinity is not allowed"),
            Self::LoneSurrogate => f.write_str("Lone UTF-16 surrogate is not allowed"),
            Self::InvalidJSON(message) => write!(f, "Invalid JSON: {message}"),
        }
    }
}

impl std::error::Error for CanonicalError {}

/// Serialize a JSON value canonically.
///
/// A `serde_json::Value` cannot hold `NaN`, `Infinity` or a lone surrogate, so this never fails
/// today; the `Result` keeps the signature aligned with [`stringify_text`] and the TS function.
/// Every number is formatted as the double it denotes, as `JSON.parse` would have read it:
/// integers above 2^53 lose precision exactly as they do in JavaScript.
pub fn stringify(value: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_value(&mut out, value)?;
    Ok(out)
}

/// Parse JSON text and serialize it canonically.
///
/// This is the path for JSON that arrives as text: an escape that encodes a lone UTF-16
/// surrogate (`"\ud800"`, in a string or a key) fails with [`CanonicalError::LoneSurrogate`],
/// where `JSON.parse` would keep it and `canonicalize` would then throw. Other malformed text
/// fails with [`CanonicalError::InvalidJSON`]. Duplicate keys keep the last value, as in
/// `JSON.parse`.
pub fn stringify_text(json: &str) -> Result<String, CanonicalError> {
    check_surrogate_escapes(json)?;
    let value: Value = serde_json::from_str(json)
        .map_err(|error| CanonicalError::InvalidJSON(error.to_string()))?;
    stringify(&value)
}

/// Format a number as `JSON.stringify` does (ECMAScript `Number::toString`), rejecting the
/// non-finite values RFC 8785 excludes. Negative zero formats as `0`.
pub fn format_number(number: f64) -> Result<String, CanonicalError> {
    if number.is_nan() {
        return Err(CanonicalError::NaN);
    }
    if number.is_infinite() {
        return Err(CanonicalError::Infinity);
    }
    let mut buffer = ryu_js::Buffer::new();
    Ok(buffer.format_finite(number).to_owned())
}

fn write_value(out: &mut String, value: &Value) -> Result<(), CanonicalError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&format_number(number_as_f64(number))?),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| crate::compare_utf16(a, b));
            out.push('{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// The double a JSON number denotes. `u64`/`i64` to `f64` rounds to nearest, ties to even, as
/// `JSON.parse` rounds the same decimal digits.
pub(crate) fn number_as_f64(number: &serde_json::Number) -> f64 {
    if let Some(unsigned) = number.as_u64() {
        unsigned as f64
    } else if let Some(signed) = number.as_i64() {
        signed as f64
    } else {
        number.as_f64().unwrap_or(f64::NAN)
    }
}

/// `JSON.stringify` string escaping: the two-character escapes, `\u00xx` (lowercase hex) for the
/// other control characters, everything else literal (including `/`, DEL, U+2028 and U+2029).
fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0A}' => out.push_str("\\n"),
            '\u{0C}' => out.push_str("\\f"),
            '\u{0D}' => out.push_str("\\r"),
            '\u{00}'..='\u{1F}' => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            _ => out.push(c),
        }
    }
    out.push('"');
}

/// Reject `\uXXXX` escapes that encode an unpaired surrogate, anywhere in the strings of `json`.
///
/// Raw surrogates cannot occur in a `&str`, so escapes are the only way one reaches us. A high
/// surrogate must be followed directly by an escaped low surrogate. Text outside strings and
/// malformed escapes are left for the JSON parser to judge.
fn check_surrogate_escapes(json: &str) -> Result<(), CanonicalError> {
    let bytes = json.as_bytes();
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if !in_string {
            in_string = byte == b'"';
            index += 1;
            continue;
        }
        match byte {
            b'"' => {
                in_string = false;
                index += 1;
            }
            b'\\' if bytes.get(index + 1) == Some(&b'u') => {
                let Some(unit) = hex_unit(bytes, index + 2) else {
                    index += 2;
                    continue;
                };
                index += 6;
                if (0xDC00..=0xDFFF).contains(&unit) {
                    return Err(CanonicalError::LoneSurrogate);
                }
                if (0xD800..=0xDBFF).contains(&unit) {
                    let low = (bytes.get(index) == Some(&b'\\')
                        && bytes.get(index + 1) == Some(&b'u'))
                    .then(|| hex_unit(bytes, index + 2))
                    .flatten();
                    match low {
                        Some(low) if (0xDC00..=0xDFFF).contains(&low) => index += 6,
                        _ => return Err(CanonicalError::LoneSurrogate),
                    }
                }
            }
            // Any other escape is two bytes; skipping both keeps `\"` and `\\` from confusing us.
            b'\\' => index += 2,
            _ => index += 1,
        }
    }
    Ok(())
}

fn hex_unit(bytes: &[u8], start: usize) -> Option<u32> {
    let digits = bytes.get(start..start + 4)?;
    let text = std::str::from_utf8(digits).ok()?;
    if !digits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    u32::from_str_radix(text, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_match_number_to_string() {
        let cases: [(f64, &str); 9] = [
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123e-20, "1.23e-18"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (2.0f64.powi(53) + 2.0, "9007199254740994"),
            (f64::MIN_POSITIVE, "2.2250738585072014e-308"),
            (
                f64::from_bits(0x000f_ffff_ffff_ffff),
                "2.225073858507201e-308",
            ),
        ];
        for (number, expected) in cases {
            assert_eq!(format_number(number).as_deref(), Ok(expected), "{number:e}");
        }
        assert_eq!(format_number(f64::NAN), Err(CanonicalError::NaN));
        assert_eq!(
            format_number(f64::NEG_INFINITY),
            Err(CanonicalError::Infinity)
        );
    }

    #[test]
    fn integers_above_2_pow_53_round_like_json_parse() {
        assert_eq!(
            stringify_text("9007199254740993").as_deref(),
            Ok("9007199254740992")
        );
        assert_eq!(
            stringify_text("-9007199254740993").as_deref(),
            Ok("-9007199254740992")
        );
        assert_eq!(stringify_text("[-0, 1.0, 1E2]").as_deref(), Ok("[0,1,100]"));
        assert_eq!(
            stringify_text("18446744073709551616").as_deref(),
            Ok("18446744073709552000")
        );
    }

    #[test]
    fn surrogate_escapes() {
        assert_eq!(stringify_text(r#""\ud83d\ude02""#).as_deref(), Ok("\"😂\""));
        assert_eq!(stringify_text(r#""\uD83D\uDE02""#).as_deref(), Ok("\"😂\""));
        for lone in [
            r#""\ud800""#,
            r#""\udfff""#,
            r#""\ud800\u0041""#,
            r#""\ud800x""#,
            r#""\ud800\ud800""#,
            r#"{"\udc00":1}"#,
            r#"["\\", "\ud800"]"#,
        ] {
            assert_eq!(
                stringify_text(lone),
                Err(CanonicalError::LoneSurrogate),
                "{lone}"
            );
        }
        // An escaped backslash before `u` is not an escape.
        assert_eq!(
            stringify_text(r#""\\ud800""#).as_deref(),
            Ok(r#""\\ud800""#)
        );
        assert!(matches!(
            stringify_text("{"),
            Err(CanonicalError::InvalidJSON(_))
        ));
    }

    #[test]
    fn escapes_like_json_stringify() {
        let value = Value::String("\u{1f}\u{7f}\u{2028}/".to_owned());
        assert_eq!(
            stringify(&value).as_deref(),
            Ok("\"\\u001f\u{7f}\u{2028}/\"")
        );
    }

    #[test]
    fn duplicate_keys_keep_last() {
        assert_eq!(
            stringify_text(r#"{"a":1,"a":2}"#).as_deref(),
            Ok(r#"{"a":2}"#)
        );
    }
}
