//! JSON Patch (RFC 6902 plus a `set` operation), as `applyPatches` in `@sozai/patch`.
//!
//! [`apply`] works on a copy and returns it, so a failing patch leaves the input untouched, as
//! the TS function leaves `data` untouched.
//!
//! Paths read own JSON members only, as the TS `getMember`: an object member, or an in-bounds
//! array element at a canonical index. Inherited members (`/toString`), `length` and string
//! indices (`/name/0`) are absent, and walking through `null` or another primitive finds nothing.
//! A numeric segment stays an exact member name on objects and is an index only on arrays.

use std::fmt;

use serde_json::{Map, Value};

/// One JSON Patch operation.
#[derive(Clone, Debug, PartialEq)]
pub enum Operation {
    /// Insert into an array (or `-` to append), or add or overwrite an object member.
    Add { path: String, value: Value },
    /// Overwrite an array element (or append at the length, or `-`), or set an object member.
    Set { path: String, value: Value },
    /// Remove an array element or object member.
    Remove { path: String },
    /// Replace an existing array element or object member.
    Replace { path: String, value: Value },
    /// Remove the value at `from` and add it at `path`.
    Move { from: String, path: String },
    /// Add a copy of the value at `from` at `path`.
    Copy { from: String, path: String },
    /// Fail unless the value at `path` deep-equals `value`.
    Test { path: String, value: Value },
}

/// The error codes `PatchError#code` carries in TS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PatchErrorCode {
    /// `INVALID_PATH`
    InvalidPath,
    /// `PATH_NOT_FOUND`
    PathNotFound,
    /// `INVALID_INDEX`
    InvalidIndex,
    /// `TEST_FAILED`
    TestFailed,
    /// `INVALID_OPERATION`
    InvalidOperation,
    /// `INVALID_TARGET`: Rust only. Writing a member of `null`, a number, a string or a boolean,
    /// removing a member of `null`, or removing a string's own `length` or index, where the TS
    /// code throws a plain `TypeError` rather than a `PatchError`. Kubun classifies both as transient.
    InvalidTarget,
}

impl PatchErrorCode {
    /// The TS code string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPath => "INVALID_PATH",
            Self::PathNotFound => "PATH_NOT_FOUND",
            Self::InvalidIndex => "INVALID_INDEX",
            Self::TestFailed => "TEST_FAILED",
            Self::InvalidOperation => "INVALID_OPERATION",
            Self::InvalidTarget => "INVALID_TARGET",
        }
    }
}

/// A failed patch, as the TS `PatchError`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchError {
    /// What failed.
    pub kind: PatchErrorCode,
    /// A human-readable message, the TS one where TS has one.
    pub message: String,
}

impl PatchError {
    fn new(kind: PatchErrorCode, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn not_found(path: &str) -> Self {
        Self::new(
            PatchErrorCode::PathNotFound,
            format!("Path {path} does not exist"),
        )
    }

    /// The TS error code string, such as `PATH_NOT_FOUND`.
    pub fn code(&self) -> &'static str {
        self.kind.as_str()
    }
}

impl fmt::Display for PatchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PatchError {}

fn string_field(object: &Map<String, Value>, key: &str) -> Result<String, PatchError> {
    match object.get(key) {
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Err(PatchError::new(
            PatchErrorCode::InvalidOperation,
            format!("Operation field {key} must be a string"),
        )),
    }
}

fn value_field(object: &Map<String, Value>) -> Result<Value, PatchError> {
    object.get("value").cloned().ok_or_else(|| {
        PatchError::new(
            PatchErrorCode::InvalidOperation,
            "Operation field value is required",
        )
    })
}

