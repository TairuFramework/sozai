//! Bounded JSON parsing, matching `@sozai/json` with its default options.

use std::fmt;

use serde_json::Value;

/// Maximum opened containers, with a top-level array or object counted as one.
pub const MAX_DEPTH: usize = 128;

/// A depth limit violation or malformed JSON text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JSONError {
    /// The text contains more opened containers than the given limit.
    MaximumDepth(usize),
    /// The text is not JSON that `serde_json::Value` can represent.
    InvalidJSON(String),
}

impl fmt::Display for JSONError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MaximumDepth(max) => write!(f, "JSON exceeds maximum nesting depth of {max}"),
            Self::InvalidJSON(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for JSONError {}

/// Scan opened containers outside strings, skipping escapes exactly as TS `checkDepth` does.
/// This checks depth only, not syntax; unmatched closing brackets decrement the count too.
pub fn check_depth(text: &str, max: usize) -> Result<(), JSONError> {
    // A string's byte length bounds either sign of the count, including malformed text.
    let mut depth: i128 = 0;
    let mut in_string = false;
    let mut escaped = false;
    for byte in text.bytes() {
        if escaped {
            escaped = false;
            continue;
        }
        if in_string {
            match byte {
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > max as i128 {
                    return Err(JSONError::MaximumDepth(max));
                }
            }
            b'}' | b']' => depth -= 1,
            _ => {}
        }
    }
    Ok(())
}

/// Check [`MAX_DEPTH`] before parsing, then lift serde's recursion limit so depth 128 passes.
/// Duplicate keys keep the last value and prototype-related keys are retained, as in TS.
///
/// Unlike JavaScript, Rust strings cannot represent lone UTF-16 surrogates, so such escapes
/// fail to parse. Only JSON whitespace may follow the single value.
pub fn parse(text: &str) -> Result<Value, JSONError> {
    check_depth(text, MAX_DEPTH)?;
    let mut deserializer = serde_json::Deserializer::from_str(text);
    deserializer.disable_recursion_limit();
    // The stream API deserializes Value without an additional serde trait dependency.
    let mut stream = deserializer.into_iter::<Value>();
    let value = stream
        .next()
        .ok_or_else(|| JSONError::InvalidJSON("EOF while parsing a value".to_owned()))?
        .map_err(|error| JSONError::InvalidJSON(error.to_string()))?;
    if text.as_bytes()[stream.byte_offset()..]
        .iter()
        .any(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
    {
        return Err(JSONError::InvalidJSON("trailing characters".to_owned()));
    }
    Ok(value)
}

/// Whether a value fits `max` opened containers, counted as [`check_depth`] counts them.
/// Iterative even for arbitrarily deep caller-provided values. A scalar has depth zero.
/// Refused owned values should be passed to [`dismantle`] rather than dropped recursively.
pub fn check_value_depth(value: &Value, max: usize) -> bool {
    let mut stack = vec![(value, 0usize)];
    while let Some((value, depth)) = stack.pop() {
        match value {
            Value::Array(_) | Value::Object(_) if depth >= max => return false,
            Value::Array(items) => stack.extend(items.iter().map(|child| (child, depth + 1))),
            Value::Object(map) => stack.extend(map.values().map(|child| (child, depth + 1))),
            _ => {}
        }
    }
    true
}

/// Tear down an owned value iteratively, avoiding the recursive default `Value` drop.
pub fn dismantle(value: Value) {
    let mut stack = vec![value];
    while let Some(value) = stack.pop() {
        match value {
            Value::Array(items) => stack.extend(items),
            Value::Object(map) => stack.extend(map.into_iter().map(|(_, child)| child)),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn nested(depth: usize, objects: bool) -> Value {
        let mut value = Value::Null;
        for _ in 0..depth {
            value = if objects {
                Value::Object(serde_json::Map::from_iter([("a".to_owned(), value)]))
            } else {
                Value::Array(vec![value])
            };
        }
        value
    }

    #[test]
    fn text_and_value_depth_boundaries() {
        assert_eq!(MAX_DEPTH, 128);
        for objects in [false, true] {
            for depth in [128, 129] {
                let value = nested(depth, objects);
                let text = value.to_string();
                assert_eq!(check_value_depth(&value, MAX_DEPTH), depth == 128);
                assert_eq!(check_depth(&text, MAX_DEPTH).is_ok(), depth == 128);
                assert_eq!(parse(&text).is_ok(), depth == 128);
                if depth == 129 {
                    assert_eq!(
                        check_depth(&text, MAX_DEPTH).unwrap_err().to_string(),
                        "JSON exceeds maximum nesting depth of 128"
                    );
                    assert_eq!(
                        parse(&text).unwrap_err().to_string(),
                        "JSON exceeds maximum nesting depth of 128"
                    );
                }
            }
        }
        assert!(check_value_depth(&Value::Null, 0));
        assert!(!check_value_depth(&json!([]), 0));
        assert!(check_depth("null", 0).is_ok());
        assert!(check_depth("[]", 0).is_err());
        assert!(check_depth("[[]]", 1).is_err());
        assert_eq!(
            check_depth("[[]]", 1).unwrap_err().to_string(),
            "JSON exceeds maximum nesting depth of 1"
        );
    }

    #[test]
    fn strings_and_escapes_do_not_count() {
        let text = format!(r#"["\"{}{{}}\\\"",{{"key[":"]"}}]"#, "[".repeat(200));
        assert!(check_depth(&text, 2).is_ok());
        assert!(parse(&text).is_ok());
        // Like TS, the scan does not validate syntax and counts unmatched closing brackets.
        assert!(check_depth("][", 0).is_ok());
        assert!(check_depth(&"[".repeat(129), MAX_DEPTH).is_err());
    }

    #[test]
    fn parse_retains_json_semantics_and_rejects_invalid_text() {
        assert_eq!(
            parse(r#"{"a":1,"a":2,"__proto__":3,"constructor":4}"#).unwrap(),
            json!({"a":2,"__proto__":3,"constructor":4})
        );
        for text in [
            "",
            "{} x",
            "{} {}",
            "[",
            "\u{feff}{}",
            "{}\u{a0}",
            r#""\ud800""#,
        ] {
            assert!(parse(text).is_err(), "{text:?}");
        }
        assert_eq!(parse("{} \t\r\n").unwrap(), json!({}));
    }

    #[test]
    fn deep_values_are_checked_and_dismantled_on_a_small_stack() {
        std::thread::Builder::new()
            .stack_size(512 * 1024)
            .spawn(|| {
                for objects in [false, true] {
                    let value = nested(200_000, objects);
                    let within = check_value_depth(&value, MAX_DEPTH);
                    let exact = check_value_depth(&value, 200_000);
                    dismantle(value);
                    assert!(!within);
                    assert!(exact);
                }
            })
            .unwrap()
            .join()
            .unwrap();
    }
}