impl Operation {
    /// Read an operation from its JSON form, `{"op": "add", "path": "/a", "value": 1}`.
    ///
    /// An unknown `op`, or a missing or mistyped field, fails with `INVALID_OPERATION`. Extra
    /// fields are ignored here; the TS schemas reject them, but `applyPatches` itself does not.
    pub fn from_value(value: &Value) -> Result<Self, PatchError> {
        let invalid = |message: String| PatchError::new(PatchErrorCode::InvalidOperation, message);
        let object = value
            .as_object()
            .ok_or_else(|| invalid("Operation must be an object".to_owned()))?;
        let op = string_field(object, "op")?;
        Ok(match op.as_str() {
            "add" => Self::Add {
                path: string_field(object, "path")?,
                value: value_field(object)?,
            },
            "set" => Self::Set {
                path: string_field(object, "path")?,
                value: value_field(object)?,
            },
            "remove" => Self::Remove {
                path: string_field(object, "path")?,
            },
            "replace" => Self::Replace {
                path: string_field(object, "path")?,
                value: value_field(object)?,
            },
            "move" => Self::Move {
                from: string_field(object, "from")?,
                path: string_field(object, "path")?,
            },
            "copy" => Self::Copy {
                from: string_field(object, "from")?,
                path: string_field(object, "path")?,
            },
            "test" => Self::Test {
                path: string_field(object, "path")?,
                value: value_field(object)?,
            },
            other => return Err(invalid(format!("Unknown operation: {other}"))),
        })
    }
}

/// Apply operations in order to a copy of `document`, in strict mode (the TS default): a
/// missing path fails with `PATH_NOT_FOUND`.
///
/// `document` and operation values must be within [`crate::json::MAX_DEPTH`] opened containers.
/// Callers bound them with [`crate::json::check_value_depth`] before this recursive operation.
pub fn apply(document: &Value, operations: &[Operation]) -> Result<Value, PatchError> {
    apply_with(document, operations, true)
}

/// Apply operations in order to a copy of `document`.
///
/// With `strict` off, `remove`, `replace`, `copy` and `move` skip missing paths instead of
/// failing, as `applyPatches(data, patches, false)`. `test` always requires its path.
///
/// `document` and operation values must be within [`crate::json::MAX_DEPTH`] opened containers.
/// Callers bound them with [`crate::json::check_value_depth`] before this recursive operation.
pub fn apply_with(
    document: &Value,
    operations: &[Operation],
    strict: bool,
) -> Result<Value, PatchError> {
    let mut working = document.clone();
    for operation in operations {
        apply_one(&mut working, operation, strict)?;
    }
    Ok(working)
}

fn apply_one(working: &mut Value, operation: &Operation, strict: bool) -> Result<(), PatchError> {
    match operation {
        Operation::Add { path, value } => set_path(working, path, value.clone(), SetMode::INSERT),
        Operation::Set { path, value } => set_path(working, path, value.clone(), SetMode::SET),
        Operation::Replace { path, value } => {
            if strict {
                assert_path_exists(working, path)?;
            }
            let mode = SetMode {
                should_exist: strict,
                insert: false,
                allow_append: false,
            };
            set_path(working, path, value.clone(), mode)
        }
        Operation::Remove { path } => {
            if strict {
                assert_path_exists(working, path)?;
            }
            delete_path(working, path, strict).map(drop)
        }
        Operation::Copy { from, path } => {
            if strict {
                assert_path_exists(working, from)?;
            }
            match get_path(working, from)? {
                Some(value) => {
                    let value = value.clone();
                    set_path(working, path, value, SetMode::INSERT)
                }
                None if strict => Err(source_not_found(from)),
                None => Ok(()),
            }
        }
        Operation::Move { from, path } => {
            if path.starts_with(&format!("{from}/")) {
                return Err(PatchError::new(
                    PatchErrorCode::InvalidPath,
                    format!("Cannot move {from} into its own descendant {path}"),
                ));
            }
            if strict {
                assert_path_exists(working, from)?;
            }
            if get_path(working, from)?.is_none() {
                return if strict {
                    Err(source_not_found(from))
                } else {
                    Ok(())
                };
            }
            match delete_path(working, from, strict)? {
                Some(value) => set_path(working, path, value, SetMode::INSERT),
                None => Ok(()),
            }
        }
        Operation::Test { path, value } => {
            assert_path_exists(working, path)?;
            let actual = get_path(working, path)?;
            if actual.is_some_and(|actual| deep_equal(actual, value)) {
                Ok(())
            } else {
                Err(PatchError::new(
                    PatchErrorCode::TestFailed,
                    format!("Test operation failed at path {path}"),
                ))
            }
        }
    }
}

fn source_not_found(from: &str) -> PatchError {
    PatchError::new(
        PatchErrorCode::PathNotFound,
        format!("Source path {from} does not exist"),
    )
}

/// One parsed JSON Pointer segment.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Key {
    /// A canonical array index (`0` or no leading zero). Also an object member name.
    Index(String),
    /// Anything else, including `""` and the `-` append sentinel.
    Name(String),
}

impl Key {
    fn name(&self) -> &str {
        match self {
            Self::Index(text) | Self::Name(text) => text,
        }
    }

    /// The array position, `None` for a name or an index too large for memory anyway.
    fn index(&self) -> Option<usize> {
        match self {
            Self::Index(text) => text.parse().ok(),
            Self::Name(_) => None,
        }
    }
}

const FORBIDDEN_SEGMENTS: [&str; 3] = ["__proto__", "constructor", "prototype"];

fn is_array_index(text: &str) -> bool {
    text == "0"
        || (!text.is_empty()
            && !text.starts_with('0')
            && text.bytes().all(|byte| byte.is_ascii_digit()))
}

/// Parse a JSON Pointer, as `parsePath`. `""` is the whole document.
fn parse_path(path: &str) -> Result<Vec<Key>, PatchError> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let Some(rest) = path.strip_prefix('/') else {
        return Err(PatchError::new(
            PatchErrorCode::InvalidPath,
            "Path must start with /",
        ));
    };
    rest.split('/')
        .map(|segment| {
            let unescaped = segment.replace("~1", "/").replace("~0", "~");
            if FORBIDDEN_SEGMENTS.contains(&unescaped.as_str()) {
                return Err(PatchError::new(
                    PatchErrorCode::InvalidPath,
                    format!("Forbidden path segment: {unescaped}"),
                ));
            }
            Ok(if is_array_index(&unescaped) {
                Key::Index(unescaped)
            } else {
                Key::Name(unescaped)
            })
        })
        .collect()
}

fn child<'a>(value: &'a Value, key: &Key) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key.name()),
        Value::Array(items) => key.index().and_then(|index| items.get(index)),
        _ => None,
    }
}

fn child_mut<'a>(value: &'a mut Value, key: &Key) -> Option<&'a mut Value> {
    match value {
        Value::Object(map) => map.get_mut(key.name()),
        Value::Array(items) => key.index().and_then(|index| items.get_mut(index)),
        _ => None,
    }
}

/// The value at `path`, as `getPath`. `Some(Value::Null)` is a present `null`.
fn get_path<'a>(document: &'a Value, path: &str) -> Result<Option<&'a Value>, PatchError> {
    let keys = parse_path(path)?;
    Ok(keys
        .iter()
        .try_fold(document, |value, key| child(value, key)))
}

fn assert_path_exists(document: &Value, path: &str) -> Result<(), PatchError> {
    match get_path(document, path)? {
        Some(_) => Ok(()),
        None => Err(PatchError::not_found(path)),
    }
}

/// Split `path` into the parent container and the last key. Fails for the root path.
fn split_last(path: &str) -> Result<(Vec<Key>, Key), PatchError> {
    let mut keys = parse_path(path)?;
    match keys.pop() {
        Some(last) => Ok((keys, last)),
        None => Err(PatchError::new(
            PatchErrorCode::InvalidPath,
            "Root mutation unsupported",
        )),
    }
}

/// Whether `Object.hasOwn(text, key)` holds for a string primitive: `length`, or an index below
/// its UTF-16 length. Those members are read-only, so TS throws a `TypeError` writing or deleting
/// them.
fn string_has_own(text: &str, key: &Key) -> bool {
    key.name() == "length"
        || key
            .index()
            .is_some_and(|index| index < text.encode_utf16().count())
}

fn out_of_bounds(index: &Key, length: usize) -> PatchError {
    PatchError::new(
        PatchErrorCode::InvalidIndex,
        format!(
            "Array index {} out of bounds (length: {length})",
            index.name()
        ),
    )
}

#[derive(Clone, Copy)]
struct SetMode {
    should_exist: bool,
    insert: bool,
    allow_append: bool,
}

impl SetMode {
    const INSERT: Self = Self {
        should_exist: false,
        insert: true,
        allow_append: true,
    };
    const SET: Self = Self {
        should_exist: false,
        insert: false,
        allow_append: true,
    };
}

/// Write `value` at `path`, as `setPath`.
fn set_path(
    document: &mut Value,
    path: &str,
    value: Value,
    mode: SetMode,
) -> Result<(), PatchError> {
    let (parents, last) = split_last(path)?;
    let mut target = document;
    for key in &parents {
        target = child_mut(target, key).ok_or_else(|| PatchError::not_found(path))?;
    }
    match target {
        Value::Array(items) => {
            if last.name() == "-" {
                if !mode.allow_append {
                    return Err(PatchError::new(
                        PatchErrorCode::InvalidIndex,
                        "Append token not allowed here",
                    ));
                }
                items.push(value);
                return Ok(());
            }
            if !matches!(last, Key::Index(_)) {
                return Err(PatchError::new(
                    PatchErrorCode::InvalidIndex,
                    "Array index must be a number",
                ));
            }
            let length = items.len();
            let max = if mode.allow_append {
                Some(length)
            } else {
                length.checked_sub(1)
            };
            let index = last
                .index()
                .filter(|&index| max.is_some_and(|max| index <= max))
                .ok_or_else(|| out_of_bounds(&last, length))?;
            if mode.insert {
                items.insert(index, value);
            } else if index == length {
                items.push(value);
            } else {
                items[index] = value;
            }
            Ok(())
        }
        Value::Object(map) => {
            if mode.should_exist && !map.contains_key(last.name()) {
                return Err(PatchError::not_found(path));
            }
            map.insert(last.name().to_owned(), value);
            Ok(())
        }
        _ => {
            // TS: `Object.hasOwn(null, key)` throws a TypeError; on another primitive it finds no
            // member (PATH_NOT_FOUND) except a string's own `length` and indices. Assigning to a
            // primitive's member throws a TypeError in strict-mode code.
            let has_own = match target {
                Value::Null => true,
                Value::String(text) => string_has_own(text, &last),
                _ => false,
            };
            if mode.should_exist && !has_own {
                return Err(PatchError::not_found(path));
            }
            Err(PatchError::new(
                PatchErrorCode::InvalidTarget,
                format!("Cannot set {path}: parent is not an object or array"),
            ))
        }
    }
}

/// Remove the value at `path`, as `deletePath`, and return it. Non-strict misses return `None`.
fn delete_path(
    document: &mut Value,
    path: &str,
    strict: bool,
) -> Result<Option<Value>, PatchError> {
    let (parents, last) = split_last(path)?;
    let mut target = document;
    for key in &parents {
        match child_mut(target, key) {
            Some(next) => target = next,
            None if strict => return Err(PatchError::not_found(path)),
            None => return Ok(None),
        }
    }
    match target {
        Value::Array(items) => {
            if !matches!(last, Key::Index(_)) {
                return Err(PatchError::new(
                    PatchErrorCode::InvalidIndex,
                    "Array index must be a number",
                ));
            }
            let length = items.len();
            let index = last
                .index()
                .filter(|&index| index < length)
                .ok_or_else(|| out_of_bounds(&last, length))?;
            Ok(Some(items.remove(index)))
        }
        Value::Object(map) => match map.remove(last.name()) {
            Some(value) => Ok(Some(value)),
            None if strict => Err(PatchError::not_found(path)),
            None => Ok(None),
        },
        // TS: `Object.hasOwn(null, key)` throws a TypeError, strict or not.
        Value::Null => Err(PatchError::new(
            PatchErrorCode::InvalidTarget,
            format!("Cannot remove {path}: parent is null"),
        )),
        // TS: a string's own `length` and indices pass `Object.hasOwn`, then `delete` throws a
        // TypeError because they are read-only.
        Value::String(text) if string_has_own(text, &last) => Err(PatchError::new(
            PatchErrorCode::InvalidTarget,
            format!("Cannot remove {path}: member is read-only"),
        )),
        _ if strict => Err(PatchError::not_found(path)),
        _ => Ok(None),
    }
}

/// Structural equality with numbers compared as the doubles they denote, so `1`, `1.0` and
/// `1e0` are equal and `-0` equals `0` (SameValueZero leaves, as the TS `deepEqual`).
fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            crate::canonical::number_as_f64(a) == crate::canonical::number_as_f64(b)
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| deep_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| deep_equal(a, b)))
        }
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ops(value: Value) -> Vec<Operation> {
        value
            .as_array()
            .expect("array")
            .iter()
            .map(|op| Operation::from_value(op).expect("operation"))
            .collect()
    }

    fn code(document: Value, operations: Value) -> &'static str {
        apply(&document, &ops(operations))
            .expect_err("fails")
            .code()
    }

    #[test]
    fn error_codes_follow_ts_order() {
        assert_eq!(
            code(json!({}), json!([{"op": "add", "path": "a", "value": 1}])),
            "INVALID_PATH"
        );
        assert_eq!(
            code(json!({}), json!([{"op": "add", "path": "", "value": 1}])),
            "INVALID_PATH"
        );
        assert_eq!(
            code(json!({"a": 1}), json!([{"op": "remove", "path": ""}])),
            "INVALID_PATH"
        );
        assert_eq!(
            code(
                json!({}),
                json!([{"op": "add", "path": "/__proto__", "value": 1}])
            ),
            "INVALID_PATH"
        );
        assert_eq!(
            code(
                json!({"a": {}}),
                json!([{"op": "move", "from": "/a", "path": "/a/b"}])
            ),
            "INVALID_PATH"
        );
        assert_eq!(
            code(
                json!({"a": [1]}),
                json!([{"op": "add", "path": "/a/2", "value": 1}])
            ),
            "INVALID_INDEX"
        );
        assert_eq!(
            code(
                json!({"a": [1]}),
                json!([{"op": "add", "path": "/a/01", "value": 1}])
            ),
            "INVALID_INDEX"
        );
        assert_eq!(
            code(
                json!({"a": [1]}),
                json!([{"op": "add", "path": "/a/99999999999999999999999", "value": 1}])
            ),
            "INVALID_INDEX"
        );
        assert_eq!(
            code(
                json!({}),
                json!([{"op": "add", "path": "/x/y", "value": 1}])
            ),
            "PATH_NOT_FOUND"
        );
        assert_eq!(
            code(
                json!({"a": 1}),
                json!([{"op": "add", "path": "/a/b", "value": 1}])
            ),
            "INVALID_TARGET"
        );
        assert_eq!(
            code(
                json!({"a": null}),
                json!([{"op": "set", "path": "/a/b", "value": 1}])
            ),
            "INVALID_TARGET"
        );
        assert_eq!(
            code(
                json!({"a": null}),
                json!([{"op": "add", "path": "/a/b/c", "value": 1}])
            ),
            "PATH_NOT_FOUND"
        );
        assert_eq!(
            code(
                json!({"a": null}),
                json!([{"op": "set", "path": "/a/b/c", "value": 1}])
            ),
            "PATH_NOT_FOUND"
        );
        assert_eq!(
            code(
                json!({"a": "s"}),
                json!([{"op": "add", "path": "/a/0/c", "value": 1}])
            ),
            "PATH_NOT_FOUND"
        );
        assert_eq!(
            code(
                json!({"a": null}),
                json!([{"op": "remove", "path": "/a/b/c"}])
            ),
            "PATH_NOT_FOUND"
        );
        assert_eq!(
            code(
                json!({"a": 1}),
                json!([{"op": "test", "path": "/a", "value": 2}])
            ),
            "TEST_FAILED"
        );
        assert!(Operation::from_value(&json!({"op": "nope", "path": "/a"})).is_err());
    }

    #[test]
    fn values_and_non_strict() {
        let doc = json!({"a": [1, 2], "n": null, "k": {"1": "x"}});
        let result = apply(
            &doc,
            &ops(json!([
                {"op": "test", "path": "/n", "value": null},
                {"op": "test", "path": "/a/0", "value": 1.0},
                {"op": "replace", "path": "/k/1", "value": "y"},
                {"op": "set", "path": "/a/2", "value": 3},
                {"op": "add", "path": "/-", "value": 4},
                {"op": "move", "from": "/a/0", "path": "/a/0"}
            ])),
        );
        assert_eq!(
            result,
            Ok(json!({"a": [1, 2, 3], "n": null, "k": {"1": "y"}, "-": 4}))
        );
        let lenient = apply_with(
            &doc,
            &ops(json!([
                {"op": "remove", "path": "/missing"},
                {"op": "remove", "path": "/x/y"},
                {"op": "replace", "path": "/b", "value": 1},
                {"op": "copy", "from": "/missing", "path": "/c"},
                {"op": "move", "from": "/missing", "path": "/d"}
            ])),
            false,
        );
        let mut expected = doc.clone();
        expected["b"] = json!(1);
        assert_eq!(lenient, Ok(expected));
    }

    #[test]
    fn non_strict_null_and_primitive_targets() {
        let doc = json!({"n": null, "s": "ab", "x": 1, "o": {}});
        let lenient = |operations: Value| apply_with(&doc, &ops(operations), false);
        // A missing parent behind `null` is a no-op.
        assert_eq!(
            lenient(json!([{"op": "remove", "path": "/n/b/c"}])),
            Ok(doc.clone())
        );
        // Members of a number, and a string's non-members, are absent.
        assert_eq!(
            lenient(json!([
                {"op": "remove", "path": "/x/b"},
                {"op": "remove", "path": "/s/2"},
                {"op": "remove", "path": "/s/b"},
                {"op": "copy", "from": "/s/0", "path": "/c"},
                {"op": "move", "from": "/s/length", "path": "/m"}
            ])),
            Ok(doc.clone())
        );
        let invalid_target = |operations: Value| lenient(operations).expect_err("fails").code();
        // TS `Object.hasOwn(null, key)` throws.
        assert_eq!(
            invalid_target(json!([{"op": "remove", "path": "/n/b"}])),
            "INVALID_TARGET"
        );
        assert_eq!(
            invalid_target(json!([{"op": "replace", "path": "/n/b", "value": 1}])),
            "INVALID_TARGET"
        );
        // TS deletes a read-only own member of a string.
        assert_eq!(
            invalid_target(json!([{"op": "remove", "path": "/s/1"}])),
            "INVALID_TARGET"
        );
        assert_eq!(
            invalid_target(json!([{"op": "remove", "path": "/s/length"}])),
            "INVALID_TARGET"
        );
        // TS assigns to a primitive's member.
        assert_eq!(
            invalid_target(json!([{"op": "replace", "path": "/x/b", "value": 1}])),
            "INVALID_TARGET"
        );
        // Numeric segments stay exact member names on objects.
        assert_eq!(
            apply(
                &doc,
                &ops(json!([{"op": "add", "path": "/o/007", "value": 1}]))
            ),
            Ok(json!({"n": null, "s": "ab", "x": 1, "o": {"007": 1}}))
        );
    }
}
